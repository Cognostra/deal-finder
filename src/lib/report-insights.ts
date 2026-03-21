import type {
  AlertSeverity,
  FetchSource,
  ProductIdentityEntry,
  ReviewedSnapshotField,
  Watch,
  WatchHistoryEntry,
  WatchImportSource,
} from "../types.js";
import { getWatchIdentityFields } from "./product-identity.js";
import { buildWatchSignals } from "./watch-view.js";

function getHistoryEntries(watch: Watch): WatchHistoryEntry[] {
  return watch.history ?? [];
}

function getHistoryPrices(watch: Watch): number[] {
  return getHistoryEntries(watch)
    .map((entry) => entry.price)
    .filter((price): price is number => price != null);
}

function sparkline(values: number[]): string {
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

function summarizeImportSource(source: WatchImportSource | undefined): {
  type: "manual" | "url_import" | "discovery_import";
  summary: string;
  importedAt?: string;
} {
  if (!source) {
    return {
      type: "manual",
      summary: "Watch was created directly in this store.",
    };
  }
  if (source.type === "url") {
    return {
      type: "url_import",
      importedAt: source.importedAt,
      summary: `Watch was imported from a remote or exported watchlist URL on ${source.importedAt}.`,
    };
  }
  return {
    type: "discovery_import",
    importedAt: source.importedAt,
    summary: `Watch was imported from discovery candidate ${source.candidateUrl} using ${source.discoveryProvider}.`,
  };
}

function summarizeReviewedFields(reviewedFields: ReviewedSnapshotField[] | undefined): {
  count: number;
  fields: string[];
  lastReviewedAt?: string;
  reviewSources: string[];
  providerModels: string[];
} {
  const entries = reviewedFields ?? [];
  const providerModels = [...new Set(entries.map((entry) => [entry.provider, entry.model].filter(Boolean).join("/")).filter(Boolean))].sort();
  const reviewSources = [...new Set(entries.map((entry) => entry.reviewSource).filter(Boolean))].sort();
  const lastReviewedAt = [...entries.map((entry) => entry.reviewedAt).filter(Boolean)].sort().at(-1);
  return {
    count: entries.length,
    fields: entries.map((entry) => entry.field),
    lastReviewedAt,
    reviewSources,
    providerModels,
  };
}

function describeFetchSource(source: FetchSource | undefined): string | undefined {
  if (source === "firecrawl") return "Firecrawl";
  if (source === "node_http") return "Node HTTP";
  return undefined;
}

function buildGlitchAssessment(
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

function buildNoiseAssessment(
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
    if (delta !== 0) {
      directionSigns.push(delta > 0 ? 1 : -1);
    }
  }

  let directionChanges = 0;
  for (let i = 1; i < directionSigns.length; i += 1) {
    if (directionSigns[i] !== directionSigns[i - 1]) {
      directionChanges += 1;
    }
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

  if (!watch.enabled) {
    score = Math.max(0, score - 10);
  }

  return {
    score: Math.min(100, score),
    reasons,
    pricePointCount: uniquePrices.size,
  };
}

function classifyTrend(watch: Watch, history: ReturnType<typeof summarizeHistory>): {
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

export function buildWatchInsights(
  watch: Watch,
): {
  watchId: string;
  label?: string;
  url: string;
  latestPrice?: number;
  lowestSeenPrice?: number;
  highestSeenPrice?: number;
  priceDelta?: number;
  percentDelta?: number;
  trend: {
    direction: "up" | "down" | "flat" | "volatile" | "unknown";
    label: string;
    confidence: "low" | "medium" | "high";
    reasons: string[];
  };
  volatility: {
    score: number;
    reasons: string[];
    pricePointCount: number;
  };
  glitch: {
    score: number;
    reasons: string[];
  };
  currentPosition?: {
    fromLow?: number;
    fromHigh?: number;
  };
  activeSignals: string[];
  sparkline: string;
  historyCount: number;
  identity: ProductIdentityEntry[];
} {
  const history = summarizeHistory(watch);
  const trend = classifyTrend(watch, history);
  const volatility = buildNoiseAssessment(watch, history);
  const activeSignals = buildWatchSignals(watch);
  const glitch = buildGlitchAssessment(watch, history, activeSignals);
  const latestPrice = history.latestEntry?.price ?? watch.lastSnapshot?.price;
  const currentPosition =
    latestPrice != null
      ? {
          fromLow:
            history.lowestSeenPrice != null ? Number((latestPrice - history.lowestSeenPrice).toFixed(2)) : undefined,
          fromHigh:
            history.highestSeenPrice != null ? Number((history.highestSeenPrice - latestPrice).toFixed(2)) : undefined,
        }
      : undefined;

  return {
    watchId: watch.id,
    label: watch.label,
    url: watch.url,
    latestPrice,
    lowestSeenPrice: history.lowestSeenPrice,
    highestSeenPrice: history.highestSeenPrice,
    priceDelta: history.priceDelta,
    percentDelta: history.percentDelta,
    trend,
    volatility,
    glitch,
    currentPosition,
    activeSignals,
    sparkline: sparkline(getHistoryPrices(watch).slice(-12)),
    historyCount: history.historyCount,
    identity: getWatchIdentityFields(watch),
  };
}

export function buildWatchProvenanceSummary(
  watch: Watch,
): {
  watchId: string;
  label?: string;
  url: string;
  createdAt: string;
  enabled: boolean;
  origin: ReturnType<typeof summarizeImportSource>;
  history: {
    count: number;
    firstSeenAt?: string;
    lastSeenAt?: string;
  };
  lastSnapshot: null | {
    fetchedAt: string;
    title?: string;
    price?: number;
    currency?: string;
    fetchSource?: FetchSource;
    fetchSourceLabel?: string;
    responseBytes?: number;
    responseTruncated: boolean;
    reviewedFieldCount: number;
    reviewedFields: string[];
    lastReviewedAt?: string;
    reviewSources: string[];
    providerModels: string[];
  };
  provenanceNotes: string[];
} {
  const history = summarizeHistory(watch);
  const origin = summarizeImportSource(watch.importSource);
  const reviewed = summarizeReviewedFields(watch.lastSnapshot?.reviewedFields);
  const lastSnapshot = watch.lastSnapshot
    ? {
        fetchedAt: watch.lastSnapshot.fetchedAt,
        title: watch.lastSnapshot.title,
        price: watch.lastSnapshot.price,
        currency: watch.lastSnapshot.currency,
        fetchSource: watch.lastSnapshot.fetchSource,
        fetchSourceLabel: describeFetchSource(watch.lastSnapshot.fetchSource),
        responseBytes: watch.lastSnapshot.responseBytes,
        responseTruncated: watch.lastSnapshot.responseTruncated ?? false,
        reviewedFieldCount: reviewed.count,
        reviewedFields: reviewed.fields,
        lastReviewedAt: reviewed.lastReviewedAt,
        reviewSources: reviewed.reviewSources,
        providerModels: reviewed.providerModels,
      }
    : null;

  const provenanceNotes: string[] = [origin.summary];
  if (watch.lastSnapshot?.responseTruncated) {
    provenanceNotes.push("Latest committed snapshot hit the configured byte cap; extracted fields may be incomplete.");
  }
  if (reviewed.count > 0) {
    provenanceNotes.push(`Latest committed snapshot contains ${reviewed.count} reviewed field${reviewed.count === 1 ? "" : "s"}.`);
  }
  if (!watch.lastSnapshot) {
    provenanceNotes.push("This watch has no committed snapshot yet.");
  }

  return {
    watchId: watch.id,
    label: watch.label,
    url: watch.url,
    createdAt: watch.createdAt,
    enabled: watch.enabled,
    origin,
    history: {
      count: history.historyCount,
      firstSeenAt: history.firstSeenAt,
      lastSeenAt: history.lastSeenAt,
    },
    lastSnapshot,
    provenanceNotes,
  };
}
