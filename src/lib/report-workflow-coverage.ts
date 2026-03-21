import type { StoreFile, Watch, WatchHistoryEntry } from "../types.js";
import { getWatchIdentityFields } from "./product-identity.js";
import { buildAlertsSummary, buildStoreReport, buildTopDropsSummary, buildTrendsSummary } from "./report-history.js";
import { canonicalizeWatchUrl } from "./url-policy.js";

function getHistoryEntries(watch: Watch): WatchHistoryEntry[] {
  return watch.history ?? [];
}

function buildExtractionCoverage(
  watch: Watch,
): {
  level: "none" | "low" | "medium" | "high";
  score: number;
  reasons: string[];
} {
  const snapshot = watch.lastSnapshot;
  if (!snapshot) {
    return {
      level: "none",
      score: 0,
      reasons: ["No committed snapshot is stored yet."],
    };
  }

  const reasons: string[] = [];
  let score = 0;
  if (snapshot.title || snapshot.canonicalTitle) {
    score += 35;
  } else {
    reasons.push("Missing extracted title.");
  }
  if (snapshot.price != null) {
    score += 35;
  } else {
    reasons.push("Missing extracted price.");
  }
  const identityCount = getWatchIdentityFields(watch).length;
  if (identityCount > 0) {
    score += Math.min(20, identityCount * 10);
  } else {
    reasons.push("No persistent product identifiers were extracted.");
  }
  if (snapshot.rawSnippet) {
    score += 10;
  }
  if (!reasons.length) {
    reasons.push("Snapshot includes title, price, and at least one persistent product identifier.");
  }

  const level = score >= 80 ? "high" : score >= 60 ? "medium" : score >= 30 ? "low" : "none";
  return { level, score, reasons };
}

function buildGroupBreakdown(watches: Watch[], limit: number) {
  const counts = new Map<string, number>();
  for (const watch of watches) {
    const key = watch.group?.trim() || "(ungrouped)";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([group, count]) => ({ group, count }))
    .sort((a, b) => b.count - a.count || a.group.localeCompare(b.group))
    .slice(0, limit);
}

