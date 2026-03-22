import type { OpenClawPluginApi, OpenClawPluginConfigSchema } from "openclaw/plugin-sdk";
import { registerDealTools } from "./register-tools.js";

const configSchema: OpenClawPluginConfigSchema = {
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      storePath: { type: "string", description: "JSON store path (default ~/.openclaw/deal-hunter/store.json)." },
      maxConcurrent: { type: "integer", minimum: 1, maximum: 64 },
      maxBytesPerResponse: { type: "integer", minimum: 4096 },
      defaultMaxRpsPerHost: { type: "number", minimum: 0.1, maximum: 20 },
      requestTimeoutMs: { type: "integer", minimum: 1000 },
      userAgents: { type: "array", items: { type: "string" } },
      proxyUrl: { type: "string" },
      allowedHosts: { type: "array", items: { type: "string" }, description: "Optional allowlist of hostname patterns (exact host or *.suffix)." },
      blockedHosts: { type: "array", items: { type: "string" }, description: "Optional denylist of hostname patterns (exact host or *.suffix)." },
      fetcher: { enum: ["local", "firecrawl"] },
      firecrawlApiKey: { type: "string" },
      firecrawlBaseUrl: { type: "string" },
      llmReview: {
        type: "object",
        additionalProperties: false,
        properties: {
          mode: { enum: ["off", "queue", "auto_assist"] },
          lowConfidenceThreshold: { type: "number", minimum: 0, maximum: 100 },
          maxReviewsPerScan: { type: "integer", minimum: 0, maximum: 20 },
          allowPriceRewrite: { type: "boolean" },
          allowIdentityRewrite: { type: "boolean" },
          provider: { type: "string" },
          model: { type: "string" },
          timeoutMs: { type: "integer", minimum: 1000, maximum: 300000 },
        },
      },
      discovery: {
        type: "object",
        additionalProperties: false,
        properties: {
          enabled: { type: "boolean" },
          provider: { enum: ["off", "manual", "firecrawl-search"] },
          maxSearchResults: { type: "integer", minimum: 1, maximum: 20 },
          maxFetches: { type: "integer", minimum: 1, maximum: 25 },
          allowedHosts: { type: "array", items: { type: "string" } },
          blockedHosts: { type: "array", items: { type: "string" } },
          timeoutMs: { type: "integer", minimum: 1000, maximum: 300000 },
        },
      },
    },
  },
};

export default {
  id: "openclaw-deal-hunter",
  name: "Deal Hunter",
  description: "Price watches, conditional GET scans, and heuristic deal signals for OpenClaw.",
  version: "1.0.0",
  configSchema,
  register(api: OpenClawPluginApi) {
    registerDealTools(api);
  },
};
