import type { AlertSeverity, StoreFile, Watch } from "../types.js";
import { buildAlertsSummary, buildStoreReport, buildTopDropsSummary, buildTrendsSummary } from "./report-history.js";
import {
  buildWorkflowActionQueue,
  buildWorkflowBestOpportunities,
  buildWorkflowTriage,
} from "./report-workflow-priorities.js";
import { buildWatchSignals, searchWatches } from "./watch-view.js";

function buildSubsetStore(store: StoreFile, watches: Watch[]): StoreFile {
  return {
    version: store.version,
    savedViews: store.savedViews,
    watches,
  };
}

export function buildViewReport(
  store: StoreFile,
  watches: Watch[],
  options?: {
    limit?: number;
    severity?: AlertSeverity;
    metric?: "vs_peak" | "latest_change";
  },
): {
  scopedCount: number;
  report: ReturnType<typeof buildStoreReport>;
  alerts: ReturnType<typeof buildAlertsSummary>;
  trends: ReturnType<typeof buildTrendsSummary>;
  topDrops: ReturnType<typeof buildTopDropsSummary>;
  bestOpportunities: ReturnType<typeof buildWorkflowBestOpportunities>;
} {
  const scopedStore = buildSubsetStore(store, watches);
  const limit = options?.limit ?? 10;
  return {
    scopedCount: watches.length,
    report: buildStoreReport(scopedStore),
    alerts: buildAlertsSummary(scopedStore, options?.severity ?? "low", limit),
    trends: buildTrendsSummary(scopedStore, limit),
    topDrops: buildTopDropsSummary(scopedStore, options?.metric ?? "vs_peak", limit),
    bestOpportunities: buildWorkflowBestOpportunities(scopedStore, Math.min(limit, 5)),
  };
}

export function buildDigestSummary(
  store: StoreFile,
  options?: {
    limit?: number;
    severity?: AlertSeverity;
    scopeLabel?: string;
  },
): {
  scopeLabel: string;
  watchCount: number;
  headline: string;
  topLine: string;
  highlights: string[];
  actions: string[];
  digestText: string;
  bestOpportunity?: ReturnType<typeof buildWorkflowBestOpportunities>["topRealDeals"][number];
  suspiciousOpportunity?: ReturnType<typeof buildWorkflowBestOpportunities>["suspiciousDeals"][number];
  strongestAlerts: ReturnType<typeof buildAlertsSummary>["alerts"];
  changed: ReturnType<typeof buildWorkflowTriage>["changed"];
  probableNoise: ReturnType<typeof buildWorkflowTriage>["probableNoise"];
} {
  const limit = options?.limit ?? 5;
  const scopeLabel = options?.scopeLabel ?? "watchlist";
  const triage = buildWorkflowTriage(store, limit, options?.severity ?? "medium");
  const best = buildWorkflowBestOpportunities(store, Math.min(limit, 5));
  const changedCount = triage.changed.length;
  const alertCount = triage.strongestAlerts.length;
  const noisyCount = triage.probableNoise.length;

  const headlineParts = [`${scopeLabel}: ${store.watches.length} watch${store.watches.length === 1 ? "" : "es"}`];
  if (changedCount) headlineParts.push(`${changedCount} recent change${changedCount === 1 ? "" : "s"}`);
  if (alertCount) headlineParts.push(`${alertCount} active alert${alertCount === 1 ? "" : "s"}`);
  const headline = headlineParts.join(", ");

  let topLine = `No urgent movement detected in ${scopeLabel}.`;
  if (triage.bestOpportunity) {
    const priceText = triage.bestOpportunity.latestPrice != null ? ` at ${triage.bestOpportunity.latestPrice.toFixed(2)}` : "";
    topLine = `Best current opportunity in ${scopeLabel}: ${triage.bestOpportunity.label ?? triage.bestOpportunity.watchId}${priceText}.`;
  } else if (triage.strongestAlerts[0]) {
    topLine = `Top alert in ${scopeLabel}: ${triage.strongestAlerts[0].label ?? triage.strongestAlerts[0].watchId}.`;
  }

  const highlights: string[] = [];
  if (triage.bestOpportunity) {
    highlights.push(
      `Best likely-real deal: ${triage.bestOpportunity.label ?? triage.bestOpportunity.watchId}${triage.bestOpportunity.marketSpreadPercent != null ? ` (${triage.bestOpportunity.marketSpreadPercent.toFixed(1)}% internal spread)` : ""}.`,
    );
  }
  if (triage.suspiciousOpportunity) {
    highlights.push(
      `Most suspicious/glitch-prone watch: ${triage.suspiciousOpportunity.label ?? triage.suspiciousOpportunity.watchId} (glitch score ${triage.suspiciousOpportunity.glitchScore}).`,
    );
  }
  if (triage.changed[0]) {
    highlights.push(`Most recent meaningful change: ${triage.changed[0].label ?? triage.changed[0].watchId}.`);
  }
  if (triage.strongestAlerts[0] && !highlights.some((line) => line.includes(triage.strongestAlerts[0]!.label ?? triage.strongestAlerts[0]!.watchId))) {
    highlights.push(`Strongest alert: ${triage.strongestAlerts[0].label ?? triage.strongestAlerts[0].watchId}.`);
  }
  if (noisyCount) {
    highlights.push(`${noisyCount} watch${noisyCount === 1 ? "" : "es"} currently look noisy or suspicious.`);
  }

  const actions = [...triage.actionSummary];
  for (const action of best.actionSummary) {
    if (!actions.includes(action)) actions.push(action);
  }

  const digestLines = [
    headline,
    topLine,
    ...(highlights.length ? ["Highlights:", ...highlights.map((line) => `- ${line}`)] : []),
    ...(actions.length ? ["Actions:", ...actions.map((line) => `- ${line}`)] : []),
  ];

  return {
    scopeLabel,
    watchCount: store.watches.length,
    headline,
    topLine,
    highlights,
    actions,
    digestText: digestLines.join("\n"),
    bestOpportunity: triage.bestOpportunity,
    suspiciousOpportunity: triage.suspiciousOpportunity,
    strongestAlerts: triage.strongestAlerts,
    changed: triage.changed,
    probableNoise: triage.probableNoise,
  };
}

