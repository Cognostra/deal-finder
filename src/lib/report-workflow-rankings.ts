import type { AlertSeverity, StoreFile } from "../types.js";
import { buildAlertsSummary, buildStoreReport, buildTopDropsSummary } from "./report-history.js";
import { buildDiscoveryBacklog, buildMarketCheckSummary } from "./report-market.js";
import { listLlmReviewCandidates } from "./report-review.js";
import { buildWorkflowCleanup } from "./report-workflow-coverage.js";

function buildMarketLeaders(
  store: StoreFile,
  limit: number,
): Array<{
  watchId: string;
  label?: string;
  url: string;
  latestPrice?: number;
  bestKnownPrice?: number;
  highestKnownPrice?: number;
  spreadPercent?: number;
  matchCount: number;
  isBestKnownPrice: boolean;
}> {
  return store.watches
    .map((watch) => {
      const summary = buildMarketCheckSummary(store, watch);
      const latestPrice = watch.lastSnapshot?.price;
      const isBestKnownPrice =
        latestPrice != null && summary.bestKnownPrice != null && Math.abs(latestPrice - summary.bestKnownPrice) < 0.01;
      return {
        watchId: watch.id,
        label: watch.label,
        url: watch.url,
        latestPrice,
        bestKnownPrice: summary.bestKnownPrice,
        highestKnownPrice: summary.highestKnownPrice,
        spreadPercent: summary.spread?.percentFromBest,
        matchCount: summary.matchCount,
        isBestKnownPrice,
      };
    })
    .filter((item) => item.matchCount > 0 && (item.spreadPercent ?? 0) > 0)
    .sort(
      (a, b) =>
        Number(b.isBestKnownPrice) - Number(a.isBestKnownPrice) ||
        (b.spreadPercent ?? 0) - (a.spreadPercent ?? 0) ||
        a.url.localeCompare(b.url),
    )
    .slice(0, limit);
}

