import type { ImportMode, ImportedWatchInput, WatchSnapshotPatch, WatchUpdatePatch } from "../lib/store.js";
import type { SavedWatchView, StoreFile, Watch, WatchSelector } from "../types.js";

export type StoreMutation = <T>(fn: (store: StoreFile) => Promise<T>) => Promise<T>;

export type WatchBulkUpdateResult = {
  updatedIds: string[];
  missingIds: string[];
};

export type WatchImportResult = {
  added: number;
  updated: number;
  replaced: boolean;
  imported: Watch[];
  matchedById: number;
  matchedByUrl: number;
};

export interface WatchRepository {
  loadStore(): Promise<StoreFile>;
  list(): Promise<Watch[]>;
  search(selector: WatchSelector): Promise<Watch[]>;
  get(id: string): Promise<Watch | undefined>;
  add(input: Omit<Watch, "id" | "createdAt" | "enabled"> & { enabled?: boolean }): Promise<Watch>;
  update(id: string, patch: WatchUpdatePatch): Promise<Watch | undefined>;
  remove(id: string): Promise<boolean>;
  setEnabled(ids: string[], enabled: boolean): Promise<WatchBulkUpdateResult>;
  bulkUpdate(ids: string[], patch: Parameters<typeof import("../lib/store.js").bulkUpdateWatches>[2]): Promise<WatchBulkUpdateResult>;
  applySnapshotPatch(id: string, patch: WatchSnapshotPatch): Promise<Watch | undefined>;
  importWatches(
    watches: ImportedWatchInput[],
    mode: ImportMode,
    options?: Parameters<typeof import("../lib/store.js").importWatches>[3],
  ): Promise<WatchImportResult>;
  exportWatches(args: {
    watchIds?: string[];
    includeDisabled?: boolean;
    includeSnapshots?: boolean;
    includeHistory?: boolean;
  }): Promise<{ exportedAt: string; count: number; includeSnapshots: boolean; includeHistory: boolean; watches: Watch[] }>;
}

export interface SavedViewRepository {
  list(): Promise<SavedWatchView[]>;
  get(id: string): Promise<SavedWatchView | undefined>;
  create(input: { name: string; description?: string; selector?: WatchSelector }): Promise<SavedWatchView>;
  update(id: string, patch: { name?: string; description?: string | null; selector?: WatchSelector }): Promise<SavedWatchView | undefined>;
  remove(id: string): Promise<boolean>;
  resolveSelection(id: string): Promise<{
    store: StoreFile;
    savedView: SavedWatchView;
    watches: Watch[];
    watchIds: string[];
  }>;
}
