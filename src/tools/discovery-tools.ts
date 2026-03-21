import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import { resolveDealConfig } from "../config.js";
import { describeDiscoveryPolicy, fetchDiscoveryCandidates, searchDiscoveryCandidates } from "../lib/discovery.js";
import { buildDiscoveryBacklog, buildDiscoveryReport } from "../lib/report.js";
import { getWatch, importWatches, loadStore, saveStore } from "../lib/store.js";
import { buildScopedStore, buildDiscoveryFetchSummary, buildDiscoveryWorkflow, ensureDiscoveryEnabled, ensureProviderDiscoveryEnabled, resolveSavedViewSelection, toDiscoveryAnchor, type ToolContext, watchNotFoundResult } from "./shared.js";

export function registerDiscoveryTools(api: OpenClawPluginApi, ctx: ToolContext): void {
  const { storePath, withStore } = ctx;

  api.registerTool(
    {
      name: "deal_discovery_backlog",
      label: "Deal Hunter",
      description: "Rank which enabled watches most need discovery coverage expansion and explain why.",
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
          ...buildDiscoveryBacklog(scopedStore, params.limit ?? 10),
        });
      },
    },
    { optional: false },
  );

  api.registerTool(
    {
      name: "deal_discovery_policy",
      label: "Deal Hunter",
      description: "Show the effective discovery mode, budgets, trusted-host posture, and whether provider-backed search is configured.",
      parameters: Type.Object({}),
      execute: async () => {
        const cfg = resolveDealConfig(api);
        return jsonResult(describeDiscoveryPolicy(cfg));
      },
    },
    { optional: false },
  );

  api.registerTool(
    {
      name: "deal_discovery_report",
      label: "Deal Hunter",
      description: "Run the bounded discovery workflow and return a compact report of what looks importable, duplicated, weak, or blocked.",
      parameters: Type.Object({
        watchId: Type.String(),
        candidateUrls: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 10 })),
        allowedHosts: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 10 })),
        maxSearchResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
        queryHints: Type.Optional(Type.Array(Type.String(), { maxItems: 6 })),
        includeLooseTitleFallback: Type.Optional(Type.Boolean()),
        group: Type.Optional(Type.String()),
        addTags: Type.Optional(Type.Array(Type.String())),
        enabled: Type.Optional(Type.Boolean()),
      }),
      execute: async (_id, params, signal) => {
        const cfg = resolveDealConfig(api);
        ensureDiscoveryEnabled(cfg);
        const store = await loadStore(storePath);
        const watch = getWatch(store, params.watchId);
        if (!watch) {
          return watchNotFoundResult();
        }
        const { search, candidates, importPreview } = await buildDiscoveryWorkflow({
          watch,
          store,
          cfg,
          signal,
          candidateUrls: params.candidateUrls,
          allowedHosts: params.allowedHosts,
          maxSearchResults: params.maxSearchResults,
          queryHints: params.queryHints,
          includeLooseTitleFallback: params.includeLooseTitleFallback,
          group: params.group,
          addTags: params.addTags,
          enabled: params.enabled,
        });
        return jsonResult(
          buildDiscoveryReport({
            watch,
            provider: cfg.discovery.provider,
            query: search?.query,
            searchHosts: search?.searchHosts,
            skippedHosts: search?.skippedHosts,
            skippedResults: search?.skippedResults,
            candidates,
            importPreview,
          }),
        );
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "deal_discovery_search",
      label: "Deal Hunter",
      description: "Use the configured bounded discovery provider to search explicit retailer hosts for likely same-product candidates before fetching them.",
      parameters: Type.Object({
        watchId: Type.String(),
        allowedHosts: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 10 })),
        maxSearchResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
        queryHints: Type.Optional(Type.Array(Type.String(), { maxItems: 6 })),
      }),
      execute: async (_id, params, signal) => {
        const cfg = resolveDealConfig(api);
        ensureProviderDiscoveryEnabled(cfg);
        const store = await loadStore(storePath);
        const watch = getWatch(store, params.watchId);
        if (!watch) {
          return watchNotFoundResult();
        }
        const search = await searchDiscoveryCandidates({
          watch,
          cfg,
          allowedHosts: params.allowedHosts,
          maxSearchResults: params.maxSearchResults,
          queryHints: params.queryHints,
          signal,
        });
        return jsonResult({
          anchor: toDiscoveryAnchor(watch),
          provider: search.provider,
          query: search.query,
          searchHosts: search.searchHosts,
          skippedHosts: search.skippedHosts,
          summary: {
            searchHostCount: search.searchHosts.length,
            candidateCount: search.results.length,
            skippedHostCount: search.skippedHosts.length,
            skippedResultCount: search.skippedResults.length,
          },
          candidateUrls: search.results.map((entry) => entry.url),
          candidates: search.results,
          skippedResults: search.skippedResults,
        });
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "deal_discovery_fetch",
      label: "Deal Hunter",
      description: "Fetch explicit candidate URLs, extract them safely, and score likely same-product matches against one anchor watch.",
      parameters: Type.Object({
        watchId: Type.String(),
        candidateUrls: Type.Array(Type.String(), { minItems: 1, maxItems: 10 }),
        includeLooseTitleFallback: Type.Optional(Type.Boolean()),
      }),
      execute: async (_id, params, signal) => {
        const cfg = resolveDealConfig(api);
        ensureDiscoveryEnabled(cfg);
        const store = await loadStore(storePath);
        const watch = getWatch(store, params.watchId);
        if (!watch) {
          return watchNotFoundResult();
        }
        const candidates = await fetchDiscoveryCandidates({
          watch,
          candidateUrls: params.candidateUrls,
          cfg,
          signal,
          includeLooseTitleFallback: params.includeLooseTitleFallback,
        });
        return jsonResult({
          anchor: toDiscoveryAnchor(watch),
          provider: cfg.discovery.provider,
          summary: buildDiscoveryFetchSummary(candidates),
          candidates,
        });
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "deal_discovery_run",
      label: "Deal Hunter",
      description: "Run the bounded discovery workflow: optionally search, then fetch, rank, and prepare import decisions.",
      parameters: Type.Object({
        watchId: Type.String(),
        candidateUrls: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 10 })),
        allowedHosts: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 10 })),
        maxSearchResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
        queryHints: Type.Optional(Type.Array(Type.String(), { maxItems: 6 })),
        includeLooseTitleFallback: Type.Optional(Type.Boolean()),
        group: Type.Optional(Type.String()),
        addTags: Type.Optional(Type.Array(Type.String())),
        enabled: Type.Optional(Type.Boolean()),
      }),
      execute: async (_id, params, signal) => {
        const cfg = resolveDealConfig(api);
        ensureDiscoveryEnabled(cfg);
        const store = await loadStore(storePath);
        const watch = getWatch(store, params.watchId);
        if (!watch) {
          return watchNotFoundResult();
        }
        const { search, candidates, importPreview } = await buildDiscoveryWorkflow({
          watch,
          store,
          cfg,
          signal,
          candidateUrls: params.candidateUrls,
          allowedHosts: params.allowedHosts,
          maxSearchResults: params.maxSearchResults,
          queryHints: params.queryHints,
          includeLooseTitleFallback: params.includeLooseTitleFallback,
          group: params.group,
          addTags: params.addTags,
          enabled: params.enabled,
        });
        const report = buildDiscoveryReport({
          watch,
          provider: cfg.discovery.provider,
          query: search?.query,
          searchHosts: search?.searchHosts,
          skippedHosts: search?.skippedHosts,
          skippedResults: search?.skippedResults,
          candidates,
          importPreview,
        });
        return jsonResult({
          anchor: toDiscoveryAnchor(watch),
          provider: cfg.discovery.provider,
          query: search?.query,
          searchHosts: search?.searchHosts,
          skippedHosts: search?.skippedHosts,
          summary: {
            searchedCount: search?.results.length ?? 0,
            candidateCount: candidates.length,
            okCount: candidates.filter((candidate) => candidate.fetchStatus === "ok").length,
            importableCount: importPreview.filter((entry) => entry.importable).length,
            blockedOrFailedCount: candidates.filter((candidate) => candidate.fetchStatus !== "ok").length,
          },
          report,
          searchedCandidates: search?.results,
          skippedResults: search?.skippedResults,
          candidates,
          importPreview,
        });
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "deal_discovery_import",
      label: "Deal Hunter",
      description: "Import selected discovery candidates as watches. Defaults to dry-run preview.",
      parameters: Type.Object({
        watchId: Type.String(),
        candidateUrls: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 10 })),
        allowedHosts: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 10 })),
        maxSearchResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
        queryHints: Type.Optional(Type.Array(Type.String(), { maxItems: 6 })),
        includeLooseTitleFallback: Type.Optional(Type.Boolean()),
        group: Type.Optional(Type.String()),
        addTags: Type.Optional(Type.Array(Type.String())),
        enabled: Type.Optional(Type.Boolean()),
        dryRun: Type.Optional(Type.Boolean()),
      }),
      execute: async (_id, params, signal) => {
        const cfg = resolveDealConfig(api);
        ensureDiscoveryEnabled(cfg);
        const store = await loadStore(storePath);
        const watch = getWatch(store, params.watchId);
        if (!watch) {
          return watchNotFoundResult();
        }
        const { search, candidates, importPreview } = await buildDiscoveryWorkflow({
          watch,
          store,
          cfg,
          signal,
          candidateUrls: params.candidateUrls,
          allowedHosts: params.allowedHosts,
          maxSearchResults: params.maxSearchResults,
          queryHints: params.queryHints,
          includeLooseTitleFallback: params.includeLooseTitleFallback,
          group: params.group,
          addTags: params.addTags,
          enabled: params.enabled,
        });
        const dryRun = params.dryRun !== false;
        const importable = importPreview.filter((entry) => entry.importable && entry.watchInput).map((entry) => entry.watchInput!);
        const report = buildDiscoveryReport({
          watch,
          provider: cfg.discovery.provider,
          query: search?.query,
          searchHosts: search?.searchHosts,
          skippedHosts: search?.skippedHosts,
          skippedResults: search?.skippedResults,
          candidates,
          importPreview,
        });

        if (dryRun) {
          return jsonResult({
            ok: true,
            dryRun: true,
            provider: cfg.discovery.provider,
            query: search?.query,
            searchHosts: search?.searchHosts,
            importableCount: importable.length,
            report,
            searchedCandidates: search?.results,
            skippedResults: search?.skippedResults,
            importPreview,
          });
        }

        let importResult: ReturnType<typeof importWatches> | null = null;
        await withStore(async (lockedStore) => {
          importResult = importWatches(lockedStore, importable, "append");
          await saveStore(storePath, lockedStore);
        });

        return jsonResult({
          ok: true,
          dryRun: false,
          provider: cfg.discovery.provider,
          query: search?.query,
          searchHosts: search?.searchHosts,
          importableCount: importable.length,
          report,
          searchedCandidates: search?.results,
          skippedResults: search?.skippedResults,
          importPreview,
          importResult,
        });
      },
    },
    { optional: true },
  );
}
