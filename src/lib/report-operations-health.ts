import type { ResolvedDealConfig } from "../config.js";
import type { StoreFile } from "../types.js";

export function buildHealthSummary(store: StoreFile, cfg: ResolvedDealConfig, storePath: string): {
  storePath: string;
  watchCount: number;
  enabledCount: number;
  importedWatchCount: number;
  discoveryImportedCount: number;
  reviewedSnapshotCount: number;
  truncatedSnapshotCount: number;
  fetcher: ResolvedDealConfig["fetcher"];
  discoveryEnabled: boolean;
  discoveryProvider: ResolvedDealConfig["discovery"]["provider"];
  discoveryAllowedHostsConfigured: boolean;
  discoveryFirecrawlReady: boolean;
  reviewMode: ResolvedDealConfig["llmReview"]["mode"];
  reviewBudgetPerScan: number;
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
  if (cfg.discovery.enabled && cfg.discovery.provider === "manual") {
    recommendations.push("Use deal_discovery_backlog and deal_discovery_report to plan manual candidate expansion before importing anything.");
  }
  if (cfg.discovery.enabled && cfg.discovery.provider === "firecrawl-search" && !cfg.firecrawlApiKey) {
    recommendations.push('discovery.provider is "firecrawl-search" but firecrawlApiKey is missing; discovery search will not work until it is configured.');
  }
  if (cfg.discovery.enabled && cfg.discovery.provider === "firecrawl-search" && !cfg.discovery.allowedHosts?.length) {
    recommendations.push("Set discovery.allowedHosts to explicit trusted retailer hosts before using provider-backed discovery search.");
  }
  if (cfg.llmReview.mode === "queue") {
    recommendations.push("Use deal_llm_review_queue and deal_review_policy to inspect queued low-confidence reviews.");
  }
  if (cfg.llmReview.mode === "auto_assist") {
    recommendations.push("Review deal_review_policy so automatic low-confidence review stays within your intended budget and rewrite rules.");
  }
  if (store.watches.some((watch) => watch.lastSnapshot?.responseTruncated)) {
    recommendations.push("Some committed snapshots hit the response byte cap. Use deal_watch_provenance or raise maxBytesPerResponse if extraction looks incomplete.");
  }

  return {
    storePath,
    watchCount: store.watches.length,
    enabledCount: store.watches.filter((watch) => watch.enabled).length,
    importedWatchCount: store.watches.filter((watch) => Boolean(watch.importSource)).length,
    discoveryImportedCount: store.watches.filter((watch) => watch.importSource?.type === "discovery").length,
    reviewedSnapshotCount: store.watches.filter((watch) => Boolean(watch.lastSnapshot?.reviewedFields?.length)).length,
    truncatedSnapshotCount: store.watches.filter((watch) => Boolean(watch.lastSnapshot?.responseTruncated)).length,
    fetcher: cfg.fetcher,
    discoveryEnabled: cfg.discovery.enabled,
    discoveryProvider: cfg.discovery.provider,
    discoveryAllowedHostsConfigured: Boolean(cfg.discovery.allowedHosts?.length),
    discoveryFirecrawlReady: Boolean(cfg.firecrawlApiKey),
    reviewMode: cfg.llmReview.mode,
    reviewBudgetPerScan: cfg.llmReview.maxReviewsPerScan,
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

export function buildDoctorSummary(store: StoreFile, cfg: ResolvedDealConfig, storePath: string): {
  storePath: string;
  issueCount: number;
  issues: Array<{ severity: "info" | "warn"; code: string; message: string }>;
  recommendedCommands: string[];
} {
  const issues: Array<{ severity: "info" | "warn"; code: string; message: string }> = [];

  if (store.watches.length === 0) {
    issues.push({
      severity: "warn",
      code: "no_watches",
      message: "No watches are configured yet. Add a watch before relying on cron or summaries.",
    });
  }

  if (!cfg.allowedHosts?.length) {
    issues.push({
      severity: "warn",
      code: "missing_allowed_hosts",
      message: "allowedHosts is not configured. The plugin is still protected, but an allowlist would tighten scope.",
    });
  }

  if (cfg.fetcher === "firecrawl" && !cfg.firecrawlApiKey) {
    issues.push({
      severity: "warn",
      code: "missing_firecrawl_api_key",
      message: 'fetcher is set to "firecrawl" but firecrawlApiKey is not configured.',
    });
  }

  if (store.watches.some((watch) => !watch.enabled)) {
    issues.push({
      severity: "info",
      code: "disabled_watches_present",
      message: "Some watches are disabled. Review them with deal_watch_search if this is unexpected.",
    });
  }

  if (cfg.discovery.enabled && cfg.discovery.provider === "firecrawl-search" && !cfg.firecrawlApiKey) {
    issues.push({
      severity: "warn",
      code: "discovery_missing_firecrawl_api_key",
      message: 'discovery.provider is set to "firecrawl-search" but firecrawlApiKey is not configured.',
    });
  }

  if (cfg.discovery.enabled && cfg.discovery.provider === "firecrawl-search" && !cfg.discovery.allowedHosts?.length) {
    issues.push({
      severity: "warn",
      code: "discovery_missing_allowed_hosts",
      message: 'discovery.provider is "firecrawl-search" but discovery.allowedHosts is empty; bounded provider-backed discovery should use explicit trusted hosts.',
    });
  }

  if (cfg.discovery.enabled && cfg.discovery.provider === "manual") {
    issues.push({
      severity: "info",
      code: "manual_discovery_enabled",
      message: "Manual discovery is enabled. Use deal_discovery_backlog or deal_discovery_report to plan explicit candidate work.",
    });
  }

  if (cfg.llmReview.mode === "queue") {
    issues.push({
      severity: "info",
      code: "review_queue_mode",
      message: "Scan-time review is in queue mode; low-confidence results will queue review metadata without invoking a model.",
    });
  }

  if (cfg.llmReview.mode === "auto_assist") {
    issues.push({
      severity: "info",
      code: "review_auto_assist_enabled",
      message: "Scan-time review auto-assist is enabled; low-confidence results may invoke bounded model review during scans.",
    });
  }

  if (store.watches.some((watch) => watch.lastSnapshot?.responseTruncated)) {
    issues.push({
      severity: "info",
      code: "truncated_snapshots_present",
      message: "Some committed snapshots hit the configured byte cap. Use deal_watch_provenance or deal_extraction_debug to inspect whether extraction is incomplete.",
    });
  }

  if (issues.length === 0) {
    issues.push({
      severity: "info",
      code: "healthy_defaults",
      message: "No obvious configuration problems were detected.",
    });
  }

  return {
    storePath,
    issueCount: issues.length,
    issues,
    recommendedCommands: [
      "deal_help",
      "deal_watch_search",
      "deal_watch_provenance",
      "deal_discovery_policy",
      "deal_review_policy",
      "deal_report",
      "deal_health",
    ],
  };
}
