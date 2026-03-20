import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult, withFileLock } from "openclaw/plugin-sdk";
import { resolveDealConfig } from "./config.js";
import { mergeCommittedScanResults, runScan } from "./lib/engine.js";
import { cappedFetch } from "./lib/fetch.js";
import { evaluateListingText, extractListing } from "./lib/heuristics.js";
import {
  buildAlertsSummary,
  buildDoctorSummary,
  buildHealthSummary,
  buildHistorySummary,
  buildQuickstartGuide,
  buildSampleSetup,
  buildStoreReport,
} from "./lib/report.js";
import type { ImportedWatchInput } from "./lib/store.js";
import { addWatch, getWatch, importWatches, loadStore, removeWatch, saveStore, setWatchEnabled, updateWatch } from "./lib/store.js";
import { buildWatchSignals, searchWatches } from "./lib/watch-view.js";
import { validateTargetUrl } from "./lib/url-policy.js";

const LOCK_OPTS = {
  retries: { retries: 20, factor: 1.5, minTimeout: 40, maxTimeout: 800, randomize: true },
  stale: 120_000,
} as const;

function buildScanSummary(results: Awaited<ReturnType<typeof runScan>>) {
  const summary = {
    ok: 0,
    failed: 0,
    changed: 0,
    alerted: 0,
    highPriority: 0,
    lowConfidence: 0,
    unchanged: 0,
  };

  for (const result of results) {
    if (result.ok) summary.ok += 1;
    else summary.failed += 1;
    if (result.changed) summary.changed += 1;
    if (result.alertSeverity !== "none") summary.alerted += 1;
    if (result.alertSeverity === "high") summary.highPriority += 1;
    if (result.extractionConfidence.level === "low" || result.extractionConfidence.level === "none") {
      summary.lowConfidence += 1;
    }
    if (!result.changed && result.ok) summary.unchanged += 1;
  }

  const rankedAlerts = results
    .filter((result) => result.alertSeverity !== "none")
    .sort((a, b) => b.alertScore - a.alertScore || a.timingMs.total - b.timingMs.total)
    .map((result) => ({
      watchId: result.watchId,
      label: result.label,
      url: result.url,
      fetchSource: result.fetchSource,
      fetchSourceNote: result.fetchSourceNote,
      changeType: result.changeType,
      alertSeverity: result.alertSeverity,
      alertScore: result.alertScore,
      summaryLine: result.summaryLine,
      alerts: result.alerts,
      previousPrice: result.previousPrice,
      currentPrice: result.currentPrice,
      priceDelta: result.priceDelta,
      percentDelta: result.percentDelta,
      extractionConfidence: result.extractionConfidence,
    }));

  return { summary, rankedAlerts };
}

function toWatchView(watch: Awaited<ReturnType<typeof loadStore>>["watches"][number]) {
  const signals = buildWatchSignals(watch);
  const prices = (watch.history ?? [])
    .map((entry) => entry.price)
    .filter((price): price is number => price != null);
  return {
    ...watch,
    currentPrice: watch.lastSnapshot?.price,
    currentCurrency: watch.lastSnapshot?.currency,
    lastFetchedAt: watch.lastSnapshot?.fetchedAt,
    historyCount: watch.history?.length ?? 0,
    lowestSeenPrice: prices.length ? Math.min(...prices) : watch.lastSnapshot?.price,
    highestSeenPrice: prices.length ? Math.max(...prices) : watch.lastSnapshot?.price,
    signalCount: signals.length,
    signals,
  };
}

