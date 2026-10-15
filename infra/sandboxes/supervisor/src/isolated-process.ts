import { createHash, randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type Docker from "dockerode";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { ComputerEgressMode } from "./computer-spec.js";

export const HARNESS_IMAGE = process.env.RAKAZO_HARNESS_IMAGE ?? "rakazo/harness:local";
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_QUEUED_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;
const IDENTITY_HEADER = "x-rakazo-runtime-bot-id";
const CREDENTIAL_ENV = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "KIMI_API_KEY",
  "KIMI_BASE_URL",
  "KIMI_DISABLE_TELEMETRY",
]);

export const isolatedProcessRequest = z
  .object({
    isolation: z.literal("primary-harness"),
    sessionScope: z
      .object({
        threadId: z.string().min(1).max(200),
        profileId: z.string().min(1).max(200),
        profileRevision: z.number().int().positive(),
        accountId: z.string().min(1).max(200),
        epoch: z.string().min(1).max(200),
      })
      .strict()
      .optional(),
    argv: z
      .array(
        z
          .string()
          .min(1)
          .max(512 * 1024)
          .refine((s) => !s.includes("\0")),
      )
      .min(1)
      .max(128),
    env: z
      .record(
        z.string(),
        z
          .string()
          .max(32 * 1024)
          .refine((s) => !s.includes("\0")),
      )
      .optional(),
    timeoutMs: z.number().int().positive().max(MAX_TIMEOUT_MS).optional(),
  })
  .strict()
  .refine((request) => Object.keys(request.env ?? {}).every((key) => CREDENTIAL_ENV.has(key)), {
    message: "Runtime environment may only contain supported credentials and endpoints.",
  });

type ProcessRequest = z.infer<typeof isolatedProcessRequest>;
type Event = { type: "stdout" | "stderr"; data: string } | { type: "exit"; code: number };
export interface ProcessIdentity {
  computerId: string;
  computerBotId: string;
  spaceId: string;
  botId: string;
  runId: string;
  userId: string;
}

/** No host/team mounts or namespaces. Only explicitly scoped native transcript state may persist. */
export function isolatedProcessContainerOptions(
  id: string,
  identity: ProcessIdentity,
  request: ProcessRequest,
  networkName: string,
  sessionVolume?: string,
): Docker.ContainerCreateOptions {
  return {
    name: `rakazo-harness-${id}`,
    Image: HARNESS_IMAGE,
    User: "10001:10001",
    Entrypoint: ["/usr/bin/timeout"],
    // PID 1 exits even if the supervisor crashes; Docker then destroys all descendants.
    Cmd: [
      "--signal=TERM",
      "--kill-after=5s",
      `${Math.ceil((request.timeoutMs ?? MAX_TIMEOUT_MS) / 1000)}s`,
      "/usr/local/bin/python3",
      "-I",
      "/opt/rakazo-harness/launch.py",
    ],
    WorkingDir: "/home/harness",
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    OpenStdin: true,
    StdinOnce: true,
    Tty: false,
    Labels: {
      "rakazo.harness": "true",
      "rakazo.computerId": identity.computerId,
      "rakazo.spaceId": identity.spaceId,
      "rakazo.botId": identity.botId,
      "rakazo.runId": identity.runId,
    },
    HostConfig: {
      NetworkMode: networkName,
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      Init: true,
      Memory: 1024 * 1024 * 1024,
      MemorySwap: 1024 * 1024 * 1024,
      NanoCpus: 2_000_000_000,
      PidsLimit: 128,
      Tmpfs: {
        "/home/harness": "rw,nosuid,nodev,noexec,size=128m,mode=0700,uid=10001,gid=10001",
        "/tmp": "rw,nosuid,nodev,noexec,size=64m,mode=1777",
      },
      LogConfig: { Type: "none", Config: {} },
      ...(sessionVolume
        ? {
            Mounts: [
              {
                Type: "volume" as const,
                Source: sessionVolume,
                Target: "/sessions",
                ReadOnly: false,
              },
            ],
          }
        : {}),
    },
  };
}

