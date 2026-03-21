import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import { bulkUpdateWatches, getWatch, loadStore, removeWatch, saveStore } from "../lib/store.js";
import { canonicalizeWatchUrl } from "../lib/url-policy.js";
import { searchWatches } from "../lib/watch-view.js";
import { resolveSavedViewSelection, toWatchView, type LoadedStore, type ToolContext } from "./shared.js";

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

function selectWatches(
  store: LoadedStore,
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

export function registerWatchMaintenanceTools(api: OpenClawPluginApi, ctx: ToolContext): void {
  const { storePath, withStore } = ctx;

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
}
