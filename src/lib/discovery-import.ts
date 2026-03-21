import type { ResolvedDealConfig } from "../config.js";
import type { DiscoveryCandidate, Watch } from "../types.js";
import type { ImportedWatchInput } from "./store.js";
import { canonicalizeWatchUrl } from "./url-policy.js";

export function buildDiscoveryImportPreview(args: {
  watch: Watch;
  candidates: DiscoveryCandidate[];
  existingWatches: Watch[];
  discoveryProvider: Exclude<ResolvedDealConfig["discovery"]["provider"], "off">;
  group?: string;
  addTags?: string[];
  enabled?: boolean;
}): Array<{
  candidate: DiscoveryCandidate;
  duplicateWatchId?: string;
  importable: boolean;
  watchInput?: ImportedWatchInput;
}> {
  const { watch, candidates, existingWatches, discoveryProvider, group, addTags, enabled } = args;
  const existingByUrl = new Map(existingWatches.map((entry) => [canonicalizeWatchUrl(entry.url).toString(), entry.id]));

  return candidates.map((candidate) => {
    const duplicateWatchId = existingByUrl.get(canonicalizeWatchUrl(candidate.url).toString());
    const importable = candidate.fetchStatus === "ok" && !duplicateWatchId && candidate.recommendedAction !== "likely_not_same_product";
    return {
      candidate,
      duplicateWatchId,
      importable,
      watchInput: importable
        ? {
            url: candidate.url,
            label: candidate.extractedTitle ?? watch.label,
            group: group ?? watch.group,
            tags: [...new Set([...(watch.tags ?? []), ...(addTags ?? [])])],
            maxPrice: watch.maxPrice,
            percentDrop: watch.percentDrop,
            keywords: watch.keywords,
            checkIntervalHint: watch.checkIntervalHint,
            enabled: enabled ?? watch.enabled,
            importSource: {
              type: "discovery",
              importedAt: new Date().toISOString(),
              discoveryProvider,
              sourceWatchId: watch.id,
              sourceWatchUrl: watch.url,
              sourceWatchLabel: watch.label,
              candidateUrl: candidate.url,
              searchQuery: candidate.searchQuery,
              searchRank: candidate.searchRank,
              searchTitle: candidate.searchTitle,
              searchDescription: candidate.searchDescription,
            },
            lastSnapshot: {
              title: candidate.extractedTitle,
              canonicalTitle: candidate.canonicalTitle,
              brand: candidate.brand,
              modelId: candidate.modelId,
              sku: candidate.sku,
              mpn: candidate.mpn,
              gtin: candidate.gtin,
              asin: candidate.asin,
              price: candidate.price,
              currency: candidate.currency,
              fetchedAt: new Date().toISOString(),
            },
          }
        : undefined,
    };
  });
}

export function describeDiscoveryPolicy(cfg: ResolvedDealConfig): {
  enabled: boolean;
  provider: string;
  maxSearchResults: number;
  maxFetches: number;
  allowedHosts?: string[];
  blockedHosts?: string[];
  timeoutMs: number;
  firecrawlConfigured: boolean;
  notes: string[];
} {
  const notes: string[] = [];
  if (!cfg.discovery.enabled || cfg.discovery.provider === "off") {
    notes.push("Discovery is disabled.");
  } else if (cfg.discovery.provider === "manual") {
    notes.push("Manual discovery only evaluates explicit candidate URLs you provide.");
  } else if (cfg.discovery.provider === "firecrawl-search") {
    notes.push("Provider-backed discovery search is enabled, but search remains bounded by explicit trusted hosts and fetch budgets.");
    if (!cfg.firecrawlApiKey) {
      notes.push("Firecrawl search is selected but firecrawlApiKey is not configured.");
    }
    if (!cfg.discovery.allowedHosts?.length) {
      notes.push("Provider-backed search should use explicit discovery.allowedHosts or per-call allowedHosts.");
    }
  }
  notes.push("Discovery candidates are never auto-imported.");
  notes.push("Fetched discovery URLs still pass the standard URL and redirect safety policy.");

  return {
    enabled: cfg.discovery.enabled,
    provider: cfg.discovery.provider,
    maxSearchResults: cfg.discovery.maxSearchResults,
    maxFetches: cfg.discovery.maxFetches,
    allowedHosts: cfg.discovery.allowedHosts,
    blockedHosts: cfg.discovery.blockedHosts,
    timeoutMs: cfg.discovery.timeoutMs,
    firecrawlConfigured: Boolean(cfg.firecrawlApiKey),
    notes,
  };
}
