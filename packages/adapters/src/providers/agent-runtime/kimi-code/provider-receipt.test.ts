import { once } from "node:events";
import type { IncomingMessage } from "node:http";
import { Agent, get } from "node:http";
import type { Socket } from "node:net";
import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { createKimiProviderReceipt } from "./provider-receipt.js";

const plan = {
  runId: "run-one",
  connectionId: "connection-one",
  modelId: "internal-model",
  method: "POST",
  endpoint: "https://provider.invalid/coding/v1/chat/completions",
  wireModel: "wire-model",
};

const base = { model: plan.wireModel, id: "response", object: "chat.completion.chunk" };
const frame = (delta: object, finish_reason: null | "stop") =>
  `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
const body = `${frame({ content: "answer" }, null)}${frame({}, "stop")}data: [DONE]\n\n`;

async function withFixture(
  run: (
    request: (path: string) => Promise<IncomingMessage>,
    cleanSocket: () => Socket,
  ) => Promise<void>,
) {
  const sockets = new Set<Socket>();
  let kept: Socket | undefined;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.once("data", (request) => {
      const path = request.toString().split(" ")[1];
      const status = path === "/quota" ? 429 : 200;
      const mime = path === "/json" ? "application/json" : "text/event-stream; charset=utf-8";
      const header = `HTTP/1.1 ${status} Reply\r\nContent-Type: ${mime}\r\n`;
      if (path === "/unframed") {
        socket.end(`${header}Connection: close\r\n\r\n${body}`);
        return;
      }
      const bytes = `${header}Transfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n${Buffer.byteLength(body).toString(16)}\r\n${body}\r\n`;
      if (path === "/truncated") {
        // The entire SSE is present, but the HTTP zero chunk is missing.
        socket.end(bytes);
        return;
      }
      if (path === "/paused") {
        socket.write(bytes);
        return;
      }
      kept = socket;
      socket.write(`${bytes}0\r\n\r\n`);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  const agent = new Agent({ keepAlive: true });
  try {
    await run(
      async (path) => {
        const req = get({
          agent,
          host: "127.0.0.1",
          port: address.port,
          path,
          signal: AbortSignal.timeout(3_000),
        });
        const [res] = await once(req, "response");
        return res;
      },
      () => kept!,
    );
  } finally {
    agent.destroy();
    for (const socket of sockets) socket.destroy();
    const closed = once(server, "close");
    server.close();
    await closed;
  }
}

async function read(body: AsyncIterable<Uint8Array>) {
  const parts: Uint8Array[] = [];
  for await (const chunk of body) parts.push(chunk);
  return Buffer.concat(parts).toString();
}

describe("Kimi provider receipt", () => {
  it("certifies a complete HTTP body without waiting for the keep-alive socket to close", async () => {
    await withFixture(async (request, socket) => {
      const receipt = createKimiProviderReceipt(plan, new AbortController().signal);
      const attempt = receipt.begin(plan)!;
      expect(await read(attempt.relay(await request("/complete")))).toBe(body);
      expect(socket().destroyed).toBe(false);
      expect(receipt.consume()).toEqual({
        runId: plan.runId,
        connectionId: plan.connectionId,
        modelId: plan.modelId,
      });
      expect(receipt.consume()).toBeUndefined();
    });
  });

  it("keeps same-model concurrent success and physical truncation separate", async () => {
    await withFixture(async (request) => {
      const other = { ...plan, runId: "run-two", connectionId: "connection-two" };
      const a = createKimiProviderReceipt(plan, new AbortController().signal);
      const b = createKimiProviderReceipt(other, new AbortController().signal);
      const one = a.begin(plan)!;
      const two = b.begin(other)!;
      const [ra, rb] = await Promise.all([request("/complete"), request("/truncated")]);
      const results = await Promise.allSettled([read(one.relay(ra)), read(two.relay(rb))]);
      expect(results[0]).toEqual({ status: "fulfilled", value: body });
      expect(results[1]).toMatchObject({ status: "rejected" });
      expect(rb.complete).toBe(false);
      expect(b.consume()).toBeUndefined();
      expect(a.consume()).toMatchObject({ runId: plan.runId, connectionId: plan.connectionId });
    });
  });

  it.each(["/quota", "/json", "/unframed"])("does not certify %s", async (path) => {
    await withFixture(async (request) => {
      const receipt = createKimiProviderReceipt(plan, new AbortController().signal);
      await expect(read(receipt.begin(plan)!.relay(await request(path)))).rejects.toThrow(
        "could not be verified",
      );
      expect(receipt.consume()).toBeUndefined();
    });
  });

  it.each(["runId", "connectionId", "modelId", "method", "endpoint", "wireModel"] as const)(
    "does not recover from a mismatched %s",
    (field) => {
      const receipt = createKimiProviderReceipt(plan, new AbortController().signal);
      expect(receipt.begin({ ...plan, [field]: "mismatch" })).toBeUndefined();
      expect(receipt.begin(plan)).toBeUndefined();
    },
  );

  it("invalidates an otherwise valid receipt on a duplicate attempt before consumption", async () => {
    await withFixture(async (request) => {
      const receipt = createKimiProviderReceipt(plan, new AbortController().signal);
      await read(receipt.begin(plan)!.relay(await request("/complete")));
      expect(receipt.begin(plan)).toBeUndefined();
      expect(receipt.consume()).toBeUndefined();
    });
  });

  it("destroys the upstream response when cancelled during an incomplete body", async () => {
    await withFixture(async (request) => {
      const controller = new AbortController();
      const receipt = createKimiProviderReceipt(plan, controller.signal);
      const upstream = await request("/paused");
      const iterator = receipt.begin(plan)!.relay(upstream);
      await expect(iterator.next()).resolves.toMatchObject({ done: false });
      controller.abort();
      await expect(iterator.next()).rejects.toThrow("could not be verified");
      expect(upstream.destroyed).toBe(true);
      expect(receipt.consume()).toBeUndefined();
    });
  });

  it("withholds a verified receipt after cancellation", async () => {
    await withFixture(async (request) => {
      const controller = new AbortController();
      const receipt = createKimiProviderReceipt(plan, controller.signal);
      await read(receipt.begin(plan)!.relay(await request("/complete")));
      controller.abort();
      expect(receipt.consume()).toBeUndefined();
    });
  });
});
