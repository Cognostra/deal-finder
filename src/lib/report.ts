import type { ResolvedDealConfig } from "../config.js";
import type { StoreFile, Watch } from "../types.js";
import { buildWatchSignals } from "./watch-view.js";

export function buildStoreReport(store: StoreFile): {
  total: number;
  enabled: number;
  disabled: number;
  withSnapshots: number;
  withSignals: number;
  topSignals: Array<{ watchId: string; label?: string; url: string; signals: string[] }>;
} {
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

  return {
    total: watches.length,
    enabled: watches.filter((watch) => watch.enabled).length,
    disabled: watches.filter((watch) => !watch.enabled).length,
    withSnapshots: watches.filter((watch) => Boolean(watch.lastSnapshot)).length,
    withSignals: topSignals.length,
    topSignals,
  };
}

export function buildHealthSummary(store: StoreFile, cfg: ResolvedDealConfig, storePath: string): {
  storePath: string;
  watchCount: number;
  enabledCount: number;
  fetcher: ResolvedDealConfig["fetcher"];
  requestTimeoutMs: number;
  maxConcurrent: number;
  maxBytesPerResponse: number;
  defaultMaxRpsPerHost: number;
  proxyConfigured: boolean;
  allowedHostsConfigured: boolean;
  blockedHostsConfigured: boolean;
  recommendations: string[];
} {
  const recommendations: string[] = [];

  if (!cfg.allowedHosts?.length) {
    recommendations.push("Consider setting allowedHosts so scans are limited to trusted retailer domains.");
  }
  if (store.watches.length === 0) {
    recommendations.push("Add at least one watch with deal_watch_add before scheduling cron scans.");
  }
  if (store.watches.some((watch) => !watch.enabled)) {
    recommendations.push("Use deal_watch_search or deal_watch_set_enabled to review disabled watches.");
  }

  return {
    storePath,
    watchCount: store.watches.length,
    enabledCount: store.watches.filter((watch) => watch.enabled).length,
    fetcher: cfg.fetcher,
    requestTimeoutMs: cfg.requestTimeoutMs,
    maxConcurrent: cfg.maxConcurrent,
    maxBytesPerResponse: cfg.maxBytesPerResponse,
    defaultMaxRpsPerHost: cfg.defaultMaxRpsPerHost,
    proxyConfigured: Boolean(cfg.proxyUrl),
    allowedHostsConfigured: Boolean(cfg.allowedHosts?.length),
    blockedHostsConfigured: Boolean(cfg.blockedHosts?.length),
    recommendations,
  };
}
