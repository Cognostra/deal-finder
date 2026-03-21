import type { StoreFile, Watch, WatchHistoryEntry } from "../types.js";
import { getWatchHost } from "./product-identity.js";

function getHistoryEntries(watch: Watch): WatchHistoryEntry[] {
  return watch.history ?? [];
}

function getHistoryPrices(watch: Watch): number[] {
  return getHistoryEntries(watch)
    .map((entry) => entry.price)
    .filter((price): price is number => price != null);
}

function summarizeHistory(watch: Watch) {
  const history = getHistoryEntries(watch);
  const prices = getHistoryPrices(watch);
  const latest = history[history.length - 1];
  const previous = history.length > 1 ? history[history.length - 2] : undefined;
  const lowestSeenPrice = prices.length ? Math.min(...prices) : undefined;
  const highestSeenPrice = prices.length ? Math.max(...prices) : undefined;
  const priceDelta =
    previous?.price != null && latest?.price != null ? Number((latest.price - previous.price).toFixed(2)) : undefined;
  const percentDelta =
    previous?.price != null && latest?.price != null && previous.price > 0
      ? Number((((latest.price - previous.price) / previous.price) * 100).toFixed(1))
      : undefined;

  return {
    history,
    historyCount: history.length,
    latestEntry: latest,
    previousEntry: previous,
    lowestSeenPrice,
    highestSeenPrice,
    firstSeenAt: history[0]?.fetchedAt,
    lastSeenAt: latest?.fetchedAt,
    priceDelta,
    percentDelta,
  };
}

function recommendCadenceMinutes(history: ReturnType<typeof summarizeHistory>): {
  recommendedMinutes: number;
  basis: string;
} {
  const entries = history.history;
  if (entries.length < 3) {
    return { recommendedMinutes: 360, basis: "Insufficient history; defaulting to every 6 hours." };
  }

  const deltasMinutes: number[] = [];
  for (let i = 1; i < entries.length; i += 1) {
    const prev = Date.parse(entries[i - 1]!.fetchedAt);
    const next = Date.parse(entries[i]!.fetchedAt);
    if (Number.isFinite(prev) && Number.isFinite(next) && next > prev) {
      deltasMinutes.push((next - prev) / 60_000);
    }
  }

  if (!deltasMinutes.length) {
    return { recommendedMinutes: 360, basis: "History timestamps were not usable; defaulting to every 6 hours." };
  }

  const sorted = [...deltasMinutes].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const suggested = Math.round(Math.max(30, Math.min(1440, median / 2)));
  return {
    recommendedMinutes: suggested,
    basis: `Median observed update interval was about ${Math.round(median)} minutes.`,
  };
}

export function buildScheduleAdvice(
  store: StoreFile,
  mode: "host" | "watch" = "host",
): {
  mode: "host" | "watch";
  recommendations: Array<{
    target: string;
    watchCount: number;
    recommendedMinutes: number;
    basis: string;
    sampleWatchIds: string[];
  }>;
} {
  const groups = new Map<string, Watch[]>();

  for (const watch of store.watches) {
    const target = mode === "host" ? getWatchHost(watch.url) : watch.id;
    const existing = groups.get(target) ?? [];
    existing.push(watch);
    groups.set(target, existing);
  }

  const recommendations = [...groups.entries()]
    .map(([target, watches]) => {
      const combinedHistory = watches
        .flatMap((watch) => getHistoryEntries(watch))
        .sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt));
      const representative = watches[0]!;
      const syntheticWatch: Watch = {
        ...representative,
        history: combinedHistory,
      };
      const cadence = recommendCadenceMinutes(summarizeHistory(syntheticWatch));
      return {
        target,
        watchCount: watches.length,
        recommendedMinutes: cadence.recommendedMinutes,
        basis: cadence.basis,
        sampleWatchIds: watches.slice(0, 5).map((watch) => watch.id),
      };
    })
    .sort((a, b) => a.recommendedMinutes - b.recommendedMinutes || b.watchCount - a.watchCount);

  return { mode, recommendations };
}
