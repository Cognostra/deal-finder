import type { ProductIdentityEntry, StoreFile } from "../types.js";
import { buildProductGroups } from "./product-identity.js";

export function buildProductGroupsSummary(
  store: StoreFile,
  options?: { includeLooseTitleFallback?: boolean; limit?: number; minMatchScore?: number },
): {
  groupCount: number;
  groupedWatchCount: number;
  ungroupedSnapshotCount: number;
  groups: Array<{
    groupId: string;
    title?: string;
    canonicalTitle?: string;
    watchCount: number;
    bestPrice?: number;
    highestPrice?: number;
    spread?: {
      absolute: number;
      percentFromBest: number;
    };
    bestWatchId?: string;
    matchBasis: string[];
    identifiers: Array<ProductIdentityEntry & { count: number }>;
    members: Array<{
      watchId: string;
      label?: string;
      url: string;
      host: string;
      latestPrice?: number;
      currency?: string;
      enabled: boolean;
      sharedIdentityCount: number;
    }>;
  }>;
} {
  const groups = buildProductGroups(store, options).slice(0, options?.limit ?? 20);
  const groupedWatchIds = new Set(groups.flatMap((group) => group.members.map((member) => member.watchId)));
  const snapshotCount = store.watches.filter((watch) => Boolean(watch.lastSnapshot)).length;
  return {
    groupCount: groups.length,
    groupedWatchCount: groupedWatchIds.size,
    ungroupedSnapshotCount: Math.max(0, snapshotCount - groupedWatchIds.size),
    groups,
  };
}

export function buildBestPriceBoard(
  store: StoreFile,
  options?: { includeLooseTitleFallback?: boolean; limit?: number; minMatchScore?: number },
): {
  groupCount: number;
  opportunities: Array<{
    groupId: string;
    title?: string;
    watchCount: number;
    bestWatchId?: string;
    bestWatchLabel?: string;
    bestHost?: string;
    bestPrice?: number;
    highestPrice?: number;
    spread?: {
      absolute: number;
      percentFromBest: number;
    };
    alternateCount: number;
    alternates: Array<{
      watchId: string;
      label?: string;
      host: string;
      latestPrice?: number;
    }>;
    reasons: string[];
  }>;
} {
  const groups = buildProductGroups(store, options);
  const opportunities = groups
    .filter((group) => group.spread && group.bestPrice != null && group.bestWatchId)
    .map((group) => {
      const bestWatch = group.members.find((member) => member.watchId === group.bestWatchId);
      const alternates = group.members.filter((member) => member.watchId !== group.bestWatchId).slice(0, 5);
      return {
        groupId: group.groupId,
        title: group.title,
        watchCount: group.watchCount,
        bestWatchId: group.bestWatchId,
        bestWatchLabel: bestWatch?.label,
        bestHost: bestWatch?.host,
        bestPrice: group.bestPrice,
        highestPrice: group.highestPrice,
        spread: group.spread,
        alternateCount: Math.max(0, group.members.length - 1),
        alternates: alternates.map((alternate) => ({
          watchId: alternate.watchId,
          label: alternate.label,
          host: alternate.host,
          latestPrice: alternate.latestPrice,
        })),
        reasons: [
          ...(group.matchBasis.length ? [`Grouped by ${group.matchBasis.join(", ")}.`] : []),
          ...(group.spread
            ? [`Internal same-product spread is ${group.spread.absolute.toFixed(2)} (${group.spread.percentFromBest.toFixed(1)}%).`]
            : []),
        ],
      };
    })
    .sort(
      (a, b) =>
        (b.spread?.percentFromBest ?? 0) - (a.spread?.percentFromBest ?? 0) ||
        b.watchCount - a.watchCount ||
        (a.title ?? a.groupId).localeCompare(b.title ?? b.groupId),
    )
    .slice(0, options?.limit ?? 20);

  return {
    groupCount: groups.length,
    opportunities,
  };
}
