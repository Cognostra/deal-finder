import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import { resolveDealConfig } from "../config.js";
import { cappedFetch } from "../lib/fetch.js";
import { canonicalizeTitle, debugExtractListing } from "../lib/heuristics.js";
import { runLlmReviewCandidate } from "../lib/llm-review.js";
import { buildExternalProductMatchCandidate } from "../lib/product-identity.js";
import { listLlmReviewCandidates } from "../lib/report.js";
import { applyWatchSnapshotPatch, getWatch, loadStore, saveStore } from "../lib/store.js";
import { buildScopedStore, resolveSavedViewSelection, type ToolContext, watchNotFoundResult } from "./shared.js";
import { validateTargetUrl } from "../lib/url-policy.js";
import { createToolRuntimeServices } from "./runtime-services.js";

export function registerReportInsightTools(api: OpenClawPluginApi, ctx: ToolContext): void {
  const { storePath, withStore } = ctx;
  const runtime = createToolRuntimeServices(api, ctx);

  api.registerTool({ name: "deal_history", label: "Deal Hunter", description: "Show stored price history and recent changes for one watch or summarize history across watches.", parameters: Type.Object({
    watchId: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  }), execute: async (_id, params) => {
    const result = await runtime.services.reporting.getHistory({ watchId: params.watchId, limit: params.limit });
    if (!result) return watchNotFoundResult();
    return jsonResult(result);
  } }, { optional: false });

  api.registerTool({ name: "deal_alerts", label: "Deal Hunter", description: "Show the hottest current threshold, keyword, and recent change signals across the watchlist.", parameters: Type.Object({
    severity: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")])),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  }), execute: async (_id, params) => {
    return jsonResult(await runtime.services.reporting.getAlerts({
      severity: params.severity ?? "low",
      limit: params.limit,
    }));
  } }, { optional: false });

  api.registerTool({ name: "deal_trends", label: "Deal Hunter", description: "Summarize watch trends, including falling, rising, flat, and volatile watches.", parameters: Type.Object({
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  }), execute: async (_id, params) => {
    return jsonResult(await runtime.services.reporting.getTrends(params.limit));
  } }, { optional: false });

  api.registerTool({ name: "deal_top_drops", label: "Deal Hunter", description: "Rank the strongest drops by current discount from peak or the latest committed move.", parameters: Type.Object({
    metric: Type.Optional(Type.Union([Type.Literal("vs_peak"), Type.Literal("latest_change")])),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  }), execute: async (_id, params) => {
    return jsonResult(await runtime.services.reporting.getTopDrops(params.metric ?? "vs_peak", params.limit));
  } }, { optional: false });

  api.registerTool({ name: "deal_watch_insights", label: "Deal Hunter", description: "Explain one watch in depth: trend, volatility, glitch risk, current position, and active signals.", parameters: Type.Object({
    watchId: Type.String(),
  }), execute: async (_id, params) => {
    const result = await runtime.services.reporting.getWatchInsights(params.watchId);
    if (!result) return watchNotFoundResult();
    return jsonResult(result);
  } }, { optional: false });

  api.registerTool({ name: "deal_watch_provenance", label: "Deal Hunter", description: "Show how one watch entered the store, what the latest committed snapshot came from, and whether any reviewed fields or truncation warnings exist.", parameters: Type.Object({
    watchId: Type.String(),
  }), execute: async (_id, params) => {
    const result = await runtime.services.reporting.getWatchProvenance(params.watchId);
    if (!result) return watchNotFoundResult();
    return jsonResult(result);
  } }, { optional: false });

  api.registerTool({ name: "deal_watch_identity", label: "Deal Hunter", description: "Show stored product identifiers for a watch and any other watches sharing those identifiers.", parameters: Type.Object({
    watchId: Type.String(),
  }), execute: async (_id, params) => {
    const result = await runtime.services.reporting.getWatchIdentity(params.watchId);
    if (!result) return watchNotFoundResult();
    return jsonResult(result);
  } }, { optional: false });

  api.registerTool({ name: "deal_market_check", label: "Deal Hunter", description: "Compare one watch against likely same-product watches already in the current store and summarize price spread.", parameters: Type.Object({
    watchId: Type.String(),
    includeLooseTitleFallback: Type.Optional(Type.Boolean()),
  }), execute: async (_id, params) => {
    const result = await runtime.services.reporting.getMarketCheck(params.watchId, {
      includeLooseTitleFallback: params.includeLooseTitleFallback,
    });
    if (!result) return watchNotFoundResult();
    return jsonResult(result);
  } }, { optional: false });

  api.registerTool({ name: "deal_market_check_candidates", label: "Deal Hunter", description: "Fetch explicit candidate URLs and compare them against one anchor watch without importing anything.", parameters: Type.Object({
    watchId: Type.String(),
    candidateUrls: Type.Array(Type.String(), { minItems: 1, maxItems: 10 }),
    includeLooseTitleFallback: Type.Optional(Type.Boolean()),
  }), execute: async (_id, params, signal) => {
    const store = await loadStore(storePath);
    const watch = getWatch(store, params.watchId);
    if (!watch) return watchNotFoundResult();
    const cfg = resolveDealConfig(api);
    const evaluations = await Promise.all(params.candidateUrls.map(async (candidateUrl: string) => {
      const url = validateTargetUrl(candidateUrl, cfg).toString();
      try {
        const { meta, text } = await cappedFetch(url, cfg, { signal });
        const { extracted, confidence, debug } = debugExtractListing(text, 4000);
        const match = buildExternalProductMatchCandidate(watch, { url, extracted }, { includeLooseTitleFallback: params.includeLooseTitleFallback });
        return {
          url,
          ok: true,
          meta,
          extracted,
          extractionConfidence: confidence,
          matchedExtractor: debug.matchedExtractor,
          match,
          recommendedAction:
            match?.matchStrength === "high" ? "strong_candidate_for_manual_review_or_watch_add"
              : match?.matchStrength === "medium" ? "review_before_import"
              : "likely_not_same_product",
        };
      } catch (error) {
        return { url, ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }));
    const matched = evaluations.filter((entry) => entry.ok && Boolean(entry.match)).sort((a, b) => ((b.ok ? (b.match?.matchScore ?? 0) : 0) - (a.ok ? (a.match?.matchScore ?? 0) : 0)));
    return jsonResult({
      anchor: { watchId: watch.id, label: watch.label, url: watch.url, snapshot: watch.lastSnapshot },
      summary: {
        candidateCount: params.candidateUrls.length,
        fetchedCount: evaluations.filter((entry) => entry.ok).length,
        matchCount: matched.length,
        highConfidenceMatches: matched.filter((entry) => entry.match.matchStrength === "high").length,
        blockedOrFailed: evaluations.filter((entry) => !entry.ok).length,
      },
      candidates: evaluations,
    });
  } }, { optional: true });

  api.registerTool({ name: "deal_product_groups", label: "Deal Hunter", description: "Group likely same-product watches across the store or a saved view and summarize internal price spreads.", parameters: Type.Object({
    savedViewId: Type.Optional(Type.String()),
    includeLooseTitleFallback: Type.Optional(Type.Boolean()),
    minMatchScore: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  }), execute: async (_id, params) => {
    return jsonResult(await runtime.services.reporting.getProductGroups({
      savedViewId: params.savedViewId,
      includeLooseTitleFallback: params.includeLooseTitleFallback,
      minMatchScore: params.minMatchScore,
      limit: params.limit,
    }));
  } }, { optional: false });

  api.registerTool({ name: "deal_best_price_board", label: "Deal Hunter", description: "Rank product groups by current internal same-product price spread and identify the best-known watch in each group.", parameters: Type.Object({
    savedViewId: Type.Optional(Type.String()),
    includeLooseTitleFallback: Type.Optional(Type.Boolean()),
    minMatchScore: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  }), execute: async (_id, params) => {
    return jsonResult(await runtime.services.reporting.getBestPriceBoard({
      savedViewId: params.savedViewId,
      includeLooseTitleFallback: params.includeLooseTitleFallback,
      minMatchScore: params.minMatchScore,
      limit: params.limit,
    }));
  } }, { optional: false });

  api.registerTool({ name: "deal_llm_review_queue", label: "Deal Hunter", description: "Prepare low-confidence extraction or identity cases for optional manual or llm-task-based JSON review without making this plugin depend on llm-task.", parameters: Type.Object({
    savedViewId: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  }), execute: async (_id, params) => {
    return jsonResult(await runtime.services.reporting.getLlmReviewQueue({
      savedViewId: params.savedViewId,
      limit: params.limit,
    }));
  } }, { optional: false });

  api.registerTool({ name: "deal_llm_review_run", label: "Deal Hunter", description: "Run one queued extraction or identity review through the embedded OpenClaw agent runtime and return JSON output.", parameters: Type.Object({
    watchId: Type.String(),
    reviewType: Type.Optional(Type.Union([Type.Literal("extraction_review"), Type.Literal("identity_resolution")])),
    savedViewId: Type.Optional(Type.String()),
    provider: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    authProfileId: Type.Optional(Type.String()),
    temperature: Type.Optional(Type.Number()),
    maxTokens: Type.Optional(Type.Integer({ minimum: 1 })),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 300000 })),
  }), execute: async (_id, params) => {
    const store = await loadStore(storePath);
    const selection = params.savedViewId ? resolveSavedViewSelection(store, params.savedViewId) : null;
    const scopedStore = selection ? buildScopedStore(store, selection.watches) : store;
    const candidate = listLlmReviewCandidates(scopedStore).find((entry) => entry.watchId === params.watchId && (!params.reviewType || entry.type === params.reviewType));
    if (!candidate) return jsonResult({ ok: false, error: "review candidate not found" });
    const result = await runLlmReviewCandidate(api, candidate, {
      provider: params.provider,
      model: params.model,
      authProfileId: params.authProfileId,
      temperature: params.temperature,
      maxTokens: params.maxTokens,
      timeoutMs: params.timeoutMs,
    });
    return jsonResult({
      ok: true,
      savedView: selection?.summary,
      candidate: {
        watchId: candidate.watchId,
        label: candidate.label,
        url: candidate.url,
        type: candidate.type,
        priority: candidate.priority,
        reasons: candidate.reasons,
      },
      execution: {
        provider: result.provider,
        model: result.model,
        schemaValidation: "not_enforced",
      },
      output: result.json,
      rawText: result.rawText,
    });
  } }, { optional: true });

  api.registerTool({ name: "deal_llm_review_apply", label: "Deal Hunter", description: "Apply reviewed extraction or identity fields back onto a watch snapshot. Defaults to dry-run preview.", parameters: Type.Object({
    watchId: Type.String(),
    review: Type.Object({
      title: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      canonicalTitle: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      brand: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      modelId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      sku: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      mpn: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      gtin: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      asin: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      price: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
      currency: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      rawSnippet: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    }),
    reviewSource: Type.Optional(Type.String()),
    candidateType: Type.Optional(Type.Union([Type.Literal("extraction_review"), Type.Literal("identity_resolution")])),
    provider: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    reasons: Type.Optional(Type.Array(Type.String())),
    dryRun: Type.Optional(Type.Boolean()),
  }), execute: async (_id, params) => {
    const store = await loadStore(storePath);
    const watch = getWatch(store, params.watchId);
    if (!watch) return watchNotFoundResult();

    const before = watch.lastSnapshot ? { ...watch.lastSnapshot } : undefined;
    const computedCanonicalTitle =
      "canonicalTitle" in params.review
        ? params.review.canonicalTitle
        : (typeof params.review.title === "string" ? canonicalizeTitle(params.review.title) : undefined);

    const patch = {
      title: params.review.title,
      canonicalTitle: computedCanonicalTitle,
      brand: params.review.brand,
      modelId: params.review.modelId,
      sku: params.review.sku,
      mpn: params.review.mpn,
      gtin: params.review.gtin,
      asin: params.review.asin,
      price: params.review.price,
      currency: params.review.currency,
      rawSnippet: params.review.rawSnippet,
      provenance: {
        reviewSource: params.reviewSource?.trim() || "deal_llm_review_apply",
        candidateType: params.candidateType,
        provider: params.provider?.trim() || undefined,
        model: params.model?.trim() || undefined,
        reasons: params.reasons?.map((reason: string) => reason.trim()).filter(Boolean),
      },
    };
    const changedFieldNames = [
      ...Object.keys(params.review),
      ...(("canonicalTitle" in params.review || typeof params.review.title !== "string") ? [] : ["canonicalTitle"]),
    ].filter((field, index, fields) => fields.indexOf(field) === index)
      .filter((field) => {
        const key = field as keyof typeof patch;
        return before?.[key as keyof NonNullable<typeof before>] !== patch[key];
      });

    if (params.dryRun !== false) {
      const previewStore = structuredClone(store);
      const previewWatch = applyWatchSnapshotPatch(previewStore, params.watchId, patch)!;
      return jsonResult({
        ok: true,
        dryRun: true,
        watchId: params.watchId,
        reviewSource: patch.provenance.reviewSource,
        changedFields: changedFieldNames,
        before,
        after: previewWatch.lastSnapshot,
      });
    }

    let updated: Awaited<ReturnType<typeof loadStore>>["watches"][number] | undefined;
    await withStore(async (lockedStore) => {
      updated = applyWatchSnapshotPatch(lockedStore, params.watchId, patch);
      await saveStore(storePath, lockedStore);
    });

    return jsonResult({
      ok: true,
      dryRun: false,
      watchId: params.watchId,
      reviewSource: patch.provenance.reviewSource,
      changedFields: changedFieldNames,
      before,
      after: updated?.lastSnapshot,
    });
  } }, { optional: true });

  api.registerTool({ name: "deal_schedule_advice", label: "Deal Hunter", description: "Recommend scan cadence by host or watch based on observed history timing.", parameters: Type.Object({
    mode: Type.Optional(Type.Union([Type.Literal("host"), Type.Literal("watch")])),
  }), execute: async (_id, params) => {
    return jsonResult(await runtime.services.reporting.getScheduleAdvice(params.mode ?? "host"));
  } }, { optional: false });
}