export function buildWorkflowBestOpportunities(
  store: StoreFile,
  limit = 5,
): {
  watchCount: number;
  topRealDeals: Array<{
    watchId: string;
    label?: string;
    url: string;
    latestPrice?: number;
    severity: AlertSeverity;
    glitchScore: number;
    savingsPercentFromPeak?: number;
    recentPercentDelta?: number;
    bestKnownPrice?: number;
    marketSpreadPercent?: number;
    isBestKnownPrice: boolean;
    summaryLine?: string;
    signals: string[];
    rationale: string[];
  }>;
  suspiciousDeals: Array<{
    watchId: string;
    label?: string;
    url: string;
    latestPrice?: number;
    severity: AlertSeverity;
    glitchScore: number;
    summaryLine?: string;
    reasons: string[];
  }>;
  marketLeaders: Array<{
    watchId: string;
    label?: string;
    url: string;
    latestPrice?: number;
    bestKnownPrice?: number;
    highestKnownPrice?: number;
    spreadPercent?: number;
    matchCount: number;
    isBestKnownPrice: boolean;
  }>;
  strongestAlerts: Array<{
    watchId: string;
    label?: string;
    url: string;
    severity: AlertSeverity;
    summaryLine?: string;
    latestPrice?: number;
    glitchScore: number;
  }>;
  actionSummary: string[];
} {
  const alerts = buildAlertsSummary(store, "low", Math.max(limit * 4, 20)).alerts;
  const drops = new Map(buildTopDropsSummary(store, "vs_peak", Math.max(limit * 4, 20)).drops.map((drop) => [drop.watchId, drop]));
  const topRealDeals = alerts
    .map((alert) => {
      const watch = store.watches.find((candidate) => candidate.id === alert.watchId);
      if (!watch) return null;
      const market = buildMarketCheckSummary(store, watch);
      const drop = drops.get(alert.watchId);
      const latestPrice = watch.lastSnapshot?.price;
      const isBestKnownPrice =
        latestPrice != null && market.bestKnownPrice != null && Math.abs(latestPrice - market.bestKnownPrice) < 0.01;
      const rationale = [
        ...(alert.signals.length ? [`Active signals: ${alert.signals.join(", ")}.`] : []),
        ...(drop?.savingsPercentFromPeak != null
          ? [`Current price is ${drop.savingsPercentFromPeak.toFixed(1)}% below the observed peak.`]
          : []),
        ...(market.spread?.percentFromBest != null
          ? [
              isBestKnownPrice
                ? `This watch is currently the best known internal price with a ${market.spread.percentFromBest.toFixed(1)}% spread.`
                : `Internal same-product spread is ${market.spread.percentFromBest.toFixed(1)}%.`,
            ]
          : []),
      ];
      return {
        watchId: alert.watchId,
        label: alert.label,
        url: alert.url,
        latestPrice: alert.latestPrice,
        severity: alert.severity,
        glitchScore: alert.glitchScore,
        savingsPercentFromPeak: drop?.savingsPercentFromPeak,
        recentPercentDelta: alert.percentDelta,
        bestKnownPrice: market.bestKnownPrice,
        marketSpreadPercent: market.spread?.percentFromBest,
        isBestKnownPrice,
        summaryLine: alert.summaryLine,
        signals: alert.signals,
        rationale,
        score:
          (alert.severity === "high" ? 45 : alert.severity === "medium" ? 30 : 15) +
          Math.max(0, drop?.savingsPercentFromPeak ?? 0) +
          Math.max(0, Math.abs(Math.min(alert.percentDelta ?? 0, 0))) +
          (isBestKnownPrice ? 20 : 0) +
          Math.max(0, (market.spread?.percentFromBest ?? 0) / 2) -
          alert.glitchScore,
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .filter((item) => item.glitchScore < 70)
    .sort((a, b) => b.score - a.score || a.url.localeCompare(b.url))
    .slice(0, limit)
    .map(({ score: _score, ...item }) => item);

  const suspiciousDeals = alerts
    .filter((alert) => alert.glitchScore >= 60)
    .map((alert) => ({
      watchId: alert.watchId,
      label: alert.label,
      url: alert.url,
      latestPrice: alert.latestPrice,
      severity: alert.severity,
      glitchScore: alert.glitchScore,
      summaryLine: alert.summaryLine,
      reasons: alert.glitchReasons,
    }))
    .slice(0, limit);

  const marketLeaders = buildMarketLeaders(store, limit);
  const strongestAlerts = alerts.slice(0, limit).map((alert) => ({
    watchId: alert.watchId,
    label: alert.label,
    url: alert.url,
    severity: alert.severity,
    summaryLine: alert.summaryLine,
    latestPrice: alert.latestPrice,
    glitchScore: alert.glitchScore,
  }));

  const actionSummary: string[] = [];
  if (topRealDeals[0]) {
    actionSummary.push(`Start with ${topRealDeals[0].label ?? topRealDeals[0].watchId}; it currently looks like the strongest likely-real opportunity.`);
  }
  if (suspiciousDeals.length) {
    actionSummary.push(`Review ${suspiciousDeals.length} suspicious/glitch-prone watch${suspiciousDeals.length === 1 ? "" : "es"} before acting automatically.`);
  }
  if (marketLeaders.some((item) => item.isBestKnownPrice)) {
    actionSummary.push("At least one watch currently holds the best known internal same-product price.");
  }

  return {
    watchCount: store.watches.length,
    topRealDeals,
    suspiciousDeals,
    marketLeaders,
    strongestAlerts,
    actionSummary,
  };
}

export function buildWorkflowTriage(
  store: StoreFile,
  limit = 5,
  minSeverity: AlertSeverity = "medium",
): {
  watchCount: number;
  changed: ReturnType<typeof buildStoreReport>["recentChanges"];
  strongestAlerts: ReturnType<typeof buildAlertsSummary>["alerts"];
  probableNoise: Array<{
    watchId: string;
    label?: string;
    url: string;
    glitchScore?: number;
    noiseScore?: number;
    reason: string;
  }>;
  bestOpportunity?: ReturnType<typeof buildWorkflowBestOpportunities>["topRealDeals"][number];
  suspiciousOpportunity?: ReturnType<typeof buildWorkflowBestOpportunities>["suspiciousDeals"][number];
  actionSummary: string[];
} {
  const overview = buildStoreReport(store);
  const best = buildWorkflowBestOpportunities(store, limit);
  const strongestAlerts = buildAlertsSummary(store, minSeverity, limit).alerts;
  const probableNoise = [
    ...best.suspiciousDeals.map((item) => ({
      watchId: item.watchId,
      label: item.label,
      url: item.url,
      glitchScore: item.glitchScore,
      score: item.glitchScore,
      reason: item.reasons[0] ?? "Likely glitch-prone behavior.",
    })),
    ...overview.noisyWatches.map((item) => ({
      watchId: item.watchId,
      label: item.label,
      url: item.url,
      noiseScore: item.noiseScore,
      score: item.noiseScore,
      reason: item.reason,
    })),
  ]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ score: _score, ...item }) => item);

  const actionSummary: string[] = [];
  if (best.topRealDeals[0]) {
    actionSummary.push(`Best current likely-real opportunity: ${best.topRealDeals[0].label ?? best.topRealDeals[0].watchId}.`);
  }
  if (probableNoise.length) {
    actionSummary.push(`Treat ${probableNoise.length} watch${probableNoise.length === 1 ? "" : "es"} as noisy or suspicious until reviewed.`);
  }
  if (!best.topRealDeals.length && strongestAlerts.length) {
    actionSummary.push("Alerts exist, but none currently clear the low-glitch filter for likely-real opportunities.");
  }

  return {
    watchCount: store.watches.length,
    changed: overview.recentChanges.slice(0, limit),
    strongestAlerts,
    probableNoise,
    bestOpportunity: best.topRealDeals[0],
    suspiciousOpportunity: best.suspiciousDeals[0],
    actionSummary,
  };
}

