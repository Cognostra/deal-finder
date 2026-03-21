import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import { resolveDealConfig } from "../config.js";
import { addWatch, getWatch, loadStore, removeWatch, saveStore, setWatchEnabled, updateWatch } from "../lib/store.js";
import { searchWatches } from "../lib/watch-view.js";
import { canonicalizeWatchUrl } from "../lib/url-policy.js";
import { toWatchView, type ToolContext } from "./shared.js";

export function registerWatchStateTools(api: OpenClawPluginApi, ctx: ToolContext): void {
  const { storePath, withStore } = ctx;

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
}
