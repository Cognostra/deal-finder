import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createJsonSavedViewRepository, createJsonWatchRepository } from "../core/json-repositories.js";
import { createDiscoveryService } from "../core/services/discovery-service.js";
import { createReportingService } from "../core/services/reporting-service.js";
import { createReviewService, type ReviewExecutor } from "../core/services/review-service.js";
import { createSavedViewService } from "../core/services/saved-view-service.js";
import { createScanCommitService, createScanExecutionService } from "../core/services/scan-service.js";
import { createWatchService } from "../core/services/watch-service.js";
import { runLlmReviewCandidate } from "../lib/llm-review.js";
import type { ToolContext } from "./shared.js";

export function createToolRuntimeServices(api: OpenClawPluginApi, ctx: ToolContext) {
  const watchRepository = createJsonWatchRepository(ctx);
  const savedViewRepository = createJsonSavedViewRepository(ctx);
  const reviewService = createReviewService();
  const reviewExecutor: ReviewExecutor = (candidate, args) => runLlmReviewCandidate(api, candidate, args);
  const watch = createWatchService({ watchRepository });
  const savedViews = createSavedViewService({ watchRepository, savedViewRepository });

  return {
    repositories: {
      watchRepository,
      savedViewRepository,
    },
    services: {
      discovery: createDiscoveryService(),
      reporting: createReportingService({ watchRepository, savedViewRepository }),
      review: reviewService,
      watch,
      savedViews,
      scanExecution: createScanExecutionService(reviewService),
      scanCommit: createScanCommitService(),
    },
    logger: api.logger,
    reviewExecutor,
  };
}