const IMPORTED_WATCH_SCHEMA = Type.Object({
  id: Type.Optional(Type.String()),
  url: Type.String(),
  label: Type.Optional(Type.String()),
  maxPrice: Type.Optional(Type.Number()),
  percentDrop: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
  keywords: Type.Optional(Type.Array(Type.String())),
  checkIntervalHint: Type.Optional(Type.String()),
  enabled: Type.Optional(Type.Boolean()),
  createdAt: Type.Optional(Type.String()),
  lastSnapshot: Type.Optional(
    Type.Object({
      title: Type.Optional(Type.String()),
      canonicalTitle: Type.Optional(Type.String()),
      price: Type.Optional(Type.Number()),
      currency: Type.Optional(Type.String()),
      etag: Type.Optional(Type.String()),
      lastModified: Type.Optional(Type.String()),
      contentHash: Type.Optional(Type.String()),
      fetchedAt: Type.String(),
      rawSnippet: Type.Optional(Type.String()),
    }),
  ),
  history: Type.Optional(
    Type.Array(
      Type.Object({
        fetchedAt: Type.String(),
        price: Type.Optional(Type.Number()),
        currency: Type.Optional(Type.String()),
        title: Type.Optional(Type.String()),
        canonicalTitle: Type.Optional(Type.String()),
        contentHash: Type.Optional(Type.String()),
        changeType: Type.Optional(Type.String()),
        alertSeverity: Type.Optional(Type.Union([
          Type.Literal("none"),
          Type.Literal("low"),
          Type.Literal("medium"),
          Type.Literal("high"),
        ])),
        alerts: Type.Optional(Type.Array(Type.String())),
        summaryLine: Type.Optional(Type.String()),
      }),
    ),
  ),
});

