import type { StoreFile, Watch } from "../types.js";
import { buildWatchSignals } from "./watch-view.js";
import {
  buildGlitchAssessment,
  buildNoiseAssessment,
  getHistoryEntries,
  summarizeHistory,
} from "./report-history-primitives.js";

export function buildStoreReport(store: StoreFile) {
  const watches = store.watches;
  const topSignals = watches
    .map((watch) => ({
      watchId: watch.id,
      label: watch.label,
      url: watch.url,
      signals: buildWatchSignals(watch),
    }))
    .filter((watch) => watch.signals.length > 0)
    .sort((a, b) => b.signals.length - a.signals.length || a.url.localeCompare(b.url))
    .slice(0, 10);
  const priceLeaders = watches
    .map((watch) => {
      const history = summarizeHistory(watch);
      return {
        watchId: watch.id,
        label: watch.label,
        url: watch.url,
        latestPrice: watch.lastSnapshot?.price,
        lowestSeenPrice: history.lowestSeenPrice,
        historyCount: history.historyCount,
      };
    })
    .filter((watch) => watch.historyCount > 0 || watch.latestPrice != null)
    .sort(
      (a, b) =>
        (a.lowestSeenPrice ?? a.latestPrice ?? Number.POSITIVE_INFINITY) -
          (b.lowestSeenPrice ?? b.latestPrice ?? Number.POSITIVE_INFINITY) ||
        b.historyCount - a.historyCount,
    )
    .slice(0, 10);
  const recentChanges = watches
    .flatMap((watch) =>
      getHistoryEntries(watch).map((entry) => ({
        watchId: watch.id,
        label: watch.label,
        url: watch.url,
        fetchedAt: entry.fetchedAt,
        changeType: entry.changeType,
        alertSeverity: entry.alertSeverity,
        summaryLine: entry.summaryLine,
        price: entry.price,
        currency: entry.currency,
      })),
    )
    .sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt))
    .slice(0, 15);
  const noisyWatches = watches
    .map((watch) => {
      const history = summarizeHistory(watch);
      const noise = buildNoiseAssessment(watch, history);
      if (noise.score < 45) return null;
      return {
        watchId: watch.id,
        label: watch.label,
        url: watch.url,
        noiseScore: noise.score,
        reason: noise.reasons[0] ?? "Recent history is unusually volatile.",
        historyCount: history.historyCount,
        pricePointCount: noise.pricePointCount,
        lastSeenAt: history.lastSeenAt,
      };
    })
    .filter((watch): watch is NonNullable<typeof watch> => Boolean(watch))
    .sort((a, b) => b.noiseScore - a.noiseScore || (b.lastSeenAt ?? "").localeCompare(a.lastSeenAt ?? ""))
    .slice(0, 10);
  const glitchCandidates = watches
    .map((watch) => {
      const history = summarizeHistory(watch);
      const glitch = buildGlitchAssessment(watch, history, buildWatchSignals(watch));
      if (glitch.score < 60) return null;
      return {
        watchId: watch.id,
        label: watch.label,
        url: watch.url,
        glitchScore: glitch.score,
        reasons: glitch.reasons,
        latestPrice: history.latestEntry?.price ?? watch.lastSnapshot?.price,
        previousPrice: history.previousEntry?.price,
        lastSeenAt: history.lastSeenAt,
      };
    })
    .filter((watch): watch is NonNullable<typeof watch> => Boolean(watch))
    .sort((a, b) => b.glitchScore - a.glitchScore || (b.lastSeenAt ?? "").localeCompare(a.lastSeenAt ?? ""))
    .slice(0, 10);

  return {
    total: watches.length,
    savedViewCount: store.savedViews.length,
    enabled: watches.filter((watch) => watch.enabled).length,
    disabled: watches.filter((watch) => !watch.enabled).length,
    withSnapshots: watches.filter((watch) => Boolean(watch.lastSnapshot)).length,
    withHistory: watches.filter((watch) => Boolean(watch.history?.length)).length,
    withSignals: topSignals.length,
    topSignals,
    priceLeaders,
    recentChanges,
    noisyWatches,
    glitchCandidates,
  };
}

export function buildHistorySummary(watch: Watch, limit = 20) {
  const history = summarizeHistory(watch);
  return {
    watchId: watch.id,
    label: watch.label,
    url: watch.url,
    historyCount: history.historyCount,
    latestPrice: watch.lastSnapshot?.price,
    latestCurrency: watch.lastSnapshot?.currency,
    lowestSeenPrice: history.lowestSeenPrice,
    highestSeenPrice: history.highestSeenPrice,
    firstSeenAt: history.firstSeenAt,
    lastSeenAt: history.lastSeenAt,
    priceDelta: history.priceDelta,
    percentDelta: history.percentDelta,
    recent: getHistoryEntries(watch).slice(-limit).reverse(),
  };
}
