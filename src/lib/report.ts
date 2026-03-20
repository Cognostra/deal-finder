import type { ResolvedDealConfig } from "../config.js";
import type { AlertSeverity, DiscoveryCandidate, FetchSource, LlmReviewCandidate, ProductIdentityEntry, ProductIdentityField, ReviewedSnapshotField, StoreFile, Watch, WatchHistoryEntry, WatchImportSource } from "../types.js";
import { buildProductGroups, buildProductMatchCandidates, getWatchHost, getWatchIdentityFields, getWatchIdentityStrength } from "./product-identity.js";
import { canonicalizeWatchUrl } from "./url-policy.js";
import { buildWatchSignals, searchWatches } from "./watch-view.js";

function getHistoryEntries(watch: Watch): WatchHistoryEntry[] {
  return watch.history ?? [];
}

function getHistoryPrices(watch: Watch): number[] {
  return getHistoryEntries(watch)
    .map((entry) => entry.price)
    .filter((price): price is number => price != null);
}

function compareSeverity(a: AlertSeverity, b: AlertSeverity): number {
  const order = { none: 0, low: 1, medium: 2, high: 3 } as const;
  return order[a] - order[b];
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

export function buildStoreReport(store: StoreFile): {
  total: number;
  savedViewCount: number;
  enabled: number;
  disabled: number;
  withSnapshots: number;
  withSignals: number;
  withHistory: number;
  topSignals: Array<{ watchId: string; label?: string; url: string; signals: string[] }>;
  priceLeaders: Array<{
    watchId: string;
    label?: string;
    url: string;
    latestPrice?: number;
    lowestSeenPrice?: number;
    historyCount: number;
  }>;
  recentChanges: Array<{
    watchId: string;
    label?: string;
    url: string;
    fetchedAt: string;
    changeType?: string;
    alertSeverity?: AlertSeverity;
    summaryLine?: string;
    price?: number;
    currency?: string;
  }>;
  noisyWatches: Array<{
    watchId: string;
    label?: string;
    url: string;
    noiseScore: number;
    reason: string;
    historyCount: number;
    pricePointCount: number;
    lastSeenAt?: string;
  }>;
  glitchCandidates: Array<{
    watchId: string;
    label?: string;
    url: string;
    glitchScore: number;
    reasons: string[];
    latestPrice?: number;
    previousPrice?: number;
    lastSeenAt?: string;
  }>;
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
        (b.historyCount - a.historyCount),
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
      if (noise.score < 45) {
        return null;
      }
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
      const signals = buildWatchSignals(watch);
      const glitch = buildGlitchAssessment(watch, history, signals);
      if (glitch.score < 60) {
        return null;
      }
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

export function buildSampleSetup() {
  return {
    installCommand: "openclaw plugins install openclaw-deal-hunter",
    configSnippet: {
      plugins: {
        entries: {
          "openclaw-deal-hunter": {
            enabled: true,
            config: {
              maxConcurrent: 8,
              maxBytesPerResponse: 1_048_576,
              defaultMaxRpsPerHost: 1,
              allowedHosts: ["*.example.com"],
              blockedHosts: ["localhost"],
              fetcher: "local",
            },
          },
        },
      },
    },
    discoveryExamples: {
      manual: {
        plugins: {
          entries: {
            "openclaw-deal-hunter": {
              enabled: true,
              config: {
                allowedHosts: ["www.bestbuy.com", "www.target.com"],
                discovery: {
                  enabled: true,
                  provider: "manual",
                  maxFetches: 5,
                  allowedHosts: ["www.bestbuy.com", "www.target.com"],
                },
              },
            },
          },
        },
      },
      firecrawlSearch: {
        plugins: {
          entries: {
            "openclaw-deal-hunter": {
              enabled: true,
              config: {
                firecrawlApiKey: "fc-REPLACE_ME",
                discovery: {
                  enabled: true,
                  provider: "firecrawl-search",
                  maxSearchResults: 5,
                  maxFetches: 5,
                  allowedHosts: ["www.bestbuy.com", "www.target.com"],
                },
              },
            },
          },
        },
      },
    },
    reviewExamples: {
      queueOnly: {
        plugins: {
          entries: {
            "openclaw-deal-hunter": {
              enabled: true,
              config: {
                llmReview: {
                  mode: "queue",
                  lowConfidenceThreshold: 45,
                  maxReviewsPerScan: 3,
                },
              },
            },
          },
        },
      },
      autoAssist: {
        plugins: {
          entries: {
            "openclaw-deal-hunter": {
              enabled: true,
              config: {
                llmReview: {
                  mode: "auto_assist",
                  lowConfidenceThreshold: 35,
                  maxReviewsPerScan: 2,
                  allowIdentityRewrite: true,
                  allowPriceRewrite: false,
                },
              },
            },
          },
        },
      },
    },
    allowlist: [
      "openclaw-deal-hunter",
      "deal_watch_list",
      "deal_template_list",
      "deal_watch_add",
      "deal_watch_add_template",
      "deal_watch_update",
      "deal_watch_set_enabled",
      "deal_watch_search",
      "deal_watch_taxonomy",
      "deal_host_report",
      "deal_saved_view_list",
      "deal_saved_view_create",
      "deal_saved_view_update",
      "deal_saved_view_run",
      "deal_saved_view_dashboard",
      "deal_saved_view_delete",
      "deal_view_scan",
      "deal_view_report",
      "deal_watch_bulk_update",
      "deal_view_bulk_update",
      "deal_watch_tag",
      "deal_watch_dedupe",
      "deal_watch_export",
      "deal_watch_import",
      "deal_watch_import_url",
      "deal_watch_remove",
      "deal_scan",
      "deal_fetch_url",
      "deal_extraction_debug",
      "deal_evaluate_text",
      "deal_help",
      "deal_quickstart",
      "deal_report",
      "deal_digest",
      "deal_workflow_action_queue",
      "deal_workflow_portfolio",
      "deal_workflow_triage",
      "deal_workflow_cleanup",
      "deal_workflow_best_opportunities",
      "deal_health",
      "deal_discovery_backlog",
      "deal_discovery_policy",
      "deal_review_policy",
      "deal_history",
      "deal_alerts",
      "deal_trends",
      "deal_top_drops",
      "deal_market_check",
      "deal_market_check_candidates",
      "deal_discovery_report",
      "deal_discovery_search",
      "deal_discovery_fetch",
      "deal_discovery_run",
      "deal_discovery_import",
      "deal_product_groups",
      "deal_best_price_board",
      "deal_llm_review_queue",
      "deal_llm_review_run",
      "deal_llm_review_apply",
      "deal_watch_insights",
      "deal_watch_identity",
      "deal_schedule_advice",
      "deal_doctor",
      "deal_sample_setup",
    ],
    examplePrompts: [
      "Use deal_help and tell me the best first-run workflow for this plugin.",
      "Use deal_quickstart and give me the safest first-run checklist for this plugin.",
      "Use deal_template_list and recommend the best starter template for my first watch.",
      "Use deal_watch_add_template in dry-run mode to prepare a restock_signal watch for https://example.com/product.",
      "Use deal_watch_add to add a watch for https://example.com/product and then use deal_scan with commit true.",
      "Use deal_watch_taxonomy and suggest the best saved views I should create from my current groups and tags.",
      "Use deal_host_report and tell me which retailer hosts are driving the most signals right now.",
      "Use deal_watch_search to show me disabled watches and any watches currently showing threshold or keyword signals.",
      "Use deal_saved_view_create to save a view for my GPU watches with active signals, then run it.",
      "Use deal_saved_view_dashboard so I can see which saved views currently deserve attention first.",
      "Use deal_saved_view_update to rename my GPU view and tighten the selector to only enabled watches with snapshots.",
      "Use deal_watch_tag to tag my GPU watches and group them under pc-build.",
      "Use deal_view_scan with commit true for my GPU alerts saved view, then summarize what changed.",
      "Use deal_view_report for my GPU alerts saved view so I get alerts, trends, drops, and best opportunities in one call.",
      "Use deal_digest for my GPU alerts saved view so I get a concise announcement-ready summary I can post directly.",
      "Use deal_workflow_action_queue for my GPU alerts saved view so I know exactly what to do next.",
      "Use deal_view_bulk_update in dry-run mode to add the tag featured to all watches in my GPU alerts saved view.",
      "Use deal_watch_dedupe in dry-run mode and show me any likely duplicate watches before I clean up the list.",
      "Use deal_alerts to show me the hottest current signals, then use deal_history for the most interesting watch.",
      "Use deal_top_drops and deal_trends to show me the strongest current deals with context.",
      "Use deal_market_check for my best-looking deal and show me whether the current watch is actually the best price in my store.",
      "Use deal_market_check_candidates with a few retailer URLs I provide and tell me whether any look like the same product before I add them.",
      "Use deal_discovery_report for one watch so I can see the best candidates, blocked results, duplicates, and import recommendations in one compact summary.",
      "Use deal_discovery_search for one watch and a few allowed retailer hosts so I can get bounded discovery candidates before fetching them.",
      "Use deal_discovery_run with a few explicit retailer URLs and prepare import recommendations without adding anything yet.",
      "Use deal_discovery_import in dry-run mode so I can preview which discovery candidates would become new watches.",
      "Use deal_product_groups to cluster likely same-product watches and show me which groups have meaningful internal price spread.",
      "Use deal_best_price_board to rank where my current best-known internal prices are hiding.",
      "Use deal_llm_review_queue to prepare any weak extraction or unresolved identity cases for optional manual or llm-task review.",
      "Use deal_llm_review_run for one queued candidate if I want explicit JSON output from my configured model.",
      "Use deal_llm_review_apply in dry-run mode to show how one reviewed JSON result would patch my watch snapshot.",
      "Use deal_watch_insights for my most volatile watch and explain whether it looks real or noisy.",
      "Use deal_watch_identity for my best current deal and tell me whether any other watches appear to be the same product.",
      "Use deal_workflow_triage to tell me what changed, what matters, what is noisy, and what I should review first.",
      "Use deal_workflow_best_opportunities to rank the top real deals, suspicious glitches, and strongest same-product spreads.",
      "Use deal_discovery_backlog to tell me which watches most need broader retailer coverage before I start discovery work.",
      "Use deal_discovery_policy to show whether discovery is off, manual-only, or using bounded Firecrawl search.",
      "Use deal_sample_setup and show me the manual discovery config example plus the safer queue-only review policy example.",
      "Use deal_review_policy to show whether scan-time review is off, queue-only, or auto-assist.",
      "Use deal_workflow_cleanup to show me duplicates, disabled stale watches, weak extraction cases, and noisy watches.",
      "Use deal_workflow_portfolio to give me an executive dashboard of my current watch portfolio.",
      "Use deal_digest to give me a short summary of what changed and what matters right now.",
      "Use deal_workflow_action_queue to rank my next actions across alerts, cleanup, discovery, and review.",
      "Use deal_watch_export to back up my watches, then prepare a deal_watch_import dry run for another workspace.",
      "Fetch a shared JSON watchlist with deal_watch_import_url in dry-run mode and show me what would change.",
    ],
    cronExample:
      "openclaw cron add --name \"Deal scan\" --cron \"0 * * * *\" --session isolated --message \"Run deal_scan with commit true for all enabled watches. Summarize any alerts.\" --announce",
  };
}

export function buildQuickstartGuide() {
  return {
    installCommand: "openclaw plugins install openclaw-deal-hunter",
    firstRunChecklist: [
      "Enable the plugin and allow the tools you want your agent to use.",
      "Set allowedHosts for the retailer domains you trust most.",
      "Use deal_template_list if you want a faster template-driven first watch instead of building fields manually.",
      "Use deal_watch_add to create the first watch.",
      "Use deal_watch_taxonomy once the watchlist grows so you can see which groups, tags, and saved views deserve cleanup.",
      "Use deal_host_report when you want a retailer-level view of signal density and scan cadence.",
      "Use deal_saved_view_create for repeat searches once your watchlist grows beyond a few items.",
      "Use deal_saved_view_update to keep saved views aligned with how you actually manage the watchlist.",
      "Use deal_watch_tag or deal_watch_bulk_update once you have enough watches to organize by tag or group.",
      "Use deal_view_scan or deal_view_report when you want to work on one saved slice instead of the whole portfolio.",
      "Run deal_scan with commit true to capture the first snapshot.",
      "Use deal_alerts, deal_trends, deal_market_check, deal_watch_identity, deal_workflow_triage, and deal_report to inspect what changed.",
      "Use deal_market_check_candidates if you want to compare one watched product against a few explicit retailer URLs without adding them yet.",
      "Use deal_discovery_backlog to prioritize which watches deserve discovery effort first.",
      "Use deal_discovery_policy before enabling provider-backed discovery so you can verify the active host and budget constraints.",
      "Use deal_discovery_report when you want a compact discovery decision summary before drilling into raw candidate arrays or import previews.",
      "Enable discovery in manual mode when you want bounded candidate evaluation and import preview from explicit URLs only.",
      "Enable discovery in firecrawl-search mode only when you also have explicit retailer hosts you trust for bounded search.",
      "Use deal_product_groups and deal_best_price_board after you have same-product coverage across multiple retailers.",
      "Use deal_llm_review_queue when you want optional model-assisted review without making Deal Hunter itself depend on another plugin tool.",
      "Use deal_llm_review_run when you want to execute one queued review explicitly through the embedded OpenClaw runtime.",
      "Use deal_llm_review_apply in dry-run mode before writing reviewed fields back into a watch snapshot.",
      "Use deal_watch_export before large watchlist edits or migration.",
      "Use deal_watch_import_url with dryRun first before applying a shared remote watchlist.",
    ],
    recommendedPrompts: [
      "Use deal_sample_setup and show me the safest minimal config for this plugin.",
      "Use deal_template_list and recommend the right template for a price-target watch.",
      "Use deal_watch_add_template in dry-run mode to show me the exact watch config before saving it.",
      "Use deal_watch_taxonomy and tell me which saved views I should create for my current groups and tags.",
      "Use deal_host_report and show me which hosts are most active right now.",
      "Use deal_watch_add to add my first watch, then run deal_scan with commit true.",
      "Use deal_report and deal_alerts to summarize the most interesting current deals.",
      "Use deal_view_report for my saved GPU alerts view so I get a compact multi-signal report in one call.",
      "Use deal_workflow_triage to tell me what changed and what deserves attention right now.",
      "Use deal_best_price_board to show me where the best current same-product prices are across my store.",
      "Use deal_discovery_backlog to show which enabled watches are under-covered and worth expanding across more retailers.",
      "Use deal_discovery_report if I want a smaller-model-friendly discovery summary instead of raw candidate arrays.",
      "Use deal_discovery_search first when discovery.provider is firecrawl-search and you want candidate URLs from a few trusted retailer hosts.",
      "Use deal_discovery_run with explicit retailer URLs or a configured firecrawl-search provider when you want bounded discovery plus import preview.",
      "Use deal_discovery_import in dry-run mode even with provider-backed search so I can preview import decisions before changing the watchlist.",
      "Use deal_review_policy to confirm whether low-confidence scans will only queue reviews or invoke bounded auto-assist.",
      "Use deal_llm_review_queue if any watches still look ambiguous and I want a ready-to-run JSON review payload.",
      "Use deal_llm_review_run if I want one queued review executed immediately as JSON.",
      "Use deal_llm_review_apply in dry-run mode to preview how a reviewed JSON result would update my watch.",
      "Use deal_top_drops and deal_watch_insights to tell me whether my best-looking deal is actually unusual.",
    ],
    privacyAndSafety: [
      "The plugin stores watch metadata and scan history in the configured JSON store path.",
      "It only fetches http/https URLs that pass the built-in host safety policy.",
      "Use allowedHosts to narrow scanning to trusted retailer domains.",
      "Use deal_watch_export if you want a reviewable backup before making major changes.",
    ],
    troubleshooting: [
      "Use deal_doctor for a quick sanity check of config and watch coverage.",
      "Use deal_health to confirm the active fetch limits and host-policy posture.",
      "If scans return policy errors, verify the target host against allowedHosts and blockedHosts.",
      "If extraction looks weak, use deal_extraction_debug to inspect candidates, chosen fields, and confidence reasons.",
    ],
  };
}

export function buildHistorySummary(
  watch: Watch,
  limit = 20,
): {
  watchId: string;
  label?: string;
  url: string;
  historyCount: number;
  latestPrice?: number;
  latestCurrency?: string;
  lowestSeenPrice?: number;
  highestSeenPrice?: number;
  firstSeenAt?: string;
  lastSeenAt?: string;
  priceDelta?: number;
  percentDelta?: number;
  recent: WatchHistoryEntry[];
} {
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

export function buildAlertsSummary(
  store: StoreFile,
  minSeverity: AlertSeverity = "low",
  limit = 20,
): {
  count: number;
  alerts: Array<{
    watchId: string;
    label?: string;
    url: string;
    severity: AlertSeverity;
    signals: string[];
    summaryLine?: string;
    latestPrice?: number;
    lowestSeenPrice?: number;
    priceDelta?: number;
    percentDelta?: number;
    lastSeenAt?: string;
    glitchScore: number;
    glitchReasons: string[];
  }>;
} {
  const alerts = store.watches
    .map((watch) => {
      const signals = buildWatchSignals(watch);
      const history = summarizeHistory(watch);
      const glitch = buildGlitchAssessment(watch, history, signals);
      const latestSeverity = history.latestEntry?.alertSeverity ?? "none";
      const derivedSeverity =
        signals.length > 0 && compareSeverity(latestSeverity, "medium") < 0 ? "medium" : latestSeverity;
      if (compareSeverity(derivedSeverity, minSeverity) < 0) {
        return null;
      }

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
        (b.glitchScore - a.glitchScore) ||
        (Math.abs(b.percentDelta ?? 0) - Math.abs(a.percentDelta ?? 0)) ||
        a.url.localeCompare(b.url),
    )
    .slice(0, limit);

  return {
    count: alerts.length,
    alerts,
  };
}

export function buildTopDropsSummary(
  store: StoreFile,
  metric: "vs_peak" | "latest_change" = "vs_peak",
  limit = 10,
): {
  metric: "vs_peak" | "latest_change";
  count: number;
  drops: Array<{
    watchId: string;
    label?: string;
    url: string;
    latestPrice?: number;
    previousPrice?: number;
    highestSeenPrice?: number;
    savingsFromPeak?: number;
    savingsPercentFromPeak?: number;
    recentDelta?: number;
    recentPercentDelta?: number;
    lastSeenAt?: string;
  }>;
} {
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

export function buildTrendsSummary(
  store: StoreFile,
  limit = 20,
): {
  count: number;
  trends: Array<{
    watchId: string;
    label?: string;
    url: string;
    trend: string;
    direction: "up" | "down" | "flat" | "volatile" | "unknown";
    confidence: "low" | "medium" | "high";
    latestPrice?: number;
    lowestSeenPrice?: number;
    highestSeenPrice?: number;
    percentDelta?: number;
    sparkline: string;
    reasons: string[];
  }>;
} {
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

export function buildWatchIdentitySummary(
  store: StoreFile,
  watch: Watch,
): {
  watchId: string;
  label?: string;
  url: string;
  identifiers: ProductIdentityEntry[];
  strength: "none" | "low" | "medium" | "high";
  reasons: string[];
  relatedWatches: Array<{
    watchId: string;
    label?: string;
    url: string;
    sharedFields: string[];
    conflictingFields: string[];
    matchScore: number;
    matchStrength: "low" | "medium" | "high";
    matchReasons: string[];
    matchWarnings: string[];
    latestPrice?: number;
  }>;
} {
  const identifiers = getWatchIdentityFields(watch);
  const identityStrength = getWatchIdentityStrength(watch);
  const reasons = [...identityStrength.reasons];
  const relatedWatches = buildProductMatchCandidates(watch, store.watches, { includeLooseTitleFallback: false }).map((candidate) => ({
    watchId: candidate.watchId,
    label: candidate.label,
    url: candidate.url,
    sharedFields: candidate.sharedFields,
    conflictingFields: candidate.conflictingFields,
    matchScore: candidate.matchScore,
    matchStrength: candidate.matchStrength,
    matchReasons: candidate.matchReasons,
    matchWarnings: candidate.matchWarnings,
    latestPrice: candidate.latestPrice,
  }));

  if (relatedWatches.length) {
    reasons.push(`Found ${relatedWatches.length} other watch${relatedWatches.length === 1 ? "" : "es"} sharing stored identifiers.`);
  }

  return {
    watchId: watch.id,
    label: watch.label,
    url: watch.url,
    identifiers,
    strength: identityStrength.strength,
    reasons,
    relatedWatches,
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

export function buildMarketCheckSummary(
  store: StoreFile,
  watch: Watch,
  options?: { includeLooseTitleFallback?: boolean },
): {
  watchId: string;
  label?: string;
  url: string;
  anchorPrice?: number;
  identity: ProductIdentityEntry[];
  matchCount: number;
  bestKnownPrice?: number;
  highestKnownPrice?: number;
  spread?: {
    absolute: number;
    percentFromBest: number;
  };
  matches: Array<{
    watchId: string;
    label?: string;
    url: string;
    latestPrice?: number;
    sharedFields: string[];
    conflictingFields: string[];
    matchScore: number;
    matchStrength: "low" | "medium" | "high";
    matchReasons: string[];
    matchWarnings: string[];
  }>;
  reasons: string[];
} {
  const anchorPrice = watch.lastSnapshot?.price;
  const identity = getWatchIdentityFields(watch);
  const matches = buildProductMatchCandidates(watch, store.watches, options);
  const knownPrices = [anchorPrice, ...matches.map((match) => match.latestPrice)].filter((price): price is number => price != null);
  const bestKnownPrice = knownPrices.length ? Math.min(...knownPrices) : undefined;
  const highestKnownPrice = knownPrices.length ? Math.max(...knownPrices) : undefined;
  const spread =
    bestKnownPrice != null && highestKnownPrice != null && highestKnownPrice > bestKnownPrice
      ? {
          absolute: Number((highestKnownPrice - bestKnownPrice).toFixed(2)),
          percentFromBest: Number((((highestKnownPrice - bestKnownPrice) / bestKnownPrice) * 100).toFixed(1)),
        }
      : undefined;

  const reasons: string[] = [];
  if (!identity.length) {
    reasons.push("No strong stored identifiers are available on the anchor watch; comparison may rely on title/brand similarity.");
  } else {
    reasons.push(`Anchor identifiers: ${identity.map((identifier) => `${identifier.field}=${identifier.value}`).join(", ")}.`);
  }
  if (matches.length) {
    reasons.push(`Found ${matches.length} likely same-product watch${matches.length === 1 ? "" : "es"} in the current store.`);
  } else {
    reasons.push("No likely same-product watches were found in the current store.");
  }
  const conflictCount = matches.reduce((count, match) => count + match.conflictingFields.length, 0);
  if (conflictCount > 0) {
    reasons.push(`Detected ${conflictCount} identifier conflict${conflictCount === 1 ? "" : "s"} across the candidate set; review match warnings before acting.`);
  }
  if (spread) {
    reasons.push(`Observed internal market spread is ${spread.absolute.toFixed(2)} (${spread.percentFromBest.toFixed(1)}% from the best known price).`);
  }

  return {
    watchId: watch.id,
    label: watch.label,
    url: watch.url,
    anchorPrice,
    identity,
    matchCount: matches.length,
    bestKnownPrice,
    highestKnownPrice,
    spread,
    matches,
    reasons,
  };
}

export function buildDiscoveryReport(args: {
  watch: Watch;
  provider: string;
  candidates: DiscoveryCandidate[];
  importPreview: Array<{
    candidate: DiscoveryCandidate;
    duplicateWatchId?: string;
    importable: boolean;
  }>;
  query?: string;
  searchHosts?: string[];
  skippedHosts?: string[];
  skippedResults?: Array<{ url: string; reason: string }>;
}): {
  anchor: {
    watchId: string;
    label?: string;
    url: string;
    identityStrength: ReturnType<typeof getWatchIdentityStrength>;
  };
  provider: string;
  query?: string;
  searchHosts?: string[];
  skippedHosts?: string[];
  summary: {
    candidateCount: number;
    fetchedOkCount: number;
    blockedOrFailedCount: number;
    importableCount: number;
    strongMatchCount: number;
    reviewCount: number;
    duplicateCount: number;
    weakOrRejectedCount: number;
    skippedResultCount: number;
  };
  topCandidates: Array<{
    url: string;
    host: string;
    matchScore?: number;
    matchStrength?: string;
    recommendedAction: string;
    duplicateWatchId?: string;
    price?: number;
    currency?: string;
    extractedTitle?: string;
    matchedFields: ProductIdentityField[];
    reasons: string[];
    warnings: string[];
  }>;
  blockedOrFailed: Array<{
    url: string;
    host: string;
    fetchStatus: string;
    blockedReason?: string;
  }>;
  skippedResults?: Array<{ url: string; reason: string }>;
  actionSummary: string[];
} {
  const { watch, provider, candidates, importPreview, query, searchHosts, skippedHosts, skippedResults } = args;
  const previewByUrl = new Map(importPreview.map((entry) => [entry.candidate.url, entry]));
  const strongMatchCount = candidates.filter((candidate) => candidate.matchStrength === "high").length;
  const reviewCount = candidates.filter((candidate) => candidate.recommendedAction === "review_before_import").length;
  const duplicateCount = importPreview.filter((entry) => Boolean(entry.duplicateWatchId)).length;
  const weakOrRejectedCount = candidates.filter((candidate) => candidate.recommendedAction === "likely_not_same_product").length;
  const fetchedOkCount = candidates.filter((candidate) => candidate.fetchStatus === "ok").length;
  const blockedOrFailedCount = candidates.filter((candidate) => candidate.fetchStatus !== "ok").length;
  const importableCount = importPreview.filter((entry) => entry.importable).length;

  const topCandidates = candidates
    .filter((candidate) => candidate.fetchStatus === "ok")
    .map((candidate) => {
      const preview = previewByUrl.get(candidate.url);
      return {
        url: candidate.url,
        host: candidate.host,
        matchScore: candidate.matchScore,
        matchStrength: candidate.matchStrength,
        recommendedAction: candidate.recommendedAction,
        duplicateWatchId: preview?.duplicateWatchId,
        price: candidate.price,
        currency: candidate.currency,
        extractedTitle: candidate.extractedTitle,
        matchedFields: candidate.matchedFields,
        reasons: candidate.matchReasons,
        warnings: candidate.matchWarnings,
      };
    })
    .sort((a, b) =>
      (b.matchScore ?? 0) - (a.matchScore ?? 0) ||
      Number(a.duplicateWatchId == null) - Number(b.duplicateWatchId == null) ||
      a.url.localeCompare(b.url),
    )
    .slice(0, 8);

  const blockedOrFailed = candidates
    .filter((candidate) => candidate.fetchStatus !== "ok")
    .map((candidate) => ({
      url: candidate.url,
      host: candidate.host,
      fetchStatus: candidate.fetchStatus,
      blockedReason: candidate.blockedReason,
    }))
    .slice(0, 8);

  const actionSummary: string[] = [];
  if (topCandidates[0]) {
    actionSummary.push(
      `Best current candidate is ${topCandidates[0].url} with ${topCandidates[0].matchStrength ?? "unknown"} match strength${topCandidates[0].duplicateWatchId ? ", but it is already represented by an existing watch." : "."}`,
    );
  }
  if (importableCount) {
    actionSummary.push(`There ${importableCount === 1 ? "is" : "are"} ${importableCount} candidate${importableCount === 1 ? "" : "s"} ready for import after review.`);
  }
  if (duplicateCount) {
    actionSummary.push(`${duplicateCount} candidate${duplicateCount === 1 ? " is" : "s are"} already covered by the current watch store.`);
  }
  if (blockedOrFailedCount) {
    actionSummary.push(`${blockedOrFailedCount} candidate${blockedOrFailedCount === 1 ? "" : "s"} were blocked or failed fetch policy checks.`);
  }
  if (!actionSummary.length) {
    actionSummary.push("No discovery candidates were strong enough to recommend import yet.");
  }

  return {
    anchor: {
      watchId: watch.id,
      label: watch.label,
      url: watch.url,
      identityStrength: getWatchIdentityStrength(watch),
    },
    provider,
    query,
    searchHosts,
    skippedHosts,
    summary: {
      candidateCount: candidates.length,
      fetchedOkCount,
      blockedOrFailedCount,
      importableCount,
      strongMatchCount,
      reviewCount,
      duplicateCount,
      weakOrRejectedCount,
      skippedResultCount: skippedResults?.length ?? 0,
    },
    topCandidates,
    blockedOrFailed,
    skippedResults,
    actionSummary,
  };
}

export function buildDiscoveryBacklog(
  store: StoreFile,
  limit = 10,
): {
  watchCount: number;
  candidateCount: number;
  highPriorityCount: number;
  mediumPriorityCount: number;
  backlog: Array<{
    watchId: string;
    label?: string;
    url: string;
    host: string;
    latestPrice?: number;
    identityStrength: ReturnType<typeof getWatchIdentityStrength>["strength"];
    identityScore: number;
    matchCount: number;
    activeSignals: string[];
    recommendedAction: "search_new_retailers" | "expand_coverage" | "improve_identity_first";
    priority: "high" | "medium" | "low";
    priorityScore: number;
    reasons: string[];
  }>;
  actionSummary: string[];
} {
  const scored = store.watches
    .filter((watch) => watch.enabled)
    .map((watch) => {
      const identity = getWatchIdentityStrength(watch);
      const market = buildMarketCheckSummary(store, watch);
      const signals = buildWatchSignals(watch);
      const reasons: string[] = [];
      let priorityScore = 0;
      let recommendedAction: "search_new_retailers" | "expand_coverage" | "improve_identity_first";

      if (identity.strength === "none") {
        recommendedAction = "improve_identity_first";
        priorityScore += 5;
        reasons.push("No durable identifiers are stored yet, so discovery would be low-confidence.");
      } else if (market.matchCount === 0) {
        recommendedAction = "search_new_retailers";
        priorityScore += identity.strength === "high" ? 80 : identity.strength === "medium" ? 60 : 35;
        reasons.push("No same-product matches exist in the current store.");
      } else {
        recommendedAction = "expand_coverage";
        priorityScore += market.matchCount === 1 ? 35 : 15;
        reasons.push(`Only ${market.matchCount} same-product ${market.matchCount === 1 ? "match exists" : "matches exist"} in the current store.`);
      }

      if (signals.length) {
        priorityScore += 10;
        reasons.push(`Active signals are present: ${signals.join(", ")}.`);
      }
      if (watch.lastSnapshot?.price != null) {
        priorityScore += 10;
        reasons.push("Latest snapshot has a current price, so new retailer comparisons would be immediately useful.");
      }
      if (identity.strength === "high") {
        reasons.push("Stored identity strength is high enough for bounded discovery search.");
      } else if (identity.strength === "medium") {
        reasons.push("Stored identity strength is moderate; discovery is viable but should be reviewed carefully.");
      } else if (identity.strength === "low") {
        reasons.push("Stored identity strength is low; discovery may rely more on title/brand overlap.");
      }

      const priority: "high" | "medium" | "low" =
        priorityScore >= 75 ? "high" : priorityScore >= 40 ? "medium" : "low";

      return {
        watchId: watch.id,
        label: watch.label,
        url: watch.url,
        host: getWatchHost(watch.url),
        latestPrice: watch.lastSnapshot?.price,
        identityStrength: identity.strength,
        identityScore: identity.score,
        matchCount: market.matchCount,
        activeSignals: signals,
        recommendedAction,
        priority,
        priorityScore,
        reasons,
      };
    })
    .filter((entry) => entry.recommendedAction !== "expand_coverage" || entry.matchCount <= 2)
    .sort((a, b) => b.priorityScore - a.priorityScore || a.url.localeCompare(b.url))
    .slice(0, limit);

  const highPriorityCount = scored.filter((entry) => entry.priority === "high").length;
  const mediumPriorityCount = scored.filter((entry) => entry.priority === "medium").length;
  const actionSummary: string[] = [];
  if (scored[0]) {
    actionSummary.push(`Start with ${scored[0].label ?? scored[0].watchId}; it has the strongest case for more discovery coverage.`);
  }
  if (highPriorityCount) {
    actionSummary.push(`${highPriorityCount} watch${highPriorityCount === 1 ? "" : "es"} look like high-priority discovery targets.`);
  }
  if (scored.some((entry) => entry.recommendedAction === "improve_identity_first")) {
    actionSummary.push("Some watches should improve stored identity first before wider discovery search.");
  }

  return {
    watchCount: store.watches.length,
    candidateCount: scored.length,
    highPriorityCount,
    mediumPriorityCount,
    backlog: scored,
    actionSummary,
  };
}

export function buildProductGroupsSummary(
  store: StoreFile,
  options?: { includeLooseTitleFallback?: boolean; limit?: number; minMatchScore?: number },
): {
  groupCount: number;
  groupedWatchCount: number;
  ungroupedSnapshotCount: number;
  groups: Array<{
    groupId: string;
    title?: string;
    canonicalTitle?: string;
    watchCount: number;
    bestPrice?: number;
    highestPrice?: number;
    spread?: {
      absolute: number;
      percentFromBest: number;
    };
    bestWatchId?: string;
    matchBasis: string[];
    identifiers: Array<ProductIdentityEntry & { count: number }>;
    members: Array<{
      watchId: string;
      label?: string;
      url: string;
      host: string;
      latestPrice?: number;
      currency?: string;
      enabled: boolean;
      sharedIdentityCount: number;
    }>;
  }>;
} {
  const groups = buildProductGroups(store, options).slice(0, options?.limit ?? 20);
  const groupedWatchIds = new Set(groups.flatMap((group) => group.members.map((member) => member.watchId)));
  const snapshotCount = store.watches.filter((watch) => Boolean(watch.lastSnapshot)).length;
  return {
    groupCount: groups.length,
    groupedWatchCount: groupedWatchIds.size,
    ungroupedSnapshotCount: Math.max(0, snapshotCount - groupedWatchIds.size),
    groups,
  };
}

export function buildBestPriceBoard(
  store: StoreFile,
  options?: { includeLooseTitleFallback?: boolean; limit?: number; minMatchScore?: number },
): {
  groupCount: number;
  opportunities: Array<{
    groupId: string;
    title?: string;
    watchCount: number;
    bestWatchId?: string;
    bestWatchLabel?: string;
    bestHost?: string;
    bestPrice?: number;
    highestPrice?: number;
    spread?: {
      absolute: number;
      percentFromBest: number;
    };
    alternateCount: number;
    alternates: Array<{
      watchId: string;
      label?: string;
      host: string;
      latestPrice?: number;
    }>;
    reasons: string[];
  }>;
} {
  const groups = buildProductGroups(store, options);
  const opportunities = groups
    .filter((group) => group.spread && group.bestPrice != null && group.bestWatchId)
    .map((group) => {
      const bestWatch = group.members.find((member) => member.watchId === group.bestWatchId);
      const alternates = group.members.filter((member) => member.watchId !== group.bestWatchId).slice(0, 5);
      return {
        groupId: group.groupId,
        title: group.title,
        watchCount: group.watchCount,
        bestWatchId: group.bestWatchId,
        bestWatchLabel: bestWatch?.label,
        bestHost: bestWatch?.host,
        bestPrice: group.bestPrice,
        highestPrice: group.highestPrice,
        spread: group.spread,
        alternateCount: Math.max(0, group.members.length - 1),
        alternates: alternates.map((alternate) => ({
          watchId: alternate.watchId,
          label: alternate.label,
          host: alternate.host,
          latestPrice: alternate.latestPrice,
        })),
        reasons: [
          ...(group.matchBasis.length ? [`Grouped by ${group.matchBasis.join(", ")}.`] : []),
          ...(group.spread
            ? [`Internal same-product spread is ${group.spread.absolute.toFixed(2)} (${group.spread.percentFromBest.toFixed(1)}%).`]
            : []),
        ],
      };
    })
    .sort(
      (a, b) =>
        (b.spread?.percentFromBest ?? 0) - (a.spread?.percentFromBest ?? 0) ||
        b.watchCount - a.watchCount ||
        (a.title ?? a.groupId).localeCompare(b.title ?? b.groupId),
    )
    .slice(0, options?.limit ?? 20);

  return {
    groupCount: groups.length,
    opportunities,
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
    const target =
      mode === "host"
        ? getWatchHost(watch.url)
        : watch.id;
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

function buildExtractionCoverage(
  watch: Watch,
): {
  level: "none" | "low" | "medium" | "high";
  score: number;
  reasons: string[];
} {
  const snapshot = watch.lastSnapshot;
  if (!snapshot) {
    return {
      level: "none",
      score: 0,
      reasons: ["No committed snapshot is stored yet."],
    };
  }

  const reasons: string[] = [];
  let score = 0;
  if (snapshot.title || snapshot.canonicalTitle) {
    score += 35;
  } else {
    reasons.push("Missing extracted title.");
  }
  if (snapshot.price != null) {
    score += 35;
  } else {
    reasons.push("Missing extracted price.");
  }
  const identityCount = getWatchIdentityFields(watch).length;
  if (identityCount > 0) {
    score += Math.min(20, identityCount * 10);
  } else {
    reasons.push("No persistent product identifiers were extracted.");
  }
  if (snapshot.rawSnippet) {
    score += 10;
  }
  if (!reasons.length) {
    reasons.push("Snapshot includes title, price, and at least one persistent product identifier.");
  }

  const level = score >= 80 ? "high" : score >= 60 ? "medium" : score >= 30 ? "low" : "none";
  return { level, score, reasons };
}

function buildGroupBreakdown(watches: Watch[], limit: number) {
  const counts = new Map<string, number>();
  for (const watch of watches) {
    const key = watch.group?.trim() || "(ungrouped)";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([group, count]) => ({ group, count }))
    .sort((a, b) => b.count - a.count || a.group.localeCompare(b.group))
    .slice(0, limit);
}

function buildTagBreakdown(watches: Watch[], limit: number) {
  const counts = new Map<string, number>();
  for (const watch of watches) {
    for (const tag of watch.tags ?? []) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
    .slice(0, limit);
}

function buildDetailedGroupBreakdown(
  watches: Watch[],
  limit: number,
): Array<{ group: string; count: number; activeSignals: number; watchIds: string[] }> {
  const counts = new Map<string, { count: number; activeSignals: number; watchIds: string[] }>();
  for (const watch of watches) {
    const key = watch.group?.trim() || "(ungrouped)";
    const entry = counts.get(key) ?? { count: 0, activeSignals: 0, watchIds: [] };
    entry.count += 1;
    entry.activeSignals += buildWatchSignals(watch).length > 0 ? 1 : 0;
    entry.watchIds.push(watch.id);
    counts.set(key, entry);
  }
  return [...counts.entries()]
    .map(([group, value]) => ({
      group,
      count: value.count,
      activeSignals: value.activeSignals,
      watchIds: value.watchIds.sort(),
    }))
    .sort((a, b) => b.count - a.count || b.activeSignals - a.activeSignals || a.group.localeCompare(b.group))
    .slice(0, limit);
}

function buildDetailedTagBreakdown(
  watches: Watch[],
  limit: number,
): Array<{ tag: string; count: number; activeSignals: number; watchIds: string[] }> {
  const counts = new Map<string, { count: number; activeSignals: number; watchIds: string[] }>();
  for (const watch of watches) {
    const tags = watch.tags ?? [];
    for (const tag of tags) {
      const entry = counts.get(tag) ?? { count: 0, activeSignals: 0, watchIds: [] };
      entry.count += 1;
      entry.activeSignals += buildWatchSignals(watch).length > 0 ? 1 : 0;
      entry.watchIds.push(watch.id);
      counts.set(tag, entry);
    }
  }
  return [...counts.entries()]
    .map(([tag, value]) => ({
      tag,
      count: value.count,
      activeSignals: value.activeSignals,
      watchIds: value.watchIds.sort(),
    }))
    .sort((a, b) => b.count - a.count || b.activeSignals - a.activeSignals || a.tag.localeCompare(b.tag))
    .slice(0, limit);
}

function buildSubsetStore(store: StoreFile, watches: Watch[]): StoreFile {
  return {
    version: store.version,
    savedViews: store.savedViews,
    watches,
  };
}

function buildMarketLeaders(
  store: StoreFile,
  limit: number,
): Array<{
  watchId: string;
  label?: string;
  url: string;
  latestPrice?: number;
  bestKnownPrice?: number;
  highestKnownPrice?: number;
  spreadPercent?: number;
  matchCount: number;
  isBestKnownPrice: boolean;
}> {
  return store.watches
    .map((watch) => {
      const summary = buildMarketCheckSummary(store, watch);
      const latestPrice = watch.lastSnapshot?.price;
      const isBestKnownPrice =
        latestPrice != null && summary.bestKnownPrice != null && Math.abs(latestPrice - summary.bestKnownPrice) < 0.01;
      return {
        watchId: watch.id,
        label: watch.label,
        url: watch.url,
        latestPrice,
        bestKnownPrice: summary.bestKnownPrice,
        highestKnownPrice: summary.highestKnownPrice,
        spreadPercent: summary.spread?.percentFromBest,
        matchCount: summary.matchCount,
        isBestKnownPrice,
      };
    })
    .filter((item) => item.matchCount > 0 && (item.spreadPercent ?? 0) > 0)
    .sort(
      (a, b) =>
        Number(b.isBestKnownPrice) - Number(a.isBestKnownPrice) ||
        (b.spreadPercent ?? 0) - (a.spreadPercent ?? 0) ||
        a.url.localeCompare(b.url),
    )
    .slice(0, limit);
}

export function buildWorkflowBestOpportunities(
  store: StoreFile,
  limit = 5,
): {
  watchCount: number;
  topRealDeals: Array<{
    watchId: string;
    label?: string;
    url: string;
    latestPrice?: number;
    severity: AlertSeverity;
    glitchScore: number;
    savingsPercentFromPeak?: number;
    recentPercentDelta?: number;
    bestKnownPrice?: number;
    marketSpreadPercent?: number;
    isBestKnownPrice: boolean;
    summaryLine?: string;
    signals: string[];
    rationale: string[];
  }>;
  suspiciousDeals: Array<{
    watchId: string;
    label?: string;
    url: string;
    latestPrice?: number;
    severity: AlertSeverity;
    glitchScore: number;
    summaryLine?: string;
    reasons: string[];
  }>;
  marketLeaders: Array<{
    watchId: string;
    label?: string;
    url: string;
    latestPrice?: number;
    bestKnownPrice?: number;
    highestKnownPrice?: number;
    spreadPercent?: number;
    matchCount: number;
    isBestKnownPrice: boolean;
  }>;
  strongestAlerts: Array<{
    watchId: string;
    label?: string;
    url: string;
    severity: AlertSeverity;
    summaryLine?: string;
    latestPrice?: number;
    glitchScore: number;
  }>;
  actionSummary: string[];
} {
  const alerts = buildAlertsSummary(store, "low", Math.max(limit * 4, 20)).alerts;
  const drops = new Map(buildTopDropsSummary(store, "vs_peak", Math.max(limit * 4, 20)).drops.map((drop) => [drop.watchId, drop]));
  const topRealDeals = alerts
    .map((alert) => {
      const watch = store.watches.find((candidate) => candidate.id === alert.watchId);
      if (!watch) return null;
      const market = buildMarketCheckSummary(store, watch);
      const drop = drops.get(alert.watchId);
      const latestPrice = watch.lastSnapshot?.price;
      const isBestKnownPrice =
        latestPrice != null && market.bestKnownPrice != null && Math.abs(latestPrice - market.bestKnownPrice) < 0.01;
      const rationale = [
        ...(alert.signals.length ? [`Active signals: ${alert.signals.join(", ")}.`] : []),
        ...(drop?.savingsPercentFromPeak != null
          ? [`Current price is ${drop.savingsPercentFromPeak.toFixed(1)}% below the observed peak.`]
          : []),
        ...(market.spread?.percentFromBest != null
          ? [
              isBestKnownPrice
                ? `This watch is currently the best known internal price with a ${market.spread.percentFromBest.toFixed(1)}% spread.`
                : `Internal same-product spread is ${market.spread.percentFromBest.toFixed(1)}%.`,
            ]
          : []),
      ];
      return {
        watchId: alert.watchId,
        label: alert.label,
        url: alert.url,
        latestPrice: alert.latestPrice,
        severity: alert.severity,
        glitchScore: alert.glitchScore,
        savingsPercentFromPeak: drop?.savingsPercentFromPeak,
        recentPercentDelta: alert.percentDelta,
        bestKnownPrice: market.bestKnownPrice,
        marketSpreadPercent: market.spread?.percentFromBest,
        isBestKnownPrice,
        summaryLine: alert.summaryLine,
        signals: alert.signals,
        rationale,
        score:
          (alert.severity === "high" ? 45 : alert.severity === "medium" ? 30 : 15) +
          Math.max(0, drop?.savingsPercentFromPeak ?? 0) +
          Math.max(0, Math.abs(Math.min(alert.percentDelta ?? 0, 0))) +
          (isBestKnownPrice ? 20 : 0) +
          Math.max(0, (market.spread?.percentFromBest ?? 0) / 2) -
          alert.glitchScore,
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .filter((item) => item.glitchScore < 70)
    .sort((a, b) => b.score - a.score || a.url.localeCompare(b.url))
    .slice(0, limit)
    .map(({ score: _score, ...item }) => item);

  const suspiciousDeals = alerts
    .filter((alert) => alert.glitchScore >= 60)
    .map((alert) => ({
      watchId: alert.watchId,
      label: alert.label,
      url: alert.url,
      latestPrice: alert.latestPrice,
      severity: alert.severity,
      glitchScore: alert.glitchScore,
      summaryLine: alert.summaryLine,
      reasons: alert.glitchReasons,
    }))
    .slice(0, limit);

  const marketLeaders = buildMarketLeaders(store, limit);
  const strongestAlerts = alerts.slice(0, limit).map((alert) => ({
    watchId: alert.watchId,
    label: alert.label,
    url: alert.url,
    severity: alert.severity,
    summaryLine: alert.summaryLine,
    latestPrice: alert.latestPrice,
    glitchScore: alert.glitchScore,
  }));

  const actionSummary: string[] = [];
  if (topRealDeals[0]) {
    actionSummary.push(`Start with ${topRealDeals[0].label ?? topRealDeals[0].watchId}; it currently looks like the strongest likely-real opportunity.`);
  }
  if (suspiciousDeals.length) {
    actionSummary.push(`Review ${suspiciousDeals.length} suspicious/glitch-prone watch${suspiciousDeals.length === 1 ? "" : "es"} before acting automatically.`);
  }
  if (marketLeaders.some((item) => item.isBestKnownPrice)) {
    actionSummary.push("At least one watch currently holds the best known internal same-product price.");
  }

  return {
    watchCount: store.watches.length,
    topRealDeals,
    suspiciousDeals,
    marketLeaders,
    strongestAlerts,
    actionSummary,
  };
}

export function buildWorkflowCleanup(
  store: StoreFile,
  limit = 10,
): {
  watchCount: number;
  duplicateGroups: Array<{
    canonicalUrl: string;
    keepWatchId: string;
    duplicateWatchIds: string[];
  }>;
  disabledStale: Array<{
    watchId: string;
    label?: string;
    url: string;
    lastSeenAt?: string;
    reason: string;
  }>;
  noSnapshot: Array<{
    watchId: string;
    label?: string;
    url: string;
    enabled: boolean;
  }>;
  weakExtraction: Array<{
    watchId: string;
    label?: string;
    url: string;
    level: "none" | "low" | "medium" | "high";
    score: number;
    reasons: string[];
  }>;
  noisyWatches: Array<{
    watchId: string;
    label?: string;
    url: string;
    noiseScore: number;
    reason: string;
    historyCount: number;
    pricePointCount: number;
    lastSeenAt?: string;
  }>;
  actionSummary: string[];
} {
  const byCanonicalUrl = new Map<string, Watch[]>();
  for (const watch of store.watches) {
    const canonicalUrl = canonicalizeWatchUrl(watch.url).toString();
    const group = byCanonicalUrl.get(canonicalUrl) ?? [];
    group.push(watch);
    byCanonicalUrl.set(canonicalUrl, group);
  }

  const duplicateGroups = [...byCanonicalUrl.entries()]
    .filter((entry) => entry[1].length > 1)
    .map(([canonicalUrl, watches]) => {
      const sorted = [...watches].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return {
        canonicalUrl,
        keepWatchId: sorted[0]!.id,
        duplicateWatchIds: sorted.slice(1).map((watch) => watch.id),
      };
    })
    .slice(0, limit);

  const disabledStale = store.watches
    .filter((watch) => !watch.enabled)
    .map((watch) => {
      const history = summarizeHistory(watch);
      return {
        watchId: watch.id,
        label: watch.label,
        url: watch.url,
        lastSeenAt: history.lastSeenAt,
        reason:
          history.lastSeenAt == null
            ? "Disabled and never committed a snapshot."
            : "Disabled watch still has historical data and may be a cleanup candidate.",
      };
    })
    .slice(0, limit);

  const noSnapshot = store.watches
    .filter((watch) => !watch.lastSnapshot)
    .slice(0, limit)
    .map((watch) => ({
      watchId: watch.id,
      label: watch.label,
      url: watch.url,
      enabled: watch.enabled,
    }));

  const weakExtraction = store.watches
    .map((watch) => {
      const coverage = buildExtractionCoverage(watch);
      return {
        watchId: watch.id,
        label: watch.label,
        url: watch.url,
        level: coverage.level,
        score: coverage.score,
        reasons: coverage.reasons,
      };
    })
    .filter((watch) => watch.level === "none" || watch.level === "low")
    .slice(0, limit);

  const noisyWatches = buildStoreReport(store).noisyWatches.slice(0, limit);
  const actionSummary: string[] = [];
  if (duplicateGroups.length) {
    actionSummary.push(`Resolve ${duplicateGroups.length} duplicate URL group${duplicateGroups.length === 1 ? "" : "s"} with deal_watch_dedupe or view-based cleanup.`);
  }
  if (noSnapshot.length) {
    actionSummary.push(`Scan or remove ${noSnapshot.length} watch${noSnapshot.length === 1 ? "" : "es"} that still have no committed snapshot.`);
  }
  if (weakExtraction.length) {
    actionSummary.push(`Review ${weakExtraction.length} watch${weakExtraction.length === 1 ? "" : "es"} with weak extraction quality.`);
  }

  return {
    watchCount: store.watches.length,
    duplicateGroups,
    disabledStale,
    noSnapshot,
    weakExtraction,
    noisyWatches,
    actionSummary,
  };
}

export function buildWorkflowPortfolio(
  store: StoreFile,
  limit = 10,
): {
  watchCount: number;
  overview: ReturnType<typeof buildStoreReport>;
  strongestAlerts: ReturnType<typeof buildAlertsSummary>;
  topDrops: ReturnType<typeof buildTopDropsSummary>;
  trends: ReturnType<typeof buildTrendsSummary>;
  marketLeaders: ReturnType<typeof buildWorkflowBestOpportunities>["marketLeaders"];
  groupBreakdown: Array<{ group: string; count: number }>;
  tagBreakdown: Array<{ tag: string; count: number }>;
  actionSummary: string[];
} {
  const overview = buildStoreReport(store);
  const strongestAlerts = buildAlertsSummary(store, "medium", limit);
  const topDrops = buildTopDropsSummary(store, "vs_peak", limit);
  const trends = buildTrendsSummary(store, limit);
  const marketLeaders = buildMarketLeaders(store, limit);
  const groupBreakdown = buildGroupBreakdown(store.watches, limit);
  const tagBreakdown = buildTagBreakdown(store.watches, limit);
  const actionSummary: string[] = [];

  if (strongestAlerts.alerts[0]) {
    actionSummary.push(`The hottest current alert is ${strongestAlerts.alerts[0].label ?? strongestAlerts.alerts[0].watchId}.`);
  }
  if (topDrops.drops[0]) {
    actionSummary.push(`The deepest current drop is ${topDrops.drops[0].label ?? topDrops.drops[0].watchId}.`);
  }
  if (overview.noisyWatches.length) {
    actionSummary.push(`There ${overview.noisyWatches.length === 1 ? "is" : "are"} ${overview.noisyWatches.length} noisy watch${overview.noisyWatches.length === 1 ? "" : "es"} worth reviewing.`);
  }

  return {
    watchCount: store.watches.length,
    overview,
    strongestAlerts,
    topDrops,
    trends,
    marketLeaders,
    groupBreakdown,
    tagBreakdown,
    actionSummary,
  };
}

export function buildTaxonomySummary(
  store: StoreFile,
  limit = 10,
): {
  watchCount: number;
  groupedCount: number;
  ungroupedCount: number;
  taggedCount: number;
  untaggedCount: number;
  groupBreakdown: Array<{ group: string; count: number; activeSignals: number; watchIds: string[] }>;
  tagBreakdown: Array<{ tag: string; count: number; activeSignals: number; watchIds: string[] }>;
  suggestedSavedViews: Array<{
    name: string;
    description: string;
    selector: {
      group?: string;
      tag?: string;
      hasSignals?: boolean;
      enabled?: boolean;
    };
    reason: string;
  }>;
  actionSummary: string[];
} {
  const groupedCount = store.watches.filter((watch) => Boolean(watch.group?.trim())).length;
  const taggedCount = store.watches.filter((watch) => Boolean(watch.tags?.length)).length;
  const groupBreakdown = buildDetailedGroupBreakdown(store.watches, limit);
  const tagBreakdown = buildDetailedTagBreakdown(store.watches, limit);
  const existingViewNames = new Set(store.savedViews.map((view) => view.name.toLowerCase()));
  const existingSelectorKeys = new Set(
    store.savedViews.map((view) => JSON.stringify(view.selector ?? {})),
  );
  const suggestedSavedViews: Array<{
    name: string;
    description: string;
    selector: {
      group?: string;
      tag?: string;
      hasSignals?: boolean;
      enabled?: boolean;
    };
    reason: string;
  }> = [];

  for (const group of groupBreakdown) {
    if (group.group === "(ungrouped)" || group.count < 2) continue;
    suggestedSavedViews.push({
      name: `${group.group} watchlist`,
      description: `Watches grouped under ${group.group}.`,
      selector: { group: group.group },
      reason: `${group.count} watches already share the ${group.group} group.`,
    });
    if (group.activeSignals > 0) {
      suggestedSavedViews.push({
        name: `${group.group} active signals`,
        description: `Signal-heavy watches in the ${group.group} group.`,
        selector: { group: group.group, hasSignals: true, enabled: true },
        reason: `${group.activeSignals} watches in ${group.group} currently have active signals.`,
      });
    }
  }

  for (const tag of tagBreakdown) {
    if (tag.count < 2) continue;
    suggestedSavedViews.push({
      name: `${tag.tag} tag view`,
      description: `Watches carrying the ${tag.tag} tag.`,
      selector: { tag: tag.tag },
      reason: `${tag.count} watches already share the ${tag.tag} tag.`,
    });
  }

  const dedupedSuggestedViews = suggestedSavedViews
    .filter((view, index, views) => {
      if (existingViewNames.has(view.name.toLowerCase())) return false;
      if (existingSelectorKeys.has(JSON.stringify(view.selector))) return false;
      return views.findIndex((candidate) => candidate.name === view.name) === index;
    })
    .slice(0, limit);

  const actionSummary: string[] = [];
  if (ungroupedCount(store.watches) > 0) {
    actionSummary.push(
      `${ungroupedCount(store.watches)} watch${ungroupedCount(store.watches) === 1 ? "" : "es"} are still ungrouped and may benefit from deal_watch_tag or deal_view_bulk_update.`,
    );
  }
  if (store.watches.length - taggedCount > 0) {
    const untaggedCount = store.watches.length - taggedCount;
    actionSummary.push(
      `${untaggedCount} watch${untaggedCount === 1 ? "" : "es"} still have no tags, which limits saved-view reuse.`,
    );
  }
  if (groupBreakdown[0] && groupBreakdown[0].group !== "(ungrouped)") {
    actionSummary.push(`Largest current group: ${groupBreakdown[0].group} (${groupBreakdown[0].count} watches).`);
  }
  if (tagBreakdown[0]) {
    actionSummary.push(`Most common tag: ${tagBreakdown[0].tag} (${tagBreakdown[0].count} watches).`);
  }

  return {
    watchCount: store.watches.length,
    groupedCount,
    ungroupedCount: store.watches.length - groupedCount,
    taggedCount,
    untaggedCount: store.watches.length - taggedCount,
    groupBreakdown,
    tagBreakdown,
    suggestedSavedViews: dedupedSuggestedViews,
    actionSummary,
  };
}

function ungroupedCount(watches: Watch[]): number {
  return watches.filter((watch) => !watch.group?.trim()).length;
}

export function buildHostReportSummary(
  store: StoreFile,
  limit = 10,
): {
  hostCount: number;
  hosts: Array<{
    host: string;
    watchCount: number;
    enabledCount: number;
    withSnapshots: number;
    activeSignals: number;
    mediumOrHigherAlerts: number;
    noisyCount: number;
    glitchyCount: number;
    topTags: string[];
    topGroups: string[];
    recommendedMinutes: number;
    cadenceBasis: string;
    sampleWatchIds: string[];
  }>;
  actionSummary: string[];
} {
  const scheduleByHost = new Map(
    buildScheduleAdvice(store, "host").recommendations.map((recommendation) => [recommendation.target, recommendation]),
  );
  const groups = new Map<string, Watch[]>();
  for (const watch of store.watches) {
    const host = getWatchHost(watch.url);
    const existing = groups.get(host) ?? [];
    existing.push(watch);
    groups.set(host, existing);
  }

  const hosts = [...groups.entries()]
    .map(([host, watches]) => {
      const tagCounts = new Map<string, number>();
      const groupCounts = new Map<string, number>();
      let activeSignals = 0;
      let mediumOrHigherAlerts = 0;
      let noisyCount = 0;
      let glitchyCount = 0;

      for (const watch of watches) {
        const signals = buildWatchSignals(watch);
        if (signals.length) activeSignals += 1;

        const history = summarizeHistory(watch);
        const latestSeverity = history.latestEntry?.alertSeverity;
        if (latestSeverity === "medium" || latestSeverity === "high") {
          mediumOrHigherAlerts += 1;
        }

        if (buildNoiseAssessment(watch, history).score >= 60) {
          noisyCount += 1;
        }

        if (buildGlitchAssessment(watch, history, signals).score >= 70) {
          glitchyCount += 1;
        }

        for (const tag of watch.tags ?? []) {
          tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
        }
        if (watch.group?.trim()) {
          groupCounts.set(watch.group, (groupCounts.get(watch.group) ?? 0) + 1);
        }
      }

      const cadence = scheduleByHost.get(host) ?? {
        recommendedMinutes: 360,
        basis: "Insufficient history; defaulting to every 6 hours.",
        sampleWatchIds: watches.slice(0, 5).map((watch) => watch.id),
      };

      return {
        host,
        watchCount: watches.length,
        enabledCount: watches.filter((watch) => watch.enabled).length,
        withSnapshots: watches.filter((watch) => Boolean(watch.lastSnapshot)).length,
        activeSignals,
        mediumOrHigherAlerts,
        noisyCount,
        glitchyCount,
        topTags: [...tagCounts.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, 3)
          .map(([tag]) => tag),
        topGroups: [...groupCounts.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, 3)
          .map(([group]) => group),
        recommendedMinutes: cadence.recommendedMinutes,
        cadenceBasis: cadence.basis,
        sampleWatchIds: cadence.sampleWatchIds,
      };
    })
    .sort(
      (a, b) =>
        b.watchCount - a.watchCount ||
        b.activeSignals - a.activeSignals ||
        a.recommendedMinutes - b.recommendedMinutes ||
        a.host.localeCompare(b.host),
    )
    .slice(0, limit);

  const actionSummary: string[] = [];
  if (hosts[0]) {
    actionSummary.push(`Largest host footprint: ${hosts[0].host} (${hosts[0].watchCount} watches).`);
  }
  const hottestHost = hosts
    .filter((host) => host.activeSignals > 0 || host.mediumOrHigherAlerts > 0)
    .sort((a, b) => b.activeSignals + b.mediumOrHigherAlerts - (a.activeSignals + a.mediumOrHigherAlerts))[0];
  if (hottestHost) {
    actionSummary.push(`Most active host right now: ${hottestHost.host} (${hottestHost.activeSignals} active signals, ${hottestHost.mediumOrHigherAlerts} medium+ alerts).`);
  }
  const fastestHost = hosts
    .slice()
    .sort((a, b) => a.recommendedMinutes - b.recommendedMinutes || b.watchCount - a.watchCount)[0];
  if (fastestHost) {
    actionSummary.push(`Most time-sensitive host cadence: ${fastestHost.host} every ${fastestHost.recommendedMinutes} minutes.`);
  }

  return {
    hostCount: groups.size,
    hosts,
    actionSummary,
  };
}

export function buildWorkflowTriage(
  store: StoreFile,
  limit = 5,
  minSeverity: AlertSeverity = "medium",
): {
  watchCount: number;
  changed: ReturnType<typeof buildStoreReport>["recentChanges"];
  strongestAlerts: ReturnType<typeof buildAlertsSummary>["alerts"];
  probableNoise: Array<{
    watchId: string;
    label?: string;
    url: string;
    glitchScore?: number;
    noiseScore?: number;
    reason: string;
  }>;
  bestOpportunity?: ReturnType<typeof buildWorkflowBestOpportunities>["topRealDeals"][number];
  suspiciousOpportunity?: ReturnType<typeof buildWorkflowBestOpportunities>["suspiciousDeals"][number];
  actionSummary: string[];
} {
  const overview = buildStoreReport(store);
  const best = buildWorkflowBestOpportunities(store, limit);
  const strongestAlerts = buildAlertsSummary(store, minSeverity, limit).alerts;
  const probableNoise = [
    ...best.suspiciousDeals.map((item) => ({
      watchId: item.watchId,
      label: item.label,
      url: item.url,
      glitchScore: item.glitchScore,
      score: item.glitchScore,
      reason: item.reasons[0] ?? "Likely glitch-prone behavior.",
    })),
    ...overview.noisyWatches.map((item) => ({
      watchId: item.watchId,
      label: item.label,
      url: item.url,
      noiseScore: item.noiseScore,
      score: item.noiseScore,
      reason: item.reason,
    })),
  ]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ score: _score, ...item }) => item);

  const actionSummary: string[] = [];
  if (best.topRealDeals[0]) {
    actionSummary.push(`Best current likely-real opportunity: ${best.topRealDeals[0].label ?? best.topRealDeals[0].watchId}.`);
  }
  if (probableNoise.length) {
    actionSummary.push(`Treat ${probableNoise.length} watch${probableNoise.length === 1 ? "" : "es"} as noisy or suspicious until reviewed.`);
  }
  if (!best.topRealDeals.length && strongestAlerts.length) {
    actionSummary.push("Alerts exist, but none currently clear the low-glitch filter for likely-real opportunities.");
  }

  return {
    watchCount: store.watches.length,
    changed: overview.recentChanges.slice(0, limit),
    strongestAlerts,
    probableNoise,
    bestOpportunity: best.topRealDeals[0],
    suspiciousOpportunity: best.suspiciousDeals[0],
    actionSummary,
  };
}

export function buildWorkflowActionQueue(
  store: StoreFile,
  options?: {
    limit?: number;
    severity?: AlertSeverity;
    scopeLabel?: string;
  },
): {
  scopeLabel: string;
  watchCount: number;
  itemCount: number;
  items: Array<{
    priority: "high" | "medium" | "low";
    category: "opportunity" | "alert" | "cleanup" | "discovery" | "review";
    title: string;
    reason: string;
    recommendedTool: string;
    watchId?: string;
    label?: string;
    url?: string;
  }>;
  actionSummary: string[];
} {
  const limit = options?.limit ?? 10;
  const triage = buildWorkflowTriage(store, Math.min(limit, 5), options?.severity ?? "medium");
  const cleanup = buildWorkflowCleanup(store, Math.min(limit, 5));
  const discovery = buildDiscoveryBacklog(store, Math.min(limit, 5));
  const reviewQueue = listLlmReviewCandidates(store).slice(0, Math.min(limit, 5));
  const items: Array<{
    priority: "high" | "medium" | "low";
    category: "opportunity" | "alert" | "cleanup" | "discovery" | "review";
    title: string;
    reason: string;
    recommendedTool: string;
    watchId?: string;
    label?: string;
    url?: string;
    score: number;
  }> = [];

  if (triage.bestOpportunity) {
    items.push({
      priority: "high",
      category: "opportunity",
      title: `Best current opportunity: ${triage.bestOpportunity.label ?? triage.bestOpportunity.watchId}`,
      reason: triage.bestOpportunity.rationale[0] ?? "This currently looks like the strongest likely-real deal.",
      recommendedTool: "deal_workflow_best_opportunities",
      watchId: triage.bestOpportunity.watchId,
      label: triage.bestOpportunity.label,
      url: triage.bestOpportunity.url,
      score: 100,
    });
  }

  for (const alert of triage.strongestAlerts.slice(0, Math.min(limit, 3))) {
    items.push({
      priority: alert.severity === "high" ? "high" : "medium",
      category: "alert",
      title: `Alert: ${alert.label ?? alert.watchId}`,
      reason: alert.summaryLine ?? "Threshold or keyword alert is currently active.",
      recommendedTool: "deal_alerts",
      watchId: alert.watchId,
      label: alert.label,
      url: alert.url,
      score: alert.severity === "high" ? 90 : 70,
    });
  }

  for (const duplicate of cleanup.duplicateGroups.slice(0, 2)) {
    items.push({
      priority: "medium",
      category: "cleanup",
      title: `Duplicate watch group on ${duplicate.canonicalUrl}`,
      reason: `Keep ${duplicate.keepWatchId} and review ${duplicate.duplicateWatchIds.length} duplicate watch${duplicate.duplicateWatchIds.length === 1 ? "" : "es"}.`,
      recommendedTool: "deal_watch_dedupe",
      watchId: duplicate.keepWatchId,
      url: duplicate.canonicalUrl,
      score: 60,
    });
  }

  for (const weak of cleanup.weakExtraction.slice(0, 2)) {
    items.push({
      priority: "medium",
      category: "cleanup",
      title: `Weak extraction: ${weak.label ?? weak.watchId}`,
      reason: weak.reasons[0] ?? "Extraction quality is too weak for reliable automation.",
      recommendedTool: "deal_extraction_debug",
      watchId: weak.watchId,
      label: weak.label,
      url: weak.url,
      score: 58,
    });
  }

  for (const backlog of discovery.backlog.slice(0, 2)) {
    items.push({
      priority: backlog.priority,
      category: "discovery",
      title: `Discovery target: ${backlog.label ?? backlog.watchId}`,
      reason: backlog.reasons[0] ?? "This watch would benefit from broader same-product coverage.",
      recommendedTool: "deal_discovery_backlog",
      watchId: backlog.watchId,
      label: backlog.label,
      url: backlog.url,
      score: backlog.priority === "high" ? 65 : backlog.priority === "medium" ? 45 : 30,
    });
  }

  for (const candidate of reviewQueue.slice(0, 2)) {
    items.push({
      priority: candidate.priority,
      category: "review",
      title: `Review candidate: ${candidate.label ?? candidate.watchId}`,
      reason: candidate.reasons[0] ?? "Manual or model-assisted review is recommended.",
      recommendedTool: "deal_llm_review_queue",
      watchId: candidate.watchId,
      label: candidate.label,
      url: candidate.url,
      score: candidate.priority === "high" ? 55 : 35,
    });
  }

  const deduped = new Map<string, (typeof items)[number]>();
  for (const item of items) {
    const key = `${item.category}:${item.watchId ?? item.title}`;
    const existing = deduped.get(key);
    if (!existing || item.score > existing.score) {
      deduped.set(key, item);
    }
  }

  const ranked = [...deduped.values()]
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, limit)
    .map(({ score: _score, ...item }) => item);

  const actionSummary: string[] = [];
  if (ranked[0]) {
    actionSummary.push(`Start with: ${ranked[0].title}.`);
  }
  const categoryCounts = new Map<string, number>();
  for (const item of ranked) {
    categoryCounts.set(item.category, (categoryCounts.get(item.category) ?? 0) + 1);
  }
  for (const [category, count] of categoryCounts.entries()) {
    actionSummary.push(`${count} ${category} action${count === 1 ? "" : "s"} surfaced in the current queue.`);
  }

  return {
    scopeLabel: options?.scopeLabel ?? "watchlist",
    watchCount: store.watches.length,
    itemCount: ranked.length,
    items: ranked,
    actionSummary,
  };
}

export function buildViewReport(
  store: StoreFile,
  watches: Watch[],
  options?: {
    limit?: number;
    severity?: AlertSeverity;
    metric?: "vs_peak" | "latest_change";
  },
): {
  scopedCount: number;
  report: ReturnType<typeof buildStoreReport>;
  alerts: ReturnType<typeof buildAlertsSummary>;
  trends: ReturnType<typeof buildTrendsSummary>;
  topDrops: ReturnType<typeof buildTopDropsSummary>;
  bestOpportunities: ReturnType<typeof buildWorkflowBestOpportunities>;
} {
  const scopedStore = buildSubsetStore(store, watches);
  const limit = options?.limit ?? 10;
  return {
    scopedCount: watches.length,
    report: buildStoreReport(scopedStore),
    alerts: buildAlertsSummary(scopedStore, options?.severity ?? "low", limit),
    trends: buildTrendsSummary(scopedStore, limit),
    topDrops: buildTopDropsSummary(scopedStore, options?.metric ?? "vs_peak", limit),
    bestOpportunities: buildWorkflowBestOpportunities(scopedStore, Math.min(limit, 5)),
  };
}

export function buildDigestSummary(
  store: StoreFile,
  options?: {
    limit?: number;
    severity?: AlertSeverity;
    scopeLabel?: string;
  },
): {
  scopeLabel: string;
  watchCount: number;
  headline: string;
  topLine: string;
  highlights: string[];
  actions: string[];
  digestText: string;
  bestOpportunity?: ReturnType<typeof buildWorkflowBestOpportunities>["topRealDeals"][number];
  suspiciousOpportunity?: ReturnType<typeof buildWorkflowBestOpportunities>["suspiciousDeals"][number];
  strongestAlerts: ReturnType<typeof buildAlertsSummary>["alerts"];
  changed: ReturnType<typeof buildWorkflowTriage>["changed"];
  probableNoise: ReturnType<typeof buildWorkflowTriage>["probableNoise"];
} {
  const limit = options?.limit ?? 5;
  const scopeLabel = options?.scopeLabel ?? "watchlist";
  const triage = buildWorkflowTriage(store, limit, options?.severity ?? "medium");
  const best = buildWorkflowBestOpportunities(store, Math.min(limit, 5));
  const changedCount = triage.changed.length;
  const alertCount = triage.strongestAlerts.length;
  const noisyCount = triage.probableNoise.length;

  const headlineParts = [`${scopeLabel}: ${store.watches.length} watch${store.watches.length === 1 ? "" : "es"}`];
  if (changedCount) headlineParts.push(`${changedCount} recent change${changedCount === 1 ? "" : "s"}`);
  if (alertCount) headlineParts.push(`${alertCount} active alert${alertCount === 1 ? "" : "s"}`);
  const headline = headlineParts.join(", ");

  let topLine = `No urgent movement detected in ${scopeLabel}.`;
  if (triage.bestOpportunity) {
    const priceText = triage.bestOpportunity.latestPrice != null ? ` at ${triage.bestOpportunity.latestPrice.toFixed(2)}` : "";
    topLine = `Best current opportunity in ${scopeLabel}: ${triage.bestOpportunity.label ?? triage.bestOpportunity.watchId}${priceText}.`;
  } else if (triage.strongestAlerts[0]) {
    topLine = `Top alert in ${scopeLabel}: ${triage.strongestAlerts[0].label ?? triage.strongestAlerts[0].watchId}.`;
  }

  const highlights: string[] = [];
  if (triage.bestOpportunity) {
    highlights.push(
      `Best likely-real deal: ${triage.bestOpportunity.label ?? triage.bestOpportunity.watchId}${triage.bestOpportunity.marketSpreadPercent != null ? ` (${triage.bestOpportunity.marketSpreadPercent.toFixed(1)}% internal spread)` : ""}.`,
    );
  }
  if (triage.suspiciousOpportunity) {
    highlights.push(
      `Most suspicious/glitch-prone watch: ${triage.suspiciousOpportunity.label ?? triage.suspiciousOpportunity.watchId} (glitch score ${triage.suspiciousOpportunity.glitchScore}).`,
    );
  }
  if (triage.changed[0]) {
    highlights.push(`Most recent meaningful change: ${triage.changed[0].label ?? triage.changed[0].watchId}.`);
  }
  if (triage.strongestAlerts[0] && !highlights.some((line) => line.includes(triage.strongestAlerts[0]!.label ?? triage.strongestAlerts[0]!.watchId))) {
    highlights.push(`Strongest alert: ${triage.strongestAlerts[0].label ?? triage.strongestAlerts[0].watchId}.`);
  }
  if (noisyCount) {
    highlights.push(`${noisyCount} watch${noisyCount === 1 ? "" : "es"} currently look noisy or suspicious.`);
  }

  const actions = [...triage.actionSummary];
  for (const action of best.actionSummary) {
    if (!actions.includes(action)) actions.push(action);
  }

  const digestLines = [
    headline,
    topLine,
    ...(highlights.length ? ["Highlights:", ...highlights.map((line) => `- ${line}`)] : []),
    ...(actions.length ? ["Actions:", ...actions.map((line) => `- ${line}`)] : []),
  ];

  return {
    scopeLabel,
    watchCount: store.watches.length,
    headline,
    topLine,
    highlights,
    actions,
    digestText: digestLines.join("\n"),
    bestOpportunity: triage.bestOpportunity,
    suspiciousOpportunity: triage.suspiciousOpportunity,
    strongestAlerts: triage.strongestAlerts,
    changed: triage.changed,
    probableNoise: triage.probableNoise,
  };
}

export function buildSavedViewDashboard(
  store: StoreFile,
  options?: {
    limit?: number;
    severity?: AlertSeverity;
  },
): {
  savedViewCount: number;
  populatedViewCount: number;
  emptyViewCount: number;
  views: Array<{
    savedViewId: string;
    name: string;
    description?: string;
    matchCount: number;
    enabledMatchCount: number;
    signalMatchCount: number;
    topLine: string;
    hottestAlert?: {
      watchId: string;
      label?: string;
      severity: AlertSeverity;
      summaryLine?: string;
    };
    bestOpportunity?: {
      watchId: string;
      label?: string;
      latestPrice?: number;
      summaryLine?: string;
    };
    nextAction?: {
      title: string;
      category: "opportunity" | "alert" | "cleanup" | "discovery" | "review";
      recommendedTool: string;
    };
    priorityScore: number;
  }>;
  actionSummary: string[];
} {
  const limit = options?.limit ?? 10;
  const severity = options?.severity ?? "medium";
  const views = store.savedViews
    .map((view) => {
      const watches = searchWatches(store.watches, view.selector);
      const scopedStore = buildSubsetStore(store, watches);
      const digest = buildDigestSummary(scopedStore, {
        limit: Math.min(limit, 5),
        severity,
        scopeLabel: view.name,
      });
      const queue = buildWorkflowActionQueue(scopedStore, {
        limit: Math.min(limit, 5),
        severity,
        scopeLabel: view.name,
      });
      const hottestAlert = digest.strongestAlerts[0]
        ? {
            watchId: digest.strongestAlerts[0].watchId,
            label: digest.strongestAlerts[0].label,
            severity: digest.strongestAlerts[0].severity,
            summaryLine: digest.strongestAlerts[0].summaryLine,
          }
        : undefined;
      const bestOpportunity = digest.bestOpportunity
        ? {
            watchId: digest.bestOpportunity.watchId,
            label: digest.bestOpportunity.label,
            latestPrice: digest.bestOpportunity.latestPrice,
            summaryLine: digest.bestOpportunity.summaryLine,
          }
        : undefined;
      const nextAction = queue.items[0]
        ? {
            title: queue.items[0].title,
            category: queue.items[0].category,
            recommendedTool: queue.items[0].recommendedTool,
          }
        : undefined;
      const enabledMatchCount = watches.filter((watch) => watch.enabled).length;
      const signalMatchCount = watches.filter((watch) => buildWatchSignals(watch).length > 0).length;
      const priorityScore =
        (bestOpportunity ? 60 : 0) +
        (hottestAlert ? (hottestAlert.severity === "high" ? 35 : hottestAlert.severity === "medium" ? 20 : 10) : 0) +
        Math.min(15, signalMatchCount * 3) +
        (nextAction ? 10 : 0);

      return {
        savedViewId: view.id,
        name: view.name,
        description: view.description,
        matchCount: watches.length,
        enabledMatchCount,
        signalMatchCount,
        topLine: digest.topLine,
        hottestAlert,
        bestOpportunity,
        nextAction,
        priorityScore,
      };
    })
    .sort((a, b) => b.priorityScore - a.priorityScore || b.matchCount - a.matchCount || a.name.localeCompare(b.name))
    .slice(0, limit);

  const actionSummary: string[] = [];
  if (views[0]) {
    actionSummary.push(`Start with saved view ${views[0].name}; it currently has the highest action priority.`);
  }
  const emptyViewCount = store.savedViews.filter((view) => searchWatches(store.watches, view.selector).length === 0).length;
  if (emptyViewCount) {
    actionSummary.push(`${emptyViewCount} saved view${emptyViewCount === 1 ? "" : "s"} currently match no watches and may need retuning.`);
  }

  return {
    savedViewCount: store.savedViews.length,
    populatedViewCount: views.filter((view) => view.matchCount > 0).length,
    emptyViewCount,
    views,
    actionSummary,
  };
}

export function listLlmReviewCandidates(store: StoreFile): LlmReviewCandidate[] {
  const titleCounts = new Map<string, number>();
  for (const watch of store.watches) {
    const canonicalTitle = watch.lastSnapshot?.canonicalTitle?.trim().toLowerCase();
    if (canonicalTitle) {
      titleCounts.set(canonicalTitle, (titleCounts.get(canonicalTitle) ?? 0) + 1);
    }
  }

  const extractionCandidates = store.watches
    .map((watch) => {
      const coverage = buildExtractionCoverage(watch);
      if (coverage.level !== "none" && coverage.level !== "low") return null;
      return {
        watchId: watch.id,
        label: watch.label,
        url: watch.url,
        type: "extraction_review" as const,
        priority: coverage.level === "none" ? "high" as const : "medium" as const,
        reasons: coverage.reasons,
        currentSnapshot: watch.lastSnapshot
          ? {
              title: watch.lastSnapshot.title,
              canonicalTitle: watch.lastSnapshot.canonicalTitle,
              brand: watch.lastSnapshot.brand,
              modelId: watch.lastSnapshot.modelId,
              sku: watch.lastSnapshot.sku,
              mpn: watch.lastSnapshot.mpn,
              gtin: watch.lastSnapshot.gtin,
              asin: watch.lastSnapshot.asin,
              price: watch.lastSnapshot.price,
              currency: watch.lastSnapshot.currency,
              rawSnippet: watch.lastSnapshot.rawSnippet,
            }
          : null,
        prompt:
          "Review the product page extraction. Return the best-guess normalized product title, optional brand/model identifiers, price, currency, stock status if obvious, and a confidence explanation.",
        input: {
          url: watch.url,
          label: watch.label,
          latestSnapshot: watch.lastSnapshot ?? null,
          recentHistory: getHistoryEntries(watch).slice(-3),
        },
        suggestedSchema: {
          type: "object",
          properties: {
            title: { type: ["string", "null"] },
            brand: { type: ["string", "null"] },
            modelId: { type: ["string", "null"] },
            sku: { type: ["string", "null"] },
            mpn: { type: ["string", "null"] },
            gtin: { type: ["string", "null"] },
            asin: { type: ["string", "null"] },
            price: { type: ["number", "null"] },
            currency: { type: ["string", "null"] },
            stockState: { type: ["string", "null"] },
            confidence: {
              type: "object",
              properties: {
                level: { type: "string", enum: ["low", "medium", "high"] },
                reasons: { type: "array", items: { type: "string" } },
              },
              required: ["level", "reasons"],
              additionalProperties: false,
            },
          },
          required: ["title", "confidence"],
          additionalProperties: false,
        },
      };
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate));

  const identityCandidates = store.watches
    .map((watch) => {
      const title = watch.lastSnapshot?.canonicalTitle?.trim().toLowerCase();
      if (!watch.lastSnapshot || !title) return null;
      if (getWatchIdentityFields(watch).length > 0) return null;
      if ((titleCounts.get(title) ?? 0) < 2) return null;

      const peerTitles = store.watches
        .filter((candidate) => candidate.id !== watch.id && candidate.lastSnapshot?.canonicalTitle?.trim().toLowerCase() === title)
        .map((candidate) => ({
          watchId: candidate.id,
          label: candidate.label,
          url: candidate.url,
          price: candidate.lastSnapshot?.price,
          brand: candidate.lastSnapshot?.brand,
        }))
        .slice(0, 5);

      return {
        watchId: watch.id,
        label: watch.label,
        url: watch.url,
        type: "identity_resolution" as const,
        priority: "medium" as const,
        reasons: [
          "Canonical title appears on multiple watches, but this watch has no persistent identifiers.",
          "Same-product grouping would be stronger with model/SKU/MPN/GTIN confirmation.",
        ],
        currentSnapshot: {
          title: watch.lastSnapshot.title,
          canonicalTitle: watch.lastSnapshot.canonicalTitle,
          brand: watch.lastSnapshot.brand,
          modelId: watch.lastSnapshot.modelId,
          sku: watch.lastSnapshot.sku,
          mpn: watch.lastSnapshot.mpn,
          gtin: watch.lastSnapshot.gtin,
          asin: watch.lastSnapshot.asin,
          price: watch.lastSnapshot.price,
          currency: watch.lastSnapshot.currency,
          rawSnippet: watch.lastSnapshot.rawSnippet,
        },
        prompt:
          "Resolve likely product identity for this watch. Infer any reliable persistent identifiers only if supported by the provided snapshot/title context. Be conservative.",
        input: {
          url: watch.url,
          label: watch.label,
          latestSnapshot: watch.lastSnapshot,
          peerWatchesWithSameCanonicalTitle: peerTitles,
        },
        suggestedSchema: {
          type: "object",
          properties: {
            sameProductAsPeers: { type: "boolean" },
            brand: { type: ["string", "null"] },
            modelId: { type: ["string", "null"] },
            sku: { type: ["string", "null"] },
            mpn: { type: ["string", "null"] },
            gtin: { type: ["string", "null"] },
            asin: { type: ["string", "null"] },
            confidence: {
              type: "object",
              properties: {
                level: { type: "string", enum: ["low", "medium", "high"] },
                reasons: { type: "array", items: { type: "string" } },
              },
              required: ["level", "reasons"],
              additionalProperties: false,
            },
          },
          required: ["sameProductAsPeers", "confidence"],
          additionalProperties: false,
        },
      };
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate));

  return [...extractionCandidates, ...identityCandidates]
    .sort((a, b) => Number(b.priority === "high") - Number(a.priority === "high") || a.url.localeCompare(b.url))
}

export function buildLlmReviewQueue(
  store: StoreFile,
  limit = 10,
): {
  integrationStatus: "deferred_cleanly";
  reason: string;
  candidateCount: number;
  candidates: LlmReviewCandidate[];
  notes: string[];
} {
  const candidates = listLlmReviewCandidates(store).slice(0, limit);

  return {
    integrationStatus: "deferred_cleanly",
    reason:
      "Automatic LLM fallback remains intentionally disabled; use deal_llm_review_run when you want explicit opt-in JSON review for one queued candidate.",
    candidateCount: candidates.length,
    candidates,
    notes: [
      "This queue is safe for manual review, deal_llm_review_run, or a separate workflow that explicitly enables the bundled llm-task plugin.",
      "The suggested prompt/input/schema fields are designed to stay portable across manual review, embedded execution, or JSON-only llm-task workflows.",
    ],
  };
}
