import type { DiscoveryCandidate, ProductIdentityField, StoreFile, Watch } from "../types.js";
import { getWatchHost, getWatchIdentityStrength } from "./product-identity.js";
import { buildWatchSignals } from "./watch-view.js";
import { buildMarketCheckSummary } from "./report-market-identity.js";

export function buildDiscoveryReport(args: {
  watch: Watch;
  provider: string;
  candidates: DiscoveryCandidate[];
  importPreview: Array<{
    candidate: DiscoveryCandidate;
    duplicateWatchId?: string;
    importable: boolean;
  }>;
  query?: string;
  searchHosts?: string[];
  skippedHosts?: string[];
  skippedResults?: Array<{ url: string; reason: string }>;
}): {
  anchor: {
    watchId: string;
    label?: string;
    url: string;
    identityStrength: ReturnType<typeof getWatchIdentityStrength>;
  };
  provider: string;
  query?: string;
  searchHosts?: string[];
  skippedHosts?: string[];
  summary: {
    candidateCount: number;
    fetchedOkCount: number;
    blockedOrFailedCount: number;
    importableCount: number;
    strongMatchCount: number;
    reviewCount: number;
    duplicateCount: number;
    weakOrRejectedCount: number;
    skippedResultCount: number;
  };
  topCandidates: Array<{
    url: string;
    host: string;
    matchScore?: number;
    matchStrength?: string;
    recommendedAction: string;
    duplicateWatchId?: string;
    price?: number;
    currency?: string;
    extractedTitle?: string;
    matchedFields: ProductIdentityField[];
    reasons: string[];
    warnings: string[];
  }>;
  blockedOrFailed: Array<{
    url: string;
    host: string;
    fetchStatus: string;
    blockedReason?: string;
  }>;
  skippedResults?: Array<{ url: string; reason: string }>;
  actionSummary: string[];
} {
  const { watch, provider, candidates, importPreview, query, searchHosts, skippedHosts, skippedResults } = args;
  const previewByUrl = new Map(importPreview.map((entry) => [entry.candidate.url, entry]));
  const strongMatchCount = candidates.filter((candidate) => candidate.matchStrength === "high").length;
  const reviewCount = candidates.filter((candidate) => candidate.recommendedAction === "review_before_import").length;
  const duplicateCount = importPreview.filter((entry) => Boolean(entry.duplicateWatchId)).length;
  const weakOrRejectedCount = candidates.filter((candidate) => candidate.recommendedAction === "likely_not_same_product").length;
  const fetchedOkCount = candidates.filter((candidate) => candidate.fetchStatus === "ok").length;
  const blockedOrFailedCount = candidates.filter((candidate) => candidate.fetchStatus !== "ok").length;
  const importableCount = importPreview.filter((entry) => entry.importable).length;

  const topCandidates = candidates
    .filter((candidate) => candidate.fetchStatus === "ok")
    .map((candidate) => {
      const preview = previewByUrl.get(candidate.url);
      return {
        url: candidate.url,
        host: candidate.host,
        matchScore: candidate.matchScore,
        matchStrength: candidate.matchStrength,
        recommendedAction: candidate.recommendedAction,
        duplicateWatchId: preview?.duplicateWatchId,
        price: candidate.price,
        currency: candidate.currency,
        extractedTitle: candidate.extractedTitle,
        matchedFields: candidate.matchedFields,
        reasons: candidate.matchReasons,
        warnings: candidate.matchWarnings,
      };
    })
    .sort((a, b) =>
      (b.matchScore ?? 0) - (a.matchScore ?? 0) ||
      Number(a.duplicateWatchId == null) - Number(b.duplicateWatchId == null) ||
      a.url.localeCompare(b.url),
    )
    .slice(0, 8);

  const blockedOrFailed = candidates
    .filter((candidate) => candidate.fetchStatus !== "ok")
    .map((candidate) => ({
      url: candidate.url,
      host: candidate.host,
      fetchStatus: candidate.fetchStatus,
      blockedReason: candidate.blockedReason,
    }))
    .slice(0, 8);

  const actionSummary: string[] = [];
  if (topCandidates[0]) {
    actionSummary.push(
      `Best current candidate is ${topCandidates[0].url} with ${topCandidates[0].matchStrength ?? "unknown"} match strength${topCandidates[0].duplicateWatchId ? ", but it is already represented by an existing watch." : "."}`,
    );
  }
  if (importableCount) {
    actionSummary.push(`There ${importableCount === 1 ? "is" : "are"} ${importableCount} candidate${importableCount === 1 ? "" : "s"} ready for import after review.`);
  }
  if (duplicateCount) {
    actionSummary.push(`${duplicateCount} candidate${duplicateCount === 1 ? " is" : "s are"} already covered by the current watch store.`);
  }
  if (blockedOrFailedCount) {
    actionSummary.push(`${blockedOrFailedCount} candidate${blockedOrFailedCount === 1 ? "" : "s"} were blocked or failed fetch policy checks.`);
  }
  if (!actionSummary.length) {
    actionSummary.push("No discovery candidates were strong enough to recommend import yet.");
  }

  return {
    anchor: {
      watchId: watch.id,
      label: watch.label,
      url: watch.url,
      identityStrength: getWatchIdentityStrength(watch),
    },
    provider,
    query,
    searchHosts,
    skippedHosts,
    summary: {
      candidateCount: candidates.length,
      fetchedOkCount,
      blockedOrFailedCount,
      importableCount,
      strongMatchCount,
      reviewCount,
      duplicateCount,
      weakOrRejectedCount,
      skippedResultCount: skippedResults?.length ?? 0,
    },
    topCandidates,
    blockedOrFailed,
    skippedResults,
    actionSummary,
  };
}

