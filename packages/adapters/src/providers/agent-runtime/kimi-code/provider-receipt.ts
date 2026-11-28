import type { IncomingMessage } from "node:http";
import { createKimiSseCompletionObserver } from "./provider-sse-completion.js";

interface ProviderBinding {
  readonly runId: string;
  readonly connectionId: string;
  readonly modelId: string;
}

interface ProviderRequest extends ProviderBinding {
  readonly method: string;
  readonly endpoint: string;
  readonly wireModel: string;
}

const completionError = () => new Error("Kimi provider response could not be verified.");

/**
 * Single attempt owned by one trusted egress instance, not shared by wire
 * model. The caller resolves the credential and pinned endpoint before
 * begin; these facts must not come from a child-supplied claim. This object
 * neither opens a connection nor vouches for the worker's right to publish.
 */
export function createKimiProviderReceipt(plan: ProviderRequest, signal: AbortSignal) {
  const { runId, connectionId, modelId, wireModel, endpoint, method } = plan;
  const binding = { runId, connectionId, modelId };
  let started = false;
  let responseStarted = false;
  let invalid = false;
  let verified = false;

  function discard() {
    invalid = true;
    verified = false;
  }

  // The forwarder must propagate relay failure and never send clean EOF until this completes.
  async function* relay(upstream: IncomingMessage): AsyncGenerator<Uint8Array> {
    const observer = createKimiSseCompletionObserver(wireModel);
    let complete = false;
    const stopReading = () => upstream.destroy();
    signal.addEventListener("abort", stopReading, { once: true });
    try {
      const mime = upstream.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
      const encoding = upstream.headers["content-encoding"]?.trim().toLowerCase();
      if (
        responseStarted ||
        invalid ||
        signal.aborted ||
        upstream.statusCode !== 200 ||
        mime !== "text/event-stream" ||
        (encoding !== undefined && encoding !== "identity") ||
        // A close-delimited HTTP/1.x body cannot distinguish EOF from truncation.
        (upstream.headers["transfer-encoding"]?.trim().toLowerCase() !== "chunked" &&
          upstream.headers["content-length"] === undefined)
      )
        throw completionError();
      responseStarted = true;
      for await (const chunk of upstream) {
        if (signal.aborted || invalid || !(chunk instanceof Uint8Array) || !observer.push(chunk))
          throw completionError();
        yield chunk;
      }
      if (signal.aborted || invalid || !upstream.complete || !observer.finish())
        throw completionError();
      complete = true;
      verified = true;
    } catch {
      throw completionError();
    } finally {
      signal.removeEventListener("abort", stopReading);
      if (!complete) {
        observer.discard();
        discard();
        upstream.destroy();
      }
    }
  }

  return {
    /** Reserve the only authorized attempt before dispatch, not on HTTP success. */
    begin(request: ProviderRequest): { relay: typeof relay } | undefined {
      if (
        started ||
        invalid ||
        signal.aborted ||
        !runId ||
        !connectionId ||
        !modelId ||
        !endpoint ||
        !wireModel ||
        method !== "POST" ||
        request.method !== method ||
        request.runId !== runId ||
        request.connectionId !== connectionId ||
        request.modelId !== modelId ||
        request.endpoint !== endpoint ||
        request.wireModel !== wireModel
      ) {
        discard();
        return;
      }
      started = true;
      return { relay };
    },
    /** Used by the launcher only after the forwarded body cleanly ends. */
    consume(): ProviderBinding | undefined {
      if (!verified || signal.aborted) return;
      verified = false;
      return binding;
    },
    discard,
  };
}