export function registerDealTools(api: OpenClawPluginApi): void {
  const cfgBase = resolveDealConfig(api);
  const storePath = cfgBase.storePath;

  const withStore = async <T>(fn: (store: Awaited<ReturnType<typeof loadStore>>) => Promise<T>): Promise<T> => {
    return withFileLock(`${storePath}.lock`, LOCK_OPTS, async () => {
      const store = await loadStore(storePath);
      return fn(store);
    });
  };

  api.registerTool(
    {
      name: "deal_watch_list",
      label: "Deal Hunter",
      description: "List price watches and last snapshot metadata.",
      parameters: Type.Object({
        includeDisabled: Type.Optional(Type.Boolean({ description: "Include disabled watches" })),
      }),
      execute: async (_id, params) => {
        const store = await loadStore(storePath);
        const list = params.includeDisabled ? store.watches : store.watches.filter((w) => w.enabled);
        return jsonResult({ watches: list.map(toWatchView), storePath });
      },
    },
    { optional: false },
  );

  api.registerTool(
    {
      name: "deal_watch_add",
      label: "Deal Hunter",
      description: "Add a URL to the deal watchlist (optional price drop / max price thresholds).",
      parameters: Type.Object({
        url: Type.String(),
        label: Type.Optional(Type.String()),
        maxPrice: Type.Optional(Type.Number()),
        percentDrop: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
        keywords: Type.Optional(Type.Array(Type.String())),
        checkIntervalHint: Type.Optional(Type.String()),
        enabled: Type.Optional(Type.Boolean()),
      }),
      execute: async (_id, params) => {
        const cfg = resolveDealConfig(api);
        const normalizedUrl = validateTargetUrl(params.url, cfg).toString();
        await withStore(async (store) => {
          addWatch(store, {
            url: normalizedUrl,
            label: params.label,
            maxPrice: params.maxPrice,
            percentDrop: params.percentDrop,
            keywords: params.keywords,
            checkIntervalHint: params.checkIntervalHint,
            enabled: params.enabled,
          });
          await saveStore(storePath, store);
        });
        return jsonResult({ ok: true, message: "Watch added." });
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "deal_watch_update",
      label: "Deal Hunter",
      description: "Update watch metadata, thresholds, URL, or enabled state.",
      parameters: Type.Object({
        watchId: Type.String(),
        url: Type.Optional(Type.String()),
        label: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        maxPrice: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
        percentDrop: Type.Optional(Type.Union([Type.Number({ minimum: 0, maximum: 100 }), Type.Null()])),
        keywords: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
        checkIntervalHint: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        enabled: Type.Optional(Type.Boolean()),
        clearLastSnapshot: Type.Optional(Type.Boolean()),
      }),
      execute: async (_id, params) => {
        const cfg = resolveDealConfig(api);
        let updatedWatch = null;

        await withStore(async (store) => {
          const normalizedUrl = params.url ? validateTargetUrl(params.url, cfg).toString() : undefined;
          updatedWatch = updateWatch(store, params.watchId, {
            url: normalizedUrl,
            label: params.label,
            maxPrice: params.maxPrice,
            percentDrop: params.percentDrop,
            keywords: params.keywords,
            checkIntervalHint: params.checkIntervalHint,
            enabled: params.enabled,
            clearLastSnapshot: params.clearLastSnapshot,
          });
          if (updatedWatch) await saveStore(storePath, store);
        });

        if (!updatedWatch) {
          return {
            content: [{ type: "text", text: JSON.stringify({ ok: false, error: "watch not found" }, null, 2) }],
            details: { ok: false },
          };
        }

        return jsonResult({ ok: true, watch: toWatchView(updatedWatch) });
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "deal_watch_set_enabled",
      label: "Deal Hunter",
      description: "Enable or disable one or more watches in bulk.",
      parameters: Type.Object({
        watchIds: Type.Array(Type.String(), { minItems: 1 }),
        enabled: Type.Boolean(),
      }),
      execute: async (_id, params) => {
        let result = { updatedIds: [] as string[], missingIds: [] as string[] };
        let watches: ReturnType<typeof toWatchView>[] = [];

        await withStore(async (store) => {
          result = setWatchEnabled(store, params.watchIds, params.enabled);
          if (result.updatedIds.length > 0) {
            await saveStore(storePath, store);
          }
          watches = result.updatedIds
            .map((id) => getWatch(store, id))
            .filter((watch): watch is NonNullable<typeof watch> => Boolean(watch))
            .map(toWatchView);
        });

        return jsonResult({
          ok: true,
          enabled: params.enabled,
          updatedCount: result.updatedIds.length,
          missingCount: result.missingIds.length,
          updatedIds: result.updatedIds,
          missingIds: result.missingIds,
          watches,
        });
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "deal_watch_remove",
      label: "Deal Hunter",
      description: "Remove a watch by id (see deal_watch_list).",
      parameters: Type.Object({
        watchId: Type.String(),
      }),
      execute: async (_id, params) => {
        let removed = false;
        await withStore(async (store) => {
          removed = removeWatch(store, params.watchId);
          if (removed) await saveStore(storePath, store);
        });
        if (!removed) {
          return {
            content: [{ type: "text", text: JSON.stringify({ ok: false, error: "watch not found" }, null, 2) }],
            details: { ok: false },
          };
        }
        return jsonResult({ ok: true });
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "deal_watch_export",
      label: "Deal Hunter",
      description: "Export watches for backup or migration, with optional snapshot and history data.",
      parameters: Type.Object({
        watchIds: Type.Optional(Type.Array(Type.String(), { description: "Empty = all watches" })),
        includeDisabled: Type.Optional(Type.Boolean()),
        includeSnapshots: Type.Optional(Type.Boolean()),
        includeHistory: Type.Optional(Type.Boolean()),
      }),
      execute: async (_id, params) => {
        const store = await loadStore(storePath);
        const allowedIds = params.watchIds?.length ? new Set(params.watchIds) : null;
        const includeDisabled = params.includeDisabled === true;
        const includeSnapshots = params.includeSnapshots !== false;
        const includeHistory = params.includeHistory !== false;

        const watches = store.watches
          .filter((watch) => (includeDisabled ? true : watch.enabled))
          .filter((watch) => (allowedIds ? allowedIds.has(watch.id) : true))
          .map((watch) => {
            const exported = structuredClone(watch);
            if (!includeSnapshots) {
              exported.lastSnapshot = undefined;
            }
            if (!includeHistory) {
              exported.history = undefined;
            }
            return exported;
          });

        return jsonResult({
          exportedAt: new Date().toISOString(),
          count: watches.length,
          includeSnapshots,
          includeHistory,
          watches,
        });
      },
    },
    { optional: false },
  );

  api.registerTool(
    {
      name: "deal_watch_import",
      label: "Deal Hunter",
      description: "Import watches from a prior export or agent-generated list. Supports append, upsert, replace, and dry-run.",
      parameters: Type.Object({
        mode: Type.Optional(Type.Union([
          Type.Literal("append"),
          Type.Literal("upsert"),
          Type.Literal("replace"),
        ])),
        dryRun: Type.Optional(Type.Boolean()),
        watches: Type.Array(IMPORTED_WATCH_SCHEMA, { minItems: 1 }),
      }),
      execute: async (_id, params) => {
        const cfg = resolveDealConfig(api);
        const mode = params.mode ?? "upsert";
        const normalizedWatches = params.watches.map((watch: ImportedWatchInput) => ({
          ...watch,
          url: validateTargetUrl(watch.url, cfg).toString(),
        }));

        let result = {
          added: 0,
          updated: 0,
          replaced: false,
          imported: [] as Awaited<ReturnType<typeof loadStore>>["watches"],
          matchedById: 0,
          matchedByUrl: 0,
        };

        await withStore(async (store) => {
          const target = params.dryRun ? structuredClone(store) : store;
          result = importWatches(target, normalizedWatches, mode);
          if (!params.dryRun) {
            await saveStore(storePath, target);
          }
        });

        return jsonResult({
          ok: true,
          dryRun: params.dryRun === true,
          mode,
          added: result.added,
          updated: result.updated,
          replaced: result.replaced,
          matchedById: result.matchedById,
          matchedByUrl: result.matchedByUrl,
          importedCount: result.imported.length,
          watches: result.imported.map(toWatchView),
        });
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "deal_watch_search",
      label: "Deal Hunter",
      description: "Search, filter, and sort watches by query, snapshot state, signals, enabled state, or price.",
      parameters: Type.Object({
        query: Type.Optional(Type.String()),
        enabled: Type.Optional(Type.Boolean()),
        hasSnapshot: Type.Optional(Type.Boolean()),
        hasSignals: Type.Optional(Type.Boolean()),
        sortBy: Type.Optional(Type.Union([
          Type.Literal("createdAt"),
          Type.Literal("label"),
          Type.Literal("price"),
        ])),
        descending: Type.Optional(Type.Boolean()),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
      }),
      execute: async (_id, params) => {
        const store = await loadStore(storePath);
        const matches = searchWatches(store.watches, params);
        const views = matches.map(toWatchView);

        return jsonResult({
          summary: {
            totalWatches: store.watches.length,
            matched: views.length,
            enabledMatched: views.filter((watch) => watch.enabled).length,
            disabledMatched: views.filter((watch) => !watch.enabled).length,
            withSnapshotsMatched: views.filter((watch) => Boolean(watch.lastSnapshot)).length,
            withSignalsMatched: views.filter((watch) => watch.signalCount > 0).length,
          },
          watches: views,
        });
      },
    },
    { optional: false },
  );

  api.registerTool(
    {
      name: "deal_scan",
      label: "Deal Hunter",
      description:
        "Scan one watch, all enabled watches, or a subset (watchIds). Fetches with pooling, conditional GET, and streaming caps. Use commit=false to dry-run.",
      parameters: Type.Object({
        watchIds: Type.Optional(Type.Array(Type.String(), { description: "Empty = all enabled watches" })),
        commit: Type.Optional(Type.Boolean({ default: true, description: "Persist snapshots when true" })),
      }),
      execute: async (_id, params, signal) => {
        const cfg = resolveDealConfig(api);
        const commit = params.commit !== false;
        const scanSnapshot = await withStore(async (store) => structuredClone(store));
        const results = await runScan({
          api,
          cfg,
          store: scanSnapshot,
          storePath,
          watchIds: params.watchIds,
          commit: false,
          signal,
        });

        let commitSummary = null;
        if (commit) {
          commitSummary = await withStore(async (store) => {
            const summary = mergeCommittedScanResults(store, results, cfg);
            await saveStore(storePath, store);
            return summary;
          });
        }

        const { summary, rankedAlerts } = buildScanSummary(results);

        return jsonResult({
          results,
          summary,
          rankedAlerts,
          engine: "node",
          watchCount: results.length,
          commit,
          commitSummary,
        });
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "deal_fetch_url",
      label: "Deal Hunter",
      description: "Fetch a single URL with plugin rate limits and byte cap (returns truncated body + headers meta).",
      parameters: Type.Object({
        url: Type.String(),
      }),
      execute: async (_id, params, signal) => {
        const cfg = resolveDealConfig(api);
        const url = validateTargetUrl(params.url, cfg).toString();
        const { meta, text } = await cappedFetch(url, cfg, { signal });
        const preview = text.slice(0, 8000);
        const extracted = extractListing(text);
        const extractedFields = [
          extracted.title ? "title" : null,
          extracted.price != null ? "price" : null,
          extracted.currency ? "currency" : null,
        ].filter(Boolean);
        const fetchSource = cfg.fetcher === "firecrawl" ? "firecrawl" : "node_http";
        const fetchSourceNote =
          cfg.fetcher === "firecrawl"
            ? "Fetched through the Firecrawl scrape API from the Node engine."
            : "Fetched directly over HTTP by the Node engine.";
        const extractionConfidence = {
          score: extractedFields.length === 3 ? 90 : extractedFields.length === 2 ? 70 : extractedFields.length === 1 ? 40 : 10,
          level:
            extractedFields.length === 3
              ? "high"
              : extractedFields.length === 2
                ? "medium"
                : extractedFields.length === 1
                  ? "low"
                  : "none",
          reasons:
            extractedFields.length > 0
              ? [`Extracted fields: ${extractedFields.join(", ")}.`]
              : ["No reliable product fields were extracted from the response preview."],
        };
        const summaryLine = extracted.price != null
          ? `${extracted.title ?? url}: ${extracted.price.toFixed(2)}${extracted.currency ? ` ${extracted.currency}` : ""}`
          : `${extracted.title ?? url}: no price extracted`;
        return jsonResult({
          meta,
          bodyPreview: preview,
          bodyLength: text.length,
          extracted,
          fetchSource,
          fetchSourceNote,
          extractionConfidence,
          summaryLine,
        });
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "deal_evaluate_text",
      label: "Deal Hunter",
      description: "Run glitch/freebie heuristics on pasted title/description text (no network).",
      parameters: Type.Object({
        text: Type.String(),
        maxPrice: Type.Optional(Type.Number()),
      }),
      execute: async (_id, params) => {
        const evaluation = evaluateListingText(params.text, { maxPrice: params.maxPrice });
        return jsonResult(evaluation);
      },
    },
    { optional: false },
  );

  api.registerTool(
    {
      name: "deal_help",
      label: "Deal Hunter",
      description: "Show install, tool, cron, import/export, troubleshooting, and safety guidance for Deal Hunter.",
      parameters: Type.Object({
        topic: Type.Optional(Type.Union([
          Type.Literal("overview"),
          Type.Literal("install"),
          Type.Literal("tools"),
          Type.Literal("cron"),
          Type.Literal("safety"),
          Type.Literal("import_export"),
          Type.Literal("troubleshooting"),
          Type.Literal("privacy"),
        ])),
      }),
      execute: async (_id, params) => {
        const topics = {
          overview: {
            installCommand: "openclaw plugins install openclaw-deal-hunter",
            coreTools: [
              "deal_watch_add",
              "deal_watch_update",
              "deal_watch_set_enabled",
              "deal_watch_search",
              "deal_watch_export",
              "deal_watch_import",
              "deal_scan",
              "deal_history",
              "deal_alerts",
            ],
            firstPrompt:
              "Use deal_watch_list and deal_watch_search to show me my current watches and call out any threshold or keyword signals.",
          },
          install: {
            sourceRepo: "https://github.com/Cognostra/deal-finder",
            installCommand: "openclaw plugins install openclaw-deal-hunter",
            note: "GitHub is the source/support repo. Native OpenClaw installs should use the npm package spec.",
          },
          tools: {
            readOnlyTools: [
              "deal_watch_list",
              "deal_watch_search",
              "deal_watch_export",
              "deal_fetch_url",
              "deal_evaluate_text",
              "deal_help",
              "deal_history",
              "deal_alerts",
            ],
            writeTools: [
              "deal_watch_add",
              "deal_watch_update",
              "deal_watch_set_enabled",
              "deal_watch_remove",
              "deal_watch_import",
              "deal_scan",
            ],
            examplePrompt:
              "Use deal_watch_search to find disabled watches, then use deal_watch_set_enabled to re-enable the ones I still care about.",
          },
          cron: {
            example:
              "openclaw cron add --name \"Deal scan\" --cron \"0 * * * *\" --session isolated --message \"Run deal_scan with commit true for all enabled watches. Summarize any alerts.\" --announce",
          },
          import_export: {
            exportPrompt:
              "Use deal_watch_export with includeHistory true so I can back up my active watches before I reorganize them.",
            importPrompt:
              "Prepare a deal_watch_import dry run in upsert mode so I can preview which watches would be added or updated.",
            modes: ["append", "upsert", "replace"],
          },
          troubleshooting: {
            firstChecks: ["deal_doctor", "deal_health", "deal_fetch_url"],
            note: "If a scan is blocked, verify the target host against your allowedHosts and blockedHosts policy.",
          },
          privacy: {
            storeNote: "Watch metadata and committed scan history are stored in the configured JSON store path.",
            backupNote: "Use deal_watch_export when you want a reviewable backup before major edits or migration.",
            networkNote: "Only http/https targets that pass the host safety policy are fetched.",
          },
          safety: {
            guardrails: [
              "Only http/https targets are allowed.",
              "Localhost, private IPs, and hostnames resolving to private IPs are blocked.",
              "Responses are byte-capped and rate-limited per host.",
            ],
          },
        } as const;
        const topic = (params.topic ?? "overview") as keyof typeof topics;

        return jsonResult({
          topic,
          details: topics[topic],
        });
      },
    },
    { optional: false },
  );

  api.registerTool(
    {
      name: "deal_quickstart",
      label: "Deal Hunter",
      description: "Show a first-run checklist, recommended prompts, and privacy/safety reminders for new users.",
      parameters: Type.Object({}),
      execute: async () => {
        return jsonResult(buildQuickstartGuide());
      },
    },
    { optional: false },
  );

  api.registerTool(
    {
      name: "deal_report",
      label: "Deal Hunter",
      description: "Summarize the current watchlist, snapshots, and signal-heavy watches.",
      parameters: Type.Object({}),
      execute: async () => {
        const store = await loadStore(storePath);
        const report = buildStoreReport(store);
        return jsonResult({
          ...report,
          watches: store.watches.map(toWatchView),
        });
      },
    },
    { optional: false },
  );

  api.registerTool(
    {
      name: "deal_health",
      label: "Deal Hunter",
      description: "Show configuration, storage, safety posture, and operational recommendations.",
      parameters: Type.Object({}),
      execute: async () => {
        const cfg = resolveDealConfig(api);
        const store = await loadStore(storePath);
        return jsonResult(buildHealthSummary(store, cfg, storePath));
      },
    },
    { optional: false },
  );

  api.registerTool(
    {
      name: "deal_doctor",
      label: "Deal Hunter",
      description: "Run a lightweight configuration and watchlist sanity check.",
      parameters: Type.Object({}),
      execute: async () => {
        const cfg = resolveDealConfig(api);
        const store = await loadStore(storePath);
        return jsonResult(buildDoctorSummary(store, cfg, storePath));
      },
    },
    { optional: false },
  );

  api.registerTool(
    {
      name: "deal_sample_setup",
      label: "Deal Hunter",
      description: "Show example install, config, allowlist, prompts, and cron setup for Deal Hunter.",
      parameters: Type.Object({}),
      execute: async () => {
        return jsonResult(buildSampleSetup());
      },
    },
    { optional: false },
  );

  api.registerTool(
    {
      name: "deal_history",
      label: "Deal Hunter",
      description: "Show stored price history and recent changes for one watch or summarize history across watches.",
      parameters: Type.Object({
        watchId: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      }),
      execute: async (_id, params) => {
        const store = await loadStore(storePath);
        const limit = params.limit ?? 20;

        if (params.watchId) {
          const watch = getWatch(store, params.watchId);
          if (!watch) {
            return {
              content: [{ type: "text", text: JSON.stringify({ ok: false, error: "watch not found" }, null, 2) }],
              details: { ok: false },
            };
          }

          return jsonResult(buildHistorySummary(watch, limit));
        }

        const watches = store.watches
          .filter((watch) => Boolean(watch.history?.length))
          .map((watch) => buildHistorySummary(watch, Math.min(limit, 5)))
          .sort((a, b) => (b.lastSeenAt ?? "").localeCompare(a.lastSeenAt ?? ""))
          .slice(0, limit);

        return jsonResult({
          count: watches.length,
          watches,
        });
      },
    },
    { optional: false },
  );

  api.registerTool(
    {
      name: "deal_alerts",
      label: "Deal Hunter",
      description: "Show the hottest current threshold, keyword, and recent change signals across the watchlist.",
      parameters: Type.Object({
        severity: Type.Optional(Type.Union([
          Type.Literal("low"),
          Type.Literal("medium"),
          Type.Literal("high"),
        ])),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      }),
      execute: async (_id, params) => {
        const store = await loadStore(storePath);
        return jsonResult(buildAlertsSummary(store, params.severity ?? "low", params.limit ?? 20));
      },
    },
    { optional: false },
  );
}
