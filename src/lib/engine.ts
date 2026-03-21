import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { ResolvedDealConfig } from "../config.js";
import type { ScanResultItem, StoreFile, Watch } from "../types.js";
import { mapPool } from "./concurrency.js";
import { commitScanResults, mergeCommittedScanResults, type ScanCommitSummary } from "./engine-commit.js";
import { buildInvalidWatchResult, scanOneWatch } from "./engine-scan.js";
import { PerHostRateLimiter } from "./host-limiter.js";
import { applyScanReviewPolicy } from "./review-policy.js";
import { saveStore } from "./store.js";
import { validateTargetUrl } from "./url-policy.js";
export { mergeCommittedScanResults };
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
  let list = store.watches.filter((w) => w.enabled);
  if (watchIds?.length) {
    const set = new Set(watchIds);
    list = list.filter((w) => set.has(w.id));
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

  api.logger.debug?.(
    `deal-hunter: scan start engine=node fetcher=${cfg.fetcher} count=${safeList.length} invalid=${invalidResults.length}`,
  );

  const intervalMs = Math.ceil(1000 / Math.max(0.1, cfg.defaultMaxRpsPerHost));
  const limiter = new PerHostRateLimiter(intervalMs);

  const scanResults = await mapPool(safeList, cfg.maxConcurrent, (w) =>
    scanOneWatch(w, cfg, limiter, args.signal),
  );
  const rawResults = invalidResults.concat(scanResults);
  const results = await applyScanReviewPolicy({
    api,
    cfg,
    list: safeList,
    results: rawResults,
  });

  if (commit) {
    await commitScanResults(store, results);
    await saveStore(storePath, store);
  }

  api.logger.debug?.(
    `deal-hunter: scan complete commit=${commit} count=${results.length} engine=node`,
  );

  return results;
}
