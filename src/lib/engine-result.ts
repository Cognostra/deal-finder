import type { ResolvedDealConfig } from "../config.js";
import type {
  AlertSeverity,
  ExtractedListing,
  ExtractionConfidence,
  FetchMeta,
  FetchSource,
  ScanChangeType,
  ScanResultItem,
  Watch,
  WatchSnapshot,
} from "../types.js";
import { extractListing, hashSnippet } from "./heuristics.js";

export function buildAlerts(w: Watch, prev: WatchSnapshot | undefined, next: WatchSnapshot): string[] {
  const alerts: string[] = [];
  const p = next.price ?? prev?.price;
  if (w.maxPrice != null && p != null && p <= w.maxPrice) {
    alerts.push(`price_${p}_at_or_below_max_${w.maxPrice}`);
  }
  if (
    w.percentDrop != null &&
    prev?.price != null &&
    next.price != null &&
    prev.price > 0 &&
    next.price < prev.price
  ) {
    const drop = ((prev.price - next.price) / prev.price) * 100;
    if (drop >= w.percentDrop) {
      alerts.push(`price_drop_${drop.toFixed(1)}_percent`);
    }
  }
  if (next.price != null && next.price <= 0.01 && prev?.price != null && prev.price > 5) {
    alerts.push("possible_price_glitch");
  }
  if (w.keywords?.length) {
    const blob = `${next.title ?? ""} ${next.rawSnippet ?? ""}`.toLowerCase();
    for (const k of w.keywords) {
      if (k && blob.includes(k.toLowerCase())) alerts.push(`keyword:${k}`);
    }
  }
  return alerts;
}

export function snapshotFromExtracted(
  extracted: ReturnType<typeof extractListing>,
  meta: FetchMeta,
  fetchSource: FetchSource,
  prev?: WatchSnapshot,
): WatchSnapshot {
  const rawSnippet = extracted.snippet?.slice(0, 2000);
  const contentHash = rawSnippet ? hashSnippet(rawSnippet) : prev?.contentHash;
  return {
    title: extracted.title,
    canonicalTitle: extracted.canonicalTitle,
    brand: extracted.brand,
    modelId: extracted.modelId,
    sku: extracted.sku,
    mpn: extracted.mpn,
    gtin: extracted.gtin,
    asin: extracted.asin,
    price: extracted.price,
    currency: extracted.currency,
    etag: meta.etag ?? prev?.etag,
    lastModified: meta.lastModified ?? prev?.lastModified,
    contentHash,
    fetchedAt: new Date().toISOString(),
    rawSnippet,
    fetchSource,
    responseBytes: meta.bytesRead,
    responseTruncated: meta.truncated ?? false,
  };
}

function formatMoney(price?: number, currency?: string): string {
  if (price == null) return "no price";
  return currency ? `${price.toFixed(2)} ${currency}` : price.toFixed(2);
}

function formatSignedMoney(value?: number, currency?: string): string | undefined {
  if (value == null) return undefined;
  const sign = value > 0 ? "+" : "";
  return currency ? `${sign}${value.toFixed(2)} ${currency}` : `${sign}${value.toFixed(2)}`;
}

function sameSnapshot(
  before: WatchSnapshot | undefined,
  after: WatchSnapshot | undefined,
): boolean {
  if (!before || !after) return false;
  return (
    before.canonicalTitle === after.canonicalTitle &&
    before.price === after.price &&
    before.currency === after.currency &&
    before.contentHash === after.contentHash
  );
}

function buildExtractionConfidence(args: {
  extracted?: ExtractedListing;
  before?: WatchSnapshot;
  after?: WatchSnapshot;
  meta?: FetchMeta;
}): ExtractionConfidence {
  const { extracted, before, after, meta } = args;
  const reasons: string[] = [];

  if (meta?.notModified && before) {
    return {
      score: 95,
      level: "high",
      reasons: ["HTTP 304 not modified; previous snapshot reused."],
    };
  }

  let score = 0;
  const title = extracted?.title ?? after?.title;
  const price = extracted?.price ?? after?.price;
  const currency = extracted?.currency ?? after?.currency;
  const snippet = extracted?.snippet ?? after?.rawSnippet;

  if (title) {
    score += 35;
    reasons.push("Extracted a title.");
  }
  if (price != null) {
    score += 45;
    reasons.push("Extracted a price.");
  }
  if (price != null && currency) {
    score += 10;
    reasons.push("Price includes a currency.");
  }
  if (snippet && snippet.length >= 80) {
    score += 10;
    reasons.push("Captured a useful snippet preview.");
  } else if (snippet && score === 0) {
    score += 15;
    reasons.push("Only snippet evidence was available.");
  }

  if (meta?.truncated) {
    reasons.push("Response hit the configured byte cap; extraction may be incomplete.");
  }

  const bounded = Math.min(100, score);
  const level =
    bounded >= 75 ? "high" : bounded >= 45 ? "medium" : bounded > 0 ? "low" : "none";

  if (reasons.length === 0) {
    reasons.push("No reliable product fields were extracted.");
  }

  return { score: bounded, level, reasons };
}