/** Include both authenticated ownership and the server-resolved compatibility/credential epoch. */
export function sessionVolumeName(
  owner: string,
  identity: ProcessIdentity,
  scope: NonNullable<ProcessRequest["sessionScope"]>,
) {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        owner,
        identity.spaceId,
        identity.userId,
        identity.botId,
        scope.threadId,
        scope.profileId,
        scope.profileRevision,
        scope.accountId,
        scope.epoch,
      ]),
    )
    .digest("hex");
  return `rakazo-harness-session-${digest}`;
}

/** Docker headers and UTF-8 code points can both cross arbitrary transport/frame boundaries. */
export function processFrameDecoder(onEvent: (event: Event) => void) {
  let pending = Buffer.alloc(0);
  const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
  return {
    push(chunk: Buffer) {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 8) {
        const stream = pending[0] === 1 ? "stdout" : pending[0] === 2 ? "stderr" : undefined;
        const size = pending.readUInt32BE(4);
        if (!stream || pending[1] || pending[2] || pending[3] || size > MAX_FRAME_BYTES) {
          throw new Error("Invalid runtime output frame.");
        }
        if (pending.length < 8 + size) break;
        const data = decoders[stream].write(pending.subarray(8, 8 + size));
        if (data) onEvent({ type: stream, data });
        pending = Buffer.from(pending.subarray(8 + size));
      }
    },
    finish() {
      if (pending.length) throw new Error("Truncated runtime output frame.");
      for (const type of ["stdout", "stderr"] as const) {
        const data = decoders[type].end();
        if (data) onEvent({ type, data });
      }
    },
  };
}

interface RunningProcess {
  identity: ProcessIdentity;
  input(data: string): Promise<void>;
  closeInput(): Promise<void>;
  terminate(): Promise<void>;
}

export function assertHarnessDaemon(info: {
  OSType?: string;
  OperatingSystem?: string;
  SecurityOptions?: string[];
}) {
  if (
    info.OSType !== "linux" ||
    /docker desktop/i.test(info.OperatingSystem ?? "") ||
    info.SecurityOptions?.some((option) => /rootless/i.test(option))
  ) {
    throw new Error(
      "Primary harnesses require rootful Linux Docker with verified iptables egress.",
    );
  }
}

function isMissing(error: unknown) {
  return Boolean(
    error && typeof error === "object" && "statusCode" in error && error.statusCode === 404,
  );
}

/** All process control stays in the Docker supervisor; API hosts never spawn a CLI. */
export class IsolatedProcessManager {
  private readonly running = new Map<string, RunningProcess>();
  private ready: Promise<void> | undefined;
  private closing = false;
  private readonly sessionLeases = new Map<string, string>();
  constructor(
    private readonly docker: Docker,
    private readonly egress: ComputerEgressMode,
    private readonly owner: string,
  ) {}

  initialize() {
    this.ready ??= (async () => {
      // A dead supervisor cannot retain a session lease. Remove only this installation's orphans.
      const filters = { label: [`rakazo.harnessOwner=${this.owner}`] };
      const containers = await this.docker.listContainers({ all: true, filters });
      await Promise.all(
        containers.map((item) => this.docker.getContainer(item.Id).remove({ force: true })),
      );
      const networks = await this.docker.listNetworks({ filters });
      await Promise.all(networks.map((item) => this.docker.getNetwork(item.Id).remove()));
    })();
    const ready = this.ready;
    void ready.catch(() => {
      if (this.ready === ready) this.ready = undefined;
    });
    return ready;
  }

