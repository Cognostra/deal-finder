import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import { resolveDealConfig } from "../config.js";
import { mergeCommittedScanResults, runScan } from "../lib/engine.js";
import { buildSavedViewDashboard, buildViewReport } from "../lib/report.js";
import { addSavedView, listSavedViews, loadStore, removeSavedView, saveStore, updateSavedView } from "../lib/store.js";
import { buildScanSummary, resolveSavedViewSelection, toSavedViewSummary, toWatchView, type ToolContext } from "./shared.js";

const WATCH_SELECTOR_SCHEMA = {
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

export function registerSavedViewTools(api: OpenClawPluginApi, ctx: ToolContext): void {
  const { storePath, withStore } = ctx;

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
      name: "deal_saved_view_dashboard",
      label: "Deal Hunter",
      description: "Summarize all saved views at a glance, including current match counts, hottest alerts, best opportunities, and the next recommended action.",
      parameters: Type.Object({
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
        severity: Type.Optional(Type.Union([
          Type.Literal("low"),
          Type.Literal("medium"),
          Type.Literal("high"),
        ])),
      }),
      execute: async (_id, params) => {
        const store = await loadStore(storePath);
        return jsonResult(buildSavedViewDashboard(store, {
          limit: params.limit ?? 10,
          severity: params.severity ?? "medium",
        }));
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
        const selection = resolveSavedViewSelection(store, params.savedViewId);
        return jsonResult({
          savedView: selection.summary,
          watches: selection.watches.map(toWatchView),
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

        const { summary, rankedAlerts, reviewWarnings } = buildScanSummary(results);
        return jsonResult({
          savedView: selection.summary,
          matchedCount: selection.watches.length,
          enabledMatchedCount: eligibleWatchIds.length,
          disabledMatchedCount: selection.watches.length - eligibleWatchIds.length,
          results,
          summary,
          rankedAlerts,
          reviewWarnings,
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
}
