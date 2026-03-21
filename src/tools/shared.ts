import { jsonResult } from "openclaw/plugin-sdk";
import { resolveDealConfig } from "../config.js";
import { buildDiscoveryImportPreview, fetchDiscoveryCandidates, searchDiscoveryCandidates } from "../lib/discovery.js";
import { runScan } from "../lib/engine.js";
import type { loadStore } from "../lib/store.js";
import { getSavedView } from "../lib/store.js";
import { buildWatchSignals } from "../lib/watch-view.js";
import { searchWatches } from "../lib/watch-view.js";
import { canonicalizeWatchUrl } from "../lib/url-policy.js";

export type LoadedStore = Awaited<ReturnType<typeof loadStore>>;
export type LoadedWatch = LoadedStore["watches"][number];
export type WithStore = <T>(fn: (store: LoadedStore) => Promise<T>) => Promise<T>;

export type ToolContext = {
  storePath: string;
  withStore: WithStore;
};

export function toWatchView(watch: LoadedWatch) {
  const signals = buildWatchSignals(watch);
  const prices = (watch.history ?? [])
    .map((entry) => entry.price)
    .filter((price): price is number => price != null);
  return {
    ...watch,
    canonicalUrl: canonicalizeWatchUrl(watch.url).toString(),
    currentPrice: watch.lastSnapshot?.price,
    currentCurrency: watch.lastSnapshot?.currency,
    lastFetchedAt: watch.lastSnapshot?.fetchedAt,
    historyCount: watch.history?.length ?? 0,
    importSource: watch.importSource,
    lowestSeenPrice: prices.length ? Math.min(...prices) : watch.lastSnapshot?.price,
    highestSeenPrice: prices.length ? Math.max(...prices) : watch.lastSnapshot?.price,
    signalCount: signals.length,
    signals,
  };
}

export function buildScanSummary(results: Awaited<ReturnType<typeof runScan>>) {
  const summary = {
    ok: 0,
    failed: 0,
    changed: 0,
    alerted: 0,
    highPriority: 0,
    lowConfidence: 0,
    unchanged: 0,
    truncatedResponses: 0,
    reviewQueued: 0,
    reviewApplied: 0,
  };
  const reviewWarnings = new Set<string>();

  for (const result of results) {
    if (result.ok) summary.ok += 1;
    else summary.failed += 1;
    if (result.changed) summary.changed += 1;
    if (result.alertSeverity !== "none") summary.alerted += 1;
    if (result.alertSeverity === "high") summary.highPriority += 1;
    if (result.extractionConfidence.level === "low" || result.extractionConfidence.level === "none") {
      summary.lowConfidence += 1;
    }
    if (!result.changed && result.ok) summary.unchanged += 1;
    if (result.responseTruncated) summary.truncatedResponses += 1;
    if (result.reviewQueued) summary.reviewQueued += 1;
    if (result.reviewApplied) summary.reviewApplied += 1;
    for (const warning of result.reviewWarnings) reviewWarnings.add(warning);
  }

  const rankedAlerts = results
    .filter((result) => result.alertSeverity !== "none")
    .sort((a, b) => b.alertScore - a.alertScore || a.timingMs.total - b.timingMs.total)
    .map((result) => ({
      watchId: result.watchId,
      label: result.label,
      url: result.url,
      fetchSource: result.fetchSource,
      fetchSourceNote: result.fetchSourceNote,
      responseTruncated: result.responseTruncated,
      changeType: result.changeType,
      alertSeverity: result.alertSeverity,
      alertScore: result.alertScore,
      summaryLine: result.summaryLine,
      alerts: result.alerts,
      previousPrice: result.previousPrice,
      currentPrice: result.currentPrice,
      priceDelta: result.priceDelta,
      percentDelta: result.percentDelta,
      extractionConfidence: result.extractionConfidence,
    }));

  return { summary, rankedAlerts, reviewWarnings: [...reviewWarnings] };
}

export function toSavedViewSummary(store: LoadedStore, view: LoadedStore["savedViews"][number]) {
  const matches = searchWatches(store.watches, view.selector);
  const watchIds = matches.map((watch) => watch.id).slice(0, 20);
  return {
    ...view,
    matchCount: matches.length,
    previewWatchIds: watchIds,
  };
}

