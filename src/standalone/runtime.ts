import { createJsonStoreMaintenancePort } from "../core/json-maintenance.js";
import { createJsonSavedViewRepository, createJsonWatchRepository } from "../core/json-repositories.js";
import { createDiscoveryService } from "../core/services/discovery-service.js";
import { createReportingService } from "../core/services/reporting-service.js";
import { createReviewService } from "../core/services/review-service.js";
import { createSavedViewService } from "../core/services/saved-view-service.js";
import { createScanCommitService, createScanExecutionService } from "../core/services/scan-service.js";
import { createWatchService } from "../core/services/watch-service.js";
import { loadStore } from "../lib/store.js";
import type { StoreFile } from "../types.js";
import type { ResolvedStandaloneConfig } from "./config.js";

export function createStandaloneRuntime(config: ResolvedStandaloneConfig) {
  const storePath = config.deal.storePath;
  const withStore = async <T>(fn: (store: StoreFile) => Promise<T>) => {
    const store = await loadStore(storePath);
    return fn(store);
  };

  const watchRepository = createJsonWatchRepository({ storePath, withStore });
  const savedViewRepository = createJsonSavedViewRepository({ storePath, withStore });
  const review = createReviewService();

  return {
    repositories: {
      watchRepository,
      savedViewRepository,
    },
    maintenance: createJsonStoreMaintenancePort({ storePath }),
    services: {
      watch: createWatchService({ watchRepository }),
      savedViews: createSavedViewService({ watchRepository, savedViewRepository }),
      reporting: createReportingService({ watchRepository, savedViewRepository }),
      discovery: createDiscoveryService(),
      review,
      scanExecution: createScanExecutionService(review),
      scanCommit: createScanCommitService(),
    },
  };
}
