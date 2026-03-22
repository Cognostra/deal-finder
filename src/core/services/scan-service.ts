import type { ResolvedDealConfig } from "../../config.js";
import type { ScanResultItem, StoreFile, Watch } from "../../types.js";
import { mapPool } from "../../lib/concurrency.js";
import { buildInvalidWatchResult, scanOneWatch } from "../../lib/engine-scan.js";
import { commitScanResults, mergeCommittedScanResults, type ScanCommitSummary } from "../../lib/engine-commit.js";
import { PerHostRateLimiter } from "../../lib/host-limiter.js";
import { validateTargetUrl } from "../../lib/url-policy.js";
import type { ReviewExecutor, ReviewService } from "./review-service.js";

export type { ScanCommitSummary };

export interface ScanExecutionService {
  run(args: {
    cfg: ResolvedDealConfig;
    store: StoreFile;
    watchIds?: string[];
    signal?: AbortSignal;
    logger?: { debug?: (message: string) => void };
    reviewExecutor?: ReviewExecutor;
  }): Promise<ScanResultItem[]>;
}

export interface ScanCommitService {
  commit(store: StoreFile, results: ScanResultItem[]): Promise<void>;
  merge(store: StoreFile, results: ScanResultItem[], cfg: ResolvedDealConfig): ScanCommitSummary;
}

async function applyReviewPolicy(args: {
  cfg: ResolvedDealConfig;
  list: Watch[];
  results: ScanResultItem[];
  reviewService: ReviewService;
  reviewExecutor?: ReviewExecutor;
}): Promise<ScanResultItem[]> {
  const { cfg, list, results, reviewService, reviewExecutor } = args;
  const budget = { maxReviews: cfg.llmReview.maxReviewsPerScan, usedReviews: 0 };
  const byId = new Map(list.map((watch) => [watch.id, watch]));
  const reviewedResults: ScanResultItem[] = [];

  for (const result of results) {
    const base: ScanResultItem = {
      ...result,
      reviewMode: cfg.llmReview.mode,
      reviewQueued: false,
      reviewApplied: false,
      reviewWarnings: [...(result.reviewWarnings ?? [])],
      reviewedFields: [...(result.reviewedFields ?? [])],
    };
    const watch = byId.get(result.watchId);
    const candidate = watch ? reviewService.buildScanCandidate(watch, result, cfg) : null;
    if (!candidate) {
      reviewedResults.push(base);
      continue;
    }

    base.reviewQueued = true;
    base.reviewCandidateType = candidate.type;

    if (cfg.llmReview.mode !== "auto_assist") {
      reviewedResults.push(base);
      continue;
    }
    if (!reviewExecutor) {
      reviewedResults.push({
        ...base,
        reviewWarnings: [...base.reviewWarnings, "Automatic review was requested but no review executor is configured."],
      });
      continue;
    }
    if (budget.usedReviews >= budget.maxReviews) {
      reviewedResults.push({
        ...base,
        reviewWarnings: [
          ...base.reviewWarnings,
          `Skipped automatic review because the per-scan review budget of ${budget.maxReviews} was exhausted.`,
        ],
      });
      continue;
    }
    if (!base.after) {
      reviewedResults.push(base);
      continue;
    }

    try {
      const execution = await reviewExecutor(candidate, {
        provider: cfg.llmReview.provider,
        model: cfg.llmReview.model,
        timeoutMs: cfg.llmReview.timeoutMs,
      });
      const applied = reviewService.applyReview(
        base.after,
        execution.json,
        {
          reviewSource: "deal_scan_auto_assist",
          candidateType: candidate.type,
          provider: execution.provider,
          model: execution.model,
        },
        cfg,
      );
      budget.usedReviews += 1;
      reviewedResults.push({
        ...base,
        after: applied.snapshot,
        reviewApplied: applied.reviewedFields.length > 0,
        reviewedFields: applied.reviewedFields,
        reviewWarnings: [...base.reviewWarnings, ...applied.warnings],
        reviewProvider: execution.provider,
        reviewModel: execution.model,
      });
    } catch (error) {
      reviewedResults.push({
        ...base,
        reviewWarnings: [...base.reviewWarnings, `Automatic review failed: ${error instanceof Error ? error.message : String(error)}`],
      });
    }
  }

  return reviewedResults;
}

export function createScanExecutionService(reviewService: ReviewService): ScanExecutionService {
  return {
    async run(args) {
      const { cfg, store, watchIds, signal, logger, reviewExecutor } = args;
      let list = store.watches.filter((watch) => watch.enabled);
      if (watchIds?.length) {
        const set = new Set(watchIds);
        list = list.filter((watch) => set.has(watch.id));
      }

      const invalidResults: ScanResultItem[] = [];
      const safeList: Watch[] = [];
      for (const watch of list) {
        try {
          const safeUrl = validateTargetUrl(watch.url, cfg).toString();
          safeList.push({ ...watch, url: safeUrl });
        } catch (error) {
          invalidResults.push(buildInvalidWatchResult(watch, error));
        }
      }

      logger?.debug?.(`deal-hunter: scan start engine=node fetcher=${cfg.fetcher} count=${safeList.length} invalid=${invalidResults.length}`);

      const intervalMs = Math.ceil(1000 / Math.max(0.1, cfg.defaultMaxRpsPerHost));
      const limiter = new PerHostRateLimiter(intervalMs);
      const scanResults = await mapPool(safeList, cfg.maxConcurrent, (watch) =>
        scanOneWatch(watch, cfg, limiter, signal),
      );

      const results = await applyReviewPolicy({
        cfg,
        list: safeList,
        results: invalidResults.concat(scanResults),
        reviewService,
        reviewExecutor,
      });

      logger?.debug?.(`deal-hunter: scan complete commit=false count=${results.length} engine=node`);
      return results;
    },
  };
}

export function createScanCommitService(): ScanCommitService {
  return {
    commit: commitScanResults,
    merge: mergeCommittedScanResults,
  };
}
