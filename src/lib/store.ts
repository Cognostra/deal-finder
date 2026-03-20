import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { StoreFile, Watch } from "../types.js";

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

export function removeWatch(store: StoreFile, id: string): boolean {
  const i = store.watches.findIndex((w) => w.id === id);
  if (i === -1) return false;
  store.watches.splice(i, 1);
  return true;
}

export function getWatch(store: StoreFile, id: string): Watch | undefined {
  return store.watches.find((w) => w.id === id);
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
