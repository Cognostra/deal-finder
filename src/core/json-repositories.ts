import {
  addSavedView,
  addWatch,
  applyWatchSnapshotPatch,
  bulkUpdateWatches,
  getSavedView,
  getWatch,
  importWatches,
  listSavedViews,
  loadStore,
  removeSavedView,
  removeWatch,
  saveStore,
  setWatchEnabled,
  updateSavedView,
  updateWatch,
} from "../lib/store.js";
import { searchWatches } from "../lib/watch-view.js";
import type { WatchImportResult, WatchRepository, SavedViewRepository, StoreMutation, WatchBulkUpdateResult } from "./repositories.js";

export function createJsonWatchRepository(args: {
  storePath: string;
  withStore: StoreMutation;
}): WatchRepository {
  const { storePath, withStore } = args;

  return {
    loadStore: () => loadStore(storePath),
    async list() {
      const store = await loadStore(storePath);
      return store.watches;
    },
    async search(selector) {
      const store = await loadStore(storePath);
      return searchWatches(store.watches, selector);
    },
    async get(id) {
      const store = await loadStore(storePath);
      return getWatch(store, id);
    },
    async add(input) {
      let added = null;
      await withStore(async (store) => {
        added = addWatch(store, input);
        await saveStore(storePath, store);
      });
      return added!;
    },
    async update(id, patch) {
      let updated;
      await withStore(async (store) => {
        updated = updateWatch(store, id, patch);
        if (updated) await saveStore(storePath, store);
      });
      return updated;
    },
    async remove(id) {
      let removed = false;
      await withStore(async (store) => {
        removed = removeWatch(store, id);
        if (removed) await saveStore(storePath, store);
      });
      return removed;
    },
    async setEnabled(ids, enabled) {
      let result: WatchBulkUpdateResult = { updatedIds: [], missingIds: [] };
      await withStore(async (store) => {
        result = setWatchEnabled(store, ids, enabled);
        if (result.updatedIds.length > 0) await saveStore(storePath, store);
      });
      return result;
    },
    async bulkUpdate(ids, patch) {
      let result: WatchBulkUpdateResult = { updatedIds: [], missingIds: [] };
      await withStore(async (store) => {
        result = bulkUpdateWatches(store, ids, patch);
        if (result.updatedIds.length > 0) await saveStore(storePath, store);
      });
      return result;
    },
    async applySnapshotPatch(id, patch) {
      let updated;
      await withStore(async (store) => {
        updated = applyWatchSnapshotPatch(store, id, patch);
        if (updated) await saveStore(storePath, store);
      });
      return updated;
    },
    async importWatches(watches, mode, options) {
      let result: WatchImportResult = {
        added: 0,
        updated: 0,
        replaced: false,
        imported: [],
        matchedById: 0,
        matchedByUrl: 0,
      };
      await withStore(async (store) => {
        result = importWatches(store, watches, mode, options);
        await saveStore(storePath, store);
      });
      return result;
    },
    async exportWatches(args) {
      const store = await loadStore(storePath);
      const allowedIds = args.watchIds?.length ? new Set(args.watchIds) : null;
      const includeDisabled = args.includeDisabled === true;
      const includeSnapshots = args.includeSnapshots !== false;
      const includeHistory = args.includeHistory !== false;
      const watches = store.watches
        .filter((watch) => (includeDisabled ? true : watch.enabled))
        .filter((watch) => (allowedIds ? allowedIds.has(watch.id) : true))
        .map((watch) => {
          const exported = structuredClone(watch);
          if (!includeSnapshots) exported.lastSnapshot = undefined;
          if (!includeHistory) exported.history = undefined;
          return exported;
        });

      return {
        exportedAt: new Date().toISOString(),
        count: watches.length,
        includeSnapshots,
        includeHistory,
        watches,
      };
    },
  };
}

export function createJsonSavedViewRepository(args: {
  storePath: string;
  withStore: StoreMutation;
}): SavedViewRepository {
  const { storePath, withStore } = args;

  return {
    async list() {
      const store = await loadStore(storePath);
      return listSavedViews(store);
    },
    async get(id) {
      const store = await loadStore(storePath);
      return getSavedView(store, id);
    },
    async create(input) {
      let created = null;
      await withStore(async (store) => {
        created = addSavedView(store, input);
        await saveStore(storePath, store);
      });
      return created!;
    },
    async update(id, patch) {
      let updated;
      await withStore(async (store) => {
        updated = updateSavedView(store, id, patch);
        if (updated) await saveStore(storePath, store);
      });
      return updated;
    },
    async remove(id) {
      let removed = false;
      await withStore(async (store) => {
        removed = removeSavedView(store, id);
        if (removed) await saveStore(storePath, store);
      });
      return removed;
    },
    async resolveSelection(id) {
      const store = await loadStore(storePath);
      const savedView = getSavedView(store, id);
      if (!savedView) {
        throw new Error(`deal-hunter: unknown saved view "${id}"`);
      }
      const watches = searchWatches(store.watches, savedView.selector);
      return {
        store,
        savedView,
        watches,
        watchIds: watches.map((watch) => watch.id),
      };
    },
  };
}
