import type { ResolvedDealConfig } from "../config.js";
import type { ScanResultItem, StoreFile } from "../types.js";
import { appendWatchHistory } from "./store.js";
import { validateTargetUrl } from "./url-policy.js";

function applyCommit(store: StoreFile, results: ScanResultItem[]) {
  for (const r of results) {
    if (!r.ok || !r.after) continue;
    const w = store.watches.find((x) => x.id === r.watchId);
    if (w) {
      appendWatchHistory(w, r);
      w.lastSnapshot = r.after;
    }
  }
}

export type ScanCommitSummary = {
  updated: number;
  skippedMissing: number;
  skippedUrlChanged: number;
  skippedInvalidCurrentUrl: number;
};

export function mergeCommittedScanResults(
  store: StoreFile,
  results: ScanResultItem[],
  cfg: ResolvedDealConfig,
): ScanCommitSummary {
  let updated = 0;
  let skippedMissing = 0;
  let skippedUrlChanged = 0;
  let skippedInvalidCurrentUrl = 0;

  for (const result of results) {
    if (!result.ok || !result.after) continue;

    const currentWatch = store.watches.find((watch) => watch.id === result.watchId);
    if (!currentWatch) {
      skippedMissing += 1;
      continue;
    }

    let currentUrl: string;
    try {
      currentUrl = validateTargetUrl(currentWatch.url, cfg).toString();
    } catch {
      skippedInvalidCurrentUrl += 1;
      continue;
    }

    if (currentUrl !== result.url) {
      skippedUrlChanged += 1;
      continue;
    }

    appendWatchHistory(currentWatch, result);
    currentWatch.lastSnapshot = result.after;
    updated += 1;
  }

  return {
    updated,
    skippedMissing,
    skippedUrlChanged,
    skippedInvalidCurrentUrl,
  };
}

export async function commitScanResults(store: StoreFile, results: ScanResultItem[]) {
  applyCommit(store, results);
}