function scoreAlerts(alerts: string[]): number {
  let score = 0;
  for (const alert of alerts) {
    if (alert === "possible_price_glitch") {
      score += 95;
      continue;
    }
    if (alert.startsWith("price_") && alert.includes("_at_or_below_max_")) {
      score += 85;
      continue;
    }
    if (alert.startsWith("price_drop_")) {
      const match = alert.match(/price_drop_([\d.]+)_percent/);
      const drop = Number.parseFloat(match?.[1] ?? "");
      score += Number.isFinite(drop) ? Math.max(60, Math.min(90, Math.round(drop))) : 70;
      continue;
    }
    if (alert.startsWith("keyword:")) {
      score += 30;
      continue;
    }
    score += 20;
  }
  return Math.min(100, score);
}

function scoreToSeverity(score: number): AlertSeverity {
  if (score >= 75) return "high";
  if (score >= 40) return "medium";
  if (score > 0) return "low";
  return "none";
}

function changedFields(before: WatchSnapshot, after: WatchSnapshot): string[] {
  const fields: string[] = [];
  if (before.canonicalTitle !== after.canonicalTitle) fields.push("title");
  if (before.price !== after.price) fields.push("price");
  if (before.currency !== after.currency) fields.push("currency");
  if (before.contentHash !== after.contentHash) fields.push("content");
  return fields;
}

export function describeFetchSource(cfg: ResolvedDealConfig): {
  fetchSource: FetchSource;
  fetchSourceNote: string;
} {
  if (cfg.fetcher === "firecrawl") {
    return {
      fetchSource: "firecrawl",
      fetchSourceNote: "Fetched through the Firecrawl scrape API from the Node engine.",
    };
  }
  return {
    fetchSource: "node_http",
    fetchSourceNote: "Fetched directly over HTTP by the Node engine.",
  };
}

function classifyChange(args: {
  ok: boolean;
  before?: WatchSnapshot;
  after?: WatchSnapshot;
  meta?: FetchMeta;
}): { changed: boolean; changeType: ScanChangeType; changeReasons: string[] } {
  const { ok, before, after, meta } = args;

  if (!ok) {
    return {
      changed: false,
      changeType: "fetch_failed",
      changeReasons: ["Fetch failed before a new snapshot could be recorded."],
    };
  }

  if (meta?.notModified && before) {
    return {
      changed: false,
      changeType: "not_modified",
      changeReasons: ["Server returned 304 Not Modified; previous snapshot reused."],
    };
  }

  if (!before && after) {
    return {
      changed: true,
      changeType: "first_seen",
      changeReasons: ["Initial snapshot captured for this watch."],
    };
  }

  if (before && after) {
    if (sameSnapshot(before, after)) {
      return {
        changed: false,
        changeType: "unchanged",
        changeReasons: ["No material title, price, currency, or content change detected."],
      };
    }

    if (before.price != null && after.price != null && after.price !== before.price) {
      const direction = after.price < before.price ? "price_drop" : "price_increase";
      const changeText =
        direction === "price_drop"
          ? `Price dropped from ${formatMoney(before.price, before.currency)} to ${formatMoney(after.price, after.currency)}.`
          : `Price increased from ${formatMoney(before.price, before.currency)} to ${formatMoney(after.price, after.currency)}.`;
      return {
        changed: true,
        changeType: direction,
        changeReasons: [changeText],
      };
    }

    const fields = changedFields(before, after);
    return {
      changed: true,
      changeType: "content_changed",
      changeReasons: fields.length
        ? [`Changed fields: ${fields.join(", ")}.`]
        : ["Content changed."],
    };
  }

  return {
    changed: false,
    changeType: "unchanged",
    changeReasons: ["No new snapshot was produced."],
  };
}