export function buildWorkflowActionQueue(
  store: StoreFile,
  options?: {
    limit?: number;
    severity?: AlertSeverity;
    scopeLabel?: string;
  },
): {
  scopeLabel: string;
  watchCount: number;
  itemCount: number;
  items: Array<{
    priority: "high" | "medium" | "low";
    category: "opportunity" | "alert" | "cleanup" | "discovery" | "review";
    title: string;
    reason: string;
    recommendedTool: string;
    watchId?: string;
    label?: string;
    url?: string;
  }>;
  actionSummary: string[];
} {
  const limit = options?.limit ?? 10;
  const triage = buildWorkflowTriage(store, Math.min(limit, 5), options?.severity ?? "medium");
  const discovery = buildDiscoveryBacklog(store, Math.min(limit, 5));
  const reviewQueue = listLlmReviewCandidates(store).slice(0, Math.min(limit, 5));
  const cleanup = buildWorkflowCleanup(store, Math.min(limit, 5));
  const items: Array<{
    priority: "high" | "medium" | "low";
    category: "opportunity" | "alert" | "cleanup" | "discovery" | "review";
    title: string;
    reason: string;
    recommendedTool: string;
    watchId?: string;
    label?: string;
    url?: string;
    score: number;
  }> = [];

  if (triage.bestOpportunity) {
    items.push({
      priority: "high",
      category: "opportunity",
      title: `Best current opportunity: ${triage.bestOpportunity.label ?? triage.bestOpportunity.watchId}`,
      reason: triage.bestOpportunity.rationale[0] ?? "This currently looks like the strongest likely-real deal.",
      recommendedTool: "deal_workflow_best_opportunities",
      watchId: triage.bestOpportunity.watchId,
      label: triage.bestOpportunity.label,
      url: triage.bestOpportunity.url,
      score: 100,
    });
  }

  for (const alert of triage.strongestAlerts.slice(0, Math.min(limit, 3))) {
    items.push({
      priority: alert.severity === "high" ? "high" : "medium",
      category: "alert",
      title: `Alert: ${alert.label ?? alert.watchId}`,
      reason: alert.summaryLine ?? "Threshold or keyword alert is currently active.",
      recommendedTool: "deal_alerts",
      watchId: alert.watchId,
      label: alert.label,
      url: alert.url,
      score: alert.severity === "high" ? 90 : 70,
    });
  }

  for (const duplicate of cleanup.duplicateGroups.slice(0, 2)) {
    items.push({
      priority: "medium",
      category: "cleanup",
      title: `Duplicate watch group on ${duplicate.canonicalUrl}`,
      reason: `Keep ${duplicate.keepWatchId} and review ${duplicate.duplicateWatchIds.length} duplicate watch${duplicate.duplicateWatchIds.length === 1 ? "" : "es"}.`,
      recommendedTool: "deal_watch_dedupe",
      watchId: duplicate.keepWatchId,
      url: duplicate.canonicalUrl,
      score: 60,
    });
  }

  for (const weak of cleanup.weakExtraction.slice(0, 2)) {
    items.push({
      priority: "medium",
      category: "cleanup",
      title: `Weak extraction: ${weak.label ?? weak.watchId}`,
      reason: weak.reasons[0] ?? "Extraction quality is too weak for reliable automation.",
      recommendedTool: "deal_extraction_debug",
      watchId: weak.watchId,
      label: weak.label,
      url: weak.url,
      score: 58,
    });
  }

  for (const backlog of discovery.backlog.slice(0, 2)) {
    items.push({
      priority: backlog.priority,
      category: "discovery",
      title: `Discovery target: ${backlog.label ?? backlog.watchId}`,
      reason: backlog.reasons[0] ?? "This watch would benefit from broader same-product coverage.",
      recommendedTool: "deal_discovery_backlog",
      watchId: backlog.watchId,
      label: backlog.label,
      url: backlog.url,
      score: backlog.priority === "high" ? 65 : backlog.priority === "medium" ? 45 : 30,
    });
  }

  for (const candidate of reviewQueue.slice(0, 2)) {
    items.push({
      priority: candidate.priority,
      category: "review",
      title: `Review candidate: ${candidate.label ?? candidate.watchId}`,
      reason: candidate.reasons[0] ?? "Manual or model-assisted review is recommended.",
      recommendedTool: "deal_llm_review_queue",
      watchId: candidate.watchId,
      label: candidate.label,
      url: candidate.url,
      score: candidate.priority === "high" ? 55 : 35,
    });
  }

  const deduped = new Map<string, (typeof items)[number]>();
  for (const item of items) {
    const key = `${item.category}:${item.watchId ?? item.title}`;
    const existing = deduped.get(key);
    if (!existing || item.score > existing.score) {
      deduped.set(key, item);
    }
  }

  const ranked = [...deduped.values()]
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, limit)
    .map(({ score: _score, ...item }) => item);

  const actionSummary: string[] = [];
  if (ranked[0]) {
    actionSummary.push(`Start with: ${ranked[0].title}.`);
  }
  const categoryCounts = new Map<string, number>();
  for (const item of ranked) {
    categoryCounts.set(item.category, (categoryCounts.get(item.category) ?? 0) + 1);
  }
  for (const [category, count] of categoryCounts.entries()) {
    actionSummary.push(`${count} ${category} action${count === 1 ? "" : "s"} surfaced in the current queue.`);
  }

  return {
    scopeLabel: options?.scopeLabel ?? "watchlist",
    watchCount: store.watches.length,
    itemCount: ranked.length,
    items: ranked,
    actionSummary,
  };
}
