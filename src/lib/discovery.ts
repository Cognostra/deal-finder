import type { ResolvedDealConfig } from "../config.js";
import type { DiscoveryCandidate, Watch } from "../types.js";
import { searchViaFirecrawl } from "./firecrawl.js";
import type { ImportedWatchInput } from "./store.js";
import { cappedFetch } from "./fetch.js";
import { debugExtractListing } from "./heuristics.js";
import { buildExternalProductMatchCandidate, getWatchHost, getWatchIdentityFields } from "./product-identity.js";
import { canonicalizeWatchUrl, validateTargetUrl } from "./url-policy.js";

type SearchSeed = {
  url: string;
  searchQuery?: string;
  searchRank?: number;
  searchTitle?: string;
  searchDescription?: string;
};

function buildDiscoveryConfig(cfg: ResolvedDealConfig): ResolvedDealConfig {
  const allowedHosts = cfg.discovery.allowedHosts ?? cfg.allowedHosts;
  const blockedHosts = cfg.discovery.blockedHosts ?? cfg.blockedHosts;
  return {
    ...cfg,
    allowedHosts,
    blockedHosts,
    requestTimeoutMs: cfg.discovery.timeoutMs,
  };
}

export function normalizeDiscoveryUrls(urls: string[], cfg: ResolvedDealConfig): string[] {
  const discoveryCfg = buildDiscoveryConfig(cfg);
  return [...new Set(
    urls
      .slice(0, cfg.discovery.maxFetches)
      .map((url) => canonicalizeWatchUrl(validateTargetUrl(url, discoveryCfg).toString(), discoveryCfg).toString()),
  )];
}

export function buildDiscoverySearchQuery(watch: Watch, queryHints?: string[]): string {
  const snapshot = watch.lastSnapshot;
  const tokens: string[] = [];
  if (snapshot?.brand) tokens.push(snapshot.brand);
  const strongIdentity = getWatchIdentityFields(watch)
    .filter((entry) => entry.field !== "brand")
    .map((entry) => entry.value);
  tokens.push(...strongIdentity.slice(0, 3));
  if (snapshot?.title) tokens.push(snapshot.title);
  if (snapshot?.canonicalTitle && !snapshot.title) tokens.push(snapshot.canonicalTitle);
  if (queryHints?.length) tokens.push(...queryHints);
  return [...new Set(tokens.map((token) => token.trim()).filter(Boolean))].join(" ");
}

function resolveConcreteDiscoveryHosts(hosts: string[]): { hosts: string[]; skippedHosts: string[] } {
  const seen = new Set<string>();
  const concrete: string[] = [];
  const skippedHosts: string[] = [];
  for (const host of hosts.map((entry) => entry.trim().toLowerCase()).filter(Boolean)) {
    if (seen.has(host)) continue;
    seen.add(host);
    if (host.includes("*")) {
      skippedHosts.push(host);
      continue;
    }
    concrete.push(host);
  }
  return { hosts: concrete, skippedHosts };
}

