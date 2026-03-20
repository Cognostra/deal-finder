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
    },
  },
};

export default {
  id: "openclaw-deal-hunter",
  name: "Deal Hunter",
  description: "Price watches, conditional GET scans, and heuristic deal signals for OpenClaw.",
  version: "0.4.0",
  configSchema,
  register(api: OpenClawPluginApi) {
    registerDealTools(api);
  },
};