export function buildScopedStore(store: LoadedStore, watches: LoadedStore["watches"]): LoadedStore {
  return {
    version: store.version,
    savedViews: store.savedViews,
    watches,
  };
}

export function ensureDiscoveryEnabled(cfg: ReturnType<typeof resolveDealConfig>) {
  if (!cfg.discovery.enabled || cfg.discovery.provider === "off") {
    throw new Error("deal-hunter: discovery is disabled; set discovery.enabled=true and choose a discovery provider to use discovery workflows");
  }
}

export function ensureProviderDiscoveryEnabled(cfg: ReturnType<typeof resolveDealConfig>) {
  ensureDiscoveryEnabled(cfg);
  if (cfg.discovery.provider !== "firecrawl-search") {
    throw new Error('deal-hunter: discovery search requires discovery.provider="firecrawl-search"');
  }
}

export function getActiveDiscoveryProvider(cfg: ReturnType<typeof resolveDealConfig>): "manual" | "firecrawl-search" {
  ensureDiscoveryEnabled(cfg);
  if (cfg.discovery.provider === "off") {
    throw new Error("deal-hunter: discovery provider is off");
  }
  return cfg.discovery.provider;
}

export function resolveSavedViewSelection(store: LoadedStore, savedViewId: string) {
  const savedView = getSavedView(store, savedViewId);
  if (!savedView) {
    throw new Error(`deal-hunter: unknown saved view "${savedViewId}"`);
  }
  const watches = searchWatches(store.watches, savedView.selector);
  return {
    savedView,
    summary: toSavedViewSummary(store, savedView),
    watches,
    watchIds: watches.map((watch) => watch.id),
  };
}

export function watchNotFoundResult() {
  return jsonResult({ ok: false, error: "watch not found" });
}

export function toDiscoveryAnchor(watch: LoadedWatch) {
  return {
    watchId: watch.id,
    label: watch.label,
    url: watch.url,
    snapshot: watch.lastSnapshot,
  };
}

export async function buildDiscoveryWorkflow(args: {
  watch: LoadedWatch;
  store: LoadedStore;
  cfg: ReturnType<typeof resolveDealConfig>;
  signal?: AbortSignal;
  candidateUrls?: string[];
  allowedHosts?: string[];
  maxSearchResults?: number;
  queryHints?: string[];
  includeLooseTitleFallback?: boolean;
  group?: string;
  addTags?: string[];
  enabled?: boolean;
}) {
  const { watch, store, cfg, signal } = args;
  const search = (!args.candidateUrls || args.candidateUrls.length === 0) && cfg.discovery.provider === "firecrawl-search"
    ? await searchDiscoveryCandidates({
        watch,
        cfg,
        allowedHosts: args.allowedHosts,
        maxSearchResults: args.maxSearchResults,
        queryHints: args.queryHints,
        signal,
      })
    : null;
  const candidates = await fetchDiscoveryCandidates({
    watch,
    candidateUrls: args.candidateUrls,
    searchSeeds: search?.results,
    cfg,
    signal,
    includeLooseTitleFallback: args.includeLooseTitleFallback,
  });
  const importPreview = buildDiscoveryImportPreview({
    watch,
    candidates,
    existingWatches: store.watches,
    discoveryProvider: getActiveDiscoveryProvider(cfg),
    group: args.group,
    addTags: args.addTags,
    enabled: args.enabled,
  });
  return { search, candidates, importPreview };
}

export function buildDiscoveryFetchSummary(candidates: Awaited<ReturnType<typeof fetchDiscoveryCandidates>>) {
  return {
    candidateCount: candidates.length,
    okCount: candidates.filter((candidate) => candidate.fetchStatus === "ok").length,
    blockedOrFailedCount: candidates.filter((candidate) => candidate.fetchStatus !== "ok").length,
    strongMatchCount: candidates.filter((candidate) => candidate.matchStrength === "high").length,
    reviewCount: candidates.filter((candidate) => candidate.recommendedAction === "review_before_import").length,
    weakOrRejectedCount: candidates.filter((candidate) => candidate.recommendedAction === "likely_not_same_product").length,
  };
}
