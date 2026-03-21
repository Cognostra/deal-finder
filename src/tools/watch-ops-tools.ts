import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import { resolveDealConfig } from "../config.js";
import { mergeCommittedScanResults, runScan } from "../lib/engine.js";
import { cappedFetch } from "../lib/fetch.js";
import { debugExtractListing, evaluateListingText } from "../lib/heuristics.js";
import { describeReviewPolicy } from "../lib/review-policy.js";
import { saveStore } from "../lib/store.js";
import { canonicalizeWatchUrl, validateTargetUrl } from "../lib/url-policy.js";
import { buildScanSummary, type ToolContext } from "./shared.js";

export function registerWatchOpsTools(api: OpenClawPluginApi, ctx: ToolContext): void {
  const { storePath, withStore } = ctx;

  api.registerTool(
    {
      name: "deal_review_policy",
      label: "Deal Hunter",
      description: "Show the effective scan-time review policy, thresholds, and whether automatic model review is enabled.",
      parameters: Type.Object({}),
      execute: async () => {
        const cfg = resolveDealConfig(api);
        return jsonResult(describeReviewPolicy(cfg));
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

        const { summary, rankedAlerts, reviewWarnings } = buildScanSummary(results);

        return jsonResult({
          results,
          summary,
          rankedAlerts,
          reviewWarnings,
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
          truncated: Boolean(meta.truncated),
          bodyPreview: preview,
          bodyLength: text.length,
          extracted,
          extractionDebug: debug,
          fetchSource,
          fetchSourceNote,
          extractionConfidence,
          warnings: meta.truncated ? ["Response hit the configured byte cap; extraction may be incomplete."] : [],
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
          truncated: Boolean(meta.truncated),
          extracted,
          confidence,
          debug,
          bodyPreview: text.slice(0, 4000),
        });
      },
    },
    { optional: false },
  );
}
