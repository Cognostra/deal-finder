import type { ResolvedDealConfig } from "../config.js";
import type { AlertSeverity, StoreFile, Watch, WatchHistoryEntry } from "../types.js";
import { buildWatchSignals } from "./watch-view.js";

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
    allowlist: [
      "openclaw-deal-hunter",
      "deal_watch_list",
      "deal_watch_add",
      "deal_watch_update",
      "deal_watch_set_enabled",
      "deal_watch_search",
      "deal_watch_export",
      "deal_watch_import",
      "deal_watch_remove",
      "deal_scan",
      "deal_fetch_url",
      "deal_evaluate_text",
      "deal_help",
      "deal_report",
      "deal_health",
      "deal_history",
      "deal_alerts",
      "deal_doctor",
      "deal_sample_setup",
    ],
    examplePrompts: [
      "Use deal_help and tell me the best first-run workflow for this plugin.",
      "Use deal_watch_add to add a watch for https://example.com/product and then use deal_scan with commit true.",
      "Use deal_watch_search to show me disabled watches and any watches currently showing threshold or keyword signals.",
      "Use deal_alerts to show me the hottest current signals, then use deal_history for the most interesting watch.",
      "Use deal_watch_export to back up my watches, then prepare a deal_watch_import dry run for another workspace.",
    ],
    cronExample:
      "openclaw cron add --name \"Deal scan\" --cron \"0 * * * *\" --session isolated --message \"Run deal_scan with commit true for all enabled watches. Summarize any alerts.\" --announce",
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
