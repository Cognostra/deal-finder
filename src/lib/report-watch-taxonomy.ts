import type { StoreFile, Watch } from "../types.js";
import { buildWatchSignals } from "./watch-view.js";

function buildDetailedGroupBreakdown(
  watches: Watch[],
  limit: number,
): Array<{ group: string; count: number; activeSignals: number; watchIds: string[] }> {
  const counts = new Map<string, { count: number; activeSignals: number; watchIds: string[] }>();
  for (const watch of watches) {
    const key = watch.group?.trim() || "(ungrouped)";
    const entry = counts.get(key) ?? { count: 0, activeSignals: 0, watchIds: [] };
    entry.count += 1;
    entry.activeSignals += buildWatchSignals(watch).length > 0 ? 1 : 0;
    entry.watchIds.push(watch.id);
    counts.set(key, entry);
  }
  return [...counts.entries()]
    .map(([group, value]) => ({
      group,
      count: value.count,
      activeSignals: value.activeSignals,
      watchIds: value.watchIds.sort(),
    }))
    .sort((a, b) => b.count - a.count || b.activeSignals - a.activeSignals || a.group.localeCompare(b.group))
    .slice(0, limit);
}

function buildDetailedTagBreakdown(
  watches: Watch[],
  limit: number,
): Array<{ tag: string; count: number; activeSignals: number; watchIds: string[] }> {
  const counts = new Map<string, { count: number; activeSignals: number; watchIds: string[] }>();
  for (const watch of watches) {
    const tags = watch.tags ?? [];
    for (const tag of tags) {
      const entry = counts.get(tag) ?? { count: 0, activeSignals: 0, watchIds: [] };
      entry.count += 1;
      entry.activeSignals += buildWatchSignals(watch).length > 0 ? 1 : 0;
      entry.watchIds.push(watch.id);
      counts.set(tag, entry);
    }
  }
  return [...counts.entries()]
    .map(([tag, value]) => ({
      tag,
      count: value.count,
      activeSignals: value.activeSignals,
      watchIds: value.watchIds.sort(),
    }))
    .sort((a, b) => b.count - a.count || b.activeSignals - a.activeSignals || a.tag.localeCompare(b.tag))
    .slice(0, limit);
}

function ungroupedCount(watches: Watch[]): number {
  return watches.filter((watch) => !watch.group?.trim()).length;
}

export function buildTaxonomySummary(
  store: StoreFile,
  limit = 10,
): {
  watchCount: number;
  groupedCount: number;
  ungroupedCount: number;
  taggedCount: number;
  untaggedCount: number;
  groupBreakdown: Array<{ group: string; count: number; activeSignals: number; watchIds: string[] }>;
  tagBreakdown: Array<{ tag: string; count: number; activeSignals: number; watchIds: string[] }>;
  suggestedSavedViews: Array<{
    name: string;
    description: string;
    selector: {
      group?: string;
      tag?: string;
      hasSignals?: boolean;
      enabled?: boolean;
    };
    reason: string;
  }>;
  actionSummary: string[];
} {
  const groupedCount = store.watches.filter((watch) => Boolean(watch.group?.trim())).length;
  const taggedCount = store.watches.filter((watch) => Boolean(watch.tags?.length)).length;
  const groupBreakdown = buildDetailedGroupBreakdown(store.watches, limit);
  const tagBreakdown = buildDetailedTagBreakdown(store.watches, limit);
  const existingViewNames = new Set(store.savedViews.map((view) => view.name.toLowerCase()));
  const existingSelectorKeys = new Set(
    store.savedViews.map((view) => JSON.stringify(view.selector ?? {})),
  );
  const suggestedSavedViews: Array<{
    name: string;
    description: string;
    selector: {
      group?: string;
      tag?: string;
      hasSignals?: boolean;
      enabled?: boolean;
    };
    reason: string;
  }> = [];

  for (const group of groupBreakdown) {
    if (group.group === "(ungrouped)" || group.count < 2) continue;
    suggestedSavedViews.push({
      name: `${group.group} watchlist`,
      description: `Watches grouped under ${group.group}.`,
      selector: { group: group.group },
      reason: `${group.count} watches already share the ${group.group} group.`,
    });
    if (group.activeSignals > 0) {
      suggestedSavedViews.push({
        name: `${group.group} active signals`,
        description: `Signal-heavy watches in the ${group.group} group.`,
        selector: { group: group.group, hasSignals: true, enabled: true },
        reason: `${group.activeSignals} watches in ${group.group} currently have active signals.`,
      });
    }
  }

  for (const tag of tagBreakdown) {
    if (tag.count < 2) continue;
    suggestedSavedViews.push({
      name: `${tag.tag} tag view`,
      description: `Watches carrying the ${tag.tag} tag.`,
      selector: { tag: tag.tag },
      reason: `${tag.count} watches already share the ${tag.tag} tag.`,
    });
  }

  const dedupedSuggestedViews = suggestedSavedViews
    .filter((view, index, views) => {
      if (existingViewNames.has(view.name.toLowerCase())) return false;
      if (existingSelectorKeys.has(JSON.stringify(view.selector))) return false;
      return views.findIndex((candidate) => candidate.name === view.name) === index;
    })
    .slice(0, limit);

  const actionSummary: string[] = [];
  if (ungroupedCount(store.watches) > 0) {
    actionSummary.push(
      `${ungroupedCount(store.watches)} watch${ungroupedCount(store.watches) === 1 ? "" : "es"} are still ungrouped and may benefit from deal_watch_tag or deal_view_bulk_update.`,
    );
  }
  if (store.watches.length - taggedCount > 0) {
    const untaggedCount = store.watches.length - taggedCount;
    actionSummary.push(
      `${untaggedCount} watch${untaggedCount === 1 ? "" : "es"} still have no tags, which limits saved-view reuse.`,
    );
  }
  if (groupBreakdown[0] && groupBreakdown[0].group !== "(ungrouped)") {
    actionSummary.push(`Largest current group: ${groupBreakdown[0].group} (${groupBreakdown[0].count} watches).`);
  }
  if (tagBreakdown[0]) {
    actionSummary.push(`Most common tag: ${tagBreakdown[0].tag} (${tagBreakdown[0].count} watches).`);
  }

  return {
    watchCount: store.watches.length,
    groupedCount,
    ungroupedCount: store.watches.length - groupedCount,
    taggedCount,
    untaggedCount: store.watches.length - taggedCount,
    groupBreakdown,
    tagBreakdown,
    suggestedSavedViews: dedupedSuggestedViews,
    actionSummary,
  };
}
