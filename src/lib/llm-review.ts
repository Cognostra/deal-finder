import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { LlmReviewCandidate } from "../types.js";

function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? (match[1] ?? "").trim() : trimmed;
}

function collectText(payloads: Array<{ text?: string; isError?: boolean }> | undefined): string {
  return (payloads ?? [])
    .filter((payload) => !payload.isError && typeof payload.text === "string")
    .map((payload) => payload.text ?? "")
    .join("\n")
    .trim();
}

function resolvePreferredModel(api: OpenClawPluginApi): { provider?: string; model?: string } {
  const defaultsModel = api.config?.agents?.defaults?.model;
  const primary =
    typeof defaultsModel === "string"
      ? defaultsModel.trim()
      : (defaultsModel?.primary?.trim() ?? undefined);
  if (!primary) return {};
  return {
    provider: primary.split("/")[0],
    model: primary.split("/").slice(1).join("/"),
  };
}

export function parseJsonOnlyResponse(text: string): unknown {
  const raw = stripCodeFences(text);
  return JSON.parse(raw);
}

export async function runLlmReviewCandidate(
  api: OpenClawPluginApi,
  candidate: LlmReviewCandidate,
  options?: {
    provider?: string;
    model?: string;
    authProfileId?: string;
    temperature?: number;
    maxTokens?: number;
    timeoutMs?: number;
  },
): Promise<{
  provider: string;
  model: string;
  rawText: string;
  json: unknown;
}> {
  const preferred = resolvePreferredModel(api);
  const provider = options?.provider?.trim() || preferred.provider;
  const model = options?.model?.trim() || preferred.model;
  if (!provider || !model) {
    throw new Error("deal-hunter: provider/model could not be resolved for LLM review");
  }

  const inputJson = JSON.stringify(candidate.input ?? null, null, 2);
  const schemaJson = JSON.stringify(candidate.suggestedSchema ?? null, null, 2);
  const prompt = [
    "You are a JSON-only review function.",
    "Return ONLY valid JSON.",
    "Do not include markdown fences or commentary.",
    "",
    "TASK:",
    candidate.prompt,
    "",
    "INPUT_JSON:",
    inputJson,
    "",
    "SUGGESTED_SCHEMA_JSON:",
    schemaJson,
  ].join("\n");

  const runtimeAgent = (api.runtime as unknown as {
    agent?: {
      runEmbeddedPiAgent?: (params: Record<string, unknown>) => Promise<unknown>;
    };
  }).agent;
  if (!runtimeAgent?.runEmbeddedPiAgent) {
    throw new Error("deal-hunter: embedded OpenClaw agent runtime is not available");
  }

  const result = await runtimeAgent.runEmbeddedPiAgent({
    sessionId: `deal-hunter-llm-review-${Date.now()}`,
    sessionFile: undefined,
    workspaceDir: api.config?.agents?.defaults?.workspace ?? process.cwd(),
    config: api.config,
    prompt,
    timeoutMs: options?.timeoutMs ?? 30_000,
    runId: `deal-hunter-llm-review-${Date.now()}`,
    provider,
    model,
    authProfileId: options?.authProfileId?.trim() || undefined,
    authProfileIdSource: options?.authProfileId?.trim() ? "user" : "auto",
    streamParams: {
      temperature: options?.temperature,
      maxTokens: options?.maxTokens,
    },
    disableTools: true,
  });

  const rawText = collectText((result as { payloads?: Array<{ text?: string; isError?: boolean }> }).payloads);
  if (!rawText) {
    throw new Error("deal-hunter: LLM review returned empty output");
  }

  let json: unknown;
  try {
    json = parseJsonOnlyResponse(rawText);
  } catch {
    throw new Error("deal-hunter: LLM review returned invalid JSON");
  }

  return {
    provider,
    model,
    rawText,
    json,
  };
}