export function buildDiscoveryBacklog(
  store: StoreFile,
  limit = 10,
): {
  watchCount: number;
  candidateCount: number;
  highPriorityCount: number;
  mediumPriorityCount: number;
  backlog: Array<{
    watchId: string;
    label?: string;
    url: string;
    host: string;
    latestPrice?: number;
    identityStrength: ReturnType<typeof getWatchIdentityStrength>["strength"];
    identityScore: number;
    matchCount: number;
    activeSignals: string[];
    recommendedAction: "search_new_retailers" | "expand_coverage" | "improve_identity_first";
    priority: "high" | "medium" | "low";
    priorityScore: number;
    reasons: string[];
  }>;
  actionSummary: string[];
} {
  const scored = store.watches
    .filter((watch) => watch.enabled)
    .map((watch) => {
      const identity = getWatchIdentityStrength(watch);
      const market = buildMarketCheckSummary(store, watch);
      const signals = buildWatchSignals(watch);
      const reasons: string[] = [];
      let priorityScore = 0;
      let recommendedAction: "search_new_retailers" | "expand_coverage" | "improve_identity_first";

      if (identity.strength === "none") {
        recommendedAction = "improve_identity_first";
        priorityScore += 5;
        reasons.push("No durable identifiers are stored yet, so discovery would be low-confidence.");
      } else if (market.matchCount === 0) {
        recommendedAction = "search_new_retailers";
        priorityScore += identity.strength === "high" ? 80 : identity.strength === "medium" ? 60 : 35;
        reasons.push("No same-product matches exist in the current store.");
      } else {
        recommendedAction = "expand_coverage";
        priorityScore += market.matchCount === 1 ? 35 : 15;
        reasons.push(`Only ${market.matchCount} same-product ${market.matchCount === 1 ? "match exists" : "matches exist"} in the current store.`);
      }

      if (signals.length) {
        priorityScore += 10;
        reasons.push(`Active signals are present: ${signals.join(", ")}.`);
      }
      if (watch.lastSnapshot?.price != null) {
        priorityScore += 10;
        reasons.push("Latest snapshot has a current price, so new retailer comparisons would be immediately useful.");
      }
      if (identity.strength === "high") {
        reasons.push("Stored identity strength is high enough for bounded discovery search.");
      } else if (identity.strength === "medium") {
        reasons.push("Stored identity strength is moderate; discovery is viable but should be reviewed carefully.");
      } else if (identity.strength === "low") {
        reasons.push("Stored identity strength is low; discovery may rely more on title/brand overlap.");
      }

      const priority: "high" | "medium" | "low" =
        priorityScore >= 75 ? "high" : priorityScore >= 40 ? "medium" : "low";

      return {
        watchId: watch.id,
        label: watch.label,
        url: watch.url,
        host: getWatchHost(watch.url),
        latestPrice: watch.lastSnapshot?.price,
        identityStrength: identity.strength,
        identityScore: identity.score,
        matchCount: market.matchCount,
        activeSignals: signals,
        recommendedAction,
        priority,
        priorityScore,
        reasons,
      };
    })
    .filter((entry) => entry.recommendedAction !== "expand_coverage" || entry.matchCount <= 2)
    .sort((a, b) => b.priorityScore - a.priorityScore || a.url.localeCompare(b.url))
    .slice(0, limit);

  const highPriorityCount = scored.filter((entry) => entry.priority === "high").length;
  const mediumPriorityCount = scored.filter((entry) => entry.priority === "medium").length;
  const actionSummary: string[] = [];
  if (scored[0]) {
    actionSummary.push(`Start with ${scored[0].label ?? scored[0].watchId}; it has the strongest case for more discovery coverage.`);
  }
  if (highPriorityCount) {
    actionSummary.push(`${highPriorityCount} watch${highPriorityCount === 1 ? "" : "es"} look like high-priority discovery targets.`);
  }
  if (scored.some((entry) => entry.recommendedAction === "improve_identity_first")) {
    actionSummary.push("Some watches should improve stored identity first before wider discovery search.");
  }

  return {
    watchCount: store.watches.length,
    candidateCount: scored.length,
    highPriorityCount,
    mediumPriorityCount,
    backlog: scored,
    actionSummary,
  };
}
