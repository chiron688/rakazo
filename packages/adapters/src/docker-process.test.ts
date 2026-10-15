import type { ComputerRef, ProcessEvent } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DockerSandboxProvider } from "./docker-sandbox.js";

const computer: ComputerRef = {
  id: "computer",
  botId: "team",
  kind: "docker",
  providerRef: "computer",
};
const context = {
  operationId: "op",
  traceId: "trace",
  spaceId: "space",
  userId: "user",
  botId: "bot",
  runId: "run",
  signal: new AbortController().signal,
};
const request = { isolation: "primary-harness" as const, argv: ["node", "--version"] };
const headers = { "content-type": "application/x-ndjson", "x-rakazo-process-id": "process" };

afterEach(() => vi.unstubAllGlobals());

function mockTransport(body: ReadableStream<Uint8Array>) {
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (init?.method === "POST" && String(_url).endsWith("/processes"))
      return new Response(body, { headers });
    return Response.json({ ok: true });
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

describe("Docker bidirectional isolated runtime transport", () => {
  it("streams arbitrarily fragmented UTF-8 and carries server-bound identity on stdin and cleanup", async () => {
    const bytes = new TextEncoder().encode(
      `${JSON.stringify({ type: "stdout", data: "你好" })}\n${JSON.stringify({ type: "exit", code: 0 })}\n`,
    );
    const fetcher = mockTransport(
      new ReadableStream({
        start(controller) {
          for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
          controller.close();
        },
      }),
    );
    const provider = new DockerSandboxProvider("http://supervisor.test", "fake-token");
    const process = await provider.startProcess(computer, request, context);
    await process.writeStdin('{"request":1}\n');
    await process.closeStdin();
    const events: ProcessEvent[] = [];
    for await (const event of process.events) events.push(event);
    expect(events).toEqual([
      { type: "stdout", data: "你好" },
      { type: "exit", code: 0 },
    ]);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "http://supervisor.test/computers/computer/processes",
      "http://supervisor.test/computers/computer/processes/process/input",
      "http://supervisor.test/computers/computer/processes/process/input",
      "http://supervisor.test/computers/computer/processes/process",
    ]);
    for (const [, init] of fetcher.mock.calls)
      expect(init?.headers).toMatchObject({
        "x-rakazo-bot-id": "team",
        "x-rakazo-runtime-bot-id": "bot",
        "x-rakazo-runtime-user-id": "user",
        "x-rakazo-run-id": "run",
        "x-rakazo-space-id": "space",
      });
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({
      data: '{"request":1}\n',
    });
    expect(JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body))).toEqual({ close: true });
  });

  it("unblocks a pending read and uses a fresh cleanup signal after cancellation", async () => {
    const canceled = vi.fn();
    const fetcher = mockTransport(new ReadableStream({ cancel: canceled }));
    const abort = new AbortController();
    const process = await new DockerSandboxProvider(
      "http://supervisor.test",
      "fake-token",
    ).startProcess(computer, request, { ...context, signal: abort.signal });
    const iterator = process.events[Symbol.asyncIterator]();
    const pending = iterator.next();
    abort.abort(new Error("test canceled"));
    await expect(pending).rejects.toThrow("test canceled");
    await process.terminate();
    const deletes = fetcher.mock.calls.filter(([, init]) => init?.method === "DELETE");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.[1]?.signal?.aborted).toBe(false);
    expect(canceled).toHaveBeenCalledOnce();
    await expect(process.writeStdin("late")).rejects.toThrow(/closed/);
  });

  it.each(["broken JSON\n", '{"type":"ready"}\n', '{"type":"stdout","data":"partial"}\n'])(
    "fails interrupted or malformed streams instead of inventing success: %s",
    async (output) => {
      const fetcher = mockTransport(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(output));
            controller.close();
          },
        }),
      );
      const process = await new DockerSandboxProvider(
        "http://supervisor.test",
        "fake-token",
      ).startProcess(computer, request, context);
      await expect(
        (async () => {
          for await (const _ of process.events) {
          }
        })(),
      ).rejects.toThrow();
      expect(fetcher.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true);
    },
  );

  it("never launches on a desktop or without complete run identity", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const provider = new DockerSandboxProvider("http://supervisor.test", "fake-token");
    await expect(
      provider.startProcess({ ...computer, kind: "desktop" }, request, context),
    ).rejects.toThrow(/Docker/);
    await expect(
      provider.startProcess(computer, request, { ...context, runId: undefined }),
    ).rejects.toThrow(/identity/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("removes the isolated process when the event consumer returns early", async () => {
    const fetcher = mockTransport(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"type":"stdout","data":"hello"}\n'));
        },
      }),
    );
    const process = await new DockerSandboxProvider(
      "http://supervisor.test",
      "fake-token",
    ).startProcess(computer, request, context);
    for await (const _ of process.events) break;
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
  });
  it("bounds UTF-8 input and queued media bytes before issuing HTTP requests", async () => {
    let release!: () => void;
    const stalled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetcher = mockTransport(new ReadableStream());
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (url, init) => {
      if (String(url).endsWith("/input")) await stalled;
      return original(url, init);
    });
    const process = await new DockerSandboxProvider(
      "http://supervisor.test",
      "fake-token",
    ).startProcess(computer, request, context);
    await expect(process.writeStdin("界".repeat(6 * 1024 * 1024))).rejects.toThrow(/limit/);
    const input = "x".repeat(12 * 1024 * 1024);
    const one = process.writeStdin(input);
    const two = process.writeStdin(input);
    await expect(process.writeStdin(input)).rejects.toThrow(/queue/);
    release();
    await Promise.all([one, two]);
    await process.writeStdin("released");
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/input"))).toHaveLength(3);
    await process.terminate();
  });
});
