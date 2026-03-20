import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { LlmReviewCandidate } from "../types.js";
import { parseJsonOnlyResponse, runLlmReviewCandidate } from "./llm-review.js";

const candidate: LlmReviewCandidate = {
  watchId: "watch-1",
  label: "Test Watch",
  url: "https://example.com/p/1",
  type: "extraction_review",
  priority: "high",
  reasons: ["Needs review."],
  currentSnapshot: null,
  prompt: "Return JSON only.",
  input: { url: "https://example.com/p/1" },
  suggestedSchema: {
    type: "object",
    properties: {
      title: { type: "string" },
    },
    required: ["title"],
  },
};

describe("parseJsonOnlyResponse", () => {
  it("parses fenced JSON payloads", () => {
    expect(parseJsonOnlyResponse("```json\n{\"ok\":true}\n```")).toEqual({ ok: true });
  });
});

describe("runLlmReviewCandidate", () => {
  it("runs the embedded agent and parses JSON output", async () => {
    const runEmbeddedPiAgent = vi.fn().mockResolvedValue({
      payloads: [{ text: "{\"title\":\"Widget\"}" }],
    });

    const api = {
      config: {
        agents: {
          defaults: {
            model: "openai-codex/gpt-5.3-codex-spark",
            workspace: "/tmp",
          },
        },
      },
      runtime: {
        agent: {
          runEmbeddedPiAgent,
        },
      },
    } as unknown as OpenClawPluginApi;

    const result = await runLlmReviewCandidate(api, candidate);
    expect(runEmbeddedPiAgent).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      provider: "openai-codex",
      model: "gpt-5.3-codex-spark",
      json: { title: "Widget" },
    });
  });
});