export async function searchDiscoveryCandidates(args: {
  watch: Watch;
  cfg: ResolvedDealConfig;
  allowedHosts?: string[];
  maxSearchResults?: number;
  queryHints?: string[];
  signal?: AbortSignal;
}): Promise<{
  provider: string;
  query: string;
  searchHosts: string[];
  skippedHosts: string[];
  results: SearchSeed[];
  skippedResults: Array<{ url: string; reason: string }>;
}> {
  const { watch, cfg, signal } = args;
  if (cfg.discovery.provider !== "firecrawl-search") {
    throw new Error('deal-hunter: discovery search requires discovery.provider="firecrawl-search"');
  }
  const configuredHosts = args.allowedHosts?.length ? args.allowedHosts : cfg.discovery.allowedHosts;
  if (!configuredHosts?.length) {
    throw new Error("deal-hunter: discovery search requires explicit allowedHosts");
  }
  const { hosts: searchHosts, skippedHosts } = resolveConcreteDiscoveryHosts(configuredHosts);
  if (!searchHosts.length) {
    throw new Error("deal-hunter: discovery search requires at least one concrete allowed host");
  }
  const query = buildDiscoverySearchQuery(watch, args.queryHints);
  const perHostLimit = Math.max(1, Math.min(args.maxSearchResults ?? cfg.discovery.maxSearchResults, cfg.discovery.maxSearchResults));
  const skippedResults: Array<{ url: string; reason: string }> = [];
  const deduped = new Map<string, SearchSeed>();

  for (const host of searchHosts) {
    const searchQuery = `${query} site:${host}`;
    const search = await searchViaFirecrawl({
      query: searchQuery,
      cfg,
      limit: perHostLimit,
      signal,
    });
    if (!search.ok) {
      throw new Error(search.error ?? "Firecrawl discovery search failed");
    }
    for (const [index, result] of search.results.entries()) {
      try {
        const normalized = canonicalizeWatchUrl(validateTargetUrl(result.url, buildDiscoveryConfig(cfg)).toString(), buildDiscoveryConfig(cfg)).toString();
        if (getWatchHost(normalized) !== host) {
          skippedResults.push({ url: result.url, reason: `search result host ${getWatchHost(result.url)} did not match requested host ${host}` });
          continue;
        }
        if (!deduped.has(normalized)) {
          deduped.set(normalized, {
            url: normalized,
            searchQuery,
            searchRank: index + 1,
            searchTitle: result.title,
            searchDescription: result.description,
          });
        }
      } catch (error) {
        skippedResults.push({
          url: result.url,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return {
    provider: cfg.discovery.provider,
    query,
    searchHosts,
    skippedHosts,
    results: [...deduped.values()].slice(0, cfg.discovery.maxFetches),
    skippedResults,
  };
}

export async function fetchDiscoveryCandidates(args: {
  watch: Watch;
  candidateUrls?: string[];
  searchSeeds?: SearchSeed[];
  cfg: ResolvedDealConfig;
  signal?: AbortSignal;
  includeLooseTitleFallback?: boolean;
}): Promise<DiscoveryCandidate[]> {
  const { watch, candidateUrls, searchSeeds, cfg, signal, includeLooseTitleFallback } = args;
  const discoveryCfg = buildDiscoveryConfig(cfg);
  const normalizedUrls: SearchSeed[] = searchSeeds?.length
    ? searchSeeds.slice(0, cfg.discovery.maxFetches)
    : normalizeDiscoveryUrls(candidateUrls ?? [], cfg).map((url) => ({ url }));

  return Promise.all(
    normalizedUrls.map(async (seed) => {
      const url = seed.url;
      try {
        const { text } = await cappedFetch(url, discoveryCfg, { signal });
        const { extracted } = debugExtractListing(text, 4000);
        const match = buildExternalProductMatchCandidate(
          watch,
          { url, extracted },
          { includeLooseTitleFallback },
        );
        return {
          url,
          host: getWatchHost(url),
          sourceWatchId: watch.id,
          searchQuery: seed.searchQuery,
          searchRank: seed.searchRank,
          searchTitle: seed.searchTitle,
          searchDescription: seed.searchDescription,
          matchScore: match?.matchScore,
          matchStrength: match?.matchStrength,
          matchedFields: match?.sharedFields ?? [],
          conflictingFields: match?.conflictingFields ?? [],
          matchReasons: match?.matchReasons ?? [],
          matchWarnings: match?.matchWarnings ?? [],
          extractedTitle: extracted.title,
          canonicalTitle: extracted.canonicalTitle,
          brand: extracted.brand,
          modelId: extracted.modelId,
          sku: extracted.sku,
          mpn: extracted.mpn,
          gtin: extracted.gtin,
          asin: extracted.asin,
          price: extracted.price,
          currency: extracted.currency,
          fetchStatus: "ok",
          recommendedAction:
            match?.matchStrength === "high"
              ? "strong_candidate_for_import"
              : match?.matchStrength === "medium"
                ? "review_before_import"
                : "likely_not_same_product",
        } satisfies DiscoveryCandidate;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          url,
          host: getWatchHost(url),
          sourceWatchId: watch.id,
          searchQuery: seed.searchQuery,
          searchRank: seed.searchRank,
          searchTitle: seed.searchTitle,
          searchDescription: seed.searchDescription,
          matchedFields: [],
          conflictingFields: [],
          matchReasons: [],
          matchWarnings: [],
          fetchStatus: message.includes("blocked") || message.includes("allow") || message.includes("private")
            ? "blocked"
            : "failed",
          blockedReason: message,
          recommendedAction: "blocked_or_failed",
        } satisfies DiscoveryCandidate;
      }
    }),
  );
}

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
