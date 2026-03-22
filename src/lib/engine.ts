import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { ResolvedDealConfig } from "../config.js";
import type { ScanResultItem, StoreFile } from "../types.js";
import { createReviewService } from "../core/services/review-service.js";
import { createScanCommitService, createScanExecutionService, type ScanCommitSummary } from "../core/services/scan-service.js";
import { runLlmReviewCandidate } from "./llm-review.js";
import { saveStore } from "./store.js";
const reviewService = createReviewService();
const scanExecutionService = createScanExecutionService(reviewService);
const scanCommitService = createScanCommitService();

export const mergeCommittedScanResults = scanCommitService.merge;
export type { ScanCommitSummary };

export async function runScan(args: {
  api: OpenClawPluginApi;
  cfg: ResolvedDealConfig;
  store: StoreFile;
  storePath: string;
  watchIds?: string[];
  commit: boolean;
  signal?: AbortSignal;
}): Promise<ScanResultItem[]> {
  const { cfg, store, storePath, watchIds, commit, api } = args;
  const results = await scanExecutionService.run({
    cfg,
    store,
    watchIds,
    signal: args.signal,
    logger: api.logger,
    reviewExecutor: (candidate, executionArgs) => runLlmReviewCandidate(api, candidate, executionArgs),
  });

  if (commit) {
    await scanCommitService.commit(store, results);
    await saveStore(storePath, store);
  }

  return results;
}