  async start(identity: ProcessIdentity, request: ProcessRequest, signal: AbortSignal) {
    const assertActive = () => {
      signal.throwIfAborted();
      if (this.closing) throw new Error("Isolated runtime supervisor is stopping.");
    };
    assertActive();
    if (this.egress !== "restricted" || process.env.PRIMARY_HARNESS_EGRESS_VERIFIED !== "true") {
      throw new Error("Isolated harnesses require verified restricted host egress.");
    }
    assertHarnessDaemon(await this.docker.info());
    await this.initialize();
    assertActive();
    const id = randomUUID();
    const sessionVolume = request.sessionScope
      ? sessionVolumeName(this.owner, identity, request.sessionScope)
      : undefined;
    if (sessionVolume) {
      if (this.sessionLeases.has(sessionVolume))
        throw new Error("Native session is already leased.");
      this.sessionLeases.set(sessionVolume, id);
      try {
        const labels = {
          "rakazo.harnessSessionOwner": this.owner,
          "rakazo.harnessSessionScope": sessionVolume,
          "rakazo.harnessSessionComputer": identity.computerBotId,
          "rakazo.harnessSessionBot": identity.botId,
        };
        const volume = await this.docker
          .getVolume(sessionVolume)
          .inspect()
          .catch(async (error: unknown) => {
            if (!isMissing(error)) throw error;
            return this.docker.createVolume({ Name: sessionVolume, Labels: labels });
          });
        if (Object.entries(labels).some(([key, value]) => volume.Labels?.[key] !== value)) {
          throw new Error("Native session volume ownership mismatch.");
        }
      } catch (error) {
        this.sessionLeases.delete(sessionVolume);
        throw error;
      }
    }
    // Separate network; no supervisor, team computer or other runtime joins it.
    const network = await this.docker
      .createNetwork({
        Name: `rakazo-harness-${id}`,
        Driver: "bridge",
        Options: {
          "com.docker.network.bridge.name": `rakazo-h${createHash("sha256").update(id).digest("hex").slice(0, 7)}`,
        },
        Labels: { "rakazo.harness": "true", "rakazo.harnessOwner": this.owner },
      })
      .catch((error: unknown) => {
        if (sessionVolume) this.sessionLeases.delete(sessionVolume);
        throw error;
      });
    let container: Docker.Container | undefined;
    let attached: Duplex | undefined;
    let closed = false;
    let stdinClosed = false;
    let settled = false;
    let outputBytes = 0;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let cleanupPromise: Promise<void> | undefined;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const encoder = new TextEncoder();
    const cleanup = () =>
      (cleanupPromise ??= (async () => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
        // Force removal kills the container's entire PID namespace, including detached descendants.
        // Never rely on killing only a CLI or its immediate process group.
        try {
          await container?.remove({ force: true }).catch((error: unknown) => {
            if (!isMissing(error)) throw error;
          });
          this.running.delete(id);
          if (sessionVolume) this.sessionLeases.delete(sessionVolume);
        } finally {
          attached?.destroy();
          await network.remove().catch(() => undefined);
        }
      })());
    const send = (event: Event) => {
      if (closed || (settled && event.type !== "exit")) return;
      const encoded = encoder.encode(`${JSON.stringify(event)}\n`);
      outputBytes += encoded.byteLength;
      if (outputBytes > MAX_OUTPUT_BYTES || (controller?.desiredSize ?? 0) < -MAX_FRAME_BYTES) {
        void finish(1).catch(() => undefined);
        return;
      }
      try {
        controller?.enqueue(encoded);
      } catch {
        void finish(1).catch(() => undefined);
      }
    };
    const finish = async (code: number) => {
      if (settled) return cleanupPromise;
      settled = true;
      try {
        await cleanup();
        send({ type: "exit", code });
      } catch (error) {
        send({ type: "exit", code: 1 });
        throw error;
      } finally {
        closed = true;
        try {
          controller?.close();
        } catch {
          /* Disconnected consumer. */
        }
      }
    };
    const abort = () => {
      void finish(130).catch(() => undefined);
    };
    const body = new ReadableStream<Uint8Array>(
      {
        start(value) {
          controller = value;
          value.enqueue(encoder.encode("\n"));
        },
        cancel() {
          return finish(130);
        },
      },
      { highWaterMark: MAX_FRAME_BYTES, size: (chunk) => chunk.byteLength },
    );
    try {
      assertActive();
      const options = isolatedProcessContainerOptions(
        id,
        identity,
        request,
        network.id,
        sessionVolume,
      );
      options.Labels = { ...options.Labels, "rakazo.harnessOwner": this.owner };
      container = await this.docker.createContainer(options);
      assertActive();
      attached = (await container.attach({
        stream: true,
        stdin: true,
        stdout: true,
        stderr: true,
        hijack: true,
      })) as Duplex;
      assertActive();
      const decode = processFrameDecoder(send);
      let outputEnded!: () => void;
      const outputDone = new Promise<void>((resolve) => {
        outputEnded = resolve;
      });
      attached.on("data", (chunk: Buffer) => {
        try {
          decode.push(chunk);
        } catch {
          void finish(1).catch(() => undefined);
        }
      });
      attached.once("end", () => {
        try {
          decode.finish();
        } catch {
          void finish(1).catch(() => undefined);
        }
        outputEnded();
      });
      attached.once("close", outputEnded);
      attached.once("error", () => {
        outputEnded();
        void finish(1).catch(() => undefined);
      });
      const stream = attached;
      let inputTail = Promise.resolve();
      let queuedInputBytes = 0;
      const serialize = (operation: () => Promise<void>) => {
        const task = inputTail.then(operation);
        inputTail = task.catch(() => undefined);
        return task;
      };
      this.running.set(id, {
        identity,
        input: (data) => {
          const bytes = Buffer.byteLength(data, "utf8");
          if (bytes > MAX_INPUT_BYTES || queuedInputBytes + bytes > MAX_QUEUED_INPUT_BYTES)
            return Promise.reject(new Error("Runtime input exceeds its limit."));
          queuedInputBytes += bytes;
          return serialize(async () => {
            if (settled || closed || stdinClosed) throw new Error("Runtime input is closed.");
            await new Promise<void>((resolve, reject) =>
              stream.write(data, (error) => (error ? reject(error) : resolve())),
            );
          }).finally(() => {
            queuedInputBytes -= bytes;
          });
        },
        closeInput: () =>
          serialize(async () => {
            if (stdinClosed) return;
            stdinClosed = true;
            if (!closed) await new Promise<void>((resolve) => stream.end(resolve));
          }),
        terminate: () => finish(130),
      });
      signal.addEventListener("abort", abort, { once: true });
      assertActive();
      await container.start();
      // One private bootstrap frame precedes native stdio. Never put credentials in Docker
      // Env/Cmd, logs, project files, or the user-visible process arguments.
      await new Promise<void>((resolve, reject) =>
        stream.write(
          `${JSON.stringify({ argv: request.argv, env: request.env ?? {} })}\n`,
          (error) => (error ? reject(error) : resolve()),
        ),
      );
      assertActive();
      timeout = setTimeout(() => {
        void finish(124).catch(() => undefined);
      }, request.timeoutMs ?? MAX_TIMEOUT_MS);
      timeout.unref?.();
      void container
        .wait()
        .then(
          async (result) => {
            // Wait for attached output to drain before publishing the terminal event.
            await outputDone;
            await finish(result.StatusCode);
          },
          () => finish(1),
        )
        .catch(() => undefined);
      return { id, body };
    } catch (error) {
      await finish(1);
      throw error;
    }
  }

  get(id: string, identity: ProcessIdentity) {
    const process = this.running.get(id);
    if (
      !process ||
      Object.keys(identity).some(
        (key) =>
          process.identity[key as keyof ProcessIdentity] !== identity[key as keyof ProcessIdentity],
      )
    ) {
      throw new Error("Runtime process not found.");
    }
    return process;
  }

  async stopComputer(computerId: string) {
    await Promise.all(
      [...this.running.values()]
        .filter((item) => item.identity.computerId === computerId)
        .map((item) => item.terminate()),
    );
  }

  async destroyComputer(computerBotId: string) {
    // A disabled, never-initialized optional runtime must not add Docker requirements to
    // ordinary computer deletion. A previously initialized runtime still cleans up on rollback.
    if (!this.ready && process.env.PRIMARY_HARNESSES_ENABLED !== "true") return;
    await Promise.all(
      [...this.running.values()]
        .filter((item) => item.identity.computerBotId === computerBotId)
        .map((item) => item.terminate()),
    );
    const result = await this.docker.listVolumes({
      filters: {
        label: [
          `rakazo.harnessSessionOwner=${this.owner}`,
          `rakazo.harnessSessionComputer=${computerBotId}`,
        ],
      },
    });
    for (const volume of result.Volumes ?? []) {
      if (this.sessionLeases.has(volume.Name)) throw new Error("Native session is still leased.");
      await this.docker.getVolume(volume.Name).remove();
    }
  }

  async close() {
    this.closing = true;
    await Promise.all([...this.running.values()].map((item) => item.terminate()));
  }
}