function buildSummaryLine(args: {
  label?: string;
  url: string;
  ok: boolean;
  error?: string;
  changeType: ScanChangeType;
  alertSeverity: AlertSeverity;
  confidence: ExtractionConfidence;
  before?: WatchSnapshot;
  after?: WatchSnapshot;
  priceDelta?: number;
  percentDelta?: number;
  meta?: FetchMeta;
}): string {
  const { label, url, ok, error, changeType, alertSeverity, confidence, before, after, priceDelta, percentDelta, meta } =
    args;
  const subject = label?.trim() || after?.title || before?.title || url;

  if (!ok) {
    return `${subject}: fetch failed (${(error ?? "unknown error").slice(0, 160)})`;
  }

  if (changeType === "not_modified") {
    return `${subject}: unchanged; reused cached snapshot at ${formatMoney(after?.price, after?.currency)}`;
  }

  const parts = [`${subject}: ${formatMoney(after?.price, after?.currency)}`];

  if (priceDelta != null) {
    const deltaText = formatSignedMoney(priceDelta, after?.currency ?? before?.currency);
    const percentText = percentDelta != null ? ` (${percentDelta > 0 ? "+" : ""}${percentDelta.toFixed(1)}%)` : "";
    if (deltaText) {
      parts.push(`delta ${deltaText}${percentText}`);
    }
  }

  if (changeType === "first_seen") {
    parts.push("first snapshot");
  } else if (changeType === "unchanged") {
    parts.push("no material change");
  } else if (changeType === "content_changed") {
    parts.push("content changed");
  } else if (changeType === "price_drop") {
    parts.push("price dropped");
  } else if (changeType === "price_increase") {
    parts.push("price increased");
  }

  if (alertSeverity !== "none") {
    parts.push(`${alertSeverity} alert`);
  }
  if (confidence.level === "low" || confidence.level === "none") {
    parts.push(`parse confidence ${confidence.level}`);
  }
  if (meta?.truncated) {
    parts.push("response hit byte cap");
  }

  return parts.join("; ");
}

export function finalizeResult(args: {
  watchId: string;
  label?: string;
  url: string;
  fetchSource: FetchSource;
  fetchSourceNote: string;
  ok: boolean;
  error?: string;
  timingMs: { fetch: number; parse: number; total: number };
  meta?: FetchMeta;
  before?: WatchSnapshot;
  after?: WatchSnapshot;
  extracted?: ExtractedListing;
  alerts: string[];
}): ScanResultItem {
  const {
    watchId,
    label,
    url,
    fetchSource,
    fetchSourceNote,
    ok,
    error,
    timingMs,
    meta,
    before,
    after,
    extracted,
    alerts,
  } = args;
  const previousPrice = before?.price;
  const currentPrice = after?.price;
  const priceDelta =
    previousPrice != null && currentPrice != null ? Number((currentPrice - previousPrice).toFixed(2)) : undefined;
  const percentDelta =
    previousPrice != null && currentPrice != null && previousPrice > 0
      ? Number((((currentPrice - previousPrice) / previousPrice) * 100).toFixed(1))
      : undefined;
  const classification = classifyChange({ ok, before, after, meta });
  const extractionConfidence = buildExtractionConfidence({ extracted, before, after, meta });
  const alertScore = scoreAlerts(alerts);
  const alertSeverity = scoreToSeverity(alertScore);
  const summaryLine = buildSummaryLine({
    label,
    url,
    ok,
    error,
    changeType: classification.changeType,
    alertSeverity,
    confidence: extractionConfidence,
    before,
    after,
    priceDelta,
    percentDelta,
    meta,
  });

  return {
    watchId,
    label,
    url,
    fetchSource,
    fetchSourceNote,
    responseTruncated: meta?.truncated ?? false,
    ok,
    error,
    changed: classification.changed,
    changeType: classification.changeType,
    changeReasons: classification.changeReasons,
    previousPrice,
    currentPrice,
    previousCurrency: before?.currency,
    currentCurrency: after?.currency,
    priceDelta,
    percentDelta,
    alertSeverity,
    alertScore,
    extractionConfidence,
    summaryLine,
    timingMs,
    meta,
    before,
    after,
    extracted,
    alerts,
    reviewMode: "off",
    reviewQueued: false,
    reviewApplied: false,
    reviewWarnings: [],
    reviewedFields: [],
  };
}
