import { searchWatches } from "../../lib/watch-view.js";
import type { SavedViewRepository, WatchRepository } from "../repositories.js";

function toSavedViewSummary(
  store: Awaited<ReturnType<WatchRepository["loadStore"]>>,
  view: Awaited<ReturnType<SavedViewRepository["list"]>>[number],
) {
  const matches = searchWatches(store.watches, view.selector);
  return {
    ...view,
    matchCount: matches.length,
    previewWatchIds: matches.map((watch) => watch.id).slice(0, 20),
  };
}

export function createSavedViewService(args: {
  watchRepository: WatchRepository;
  savedViewRepository: SavedViewRepository;
}) {
  const { watchRepository, savedViewRepository } = args;

  return {
    async list() {
      const store = await watchRepository.loadStore();
      const savedViews = await savedViewRepository.list();
      return savedViews.map((view) => toSavedViewSummary(store, view));
    },
    async create(input: Parameters<SavedViewRepository["create"]>[0]) {
      const existing = await savedViewRepository.list();
      if (existing.some((view) => view.name.toLowerCase() === input.name.trim().toLowerCase())) {
        throw new Error(`deal-hunter: a saved view named "${input.name}" already exists`);
      }
      const created = await savedViewRepository.create(input);
      const store = await watchRepository.loadStore();
      return toSavedViewSummary(store, created);
    },
    async run(id: string) {
      const selection = await savedViewRepository.resolveSelection(id);
      return {
        savedView: toSavedViewSummary(selection.store, selection.savedView),
        watches: selection.watches,
        watchIds: selection.watchIds,
      };
    },
    async update(id: string, patch: Parameters<SavedViewRepository["update"]>[1]) {
      if (patch.name) {
        const existing = await savedViewRepository.list();
        if (existing.some((view) => view.id !== id && view.name.toLowerCase() === patch.name!.trim().toLowerCase())) {
          throw new Error(`deal-hunter: a saved view named "${patch.name}" already exists`);
        }
      }
      const updated = await savedViewRepository.update(id, patch);
      if (!updated) {
        throw new Error(`deal-hunter: unknown saved view "${id}"`);
      }
      const store = await watchRepository.loadStore();
      return toSavedViewSummary(store, updated);
    },
    async remove(id: string) {
      const removed = await savedViewRepository.remove(id);
      if (!removed) {
        throw new Error(`deal-hunter: unknown saved view "${id}"`);
      }
      return removed;
    },
  };
}