/** Mounted beneath the supervisor's existing bearer-token and body-limit middleware. */
export function isolatedProcessRoutes(
  manager: IsolatedProcessManager,
  authorize: (
    identity: ProcessIdentity,
    launch: () => ReturnType<IsolatedProcessManager["start"]>,
  ) => ReturnType<IsolatedProcessManager["start"]>,
) {
  const routes = new Hono();
  const enabled: MiddlewareHandler = async (c, next) => {
    if (c.req.method !== "DELETE" && process.env.PRIMARY_HARNESSES_ENABLED !== "true")
      return c.json({ error: "Primary harnesses are disabled." }, 503);
    await next();
  };
  routes.use("/:id/processes", enabled);
  routes.use("/:id/processes/*", enabled);
  const identity = (computerId: string, headers: Headers): ProcessIdentity => {
    const value = {
      computerId,
      computerBotId: headers.get("x-rakazo-bot-id") ?? "",
      spaceId: headers.get("x-rakazo-space-id") ?? "",
      botId: headers.get(IDENTITY_HEADER) ?? "",
      runId: headers.get("x-rakazo-run-id") ?? "",
      userId: headers.get("x-rakazo-runtime-user-id") ?? "",
    };
    if (Object.values(value).some((part) => !part || part.length > 200))
      throw new Error("Missing runtime identity.");
    return value;
  };
  routes.post("/:id/processes", async (c) => {
    const parsed = isolatedProcessRequest.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: "Invalid isolated runtime request." }, 400);
    try {
      const owner = identity(c.req.param("id"), c.req.raw.headers);
      const result = await authorize(owner, () =>
        manager.start(owner, parsed.data, c.req.raw.signal),
      );
      return new Response(result.body, {
        headers: {
          "content-type": "application/x-ndjson; charset=utf-8",
          "cache-control": "no-store",
          "x-accel-buffering": "no",
          "x-rakazo-process-id": result.id,
        },
      });
    } catch {
      return c.json(
        { error: "Unable to start isolated runtime. Check its image and computer authorization." },
        503,
      );
    }
  });
  routes.post("/:id/processes/:processId/input", async (c) => {
    const parsed = z
      .object({
        data: z
          .string()
          .max(MAX_INPUT_BYTES)
          .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_INPUT_BYTES)
          .optional(),
        close: z.boolean().optional(),
      })
      .strict()
      .safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: "Invalid runtime input." }, 400);
    try {
      const process = manager.get(
        c.req.param("processId"),
        identity(c.req.param("id"), c.req.raw.headers),
      );
      if (parsed.data.data !== undefined) await process.input(parsed.data.data);
      if (parsed.data.close) await process.closeInput();
      return c.json({ ok: true });
    } catch {
      return c.json({ error: "Runtime input unavailable." }, 404);
    }
  });
  routes.delete("/:id/processes/:processId", async (c) => {
    let running: RunningProcess;
    try {
      running = manager.get(
        c.req.param("processId"),
        identity(c.req.param("id"), c.req.raw.headers),
      );
    } catch {
      return c.json({ error: "Runtime process not found." }, 404);
    }
    try {
      await running.terminate();
      return c.json({ ok: true });
    } catch {
      return c.json({ error: "Runtime cleanup failed." }, 503);
    }
  });
  return routes;
}
