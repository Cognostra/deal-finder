import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import { resolveDealConfig } from "../config.js";
import { cappedFetch } from "../lib/fetch.js";
import type { ImportedWatchInput } from "../lib/store.js";
import { parseImportedWatchPayload } from "../lib/store.js";
import { validateTargetUrl } from "../lib/url-policy.js";
import { toWatchView, type ToolContext } from "./shared.js";
import { createToolRuntimeServices } from "./runtime-services.js";
import { IMPORTED_WATCH_SCHEMA, mergeImportedTags } from "./watch-admin-shared.js";

export function registerWatchImportTools(api: OpenClawPluginApi, ctx: ToolContext): void {
  const runtime = createToolRuntimeServices(api, ctx);

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
        return jsonResult(await runtime.services.watch.exportWatches({
          watchIds: params.watchIds,
          includeDisabled: params.includeDisabled,
          includeSnapshots: params.includeSnapshots,
          includeHistory: params.includeHistory,
        }));
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
        const dryRun = params.dryRun === true;
        const result = dryRun
          ? await runtime.services.watch.previewImport(params.watches as ImportedWatchInput[], mode, cfg)
          : await runtime.services.watch.importWatches(params.watches as ImportedWatchInput[], mode, cfg);

        return jsonResult({
          ok: true,
          dryRun,
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
          group: params.group ?? watch.group,
          tags: mergeImportedTags(watch.tags, params.addTags),
          enabled: params.enabled ?? watch.enabled,
        }));
        const dryRun = params.dryRun !== false;
        const result = dryRun
          ? await runtime.services.watch.previewImport(normalizedWatches, mode, cfg, {
              importSourceOverride: {
                type: "url",
                url: importUrl,
                importedAt,
              },
            })
          : await runtime.services.watch.importWatches(normalizedWatches, mode, cfg, {
              importSourceOverride: {
                type: "url",
                url: importUrl,
                importedAt,
              },
            });

        return jsonResult({
          ok: true,
          dryRun,
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
