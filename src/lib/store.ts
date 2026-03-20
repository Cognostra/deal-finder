import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { ScanResultItem, StoreFile, Watch, WatchHistoryEntry } from "../types.js";

const MAX_HISTORY_ENTRIES = 60;

export async function loadStore(path: string): Promise<StoreFile> {
  try {
    const raw = await readFile(path, "utf8");
    const data = JSON.parse(raw) as StoreFile;
    if (!data || data.version !== 1 || !Array.isArray(data.watches)) {
      return { version: 1, watches: [] };
    }
    return data;
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return { version: 1, watches: [] };
    throw e;
  }
}

export async function saveStore(path: string, data: StoreFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

export function addWatch(store: StoreFile, partial: Omit<Watch, "id" | "createdAt" | "enabled"> & { enabled?: boolean }): Watch {
  const watch: Watch = {
    id: randomUUID(),
    url: partial.url,
    label: partial.label,
    maxPrice: partial.maxPrice,
    percentDrop: partial.percentDrop,
    keywords: partial.keywords,
    checkIntervalHint: partial.checkIntervalHint,
    enabled: partial.enabled ?? true,
    createdAt: new Date().toISOString(),
    lastSnapshot: partial.lastSnapshot,
  };
  store.watches.push(watch);
  return watch;
}

export type ImportedWatchInput = {
  id?: string;
  url: string;
  label?: string;
  maxPrice?: number;
  percentDrop?: number;
  keywords?: string[];
  checkIntervalHint?: string;
  enabled?: boolean;
  createdAt?: string;
  lastSnapshot?: Watch["lastSnapshot"];
  history?: WatchHistoryEntry[];
};

export type ImportMode = "append" | "upsert" | "replace";

function cloneWatchSnapshot(snapshot: Watch["lastSnapshot"] | undefined): Watch["lastSnapshot"] {
  return snapshot ? { ...snapshot } : undefined;
}

function cloneHistory(history: WatchHistoryEntry[] | undefined): WatchHistoryEntry[] | undefined {
  return history?.map((entry) => ({
    ...entry,
    alerts: entry.alerts ? [...entry.alerts] : undefined,
  }));
}

function materializeImportedWatch(input: ImportedWatchInput, options?: { preserveId?: boolean }): Watch {
  return {
    id: options?.preserveId && input.id ? input.id : randomUUID(),
    url: input.url,
    label: input.label,
    maxPrice: input.maxPrice,
    percentDrop: input.percentDrop,
    keywords: input.keywords ? [...input.keywords] : undefined,
    checkIntervalHint: input.checkIntervalHint,
    enabled: input.enabled ?? true,
    createdAt: input.createdAt ?? new Date().toISOString(),
    lastSnapshot: cloneWatchSnapshot(input.lastSnapshot),
    history: cloneHistory(input.history),
  };
}

export function removeWatch(store: StoreFile, id: string): boolean {
  const i = store.watches.findIndex((w) => w.id === id);
  if (i === -1) return false;
  store.watches.splice(i, 1);
  return true;
}

export function getWatch(store: StoreFile, id: string): Watch | undefined {
  return store.watches.find((w) => w.id === id);
}

function toHistoryEntry(result: ScanResultItem): WatchHistoryEntry | undefined {
  if (!result.ok || !result.after || result.changeType === "not_modified") {
    return undefined;
  }

  return {
    fetchedAt: result.after.fetchedAt,
    price: result.after.price,
    currency: result.after.currency,
    title: result.after.title,
    canonicalTitle: result.after.canonicalTitle,
    contentHash: result.after.contentHash,
    changeType: result.changeType,
    alertSeverity: result.alertSeverity,
    alerts: result.alerts.slice(0, 10),
    summaryLine: result.summaryLine,
  };
}

function sameHistoryState(a: WatchHistoryEntry, b: WatchHistoryEntry): boolean {
  return (
    a.price === b.price &&
    a.currency === b.currency &&
    a.canonicalTitle === b.canonicalTitle &&
    a.contentHash === b.contentHash
  );
}

export function appendWatchHistory(watch: Watch, result: ScanResultItem): boolean {
  const entry = toHistoryEntry(result);
  if (!entry) return false;

  const history = watch.history ?? [];
  const lastEntry = history[history.length - 1];
  if (lastEntry && sameHistoryState(lastEntry, entry)) {
    return false;
  }

  watch.history = history.concat(entry).slice(-MAX_HISTORY_ENTRIES);
  return true;
}

export type WatchUpdatePatch = {
  url?: string;
  label?: string | null;
  maxPrice?: number | null;
  percentDrop?: number | null;
  keywords?: string[] | null;
  checkIntervalHint?: string | null;
  enabled?: boolean;
  clearLastSnapshot?: boolean;
};

export function updateWatch(store: StoreFile, id: string, patch: WatchUpdatePatch): Watch | undefined {
  const watch = getWatch(store, id);
  if (!watch) return undefined;

  if ("url" in patch && patch.url != null) watch.url = patch.url;
  if ("label" in patch) watch.label = patch.label ?? undefined;
  if ("maxPrice" in patch) watch.maxPrice = patch.maxPrice ?? undefined;
  if ("percentDrop" in patch) watch.percentDrop = patch.percentDrop ?? undefined;
  if ("keywords" in patch) watch.keywords = patch.keywords ?? undefined;
  if ("checkIntervalHint" in patch) watch.checkIntervalHint = patch.checkIntervalHint ?? undefined;
  if ("enabled" in patch && patch.enabled != null) watch.enabled = patch.enabled;
  if (patch.clearLastSnapshot) watch.lastSnapshot = undefined;

  return watch;
}

export function setWatchEnabled(store: StoreFile, ids: string[], enabled: boolean): {
  updatedIds: string[];
  missingIds: string[];
} {
  const updatedIds: string[] = [];
  const missingIds: string[] = [];

  for (const id of ids) {
    const watch = getWatch(store, id);
    if (!watch) {
      missingIds.push(id);
      continue;
    }
    watch.enabled = enabled;
    updatedIds.push(id);
  }

  return { updatedIds, missingIds };
}

export function importWatches(
  store: StoreFile,
  watches: ImportedWatchInput[],
  mode: ImportMode,
): {
  added: number;
  updated: number;
  replaced: boolean;
  imported: Watch[];
  matchedById: number;
  matchedByUrl: number;
} {
  const imported: Watch[] = [];
  let added = 0;
  let updated = 0;
  let matchedById = 0;
  let matchedByUrl = 0;

  if (mode === "replace") {
    store.watches = [];
  }

  for (const incoming of watches) {
    if (mode !== "append") {
      const existingById = incoming.id ? store.watches.find((watch) => watch.id === incoming.id) : undefined;
      if (existingById) {
        Object.assign(existingById, materializeImportedWatch(incoming, { preserveId: true }));
        imported.push(existingById);
        updated += 1;
        matchedById += 1;
        continue;
      }

      const existingByUrl = store.watches.find((watch) => watch.url === incoming.url);
      if (existingByUrl) {
        const replacement = materializeImportedWatch(incoming, { preserveId: true });
        replacement.id = existingByUrl.id;
        replacement.createdAt = existingByUrl.createdAt;
        Object.assign(existingByUrl, replacement);
        imported.push(existingByUrl);
        updated += 1;
        matchedByUrl += 1;
        continue;
      }
    }

    const addedWatch = materializeImportedWatch(incoming, { preserveId: mode === "replace" || mode === "upsert" });
    store.watches.push(addedWatch);
    imported.push(addedWatch);
    added += 1;
  }

  return {
    added,
    updated,
    replaced: mode === "replace",
    imported,
    matchedById,
    matchedByUrl,
  };
}
