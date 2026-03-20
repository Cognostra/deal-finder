import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { ResolvedDealConfig } from "../config.js";
import type {
  AlertSeverity,
  ExtractedListing,
  ExtractionConfidence,
  FetchMeta,
  FetchSource,
  ScanChangeType,
  ScanResultItem,
  StoreFile,
  Watch,
  WatchSnapshot,
} from "../types.js";
import { cappedFetch } from "./fetch.js";
import { extractListing, hashSnippet } from "./heuristics.js";
import { mapPool } from "./concurrency.js";
import { PerHostRateLimiter } from "./host-limiter.js";
import { appendWatchHistory, saveStore } from "./store.js";
import { validateTargetUrl } from "./url-policy.js";

function buildAlerts(w: Watch, prev: WatchSnapshot | undefined, next: WatchSnapshot): string[] {
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

function snapshotFromExtracted(
  extracted: ReturnType<typeof extractListing>,
  meta: import("../types.js").FetchMeta,
  prev?: WatchSnapshot,
): WatchSnapshot {
  const rawSnippet = extracted.snippet?.slice(0, 2000);
  const contentHash = rawSnippet ? hashSnippet(rawSnippet) : prev?.contentHash;
  return {
    title: extracted.title,
    canonicalTitle: extracted.canonicalTitle,
    price: extracted.price,
    currency: extracted.currency,
    etag: meta.etag ?? prev?.etag,
    lastModified: meta.lastModified ?? prev?.lastModified,
    contentHash,
    fetchedAt: new Date().toISOString(),
    rawSnippet,
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

function describeFetchSource(cfg: ResolvedDealConfig): {
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
}): string {
  const { label, url, ok, error, changeType, alertSeverity, confidence, before, after, priceDelta, percentDelta } =
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

  return parts.join("; ");
}

function finalizeResult(args: {
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
  });

  return {
    watchId,
    label,
    url,
    fetchSource,
    fetchSourceNote,
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
  };
}

async function scanOneWatch(
  w: Watch,
  cfg: ResolvedDealConfig,
  limiter: PerHostRateLimiter,
  signal: AbortSignal | undefined,
): Promise<ScanResultItem> {
  const t0 = performance.now();
  let fetchMs = 0;
  let parseMs = 0;
  const before = w.lastSnapshot ? { ...w.lastSnapshot } : undefined;
  const { fetchSource, fetchSourceNote } = describeFetchSource(cfg);

  try {
    const safeUrl = validateTargetUrl(w.url, cfg).toString();
    const host = new URL(safeUrl).hostname;
    await limiter.schedule(host);
    const tf = performance.now();
    const { meta, text } = await cappedFetch(safeUrl, cfg, {
      ifNoneMatch: w.lastSnapshot?.etag,
      ifModifiedSince: w.lastSnapshot?.lastModified,
      signal,
    });
    fetchMs = performance.now() - tf;

    if (meta.notModified && before) {
      const total = performance.now() - t0;
      return finalizeResult({
        watchId: w.id,
        label: w.label,
        url: w.url,
        fetchSource,
        fetchSourceNote,
        ok: true,
        timingMs: { fetch: Math.round(fetchMs), parse: 0, total: Math.round(total) },
        meta,
        before,
        after: before,
        alerts: [],
      });
    }

    if (meta.status < 200 || meta.status >= 400) {
      const total = performance.now() - t0;
      return finalizeResult({
        watchId: w.id,
        label: w.label,
        url: w.url,
        fetchSource,
        fetchSourceNote,
        ok: false,
        error: `HTTP ${meta.status}`,
        timingMs: {
          fetch: Math.round(fetchMs),
          parse: 0,
          total: Math.round(total),
        },
        meta,
        before,
        alerts: [],
      });
    }

    const tp = performance.now();
    const extracted = extractListing(text);
    parseMs = performance.now() - tp;

    const after = snapshotFromExtracted(extracted, meta, before);
    const alerts = buildAlerts(w, before, after);

    const total = performance.now() - t0;
    return finalizeResult({
      watchId: w.id,
      label: w.label,
      url: w.url,
      fetchSource,
      fetchSourceNote,
      ok: true,
      timingMs: {
        fetch: Math.round(fetchMs),
        parse: Math.round(parseMs),
        total: Math.round(total),
      },
      meta,
      before,
      after,
      extracted,
      alerts,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const total = performance.now() - t0;
    return finalizeResult({
      watchId: w.id,
      label: w.label,
      url: w.url,
      fetchSource,
      fetchSourceNote,
      ok: false,
      error: msg,
      timingMs: {
        fetch: Math.round(fetchMs),
        parse: Math.round(parseMs),
        total: Math.round(total),
      },
      before,
      alerts: [],
    });
  }
}

function buildInvalidWatchResult(w: Watch, error: unknown): ScanResultItem {
  const before = w.lastSnapshot ? { ...w.lastSnapshot } : undefined;
  const msg = error instanceof Error ? error.message : String(error);
  return finalizeResult({
    watchId: w.id,
    label: w.label,
    url: w.url,
    fetchSource: "node_http",
    fetchSourceNote: "Watch URL was rejected before any network fetch occurred.",
    ok: false,
    error: msg,
    timingMs: { fetch: 0, parse: 0, total: 0 },
    before,
    alerts: [],
  });
}

function applyCommit(store: StoreFile, results: ScanResultItem[]) {
  for (const r of results) {
    if (!r.ok || !r.after) continue;
    const w = store.watches.find((x) => x.id === r.watchId);
    if (w) {
      appendWatchHistory(w, r);
      w.lastSnapshot = r.after;
    }
  }
}

export type ScanCommitSummary = {
  updated: number;
  skippedMissing: number;
  skippedUrlChanged: number;
  skippedInvalidCurrentUrl: number;
};

export function mergeCommittedScanResults(
  store: StoreFile,
  results: ScanResultItem[],
  cfg: ResolvedDealConfig,
): ScanCommitSummary {
  let updated = 0;
  let skippedMissing = 0;
  let skippedUrlChanged = 0;
  let skippedInvalidCurrentUrl = 0;

  for (const result of results) {
    if (!result.ok || !result.after) continue;

    const currentWatch = store.watches.find((watch) => watch.id === result.watchId);
    if (!currentWatch) {
      skippedMissing += 1;
      continue;
    }

    let currentUrl: string;
    try {
      currentUrl = validateTargetUrl(currentWatch.url, cfg).toString();
    } catch {
      skippedInvalidCurrentUrl += 1;
      continue;
    }

    if (currentUrl !== result.url) {
      skippedUrlChanged += 1;
      continue;
    }

    appendWatchHistory(currentWatch, result);
    currentWatch.lastSnapshot = result.after;
    updated += 1;
  }

  return {
    updated,
    skippedMissing,
    skippedUrlChanged,
    skippedInvalidCurrentUrl,
  };
}

export async function runScan(args: {
  api: OpenClawPluginApi;
  cfg: ResolvedDealConfig;
  store: StoreFile;
  storePath: string;
  watchIds?: string[];
  commit: boolean;
  signal?: AbortSignal;
}): Promise<ScanResultItem[]> {
  const { cfg, store, storePath, watchIds, commit, api } = args;
  let list = store.watches.filter((w) => w.enabled);
  if (watchIds?.length) {
    const set = new Set(watchIds);
    list = list.filter((w) => set.has(w.id));
  }

  const invalidResults: ScanResultItem[] = [];
  const safeList: Watch[] = [];
  for (const watch of list) {
    try {
      const safeUrl = validateTargetUrl(watch.url, cfg).toString();
      safeList.push({ ...watch, url: safeUrl });
    } catch (error) {
      invalidResults.push(buildInvalidWatchResult(watch, error));
    }
  }

  api.logger.debug?.(
    `deal-hunter: scan start engine=node fetcher=${cfg.fetcher} count=${safeList.length} invalid=${invalidResults.length}`,
  );

  const intervalMs = Math.ceil(1000 / Math.max(0.1, cfg.defaultMaxRpsPerHost));
  const limiter = new PerHostRateLimiter(intervalMs);

  const scanResults = await mapPool(safeList, cfg.maxConcurrent, (w) =>
    scanOneWatch(w, cfg, limiter, args.signal),
  );
  const results = invalidResults.concat(scanResults);

  if (commit) {
    applyCommit(store, results);
    await saveStore(storePath, store);
  }

  api.logger.debug?.(
    `deal-hunter: scan complete commit=${commit} count=${results.length} engine=node`,
  );

  return results;
}
