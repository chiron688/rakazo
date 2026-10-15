import type {
  AgentRunModel,
  AgentRunRequest,
  AgentRuntimeEvent,
  SecretStore,
} from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { parseModelSecret, secretValuesToRedact } from "./pi-oauth.js";
import { modelsForRequest } from "./pi-runtime.js";

/** A profile is an explicit account choice. Never consult deployment or default credentials. */
export async function resolveProfileModel(
  deps: { prisma: PrismaClient; secretStore: SecretStore },
  scope: { userId: string },
  profile: { provider: string; modelId: string; endpoint: string | null },
  credential: { id: string; secretId: string; userId: string },
): Promise<{ model: AgentRunModel; redact: string[] }> {
  if (credential.userId !== scope.userId)
    throw new Error("Execution profile account is not authorized");
  const row = await deps.prisma.secret.findFirst({
    where: { id: credential.secretId, userId: scope.userId, spaceId: null },
  });
  if (!row) throw new Error("Execution profile account is no longer available");
  const secret = parseModelSecret(await deps.secretStore.load(row.ciphertext, row.id));
  if (secret.kind === "oauth") {
    throw new Error(
      "This harness requires an API-key connection; subscription login is not supported",
    );
  }
  const apiKey = secret.kind === "api_key" ? secret.key : secret.apiKey;
  if (!apiKey?.trim()) throw new Error("Execution profile account has no API key");
  return {
    model: {
      provider: profile.provider,
      id: profile.modelId,
      apiKey,
      baseUrl:
        profile.endpoint ?? (secret.kind === "openai_compatible" ? secret.baseUrl : undefined),
      maxTokens: secret.maxTokens,
    },
    redact: secretValuesToRedact(secret),
  };
}

/** An unexpected EOF is an interruption, never a successful native turn. */
export async function* requireRuntimeCompletion(
  events: AsyncIterable<AgentRuntimeEvent>,
): AsyncIterable<AgentRuntimeEvent> {
  let completed = false;
  for await (const event of events) {
    if (completed) throw new Error("Harness emitted an event after its terminal result");
    if (event.type === "done") completed = true;
    yield event;
  }
  if (!completed)
    throw new Error(
      "Harness interrupted before a terminal result; uncertain actions were not replayed",
    );
}

/** Other group members' output is context, not this bot's previous assistant response. */
export function profileHistoryMessage(
  message: { role: string; botId?: string | null },
  selfBotId: string,
  content: string,
): Pick<AgentRunRequest["history"][number], "role" | "content"> {
  if (message.role === "user" || message.role === "system") return { role: message.role, content };
  if (message.botId && message.botId !== selfBotId) {
    return { role: "user", content: `[Message from bot ${message.botId}]\n${content}` };
  }
  return { role: "assistant", content };
}

/** Validate Pi's actual driver, rather than accepting a decorative protocol setting. */
export function validatePiProfileModel(
  model: AgentRunModel,
  protocol: string,
  endpoint: string | null,
): void {
  if (endpoint && model.provider !== "openai-compatible") {
    throw new Error("Pi endpoint overrides require an OpenAI-compatible connection");
  }
  const configured = modelsForRequest({ model }, model.provider).getModel(model.provider, model.id);
  if (!configured)
    throw new Error("The execution profile model is unavailable for its exact provider");
  const actual =
    configured.api === "anthropic-messages"
      ? "anthropic"
      : configured.api === "openai-responses"
        ? "openai-responses"
        : configured.api === "openai-completions"
          ? "openai-chat-completions"
          : undefined;
  if (actual !== protocol)
    throw new Error("The execution profile protocol does not match the Pi model driver");
}
