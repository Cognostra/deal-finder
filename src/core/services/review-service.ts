import type { ResolvedDealConfig } from "../../config.js";
import type { LlmReviewCandidate, LlmReviewCandidateType, ScanResultItem, Watch, WatchSnapshot } from "../../types.js";
import { applyReviewJsonToSnapshot, buildScanReviewCandidate, describeReviewPolicy } from "../../lib/review-policy.js";

export type ReviewExecutor = (candidate: LlmReviewCandidate, args: {
  provider?: string;
  model?: string;
  timeoutMs?: number;
}) => Promise<{ provider?: string; model?: string; json: unknown; rawText: string }>;

export interface ReviewService {
  describePolicy(cfg: ResolvedDealConfig): ReturnType<typeof describeReviewPolicy>;
  buildScanCandidate(watch: Watch, result: ScanResultItem, cfg: ResolvedDealConfig): LlmReviewCandidate | null;
  applyReview(
    snapshot: WatchSnapshot,
    reviewJson: unknown,
    execution: {
      reviewSource: string;
      reviewedAt?: string;
      candidateType: LlmReviewCandidateType;
      provider?: string;
      model?: string;
    },
    cfg: ResolvedDealConfig,
  ): ReturnType<typeof applyReviewJsonToSnapshot>;
}

export function createReviewService(): ReviewService {
  return {
    describePolicy: describeReviewPolicy,
    buildScanCandidate: buildScanReviewCandidate,
    applyReview: applyReviewJsonToSnapshot,
  };
}
