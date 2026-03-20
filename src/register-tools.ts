import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult, withFileLock } from "openclaw/plugin-sdk";
import { resolveDealConfig } from "./config.js";
import { mergeCommittedScanResults, runScan } from "./lib/engine.js";
import { cappedFetch } from "./lib/fetch.js";
import { debugExtractListing, evaluateListingText } from "./lib/heuristics.js";
import {
  buildAlertsSummary,
  buildBestPriceBoard,
  buildDoctorSummary,
  buildHealthSummary,
  buildHistorySummary,
  buildLlmReviewQueue,
  buildMarketCheckSummary,
  buildProductGroupsSummary,
  buildQuickstartGuide,
  buildScheduleAdvice,
  buildSampleSetup,
  buildStoreReport,
  buildTopDropsSummary,
  buildTrendsSummary,
  buildViewReport,
  buildWorkflowBestOpportunities,
  buildWorkflowCleanup,
  buildWorkflowPortfolio,
  buildWorkflowTriage,
  buildWatchIdentitySummary,
  buildWatchInsights,
} from "./lib/report.js";
import type { ImportedWatchInput } from "./lib/store.js";
import { addSavedView, addWatch, bulkUpdateWatches, getSavedView, getWatch, importWatches, listSavedViews, loadStore, parseImportedWatchPayload, removeSavedView, removeWatch, saveStore, setWatchEnabled, updateSavedView, updateWatch } from "./lib/store.js";
import { buildWatchSignals, searchWatches } from "./lib/watch-view.js";
import { canonicalizeWatchUrl, validateTargetUrl } from "./lib/url-policy.js";

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
    canonicalUrl: canonicalizeWatchUrl(watch.url).toString(),
    currentPrice: watch.lastSnapshot?.price,
    currentCurrency: watch.lastSnapshot?.currency,
    lastFetchedAt: watch.lastSnapshot?.fetchedAt,
    historyCount: watch.history?.length ?? 0,
    importSource: watch.importSource,
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
  group: Type.Optional(Type.String()),
  tags: Type.Optional(Type.Array(Type.String())),
  maxPrice: Type.Optional(Type.Number()),
  percentDrop: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
  keywords: Type.Optional(Type.Array(Type.String())),
  checkIntervalHint: Type.Optional(Type.String()),
  enabled: Type.Optional(Type.Boolean()),
  createdAt: Type.Optional(Type.String()),
  importSource: Type.Optional(
    Type.Object({
      type: Type.Literal("url"),
      url: Type.String(),
      importedAt: Type.String(),
    }),
  ),
  lastSnapshot: Type.Optional(
    Type.Object({
      title: Type.Optional(Type.String()),
      canonicalTitle: Type.Optional(Type.String()),
      brand: Type.Optional(Type.String()),
      modelId: Type.Optional(Type.String()),
      sku: Type.Optional(Type.String()),
      mpn: Type.Optional(Type.String()),
      gtin: Type.Optional(Type.String()),
      asin: Type.Optional(Type.String()),
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

const WATCH_SELECTOR_SCHEMA = {
  watchIds: Type.Optional(Type.Array(Type.String(), { description: "Explicit watch ids to target." })),
  query: Type.Optional(Type.String()),
  enabled: Type.Optional(Type.Boolean()),
  hasSnapshot: Type.Optional(Type.Boolean()),
  hasSignals: Type.Optional(Type.Boolean()),
  tag: Type.Optional(Type.String()),
  group: Type.Optional(Type.String()),
  sortBy: Type.Optional(Type.Union([
    Type.Literal("createdAt"),
    Type.Literal("label"),
    Type.Literal("price"),
  ])),
  descending: Type.Optional(Type.Boolean()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
} as const;

function mergeImportedTags(existingTags: string[] | undefined, extraTags: string[] | undefined): string[] | undefined {
  const merged = [...new Set([...(existingTags ?? []), ...(extraTags ?? [])].map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
  return merged.length ? merged : undefined;
}

function selectWatches(
  store: Awaited<ReturnType<typeof loadStore>>,
  selector: {
    watchIds?: string[];
    query?: string;
    enabled?: boolean;
    hasSnapshot?: boolean;
    hasSignals?: boolean;
    tag?: string;
    group?: string;
    sortBy?: "createdAt" | "label" | "price";
    descending?: boolean;
    limit?: number;
  },
) {
  const explicitIds = selector.watchIds?.length ? new Set(selector.watchIds) : null;
  const base = explicitIds ? store.watches.filter((watch) => explicitIds.has(watch.id)) : store.watches;
  return searchWatches(base, {
    query: selector.query,
    enabled: selector.enabled,
    hasSnapshot: selector.hasSnapshot,
    hasSignals: selector.hasSignals,
    tag: selector.tag,
    group: selector.group,
    sortBy: selector.sortBy,
    descending: selector.descending,
    limit: selector.limit,
  });
}

function toSavedViewSummary(store: Awaited<ReturnType<typeof loadStore>>, view: ReturnType<typeof listSavedViews>[number]) {
  const matches = searchWatches(store.watches, view.selector);
  const watchIds = matches.map((watch) => watch.id).slice(0, 20);
  return {
    ...view,
    matchCount: matches.length,
    previewWatchIds: watchIds,
  };
}

function buildScopedStore(
  store: Awaited<ReturnType<typeof loadStore>>,
  watches: Awaited<ReturnType<typeof loadStore>>["watches"],
): Awaited<ReturnType<typeof loadStore>> {
  return {
    version: store.version,
    savedViews: store.savedViews,
    watches,
  };
}

function resolveSavedViewSelection(store: Awaited<ReturnType<typeof loadStore>>, savedViewId: string) {
  const savedView = getSavedView(store, savedViewId);
  if (!savedView) {
    throw new Error(`deal-hunter: unknown saved view "${savedViewId}"`);
  }
  const watches = searchWatches(store.watches, savedView.selector);
  return {
    savedView,
    summary: toSavedViewSummary(store, savedView),
    watches,
    watchIds: watches.map((watch) => watch.id),
  };
}

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
        group: Type.Optional(Type.String()),
        tags: Type.Optional(Type.Array(Type.String())),
        maxPrice: Type.Optional(Type.Number()),
        percentDrop: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
        keywords: Type.Optional(Type.Array(Type.String())),
        checkIntervalHint: Type.Optional(Type.String()),
        enabled: Type.Optional(Type.Boolean()),
      }),
      execute: async (_id, params) => {
        const cfg = resolveDealConfig(api);
        const normalizedUrl = canonicalizeWatchUrl(params.url, cfg).toString();
        await withStore(async (store) => {
          addWatch(store, {
            url: normalizedUrl,
            label: params.label,
            group: params.group,
            tags: params.tags,
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
        group: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        tags: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
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
          const normalizedUrl = params.url ? canonicalizeWatchUrl(params.url, cfg).toString() : undefined;
          updatedWatch = updateWatch(store, params.watchId, {
            url: normalizedUrl,
            label: params.label,
            group: params.group,
            tags: params.tags,
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
          url: canonicalizeWatchUrl(watch.url, cfg).toString(),
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
      name: "deal_watch_import_url",
      label: "Deal Hunter",
      description: "Fetch a remote JSON watchlist over HTTP(S), validate it, and import it with dry-run support.",
      parameters: Type.Object({
        url: Type.String(),
        mode: Type.Optional(Type.Union([
          Type.Literal("append"),
          Type.Literal("upsert"),
          Type.Literal("replace"),
        ])),
        dryRun: Type.Optional(Type.Boolean()),
        group: Type.Optional(Type.String()),
        addTags: Type.Optional(Type.Array(Type.String())),
        enabled: Type.Optional(Type.Boolean()),
      }),
      execute: async (_id, params) => {
        const cfg = resolveDealConfig(api);
        const mode = params.mode ?? "upsert";
        const importUrl = validateTargetUrl(params.url, cfg).toString();
        const fetchCfg = { ...cfg, fetcher: "local" as const };
        const fetched = await cappedFetch(importUrl, fetchCfg);

        if (fetched.meta.status >= 400) {
          throw new Error(`deal-hunter: failed to fetch import URL "${importUrl}" (HTTP ${fetched.meta.status})`);
        }

        let payload: unknown;
        try {
          payload = JSON.parse(fetched.text);
        } catch {
          throw new Error(`deal-hunter: import URL "${importUrl}" did not return valid JSON`);
        }

        const importedAt = new Date().toISOString();
        const remoteWatches = parseImportedWatchPayload(payload);
        const normalizedWatches = remoteWatches.map((watch: ImportedWatchInput) => ({
          ...watch,
          url: canonicalizeWatchUrl(watch.url, cfg).toString(),
          group: params.group ?? watch.group,
          tags: mergeImportedTags(watch.tags, params.addTags),
          enabled: params.enabled ?? watch.enabled,
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
          const target = params.dryRun === false ? store : structuredClone(store);
          result = importWatches(target, normalizedWatches, mode, {
            importSourceOverride: {
              type: "url",
              url: importUrl,
              importedAt,
            },
          });
          if (params.dryRun === false) {
            await saveStore(storePath, target);
          }
        });

        return jsonResult({
          ok: true,
          dryRun: params.dryRun !== false,
          mode,
          sourceUrl: importUrl,
          sourceCount: remoteWatches.length,
          fetchedAt: importedAt,
          fetchMeta: fetched.meta,
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
        tag: Type.Optional(Type.String()),
        group: Type.Optional(Type.String()),
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
      name: "deal_saved_view_list",
      label: "Deal Hunter",
      description: "List saved watch search views with selector details and current match counts.",
      parameters: Type.Object({}),
      execute: async () => {
        const store = await loadStore(storePath);
        return jsonResult({
          count: store.savedViews.length,
          savedViews: listSavedViews(store).map((view) => toSavedViewSummary(store, view)),
        });
      },
    },
    { optional: false },
  );

  api.registerTool(
    {
      name: "deal_saved_view_create",
      label: "Deal Hunter",
      description: "Persist a reusable watch search/filter view for larger watchlists.",
      parameters: Type.Object({
        name: Type.String(),
        description: Type.Optional(Type.String()),
        selector: Type.Object({
          query: WATCH_SELECTOR_SCHEMA.query,
          enabled: WATCH_SELECTOR_SCHEMA.enabled,
          hasSnapshot: WATCH_SELECTOR_SCHEMA.hasSnapshot,
          hasSignals: WATCH_SELECTOR_SCHEMA.hasSignals,
          tag: WATCH_SELECTOR_SCHEMA.tag,
          group: WATCH_SELECTOR_SCHEMA.group,
          sortBy: WATCH_SELECTOR_SCHEMA.sortBy,
          descending: WATCH_SELECTOR_SCHEMA.descending,
          limit: WATCH_SELECTOR_SCHEMA.limit,
        }),
      }),
      execute: async (_id, params) => {
        let saved;
        await withStore(async (store) => {
          if (store.savedViews.some((view) => view.name.toLowerCase() === params.name.trim().toLowerCase())) {
            throw new Error(`deal-hunter: a saved view named "${params.name}" already exists`);
          }
          saved = addSavedView(store, {
            name: params.name,
            description: params.description,
            selector: params.selector,
          });
          await saveStore(storePath, store);
        });
        const store = await loadStore(storePath);
        return jsonResult({
          ok: true,
          savedView: toSavedViewSummary(store, saved!),
        });
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "deal_saved_view_run",
      label: "Deal Hunter",
      description: "Run a previously saved view and return the current matching watches.",
      parameters: Type.Object({
        savedViewId: Type.String(),
      }),
      execute: async (_id, params) => {
        const store = await loadStore(storePath);
        const savedView = getSavedView(store, params.savedViewId);
        if (!savedView) {
          throw new Error(`deal-hunter: unknown saved view "${params.savedViewId}"`);
        }
        const watches = searchWatches(store.watches, savedView.selector).map(toWatchView);
        return jsonResult({
          savedView: toSavedViewSummary(store, savedView),
          watches,
        });
      },
    },
    { optional: false },
  );

  api.registerTool(
    {
      name: "deal_saved_view_update",
      label: "Deal Hunter",
      description: "Update or rename a saved watch view.",
      parameters: Type.Object({
        savedViewId: Type.String(),
        name: Type.Optional(Type.String()),
        description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        selector: Type.Optional(Type.Object({
          query: WATCH_SELECTOR_SCHEMA.query,
          enabled: WATCH_SELECTOR_SCHEMA.enabled,
          hasSnapshot: WATCH_SELECTOR_SCHEMA.hasSnapshot,
          hasSignals: WATCH_SELECTOR_SCHEMA.hasSignals,
          tag: WATCH_SELECTOR_SCHEMA.tag,
          group: WATCH_SELECTOR_SCHEMA.group,
          sortBy: WATCH_SELECTOR_SCHEMA.sortBy,
          descending: WATCH_SELECTOR_SCHEMA.descending,
          limit: WATCH_SELECTOR_SCHEMA.limit,
        })),
      }),
      execute: async (_id, params) => {
        let updated;
        await withStore(async (store) => {
          if (
            params.name &&
            store.savedViews.some(
              (view) => view.id !== params.savedViewId && view.name.toLowerCase() === params.name.trim().toLowerCase(),
            )
          ) {
            throw new Error(`deal-hunter: a saved view named "${params.name}" already exists`);
          }
          updated = updateSavedView(store, params.savedViewId, {
            name: params.name,
            description: params.description,
            selector: params.selector,
          });
          if (!updated) {
            throw new Error(`deal-hunter: unknown saved view "${params.savedViewId}"`);
          }
          await saveStore(storePath, store);
        });
        const store = await loadStore(storePath);
        return jsonResult({
          ok: true,
          savedView: toSavedViewSummary(store, updated!),
        });
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "deal_saved_view_delete",
      label: "Deal Hunter",
      description: "Delete a saved watch search view.",
      parameters: Type.Object({
        savedViewId: Type.String(),
      }),
      execute: async (_id, params) => {
        let removed = false;
        await withStore(async (store) => {
          removed = removeSavedView(store, params.savedViewId);
          if (!removed) {
            throw new Error(`deal-hunter: unknown saved view "${params.savedViewId}"`);
          }
          await saveStore(storePath, store);
        });
        return jsonResult({ ok: true, removed });
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "deal_view_scan",
      label: "Deal Hunter",
      description: "Run deal_scan against the watches currently matched by a saved view.",
      parameters: Type.Object({
        savedViewId: Type.String(),
        commit: Type.Optional(Type.Boolean({ default: true })),
      }),
      execute: async (_id, params, signal) => {
        const cfg = resolveDealConfig(api);
        const commit = params.commit !== false;
        const scanSnapshot = await withStore(async (store) => structuredClone(store));
        const selection = resolveSavedViewSelection(scanSnapshot, params.savedViewId);
        const eligibleWatchIds = selection.watches.filter((watch) => watch.enabled).map((watch) => watch.id);

        let results = [] as Awaited<ReturnType<typeof runScan>>;
        if (eligibleWatchIds.length > 0) {
          results = await runScan({
            api,
            cfg,
            store: scanSnapshot,
            storePath,
            watchIds: eligibleWatchIds,
            commit: false,
            signal,
          });
        }

        let commitSummary = null;
        if (commit && results.length > 0) {
          commitSummary = await withStore(async (store) => {
            const summary = mergeCommittedScanResults(store, results, cfg);
            await saveStore(storePath, store);
            return summary;
          });
        }

        const { summary, rankedAlerts } = buildScanSummary(results);
        return jsonResult({
          savedView: selection.summary,
          matchedCount: selection.watches.length,
          enabledMatchedCount: eligibleWatchIds.length,
          disabledMatchedCount: selection.watches.length - eligibleWatchIds.length,
          results,
          summary,
          rankedAlerts,
          engine: "node",
          commit,
          commitSummary,
        });
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "deal_view_report",
      label: "Deal Hunter",
      description: "Generate a multi-signal report for one saved view, including alerts, trends, drops, and best opportunities.",
      parameters: Type.Object({
        savedViewId: Type.String(),
        severity: Type.Optional(Type.Union([
          Type.Literal("low"),
          Type.Literal("medium"),
          Type.Literal("high"),
        ])),
        metric: Type.Optional(Type.Union([Type.Literal("vs_peak"), Type.Literal("latest_change")])),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      }),
      execute: async (_id, params) => {
        const store = await loadStore(storePath);
        const selection = resolveSavedViewSelection(store, params.savedViewId);
        const scoped = buildViewReport(store, selection.watches, {
          limit: params.limit ?? 10,
          severity: params.severity ?? "low",
          metric: params.metric ?? "vs_peak",
        });
        return jsonResult({
          savedView: selection.summary,
          ...scoped,
        });
      },
    },
    { optional: false },
  );

  api.registerTool(
    {
      name: "deal_watch_bulk_update",
      label: "Deal Hunter",
      description: "Bulk-update watches selected by ids or search filters. Defaults to dry-run for safety.",
      parameters: Type.Object({
        watchIds: WATCH_SELECTOR_SCHEMA.watchIds,
        query: WATCH_SELECTOR_SCHEMA.query,
        matchEnabled: Type.Optional(Type.Boolean()),
        matchHasSnapshot: Type.Optional(Type.Boolean()),
        matchHasSignals: Type.Optional(Type.Boolean()),
        matchTag: Type.Optional(Type.String()),
        matchGroup: Type.Optional(Type.String()),
        limit: WATCH_SELECTOR_SCHEMA.limit,
        dryRun: Type.Optional(Type.Boolean()),
        group: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        tags: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
        addTags: Type.Optional(Type.Array(Type.String())),
        removeTags: Type.Optional(Type.Array(Type.String())),
        maxPrice: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
        percentDrop: Type.Optional(Type.Union([Type.Number({ minimum: 0, maximum: 100 }), Type.Null()])),
        keywords: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
        checkIntervalHint: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        enabled: Type.Optional(Type.Boolean()),
        clearLastSnapshot: Type.Optional(Type.Boolean()),
      }),
      execute: async (_id, params) => {
        const dryRun = params.dryRun !== false;
        const selectorsUsed = [
          params.watchIds?.length,
          params.query,
          params.matchEnabled != null,
          params.matchHasSnapshot != null,
          params.matchHasSignals != null,
          params.matchTag,
          params.matchGroup,
        ].some(Boolean);
        if (!selectorsUsed) {
          return {
            content: [{ type: "text", text: JSON.stringify({ ok: false, error: "no watch selector provided" }, null, 2) }],
            details: { ok: false },
          };
        }

        let result = { updatedIds: [] as string[], missingIds: [] as string[] };
        let watches: ReturnType<typeof toWatchView>[] = [];

        await withStore(async (store) => {
          const selected = selectWatches(store, {
            watchIds: params.watchIds,
            query: params.query,
            enabled: params.matchEnabled,
            hasSnapshot: params.matchHasSnapshot,
            hasSignals: params.matchHasSignals,
            tag: params.matchTag,
            group: params.matchGroup,
            limit: params.limit,
          });
          result.missingIds = params.watchIds?.filter((id: string) => !selected.some((watch) => watch.id === id)) ?? [];
          const target = dryRun ? structuredClone(store) : store;
          const updateResult = bulkUpdateWatches(
            target,
            selected.map((watch) => watch.id),
            {
              group: params.group,
              tags: params.tags,
              addTags: params.addTags,
              removeTags: params.removeTags,
              maxPrice: params.maxPrice,
              percentDrop: params.percentDrop,
              keywords: params.keywords,
              checkIntervalHint: params.checkIntervalHint,
              enabled: params.enabled,
              clearLastSnapshot: params.clearLastSnapshot,
            },
          );
          result.updatedIds = updateResult.updatedIds;
          result.missingIds = [...new Set([...result.missingIds, ...updateResult.missingIds])];
          watches = updateResult.updatedIds
            .map((id: string) => getWatch(target, id))
            .filter((watch): watch is NonNullable<typeof watch> => Boolean(watch))
            .map(toWatchView);
          if (!dryRun && updateResult.updatedIds.length > 0) {
            await saveStore(storePath, target);
          }
        });

        return jsonResult({
          ok: true,
          dryRun,
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
      name: "deal_view_bulk_update",
      label: "Deal Hunter",
      description: "Bulk-update all watches currently matched by a saved view. Defaults to dry-run for safety.",
      parameters: Type.Object({
        savedViewId: Type.String(),
        dryRun: Type.Optional(Type.Boolean()),
        group: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        tags: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
        addTags: Type.Optional(Type.Array(Type.String())),
        removeTags: Type.Optional(Type.Array(Type.String())),
        maxPrice: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
        percentDrop: Type.Optional(Type.Union([Type.Number({ minimum: 0, maximum: 100 }), Type.Null()])),
        keywords: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
        checkIntervalHint: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        enabled: Type.Optional(Type.Boolean()),
        clearLastSnapshot: Type.Optional(Type.Boolean()),
      }),
      execute: async (_id, params) => {
        const dryRun = params.dryRun !== false;
        let selectionSummary = null;
        let result = { updatedIds: [] as string[], missingIds: [] as string[] };
        let watches: ReturnType<typeof toWatchView>[] = [];

        await withStore(async (store) => {
          const selection = resolveSavedViewSelection(store, params.savedViewId);
          selectionSummary = selection.summary;
          const target = dryRun ? structuredClone(store) : store;
          const updateResult = bulkUpdateWatches(
            target,
            selection.watchIds,
            {
              group: params.group,
              tags: params.tags,
              addTags: params.addTags,
              removeTags: params.removeTags,
              maxPrice: params.maxPrice,
              percentDrop: params.percentDrop,
              keywords: params.keywords,
              checkIntervalHint: params.checkIntervalHint,
              enabled: params.enabled,
              clearLastSnapshot: params.clearLastSnapshot,
            },
          );
          result = updateResult;
          watches = updateResult.updatedIds
            .map((id) => getWatch(target, id))
            .filter((watch): watch is NonNullable<typeof watch> => Boolean(watch))
            .map(toWatchView);
          if (!dryRun && updateResult.updatedIds.length > 0) {
            await saveStore(storePath, target);
          }
        });

        return jsonResult({
          ok: true,
          dryRun,
          savedView: selectionSummary,
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
      name: "deal_watch_tag",
      label: "Deal Hunter",
      description: "Add, remove, or replace watch tags and optionally assign a group. Defaults to dry-run for safety.",
      parameters: Type.Object({
        watchIds: WATCH_SELECTOR_SCHEMA.watchIds,
        query: WATCH_SELECTOR_SCHEMA.query,
        matchEnabled: Type.Optional(Type.Boolean()),
        matchHasSnapshot: Type.Optional(Type.Boolean()),
        matchHasSignals: Type.Optional(Type.Boolean()),
        matchTag: Type.Optional(Type.String()),
        matchGroup: Type.Optional(Type.String()),
        limit: WATCH_SELECTOR_SCHEMA.limit,
        dryRun: Type.Optional(Type.Boolean()),
        tags: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
        addTags: Type.Optional(Type.Array(Type.String())),
        removeTags: Type.Optional(Type.Array(Type.String())),
        group: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      }),
      execute: async (_id, params) => {
        const dryRun = params.dryRun !== false;
        const selectorsUsed = [
          params.watchIds?.length,
          params.query,
          params.matchEnabled != null,
          params.matchHasSnapshot != null,
          params.matchHasSignals != null,
          params.matchTag,
          params.matchGroup,
        ].some(Boolean);
        if (!selectorsUsed) {
          return {
            content: [{ type: "text", text: JSON.stringify({ ok: false, error: "no watch selector provided" }, null, 2) }],
            details: { ok: false },
          };
        }

        let result = { updatedIds: [] as string[], missingIds: [] as string[] };
        let watches: ReturnType<typeof toWatchView>[] = [];

        await withStore(async (store) => {
          const selected = selectWatches(store, {
            watchIds: params.watchIds,
            query: params.query,
            enabled: params.matchEnabled,
            hasSnapshot: params.matchHasSnapshot,
            hasSignals: params.matchHasSignals,
            tag: params.matchTag,
            group: params.matchGroup,
            limit: params.limit,
          });
          result.missingIds = params.watchIds?.filter((id: string) => !selected.some((watch) => watch.id === id)) ?? [];
          const target = dryRun ? structuredClone(store) : store;
          const updateResult = bulkUpdateWatches(target, selected.map((watch) => watch.id), {
            group: params.group,
            tags: params.tags,
            addTags: params.addTags,
            removeTags: params.removeTags,
          });
          result.updatedIds = updateResult.updatedIds;
          result.missingIds = [...new Set([...result.missingIds, ...updateResult.missingIds])];
          watches = updateResult.updatedIds
            .map((id: string) => getWatch(target, id))
            .filter((watch): watch is NonNullable<typeof watch> => Boolean(watch))
            .map(toWatchView);
          if (!dryRun && updateResult.updatedIds.length > 0) {
            await saveStore(storePath, target);
          }
        });

        return jsonResult({
          ok: true,
          dryRun,
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
      name: "deal_watch_dedupe",
      label: "Deal Hunter",
      description: "Find or resolve likely duplicate watches using canonicalized URLs. Defaults to report-only dry-run.",
      parameters: Type.Object({
        watchIds: Type.Optional(Type.Array(Type.String())),
        dryRun: Type.Optional(Type.Boolean()),
        action: Type.Optional(Type.Union([
          Type.Literal("report"),
          Type.Literal("disable_duplicates"),
          Type.Literal("remove_duplicates"),
        ])),
        keep: Type.Optional(Type.Union([
          Type.Literal("oldest"),
          Type.Literal("newest"),
        ])),
      }),
      execute: async (_id, params) => {
        const dryRun = params.dryRun !== false;
        const action = params.action ?? "report";
        const keep = params.keep ?? "oldest";
        let groups: Array<{
          canonicalUrl: string;
          keep: ReturnType<typeof toWatchView>;
          duplicates: ReturnType<typeof toWatchView>[];
        }> = [];
        let affectedIds: string[] = [];

        await withStore(async (store) => {
          const selected = selectWatches(store, { watchIds: params.watchIds });
          const byCanonicalUrl = new Map<string, typeof selected>();
          for (const watch of selected) {
            const canonicalUrl = canonicalizeWatchUrl(watch.url).toString();
            const existing = byCanonicalUrl.get(canonicalUrl) ?? [];
            existing.push(watch);
            byCanonicalUrl.set(canonicalUrl, existing);
          }

          const duplicates = [...byCanonicalUrl.entries()]
            .map(([canonicalUrl, watches]) => ({ canonicalUrl, watches }))
            .filter((entry) => entry.watches.length > 1);

          groups = duplicates.map(({ canonicalUrl, watches }) => {
            const sorted = [...watches].sort((a, b) =>
              keep === "newest" ? b.createdAt.localeCompare(a.createdAt) : a.createdAt.localeCompare(b.createdAt),
            );
            const [winner, ...rest] = sorted;
            return {
              canonicalUrl,
              keep: toWatchView(winner!),
              duplicates: rest.map(toWatchView),
            };
          });

          if (!dryRun && action !== "report") {
            for (const group of groups) {
              for (const duplicate of group.duplicates) {
                if (action === "disable_duplicates") {
                  const watch = getWatch(store, duplicate.id);
                  if (watch) watch.enabled = false;
                } else if (action === "remove_duplicates") {
                  removeWatch(store, duplicate.id);
                }
                affectedIds.push(duplicate.id);
              }
            }
            if (affectedIds.length > 0) {
              await saveStore(storePath, store);
            }
          }
        });

        return jsonResult({
          ok: true,
          dryRun,
          action,
          keep,
          duplicateGroupCount: groups.length,
          affectedIds,
          groups,
        });
      },
    },
    { optional: true },
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
        const { extracted, confidence: extractionConfidence, debug } = debugExtractListing(text);
        const fetchSource = cfg.fetcher === "firecrawl" ? "firecrawl" : "node_http";
        const fetchSourceNote =
          cfg.fetcher === "firecrawl"
            ? "Fetched through the Firecrawl scrape API from the Node engine."
            : "Fetched directly over HTTP by the Node engine.";
        const summaryLine = extracted.price != null
          ? `${extracted.title ?? url}: ${extracted.price.toFixed(2)}${extracted.currency ? ` ${extracted.currency}` : ""}`
          : `${extracted.title ?? url}: no price extracted`;
        return jsonResult({
          meta,
          bodyPreview: preview,
          bodyLength: text.length,
          extracted,
          extractionDebug: debug,
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
      name: "deal_extraction_debug",
      label: "Deal Hunter",
      description: "Fetch one URL and show heuristic extraction candidates, chosen fields, and confidence reasons.",
      parameters: Type.Object({
        url: Type.String(),
      }),
      execute: async (_id, params, signal) => {
        const cfg = resolveDealConfig(api);
        const url = canonicalizeWatchUrl(params.url, cfg).toString();
        const { meta, text } = await cappedFetch(url, cfg, { signal });
        const { extracted, confidence, debug } = debugExtractListing(text, 4000);
        return jsonResult({
          url,
          meta,
          extracted,
          confidence,
          debug,
          bodyPreview: text.slice(0, 4000),
        });
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
              "deal_saved_view_list",
              "deal_saved_view_create",
              "deal_saved_view_update",
              "deal_saved_view_run",
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
              "deal_scan",
              "deal_workflow_portfolio",
              "deal_workflow_triage",
              "deal_workflow_cleanup",
              "deal_workflow_best_opportunities",
              "deal_history",
              "deal_alerts",
              "deal_trends",
              "deal_top_drops",
              "deal_market_check",
              "deal_product_groups",
              "deal_best_price_board",
              "deal_llm_review_queue",
              "deal_watch_insights",
              "deal_watch_identity",
              "deal_schedule_advice",
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
              "deal_saved_view_list",
              "deal_saved_view_run",
              "deal_view_scan",
              "deal_view_report",
              "deal_watch_export",
              "deal_fetch_url",
              "deal_extraction_debug",
              "deal_evaluate_text",
              "deal_help",
              "deal_history",
              "deal_alerts",
              "deal_trends",
              "deal_top_drops",
              "deal_market_check",
              "deal_product_groups",
              "deal_best_price_board",
              "deal_llm_review_queue",
              "deal_watch_insights",
              "deal_watch_identity",
              "deal_schedule_advice",
              "deal_workflow_portfolio",
              "deal_workflow_triage",
              "deal_workflow_cleanup",
              "deal_workflow_best_opportunities",
            ],
            writeTools: [
              "deal_watch_add",
              "deal_watch_update",
              "deal_watch_set_enabled",
              "deal_saved_view_create",
              "deal_saved_view_update",
              "deal_saved_view_delete",
              "deal_watch_bulk_update",
              "deal_view_bulk_update",
              "deal_watch_tag",
              "deal_watch_dedupe",
              "deal_watch_remove",
              "deal_watch_import",
              "deal_watch_import_url",
              "deal_scan",
            ],
            examplePrompt:
              "Use deal_view_report for my GPU alerts view, then use deal_best_price_board, deal_workflow_best_opportunities, and deal_llm_review_queue if any results still look ambiguous.",
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
            importUrlPrompt:
              "Use deal_watch_import_url in dry-run mode to preview a shared remote watchlist before applying it.",
            modes: ["append", "upsert", "replace"],
          },
          troubleshooting: {
            firstChecks: ["deal_doctor", "deal_health", "deal_fetch_url"],
            note: "If a scan is blocked, verify the target host against your allowedHosts and blockedHosts policy. Use deal_extraction_debug when parsed fields look suspicious, and deal_llm_review_queue when you want a prepared manual review queue for low-confidence cases.",
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
      name: "deal_workflow_portfolio",
      label: "Deal Hunter",
      description: "Produce a portfolio-style dashboard for the whole watchlist or a saved view.",
      parameters: Type.Object({
        savedViewId: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      }),
      execute: async (_id, params) => {
        const store = await loadStore(storePath);
        const selection = params.savedViewId ? resolveSavedViewSelection(store, params.savedViewId) : null;
        const scopedStore = selection ? buildScopedStore(store, selection.watches) : store;
        return jsonResult({
          savedView: selection?.summary,
          ...buildWorkflowPortfolio(scopedStore, params.limit ?? 10),
        });
      },
    },
    { optional: false },
  );

  api.registerTool(
    {
      name: "deal_workflow_triage",
      label: "Deal Hunter",
      description: "Answer what changed, what matters, what looks noisy, and what should be reviewed first.",
      parameters: Type.Object({
        savedViewId: Type.Optional(Type.String()),
        severity: Type.Optional(Type.Union([
          Type.Literal("low"),
          Type.Literal("medium"),
          Type.Literal("high"),
        ])),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      }),
      execute: async (_id, params) => {
        const store = await loadStore(storePath);
        const selection = params.savedViewId ? resolveSavedViewSelection(store, params.savedViewId) : null;
        const scopedStore = selection ? buildScopedStore(store, selection.watches) : store;
        return jsonResult({
          savedView: selection?.summary,
          ...buildWorkflowTriage(scopedStore, params.limit ?? 5, params.severity ?? "medium"),
        });
      },
    },
    { optional: false },
  );

  api.registerTool(
    {
      name: "deal_workflow_cleanup",
      label: "Deal Hunter",
      description: "Surface duplicate, stale, weak-extraction, and noisy watches that are good cleanup candidates.",
      parameters: Type.Object({
        savedViewId: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      }),
      execute: async (_id, params) => {
        const store = await loadStore(storePath);
        const selection = params.savedViewId ? resolveSavedViewSelection(store, params.savedViewId) : null;
        const scopedStore = selection ? buildScopedStore(store, selection.watches) : store;
        return jsonResult({
          savedView: selection?.summary,
          ...buildWorkflowCleanup(scopedStore, params.limit ?? 10),
        });
      },
    },
    { optional: false },
  );

  api.registerTool(
    {
      name: "deal_workflow_best_opportunities",
      label: "Deal Hunter",
      description: "Rank the strongest likely-real deals, suspicious glitches, and best same-product internal spreads.",
      parameters: Type.Object({
        savedViewId: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      }),
      execute: async (_id, params) => {
        const store = await loadStore(storePath);
        const selection = params.savedViewId ? resolveSavedViewSelection(store, params.savedViewId) : null;
        const scopedStore = selection ? buildScopedStore(store, selection.watches) : store;
        return jsonResult({
          savedView: selection?.summary,
          ...buildWorkflowBestOpportunities(scopedStore, Math.min(params.limit ?? 5, 20)),
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

  api.registerTool(
    {
      name: "deal_trends",
      label: "Deal Hunter",
      description: "Summarize watch trends, including falling, rising, flat, and volatile watches.",
      parameters: Type.Object({
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      }),
      execute: async (_id, params) => {
        const store = await loadStore(storePath);
        return jsonResult(buildTrendsSummary(store, params.limit ?? 20));
      },
    },
    { optional: false },
  );

  api.registerTool(
    {
      name: "deal_top_drops",
      label: "Deal Hunter",
      description: "Rank the strongest drops by current discount from peak or the latest committed move.",
      parameters: Type.Object({
        metric: Type.Optional(Type.Union([Type.Literal("vs_peak"), Type.Literal("latest_change")])),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      }),
      execute: async (_id, params) => {
        const store = await loadStore(storePath);
        return jsonResult(buildTopDropsSummary(store, params.metric ?? "vs_peak", params.limit ?? 10));
      },
    },
    { optional: false },
  );

  api.registerTool(
    {
      name: "deal_watch_insights",
      label: "Deal Hunter",
      description: "Explain one watch in depth: trend, volatility, glitch risk, current position, and active signals.",
      parameters: Type.Object({
        watchId: Type.String(),
      }),
      execute: async (_id, params) => {
        const store = await loadStore(storePath);
        const watch = getWatch(store, params.watchId);
        if (!watch) {
          return {
            content: [{ type: "text", text: JSON.stringify({ ok: false, error: "watch not found" }, null, 2) }],
            details: { ok: false },
          };
        }
        return jsonResult(buildWatchInsights(watch));
      },
    },
    { optional: false },
  );

  api.registerTool(
    {
      name: "deal_watch_identity",
      label: "Deal Hunter",
      description: "Show stored product identifiers for a watch and any other watches sharing those identifiers.",
      parameters: Type.Object({
        watchId: Type.String(),
      }),
      execute: async (_id, params) => {
        const store = await loadStore(storePath);
        const watch = getWatch(store, params.watchId);
        if (!watch) {
          return {
            content: [{ type: "text", text: JSON.stringify({ ok: false, error: "watch not found" }, null, 2) }],
            details: { ok: false },
          };
        }
        return jsonResult(buildWatchIdentitySummary(store, watch));
      },
    },
    { optional: false },
  );

  api.registerTool(
    {
      name: "deal_market_check",
      label: "Deal Hunter",
      description: "Compare one watch against likely same-product watches already in the current store and summarize price spread.",
      parameters: Type.Object({
        watchId: Type.String(),
        includeLooseTitleFallback: Type.Optional(Type.Boolean()),
      }),
      execute: async (_id, params) => {
        const store = await loadStore(storePath);
        const watch = getWatch(store, params.watchId);
        if (!watch) {
          return {
            content: [{ type: "text", text: JSON.stringify({ ok: false, error: "watch not found" }, null, 2) }],
            details: { ok: false },
          };
        }
        return jsonResult(
          buildMarketCheckSummary(store, watch, {
            includeLooseTitleFallback: params.includeLooseTitleFallback,
          }),
        );
      },
    },
    { optional: false },
  );

  api.registerTool(
    {
      name: "deal_product_groups",
      label: "Deal Hunter",
      description: "Group likely same-product watches across the store or a saved view and summarize internal price spreads.",
      parameters: Type.Object({
        savedViewId: Type.Optional(Type.String()),
        includeLooseTitleFallback: Type.Optional(Type.Boolean()),
        minMatchScore: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      }),
      execute: async (_id, params) => {
        const store = await loadStore(storePath);
        const selection = params.savedViewId ? resolveSavedViewSelection(store, params.savedViewId) : null;
        const scopedStore = selection ? buildScopedStore(store, selection.watches) : store;
        return jsonResult({
          savedView: selection?.summary,
          ...buildProductGroupsSummary(scopedStore, {
            includeLooseTitleFallback: params.includeLooseTitleFallback,
            minMatchScore: params.minMatchScore,
            limit: params.limit ?? 20,
          }),
        });
      },
    },
    { optional: false },
  );

  api.registerTool(
    {
      name: "deal_best_price_board",
      label: "Deal Hunter",
      description: "Rank product groups by current internal same-product price spread and identify the best-known watch in each group.",
      parameters: Type.Object({
        savedViewId: Type.Optional(Type.String()),
        includeLooseTitleFallback: Type.Optional(Type.Boolean()),
        minMatchScore: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      }),
      execute: async (_id, params) => {
        const store = await loadStore(storePath);
        const selection = params.savedViewId ? resolveSavedViewSelection(store, params.savedViewId) : null;
        const scopedStore = selection ? buildScopedStore(store, selection.watches) : store;
        return jsonResult({
          savedView: selection?.summary,
          ...buildBestPriceBoard(scopedStore, {
            includeLooseTitleFallback: params.includeLooseTitleFallback,
            minMatchScore: params.minMatchScore,
            limit: params.limit ?? 20,
          }),
        });
      },
    },
    { optional: false },
  );

  api.registerTool(
    {
      name: "deal_llm_review_queue",
      label: "Deal Hunter",
      description: "Prepare low-confidence extraction or identity cases for optional manual or llm-task-based JSON review without making this plugin depend on llm-task.",
      parameters: Type.Object({
        savedViewId: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      }),
      execute: async (_id, params) => {
        const store = await loadStore(storePath);
        const selection = params.savedViewId ? resolveSavedViewSelection(store, params.savedViewId) : null;
        const scopedStore = selection ? buildScopedStore(store, selection.watches) : store;
        return jsonResult({
          savedView: selection?.summary,
          ...buildLlmReviewQueue(scopedStore, params.limit ?? 10),
        });
      },
    },
    { optional: false },
  );

  api.registerTool(
    {
      name: "deal_schedule_advice",
      label: "Deal Hunter",
      description: "Recommend scan cadence by host or watch based on observed history timing.",
      parameters: Type.Object({
        mode: Type.Optional(Type.Union([Type.Literal("host"), Type.Literal("watch")])),
      }),
      execute: async (_id, params) => {
        const store = await loadStore(storePath);
        return jsonResult(buildScheduleAdvice(store, params.mode ?? "host"));
      },
    },
    { optional: false },
  );
}
