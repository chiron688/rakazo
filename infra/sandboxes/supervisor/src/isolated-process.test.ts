import { Duplex } from "node:stream";
import type Docker from "dockerode";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProcessIdentity } from "./isolated-process.js";
import {
  assertHarnessDaemon,
  IsolatedProcessManager,
  isolatedProcessContainerOptions,
  isolatedProcessRequest,
  isolatedProcessRoutes,
  processFrameDecoder,
  sessionVolumeName,
} from "./isolated-process.js";

const identity: ProcessIdentity = {
  computerId: "computer",
  computerBotId: "team",
  spaceId: "space",
  botId: "bot",
  userId: "user",
  runId: "run",
};
const request = { isolation: "primary-harness" as const, argv: ["node", "--version"] };
const scope = {
  threadId: "thread",
  profileId: "profile",
  profileRevision: 1,
  accountId: "account",
  epoch: "epoch",
};

function frame(type: number, payload: Buffer | string) {
  const data = Buffer.from(payload);
  const header = Buffer.alloc(8);
  header[0] = type;
  header.writeUInt32BE(data.length, 4);
  return Buffer.concat([header, data]);
}

function fakeDocker() {
  const inputs: string[] = [];
  const inputEnd = vi.fn();
  const stream = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      inputs.push(chunk.toString());
      callback();
    },
    final(callback) {
      inputEnd();
      callback();
    },
  });
  let exit!: (result: { StatusCode: number }) => void;
  const completed = new Promise<{ StatusCode: number }>((resolve) => {
    exit = resolve;
  });
  const container = {
    attach: vi.fn(async () => stream),
    start: vi.fn(async () => undefined),
    wait: vi.fn(() => completed),
    remove: vi.fn(async () => undefined),
  };
  const network = { id: "network", remove: vi.fn(async () => undefined) };
  const volumes = new Map<string, { Name: string; Labels: Record<string, string> }>();
  const removeVolume = vi.fn(async (name: string) => {
    volumes.delete(name);
  });
  const docker = {
    info: vi.fn(async () => ({ OSType: "linux", OperatingSystem: "Debian", SecurityOptions: [] })),
    listContainers: vi.fn(async () => []),
    listNetworks: vi.fn(async () => []),
    createNetwork: vi.fn(async () => network),
    createContainer: vi.fn(async () => container),
    getVolume: vi.fn((name: string) => ({
      inspect: vi.fn(async () => {
        const v = volumes.get(name);
        if (!v) throw { statusCode: 404 };
        return v;
      }),
      remove: () => removeVolume(name),
    })),
    createVolume: vi.fn(async (value: { Name: string; Labels: Record<string, string> }) => {
      volumes.set(value.Name, value);
      return value;
    }),
    listVolumes: vi.fn(async () => ({ Volumes: [...volumes.values()] })),
  };
  return {
    docker,
    container,
    stream,
    network,
    inputs,
    inputEnd,
    exit,
    volumes,
    removeVolume,
    manager: new IsolatedProcessManager(docker as unknown as Docker, "restricted", "installation"),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("isolated runtime security", () => {
  it("rejects runtime config/environment injection and untrusted workspaces", () => {
    for (const key of [
      "HOME",
      "PATH",
      "NODE_OPTIONS",
      "PYTHONPATH",
      "LD_PRELOAD",
      "CODEX_HOME",
      "CLAUDE_CONFIG_DIR",
    ]) {
      expect(
        isolatedProcessRequest.safeParse({ ...request, env: { [key]: "hostile" } }).success,
      ).toBe(false);
    }
    expect(isolatedProcessRequest.safeParse({ ...request, cwd: "/home/rakazo/repo" }).success).toBe(
      false,
    );
    expect(
      isolatedProcessRequest.safeParse({ ...request, env: { ANTHROPIC_API_KEY: "fake-key" } })
        .success,
    ).toBe(true);
  });

  it("has a separate PID/network namespace and no team/host mounts or inherited environment", () => {
    const spec = isolatedProcessContainerOptions("id", identity, request, "private-network");
    expect(spec.User).toBe("10001:10001");
    expect(spec.WorkingDir).toBe("/home/harness");
    expect(spec.Entrypoint).toEqual(["/usr/bin/timeout"]);
    expect(spec.Cmd).toContain("/opt/rakazo-harness/launch.py");
    expect(spec.Cmd).toContain("--kill-after=5s");
    expect(spec.HostConfig).toMatchObject({
      NetworkMode: "private-network",
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      Init: true,
    });
    expect(spec.HostConfig?.Mounts).toBeUndefined();
    expect(spec.HostConfig?.Binds).toBeUndefined();
    expect(spec.HostConfig?.PidMode).toBeUndefined();
    expect(spec.HostConfig?.Privileged).toBeUndefined();
    expect(spec.HostConfig?.Tmpfs?.["/home/harness"]).toContain("uid=10001");
    expect(spec.HostConfig?.LogConfig?.Type).toBe("none");
    const secretSpec = isolatedProcessContainerOptions(
      "id",
      identity,
      { ...request, env: { OPENAI_API_KEY: "fake-sensitive-value" } },
      "network",
    );
    expect(JSON.stringify(secretSpec)).not.toContain("fake-sensitive-value");
    expect(secretSpec.Env).toBeUndefined();
  });

  it("uses only a scoped session volume and rotates scope on identity or epoch changes", () => {
    const base = sessionVolumeName("installation", identity, scope);
    expect(sessionVolumeName("installation", { ...identity, runId: "next-run" }, scope)).toBe(base);
    for (const changed of [
      { threadId: "other" },
      { profileId: "other" },
      { profileRevision: 2 },
      { accountId: "other" },
      { epoch: "other" },
    ]) {
      expect(sessionVolumeName("installation", identity, { ...scope, ...changed })).not.toBe(base);
    }
    for (const changed of [{ botId: "other" }, { spaceId: "other" }, { userId: "other" }]) {
      expect(sessionVolumeName("installation", { ...identity, ...changed }, scope)).not.toBe(base);
    }
    const spec = isolatedProcessContainerOptions(
      "id",
      identity,
      { ...request, sessionScope: scope },
      "network",
      base,
    );
    expect(spec.HostConfig?.Mounts).toEqual([
      { Type: "volume", Source: base, Target: "/sessions", ReadOnly: false },
    ]);
  });

  it.each([
    { OSType: "windows" },
    { OSType: "linux", OperatingSystem: "Docker Desktop" },
    { OSType: "linux", SecurityOptions: ["name=rootless"] },
    {},
  ])("rejects unsupported daemon %j", (info) => {
    expect(() => assertHarnessDaemon(info)).toThrow(/rootful Linux/);
  });

  it("fails closed without operator-attested restricted egress", async () => {
    const fake = fakeDocker();
    await expect(
      fake.manager.start(identity, request, new AbortController().signal),
    ).rejects.toThrow(/verified restricted/);
    vi.stubEnv("PRIMARY_HARNESS_EGRESS_VERIFIED", "true");
    const open = new IsolatedProcessManager(
      fake.docker as unknown as Docker,
      "open",
      "installation",
    );
    await expect(open.start(identity, request, new AbortController().signal)).rejects.toThrow(
      /verified restricted/,
    );
    expect(fake.docker.createContainer).not.toHaveBeenCalled();
  });
});

describe("isolated runtime framing", () => {
  it("decodes fragmented Docker headers and UTF-8 characters across stdout frames", () => {
    const events: unknown[] = [];
    const decode = processFrameDecoder((event) => events.push(event));
    const utf8 = Buffer.from("你好");
    const bytes = Buffer.concat([
      frame(1, utf8.subarray(0, 2)),
      frame(2, "error"),
      frame(1, utf8.subarray(2)),
    ]);
    for (const byte of bytes) decode.push(Buffer.from([byte]));
    decode.finish();
    expect(events).toEqual([
      { type: "stderr", data: "error" },
      { type: "stdout", data: "你好" },
    ]);
  });

  it("rejects truncated and oversized frames", () => {
    const decode = processFrameDecoder(() => undefined);
    decode.push(frame(1, "test").subarray(0, 9));
    expect(() => decode.finish()).toThrow(/Truncated/);
    const oversized = Buffer.alloc(8);
    oversized[0] = 1;
    oversized.writeUInt32BE(2 * 1024 * 1024, 4);
    expect(() => processFrameDecoder(() => undefined).push(oversized)).toThrow(/Invalid/);
  });
});

describe("isolated runtime lifecycle", () => {
  it("bounds UTF-8 input and aggregate queued media independently of frame count", async () => {
    vi.stubEnv("PRIMARY_HARNESS_EGRESS_VERIFIED", "true");
    const fake = fakeDocker();
    const { id } = await fake.manager.start(identity, request, new AbortController().signal);
    const process = fake.manager.get(id, identity);
    await expect(process.input("界".repeat(6 * 1024 * 1024))).rejects.toThrow(/limit/);
    let release!: () => void;
    fake.stream._write = (_chunk, _encoding, callback) => {
      release = () => callback();
    };
    const input = "x".repeat(12 * 1024 * 1024);
    const one = process.input(input);
    const two = process.input(input);
    await expect(process.input(input)).rejects.toThrow(/limit/);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    release();
    await one;
    await new Promise((resolve) => setImmediate(resolve));
    release();
    await two;
    fake.stream._write = (_chunk, _encoding, callback) => callback();
    await process.input("released");
    await process.terminate();
  });

  it("streams output, orders stdin and closes it without ending stdout", async () => {
    vi.stubEnv("PRIMARY_HARNESS_EGRESS_VERIFIED", "true");
    const fake = fakeDocker();
    const { id, body } = await fake.manager.start(identity, request, new AbortController().signal);
    const process = fake.manager.get(id, identity);
    await Promise.all([process.input("first"), process.input("second"), process.closeInput()]);
    expect(fake.inputs).toEqual([
      `${JSON.stringify({ argv: request.argv, env: {} })}\n`,
      "first",
      "second",
    ]);
    expect(fake.inputEnd).toHaveBeenCalledOnce();
    const output = new Response(body).text();
    fake.stream.push(frame(1, "result"));
    fake.stream.push(null);
    fake.exit({ StatusCode: 7 });
    expect(await output).toContain('"code":7');
    await vi.waitFor(() => expect(fake.container.remove).toHaveBeenCalledWith({ force: true }));
    expect(fake.network.remove).toHaveBeenCalledOnce();
  });

  it("kills the whole container on disconnect and abort and makes cleanup idempotent", async () => {
    vi.stubEnv("PRIMARY_HARNESS_EGRESS_VERIFIED", "true");
    const fake = fakeDocker();
    const abort = new AbortController();
    const { id, body } = await fake.manager.start(identity, request, abort.signal);
    const process = fake.manager.get(id, identity);
    abort.abort();
    await process.terminate();
    await body.cancel();
    expect(fake.container.remove).toHaveBeenCalledOnce();
    expect(fake.container.remove).toHaveBeenCalledWith({ force: true });
    expect(fake.stream.destroyed).toBe(true);
    expect(() => fake.manager.get(id, identity)).toThrow(/not found/);
  });

  it("enforces timeout and run/computer/tenant/user isolation on every control operation", async () => {
    vi.stubEnv("PRIMARY_HARNESS_EGRESS_VERIFIED", "true");
    vi.useFakeTimers();
    const fake = fakeDocker();
    const { id, body } = await fake.manager.start(
      identity,
      { ...request, timeoutMs: 30 },
      new AbortController().signal,
    );
    for (const field of ["computerId", "computerBotId", "spaceId", "botId", "runId", "userId"]) {
      expect(() => fake.manager.get(id, { ...identity, [field]: "other" })).toThrow(/not found/);
    }
    const output = new Response(body).text();
    await vi.advanceTimersByTimeAsync(30);
    expect(await output).toContain('"code":124');
    expect(fake.container.remove).toHaveBeenCalledWith({ force: true });
  });

  it("fences concurrent session mounts, keeps state on stop and deletes it on computer destruction", async () => {
    vi.stubEnv("PRIMARY_HARNESS_EGRESS_VERIFIED", "true");
    const fake = fakeDocker();
    const { id } = await fake.manager.start(
      identity,
      { ...request, sessionScope: scope },
      new AbortController().signal,
    );
    await expect(
      fake.manager.start(
        { ...identity, runId: "other" },
        { ...request, sessionScope: scope },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/already leased/);
    expect(fake.volumes.size).toBe(1);
    await fake.manager.stopComputer(identity.computerId);
    expect(fake.volumes.size).toBe(1);
    expect(() => fake.manager.get(id, identity)).toThrow();
    await fake.manager.destroyComputer(identity.computerBotId);
    expect(fake.volumes.size).toBe(0);
  });

  it("removes failed-start containers and network resources", async () => {
    vi.stubEnv("PRIMARY_HARNESS_EGRESS_VERIFIED", "true");
    const fake = fakeDocker();
    fake.container.start.mockRejectedValueOnce(new Error("failed"));
    await expect(
      fake.manager.start(identity, request, new AbortController().signal),
    ).rejects.toThrow("failed");
    expect(fake.container.remove).toHaveBeenCalledWith({ force: true });
    expect(fake.network.remove).toHaveBeenCalledOnce();
  });

  it("fences a launch still allocating resources when the supervisor shuts down", async () => {
    vi.stubEnv("PRIMARY_HARNESS_EGRESS_VERIFIED", "true");
    const fake = fakeDocker();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fake.docker.createNetwork.mockImplementationOnce(async () => {
      await gate;
      return fake.network;
    });
    const starting = fake.manager.start(identity, request, new AbortController().signal);
    await vi.waitFor(() => expect(fake.docker.createNetwork).toHaveBeenCalledOnce());
    await fake.manager.close();
    release();
    await expect(starting).rejects.toThrow(/stopping/);
    expect(fake.docker.createContainer).not.toHaveBeenCalled();
    expect(fake.network.remove).toHaveBeenCalledOnce();
  });

  it("allows authenticated termination after the feature is switched off", async () => {
    vi.stubEnv("PRIMARY_HARNESS_EGRESS_VERIFIED", "true");
    vi.stubEnv("PRIMARY_HARNESSES_ENABLED", "true");
    const fake = fakeDocker();
    const { id } = await fake.manager.start(identity, request, new AbortController().signal);
    const app = isolatedProcessRoutes(fake.manager, (_identity, launch) => launch());
    vi.stubEnv("PRIMARY_HARNESSES_ENABLED", "false");
    const result = await app.request(`/computer/processes/${id}`, {
      method: "DELETE",
      headers: {
        "x-rakazo-bot-id": "team",
        "x-rakazo-space-id": "space",
        "x-rakazo-runtime-bot-id": "bot",
        "x-rakazo-runtime-user-id": "user",
        "x-rakazo-run-id": "run",
      },
    });
    expect(result.status).toBe(200);
    expect(fake.container.remove).toHaveBeenCalledWith({ force: true });
  });

  it("rejects disabled routes before touching Docker", async () => {
    const fake = fakeDocker();
    const authorize = vi.fn((_identity, launch) => launch());
    const app = isolatedProcessRoutes(fake.manager, authorize);
    const result = await app.request("/computer/processes", {
      method: "POST",
      body: JSON.stringify(request),
    });
    expect(result.status).toBe(503);
    expect(authorize).not.toHaveBeenCalled();
  });
});
