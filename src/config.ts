import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { DealHunterPluginConfig } from "./types.js";
import { join } from "node:path";

const DEFAULT_UAS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
];

function normalizeHostPatterns(list?: string[]): string[] | undefined {
  if (!list?.length) return undefined;
  const out = [...new Set(list.map((item) => item.trim().toLowerCase()).filter(Boolean))];
  return out.length ? out : undefined;
}

export type ResolvedDealConfig = Required<
  Pick<
    DealHunterPluginConfig,
    | "maxConcurrent"
    | "maxBytesPerResponse"
    | "defaultMaxRpsPerHost"
    | "requestTimeoutMs"
    | "fetcher"
  >
> &
  DealHunterPluginConfig & {
    userAgents: string[];
    storePath: string;
  };

export function resolveDealConfig(api: OpenClawPluginApi): ResolvedDealConfig {
  const raw = (api.pluginConfig ?? {}) as DealHunterPluginConfig;
  const baseDir = api.resolvePath("~/.openclaw/deal-hunter");
  const defaultStore = join(baseDir, "store.json");

  return {
    storePath: raw.storePath ? api.resolvePath(raw.storePath) : defaultStore,
    maxConcurrent: raw.maxConcurrent ?? 8,
    maxBytesPerResponse: raw.maxBytesPerResponse ?? 1_048_576,
    defaultMaxRpsPerHost: raw.defaultMaxRpsPerHost ?? 1,
    requestTimeoutMs: raw.requestTimeoutMs ?? 25_000,
    userAgents: raw.userAgents?.length ? raw.userAgents : DEFAULT_UAS,
    proxyUrl: raw.proxyUrl,
    allowedHosts: normalizeHostPatterns(raw.allowedHosts),
    blockedHosts: normalizeHostPatterns(raw.blockedHosts),
    fetcher: raw.fetcher ?? "local",
    firecrawlApiKey: raw.firecrawlApiKey,
    firecrawlBaseUrl: raw.firecrawlBaseUrl ?? "https://api.firecrawl.dev",
  };
}
