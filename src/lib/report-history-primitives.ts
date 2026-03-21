import type { AlertSeverity, Watch, WatchHistoryEntry } from "../types.js";

export function getHistoryEntries(watch: Watch): WatchHistoryEntry[] {
  return watch.history ?? [];
}

export function getHistoryPrices(watch: Watch): number[] {
  return getHistoryEntries(watch)
    .map((entry) => entry.price)
    .filter((price): price is number => price != null);
}

export function compareSeverity(a: AlertSeverity, b: AlertSeverity): number {
  const order = { none: 0, low: 1, medium: 2, high: 3 } as const;
  return order[a] - order[b];
}

export function sparkline(values: number[]): string {
  if (!values.length) return "";
  const bars = "▁▂▃▄▅▆▇█";
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) return bars[3]!.repeat(values.length);
  return values
    .map((value) => {
      const index = Math.max(0, Math.min(bars.length - 1, Math.round(((value - min) / (max - min)) * (bars.length - 1))));
      return bars[index]!;
    })
    .join("");
}

export function summarizeHistory(watch: Watch) {
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

export function buildGlitchAssessment(
  watch: Watch,
  history: ReturnType<typeof summarizeHistory>,
  signals: string[],
): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  const latest = history.latestEntry;
  const previous = history.previousEntry;

  if (latest?.alerts?.includes("possible_price_glitch")) {
    score = Math.max(score, 95);
    reasons.push("Latest committed alert flagged a possible price glitch.");
  }

  if (latest?.price != null && latest.price <= 0.01 && previous?.price != null && previous.price >= 5) {
    score = Math.max(score, 95);
    reasons.push("Latest observed price is near zero after a normal previous price.");
  }

  if (history.percentDelta != null && history.percentDelta <= -90) {
    score = Math.max(score, 80);
    reasons.push(`Latest price drop was ${Math.abs(history.percentDelta).toFixed(1)}%.`);
  }

  if (
    latest?.price != null &&
    history.highestSeenPrice != null &&
    latest.price > 0 &&
    history.highestSeenPrice / latest.price >= 20
  ) {
    score = Math.max(score, 70);
    reasons.push("Historical peak price is far above the latest observed price.");
  }

  if (signals.some((signal) => signal.startsWith("max_price_hit:")) && latest?.price != null && latest.price < 1) {
    score = Math.max(score, 60);
    reasons.push("Current max-price hit is unusually close to zero.");
  }

  return { score, reasons };
}

export function buildNoiseAssessment(
  watch: Watch,
  history: ReturnType<typeof summarizeHistory>,
): { score: number; reasons: string[]; pricePointCount: number } {
  const entries = history.history.slice(-8);
  const reasons: string[] = [];
  const pricePoints = entries
    .map((entry) => entry.price)
    .filter((price): price is number => price != null);
  const uniquePrices = new Set(pricePoints.map((price) => price.toFixed(2)));
  const directionSigns: number[] = [];

  for (let i = 1; i < pricePoints.length; i += 1) {
    const delta = pricePoints[i]! - pricePoints[i - 1]!;
    if (delta !== 0) directionSigns.push(delta > 0 ? 1 : -1);
  }

  let directionChanges = 0;
  for (let i = 1; i < directionSigns.length; i += 1) {
    if (directionSigns[i] !== directionSigns[i - 1]) directionChanges += 1;
  }

  let score = 0;
  if (entries.length >= 4) {
    score += Math.min(30, entries.length * 4);
    reasons.push("Watch has several committed history points.");
  }
  if (uniquePrices.size >= 4) {
    score += 25;
    reasons.push("Watch has moved across many distinct price points.");
  }
  if (directionChanges >= 1) {
    score += directionChanges * 20;
    reasons.push("Price direction flipped across recent history.");
  }
  const contentChanges = entries.filter((entry) => entry.changeType === "content_changed").length;
  if (contentChanges >= 2) {
    score += 15;
    reasons.push("Content changed repeatedly without a stable pricing pattern.");
  }
  if (
    history.lowestSeenPrice != null &&
    history.highestSeenPrice != null &&
    history.lowestSeenPrice > 0 &&
    ((history.highestSeenPrice - history.lowestSeenPrice) / history.lowestSeenPrice) * 100 >= 40
  ) {
    score += 20;
    reasons.push("Observed price range is wide relative to the low price.");
  }

  if (!watch.enabled) score = Math.max(0, score - 10);

  return { score: Math.min(100, score), reasons, pricePointCount: uniquePrices.size };
}

export function classifyTrend(
  watch: Watch,
  history: ReturnType<typeof summarizeHistory>,
): {
  direction: "up" | "down" | "flat" | "volatile" | "unknown";
  label: string;
  confidence: "low" | "medium" | "high";
  reasons: string[];
} {
  const reasons: string[] = [];
  const entries = history.history.slice(-6);
  const prices = entries.map((entry) => entry.price).filter((price): price is number => price != null);
  if (prices.length < 2) {
    return { direction: "unknown", label: "insufficient_history", confidence: "low", reasons: ["Need at least two price points."] };
  }

  const first = prices[0]!;
  const last = prices[prices.length - 1]!;
  const netPercent = first > 0 ? ((last - first) / first) * 100 : 0;
  const noise = buildNoiseAssessment(watch, history);

  if (noise.score >= 60) {
    reasons.push("Recent history is noisy and changed direction repeatedly.");
    return { direction: "volatile", label: "volatile", confidence: "high", reasons };
  }
  if (Math.abs(netPercent) < 3) {
    reasons.push("Recent net movement is small.");
    return { direction: "flat", label: "flat", confidence: "medium", reasons };
  }
  if (netPercent <= -3) {
    reasons.push(`Recent net movement is down ${Math.abs(netPercent).toFixed(1)}%.`);
    return { direction: "down", label: "falling", confidence: Math.abs(netPercent) >= 10 ? "high" : "medium", reasons };
  }
  reasons.push(`Recent net movement is up ${netPercent.toFixed(1)}%.`);
  return { direction: "up", label: "rising", confidence: netPercent >= 10 ? "high" : "medium", reasons };
}