function buildTagBreakdown(watches: Watch[], limit: number) {
  const counts = new Map<string, number>();
  for (const watch of watches) {
    for (const tag of watch.tags ?? []) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
    .slice(0, limit);
}

export function buildWorkflowCleanup(
  store: StoreFile,
  limit = 10,
): {
  watchCount: number;
  duplicateGroups: Array<{
    canonicalUrl: string;
    keepWatchId: string;
    duplicateWatchIds: string[];
  }>;
  disabledStale: Array<{
    watchId: string;
    label?: string;
    url: string;
    lastSeenAt?: string;
    reason: string;
  }>;
  noSnapshot: Array<{
    watchId: string;
    label?: string;
    url: string;
    enabled: boolean;
  }>;
  weakExtraction: Array<{
    watchId: string;
    label?: string;
    url: string;
    level: "none" | "low" | "medium" | "high";
    score: number;
    reasons: string[];
  }>;
  noisyWatches: Array<{
    watchId: string;
    label?: string;
    url: string;
    noiseScore: number;
    reason: string;
    historyCount: number;
    pricePointCount: number;
    lastSeenAt?: string;
  }>;
  actionSummary: string[];
} {
  const byCanonicalUrl = new Map<string, Watch[]>();
  for (const watch of store.watches) {
    const canonicalUrl = canonicalizeWatchUrl(watch.url).toString();
    const group = byCanonicalUrl.get(canonicalUrl) ?? [];
    group.push(watch);
    byCanonicalUrl.set(canonicalUrl, group);
  }

  const duplicateGroups = [...byCanonicalUrl.entries()]
    .filter((entry) => entry[1].length > 1)
    .map(([canonicalUrl, watches]) => {
      const sorted = [...watches].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return {
        canonicalUrl,
        keepWatchId: sorted[0]!.id,
        duplicateWatchIds: sorted.slice(1).map((watch) => watch.id),
      };
    })
    .slice(0, limit);

  const disabledStale = store.watches
    .filter((watch) => !watch.enabled)
    .map((watch) => {
      const recent = getHistoryEntries(watch);
      const lastSeenAt = recent[recent.length - 1]?.fetchedAt;
      return {
        watchId: watch.id,
        label: watch.label,
        url: watch.url,
        lastSeenAt,
        reason:
          lastSeenAt == null
            ? "Disabled and never committed a snapshot."
            : "Disabled watch still has historical data and may be a cleanup candidate.",
      };
    })
    .slice(0, limit);

  const noSnapshot = store.watches
    .filter((watch) => !watch.lastSnapshot)
    .slice(0, limit)
    .map((watch) => ({
      watchId: watch.id,
      label: watch.label,
      url: watch.url,
      enabled: watch.enabled,
    }));

  const weakExtraction = store.watches
    .map((watch) => {
      const coverage = buildExtractionCoverage(watch);
      return {
        watchId: watch.id,
        label: watch.label,
        url: watch.url,
        level: coverage.level,
        score: coverage.score,
        reasons: coverage.reasons,
      };
    })
    .filter((watch) => watch.level === "none" || watch.level === "low")
    .slice(0, limit);

  const noisyWatches = buildStoreReport(store).noisyWatches.slice(0, limit);
  const actionSummary: string[] = [];
  if (duplicateGroups.length) {
    actionSummary.push(`Resolve ${duplicateGroups.length} duplicate URL group${duplicateGroups.length === 1 ? "" : "s"} with deal_watch_dedupe or view-based cleanup.`);
  }
  if (noSnapshot.length) {
    actionSummary.push(`Scan or remove ${noSnapshot.length} watch${noSnapshot.length === 1 ? "" : "es"} that still have no committed snapshot.`);
  }
  if (weakExtraction.length) {
    actionSummary.push(`Review ${weakExtraction.length} watch${weakExtraction.length === 1 ? "" : "es"} with weak extraction quality.`);
  }

  return {
    watchCount: store.watches.length,
    duplicateGroups,
    disabledStale,
    noSnapshot,
    weakExtraction,
    noisyWatches,
    actionSummary,
  };
}

export function buildWorkflowPortfolio(
  store: StoreFile,
  limit = 10,
): {
  watchCount: number;
  overview: ReturnType<typeof buildStoreReport>;
  strongestAlerts: ReturnType<typeof buildAlertsSummary>;
  topDrops: ReturnType<typeof buildTopDropsSummary>;
  trends: ReturnType<typeof buildTrendsSummary>;
  groupBreakdown: Array<{ group: string; count: number }>;
  tagBreakdown: Array<{ tag: string; count: number }>;
  actionSummary: string[];
} {
  const overview = buildStoreReport(store);
  const strongestAlerts = buildAlertsSummary(store, "medium", limit);
  const topDrops = buildTopDropsSummary(store, "vs_peak", limit);
  const trends = buildTrendsSummary(store, limit);
  const groupBreakdown = buildGroupBreakdown(store.watches, limit);
  const tagBreakdown = buildTagBreakdown(store.watches, limit);
  const actionSummary: string[] = [];

  if (strongestAlerts.alerts[0]) {
    actionSummary.push(`The hottest current alert is ${strongestAlerts.alerts[0].label ?? strongestAlerts.alerts[0].watchId}.`);
  }
  if (topDrops.drops[0]) {
    actionSummary.push(`The deepest current drop is ${topDrops.drops[0].label ?? topDrops.drops[0].watchId}.`);
  }
  if (overview.noisyWatches.length) {
    actionSummary.push(`There ${overview.noisyWatches.length === 1 ? "is" : "are"} ${overview.noisyWatches.length} noisy watch${overview.noisyWatches.length === 1 ? "" : "es"} worth reviewing.`);
  }

  return {
    watchCount: store.watches.length,
    overview,
    strongestAlerts,
    topDrops,
    trends,
    groupBreakdown,
    tagBreakdown,
    actionSummary,
  };
}
