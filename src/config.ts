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
    llmReview: {
      mode: NonNullable<NonNullable<DealHunterPluginConfig["llmReview"]>["mode"]>;
      lowConfidenceThreshold: number;
      maxReviewsPerScan: number;
      allowPriceRewrite: boolean;
      allowIdentityRewrite: boolean;
      provider?: string;
      model?: string;
      timeoutMs: number;
    };
    discovery: {
      enabled: boolean;
      provider: NonNullable<NonNullable<DealHunterPluginConfig["discovery"]>["provider"]>;
      maxSearchResults: number;
      maxFetches: number;
      allowedHosts?: string[];
      blockedHosts?: string[];
      timeoutMs: number;
    };
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
    llmReview: {
      mode: raw.llmReview?.mode ?? "off",
      lowConfidenceThreshold: Math.max(0, Math.min(100, raw.llmReview?.lowConfidenceThreshold ?? 45)),
      maxReviewsPerScan: Math.max(0, raw.llmReview?.maxReviewsPerScan ?? 3),
      allowPriceRewrite: raw.llmReview?.allowPriceRewrite ?? false,
      allowIdentityRewrite: raw.llmReview?.allowIdentityRewrite ?? true,
      provider: raw.llmReview?.provider?.trim() || undefined,
      model: raw.llmReview?.model?.trim() || undefined,
      timeoutMs: raw.llmReview?.timeoutMs ?? 30_000,
    },
    discovery: {
      enabled: raw.discovery?.enabled ?? false,
      provider: raw.discovery?.provider ?? "off",
      maxSearchResults: Math.max(1, raw.discovery?.maxSearchResults ?? 5),
      maxFetches: Math.max(1, raw.discovery?.maxFetches ?? 5),
      allowedHosts: normalizeHostPatterns(raw.discovery?.allowedHosts),
      blockedHosts: normalizeHostPatterns(raw.discovery?.blockedHosts),
      timeoutMs: raw.discovery?.timeoutMs ?? 25_000,
    },
  };
}
