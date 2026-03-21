import type { AlertSeverity, StoreFile } from "../types.js";
import { buildWatchSignals } from "./watch-view.js";
import {
  buildGlitchAssessment,
  classifyTrend,
  compareSeverity,
  getHistoryPrices,
  sparkline,
  summarizeHistory,
} from "./report-history-primitives.js";

export function buildAlertsSummary(store: StoreFile, minSeverity: AlertSeverity = "low", limit = 20) {
  const alerts = store.watches
    .map((watch) => {
      const signals = buildWatchSignals(watch);
      const history = summarizeHistory(watch);
      const glitch = buildGlitchAssessment(watch, history, signals);
      const latestSeverity = history.latestEntry?.alertSeverity ?? "none";
      const derivedSeverity =
        signals.length > 0 && compareSeverity(latestSeverity, "medium") < 0 ? "medium" : latestSeverity;
      if (compareSeverity(derivedSeverity, minSeverity) < 0) return null;

      return {
        watchId: watch.id,
        label: watch.label,
        url: watch.url,
        severity: derivedSeverity,
        signals,
        summaryLine: history.latestEntry?.summaryLine ?? watch.lastSnapshot?.title,
        latestPrice: watch.lastSnapshot?.price,
        lowestSeenPrice: history.lowestSeenPrice,
        priceDelta: history.priceDelta,
        percentDelta: history.percentDelta,
        lastSeenAt: history.lastSeenAt,
        glitchScore: glitch.score,
        glitchReasons: glitch.reasons,
      };
    })
    .filter((watch): watch is NonNullable<typeof watch> => Boolean(watch))
    .sort(
      (a, b) =>
        compareSeverity(b.severity, a.severity) ||
        b.glitchScore - a.glitchScore ||
        Math.abs(b.percentDelta ?? 0) - Math.abs(a.percentDelta ?? 0) ||
        a.url.localeCompare(b.url),
    )
    .slice(0, limit);

  return { count: alerts.length, alerts };
}

export function buildTopDropsSummary(store: StoreFile, metric: "vs_peak" | "latest_change" = "vs_peak", limit = 10) {
  const drops = store.watches
    .map((watch) => {
      const history = summarizeHistory(watch);
      const latestPrice = history.latestEntry?.price ?? watch.lastSnapshot?.price;
      const previousPrice = history.previousEntry?.price;
      const highestSeenPrice = history.highestSeenPrice;
      const savingsFromPeak =
        latestPrice != null && highestSeenPrice != null ? Number((highestSeenPrice - latestPrice).toFixed(2)) : undefined;
      const savingsPercentFromPeak =
        latestPrice != null && highestSeenPrice != null && highestSeenPrice > 0
          ? Number((((highestSeenPrice - latestPrice) / highestSeenPrice) * 100).toFixed(1))
          : undefined;
      return {
        watchId: watch.id,
        label: watch.label,
        url: watch.url,
        latestPrice,
        previousPrice,
        highestSeenPrice,
        savingsFromPeak,
        savingsPercentFromPeak,
        recentDelta: history.priceDelta,
        recentPercentDelta: history.percentDelta,
        lastSeenAt: history.lastSeenAt,
      };
    })
    .filter((watch) =>
      metric === "vs_peak" ? (watch.savingsPercentFromPeak ?? 0) > 0 : (watch.recentPercentDelta ?? 0) < 0,
    )
    .sort((a, b) =>
      metric === "vs_peak"
        ? (b.savingsPercentFromPeak ?? 0) - (a.savingsPercentFromPeak ?? 0) || a.url.localeCompare(b.url)
        : (a.recentPercentDelta ?? 0) - (b.recentPercentDelta ?? 0) || a.url.localeCompare(b.url),
    )
    .slice(0, limit);

  return { metric, count: drops.length, drops };
}

export function buildTrendsSummary(store: StoreFile, limit = 20) {
  const trends = store.watches
    .map((watch) => {
      const history = summarizeHistory(watch);
      const trend = classifyTrend(watch, history);
      const prices = getHistoryPrices(watch).slice(-8);
      return {
        watchId: watch.id,
        label: watch.label,
        url: watch.url,
        trend: trend.label,
        direction: trend.direction,
        confidence: trend.confidence,
        latestPrice: history.latestEntry?.price ?? watch.lastSnapshot?.price,
        lowestSeenPrice: history.lowestSeenPrice,
        highestSeenPrice: history.highestSeenPrice,
        percentDelta: history.percentDelta,
        sparkline: sparkline(prices),
        reasons: trend.reasons,
      };
    })
    .filter((watch) => watch.direction !== "unknown")
    .sort((a, b) => {
      const order = { volatile: 0, down: 1, up: 2, flat: 3, unknown: 4 } as const;
      return order[a.direction] - order[b.direction] || (b.highestSeenPrice ?? 0) - (a.highestSeenPrice ?? 0);
    })
    .slice(0, limit);

  return { count: trends.length, trends };
}
