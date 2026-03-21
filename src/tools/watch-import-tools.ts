import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import { resolveDealConfig } from "../config.js";
import { cappedFetch } from "../lib/fetch.js";
import type { ImportedWatchInput } from "../lib/store.js";
import { importWatches, loadStore, parseImportedWatchPayload, saveStore } from "../lib/store.js";
import { canonicalizeWatchUrl, validateTargetUrl } from "../lib/url-policy.js";
import { toWatchView, type ToolContext } from "./shared.js";
import { IMPORTED_WATCH_SCHEMA, mergeImportedTags } from "./watch-admin-shared.js";

export function registerWatchImportTools(api: OpenClawPluginApi, ctx: ToolContext): void {
  const { storePath, withStore } = ctx;

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
}
