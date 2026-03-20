import type { Watch } from "../types.js";

export type WatchSearchOptions = {
  query?: string;
  enabled?: boolean;
  hasSnapshot?: boolean;
  hasSignals?: boolean;
  sortBy?: "createdAt" | "label" | "price";
  descending?: boolean;
  limit?: number;
};

export function buildWatchSignals(watch: Watch): string[] {
  const signals: string[] = [];
  const snapshot = watch.lastSnapshot;
  if (!snapshot) return signals;

  if (watch.maxPrice != null && snapshot.price != null && snapshot.price <= watch.maxPrice) {
    signals.push(`max_price_hit:${snapshot.price}`);
  }

  if (watch.keywords?.length) {
    const blob = `${snapshot.title ?? ""} ${snapshot.rawSnippet ?? ""}`.toLowerCase();
    for (const keyword of watch.keywords) {
      if (keyword && blob.includes(keyword.toLowerCase())) {
        signals.push(`keyword:${keyword}`);
      }
    }
  }

  return signals;
}

export function searchWatches(watches: Watch[], options: WatchSearchOptions): Watch[] {
  const query = options.query?.trim().toLowerCase();
  const sortBy = options.sortBy ?? "createdAt";
  const descending = options.descending ?? true;

  const filtered = watches.filter((watch) => {
    if (options.enabled != null && watch.enabled !== options.enabled) return false;
    if (options.hasSnapshot != null && Boolean(watch.lastSnapshot) !== options.hasSnapshot) return false;

    const signals = buildWatchSignals(watch);
    if (options.hasSignals != null && Boolean(signals.length) !== options.hasSignals) return false;

    if (!query) return true;

    const haystacks = [
      watch.id,
      watch.url,
      watch.label ?? "",
      watch.lastSnapshot?.title ?? "",
      watch.lastSnapshot?.canonicalTitle ?? "",
      ...(watch.keywords ?? []),
    ];
    return haystacks.some((value) => value.toLowerCase().includes(query));
  });

  filtered.sort((a, b) => {
    let comparison = 0;
    if (sortBy === "label") {
      comparison = (a.label ?? a.url).localeCompare(b.label ?? b.url);
    } else if (sortBy === "price") {
      comparison = (a.lastSnapshot?.price ?? Number.POSITIVE_INFINITY) - (b.lastSnapshot?.price ?? Number.POSITIVE_INFINITY);
    } else {
      comparison = a.createdAt.localeCompare(b.createdAt);
    }
    return descending ? -comparison : comparison;
  });

  return options.limit ? filtered.slice(0, options.limit) : filtered;
}
