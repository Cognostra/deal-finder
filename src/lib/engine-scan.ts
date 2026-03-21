import type { ResolvedDealConfig } from "../config.js";
import type { ScanResultItem, Watch } from "../types.js";
import { cappedFetch } from "./fetch.js";
import { extractListing } from "./heuristics.js";
import { buildAlerts, describeFetchSource, finalizeResult, snapshotFromExtracted } from "./engine-result.js";
import { PerHostRateLimiter } from "./host-limiter.js";
import { validateTargetUrl } from "./url-policy.js";

export async function scanOneWatch(
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

    const after = snapshotFromExtracted(extracted, meta, fetchSource, before);
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

export function buildInvalidWatchResult(w: Watch, error: unknown): ScanResultItem {
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