export function buildSavedViewDashboard(
  store: StoreFile,
  options?: {
    limit?: number;
    severity?: AlertSeverity;
  },
): {
  savedViewCount: number;
  populatedViewCount: number;
  emptyViewCount: number;
  views: Array<{
    savedViewId: string;
    name: string;
    description?: string;
    matchCount: number;
    enabledMatchCount: number;
    signalMatchCount: number;
    topLine: string;
    hottestAlert?: {
      watchId: string;
      label?: string;
      severity: AlertSeverity;
      summaryLine?: string;
    };
    bestOpportunity?: {
      watchId: string;
      label?: string;
      latestPrice?: number;
      summaryLine?: string;
    };
    nextAction?: {
      title: string;
      category: "opportunity" | "alert" | "cleanup" | "discovery" | "review";
      recommendedTool: string;
    };
    priorityScore: number;
  }>;
  actionSummary: string[];
} {
  const limit = options?.limit ?? 10;
  const severity = options?.severity ?? "medium";
  const views = store.savedViews
    .map((view) => {
      const watches = searchWatches(store.watches, view.selector);
      const scopedStore = buildSubsetStore(store, watches);
      const digest = buildDigestSummary(scopedStore, {
        limit: Math.min(limit, 5),
        severity,
        scopeLabel: view.name,
      });
      const queue = buildWorkflowActionQueue(scopedStore, {
        limit: Math.min(limit, 5),
        severity,
        scopeLabel: view.name,
      });
      const hottestAlert = digest.strongestAlerts[0]
        ? {
            watchId: digest.strongestAlerts[0].watchId,
            label: digest.strongestAlerts[0].label,
            severity: digest.strongestAlerts[0].severity,
            summaryLine: digest.strongestAlerts[0].summaryLine,
          }
        : undefined;
      const bestOpportunity = digest.bestOpportunity
        ? {
            watchId: digest.bestOpportunity.watchId,
            label: digest.bestOpportunity.label,
            latestPrice: digest.bestOpportunity.latestPrice,
            summaryLine: digest.bestOpportunity.summaryLine,
          }
        : undefined;
      const nextAction = queue.items[0]
        ? {
            title: queue.items[0].title,
            category: queue.items[0].category,
            recommendedTool: queue.items[0].recommendedTool,
          }
        : undefined;
      const enabledMatchCount = watches.filter((watch) => watch.enabled).length;
      const signalMatchCount = watches.filter((watch) => buildWatchSignals(watch).length > 0).length;
      const priorityScore =
        (bestOpportunity ? 60 : 0) +
        (hottestAlert ? (hottestAlert.severity === "high" ? 35 : hottestAlert.severity === "medium" ? 20 : 10) : 0) +
        Math.min(15, signalMatchCount * 3) +
        (nextAction ? 10 : 0);

      return {
        savedViewId: view.id,
        name: view.name,
        description: view.description,
        matchCount: watches.length,
        enabledMatchCount,
        signalMatchCount,
        topLine: digest.topLine,
        hottestAlert,
        bestOpportunity,
        nextAction,
        priorityScore,
      };
    })
    .sort((a, b) => b.priorityScore - a.priorityScore || b.matchCount - a.matchCount || a.name.localeCompare(b.name))
    .slice(0, limit);

  const actionSummary: string[] = [];
  if (views[0]) {
    actionSummary.push(`Start with saved view ${views[0].name}; it currently has the highest action priority.`);
  }
  const emptyViewCount = store.savedViews.filter((view) => searchWatches(store.watches, view.selector).length === 0).length;
  if (emptyViewCount) {
    actionSummary.push(`${emptyViewCount} saved view${emptyViewCount === 1 ? "" : "s"} currently match no watches and may need retuning.`);
  }

  return {
    savedViewCount: store.savedViews.length,
    populatedViewCount: views.filter((view) => view.matchCount > 0).length,
    emptyViewCount,
    views,
    actionSummary,
  };
}
