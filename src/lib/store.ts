import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  LlmReviewCandidateType,
  ReviewedSnapshotField,
  ReviewedSnapshotFieldName,
  ReviewedSnapshotFieldValue,
  SavedWatchView,
  ScanResultItem,
  StoreFile,
  Watch,
  WatchHistoryEntry,
  WatchSelector,
} from "../types.js";
import { cloneWatchSnapshot } from "./store-import.js";
import { inspectStore } from "./store-maintenance.js";
export { importWatches, parseImportedWatchPayload } from "./store-import.js";
export type { ImportedWatchInput, ImportMode } from "./store-import.js";

const MAX_HISTORY_ENTRIES = 60;

function normalizeTags(tags: string[] | undefined): string[] | undefined {
  if (!tags?.length) return undefined;
  const normalized = [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
  return normalized.length ? normalized : undefined;
}

function normalizeGroup(group: string | undefined): string | undefined {
  const normalized = group?.trim();
  return normalized ? normalized : undefined;
}

function normalizeSelector(selector: WatchSelector | undefined): WatchSelector {
  if (!selector) return {};
  return {
    query: typeof selector.query === "string" ? selector.query : undefined,
    enabled: typeof selector.enabled === "boolean" ? selector.enabled : undefined,
    hasSnapshot: typeof selector.hasSnapshot === "boolean" ? selector.hasSnapshot : undefined,
    hasSignals: typeof selector.hasSignals === "boolean" ? selector.hasSignals : undefined,
    tag: typeof selector.tag === "string" ? selector.tag.trim() || undefined : undefined,
    group: normalizeGroup(typeof selector.group === "string" ? selector.group : undefined),
    sortBy:
      selector.sortBy === "createdAt" || selector.sortBy === "label" || selector.sortBy === "price"
        ? selector.sortBy
        : undefined,
    descending: typeof selector.descending === "boolean" ? selector.descending : undefined,
    limit:
      typeof selector.limit === "number" && Number.isInteger(selector.limit) && selector.limit > 0
        ? selector.limit
        : undefined,
  };
}

function materializeSavedView(input: {
  id?: string;
  name: string;
  description?: string;
  selector?: WatchSelector;
}): SavedWatchView {
  const name = input.name.trim();
  if (!name) {
    throw new Error('deal-hunter: saved view name cannot be empty');
  }
  return {
    id: input.id ?? randomUUID(),
    name,
    description: input.description?.trim() || undefined,
    selector: normalizeSelector(input.selector),
    createdAt: new Date().toISOString(),
  };
}

export async function loadStore(path: string): Promise<StoreFile> {
  return (await inspectStore(path)).store;
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
    group: normalizeGroup(partial.group),
    tags: normalizeTags(partial.tags),
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

export function listSavedViews(store: StoreFile): SavedWatchView[] {
  return [...store.savedViews].sort((a, b) => a.name.localeCompare(b.name) || a.createdAt.localeCompare(b.createdAt));
}

export function addSavedView(
  store: StoreFile,
  input: {
    name: string;
    description?: string;
    selector?: WatchSelector;
  },
): SavedWatchView {
  const saved = materializeSavedView(input);
  store.savedViews.push(saved);
  return saved;
}

export function getSavedView(store: StoreFile, id: string): SavedWatchView | undefined {
  return store.savedViews.find((view) => view.id === id);
}

export function updateSavedView(
  store: StoreFile,
  id: string,
  patch: {
    name?: string;
    description?: string | null;
    selector?: WatchSelector;
  },
): SavedWatchView | undefined {
  const view = getSavedView(store, id);
  if (!view) return undefined;

  if ("name" in patch && patch.name != null) {
    const name = patch.name.trim();
    if (!name) {
      throw new Error('deal-hunter: saved view name cannot be empty');
    }
    view.name = name;
  }
  if ("description" in patch) {
    view.description = patch.description?.trim() || undefined;
  }
  if ("selector" in patch && patch.selector != null) {
    view.selector = normalizeSelector(patch.selector);
  }

  return view;
}

export function removeSavedView(store: StoreFile, id: string): boolean {
  const index = store.savedViews.findIndex((view) => view.id === id);
  if (index === -1) return false;
  store.savedViews.splice(index, 1);
  return true;
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
    fetchSource: result.fetchSource,
    responseTruncated: result.responseTruncated,
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
  group?: string | null;
  tags?: string[] | null;
  maxPrice?: number | null;
  percentDrop?: number | null;
  keywords?: string[] | null;
  checkIntervalHint?: string | null;
  enabled?: boolean;
  clearLastSnapshot?: boolean;
};

export type WatchSnapshotPatch = {
  title?: string | null;
  canonicalTitle?: string | null;
  brand?: string | null;
  modelId?: string | null;
  sku?: string | null;
  mpn?: string | null;
  gtin?: string | null;
  asin?: string | null;
  price?: number | null;
  currency?: string | null;
  rawSnippet?: string | null;
  fetchedAt?: string;
  provenance?: {
    reviewSource: string;
    reviewedAt?: string;
    candidateType?: LlmReviewCandidateType;
    provider?: string;
    model?: string;
    reasons?: string[];
  };
};

const SNAPSHOT_PATCH_FIELDS: ReviewedSnapshotFieldName[] = [
  "title",
  "canonicalTitle",
  "brand",
  "modelId",
  "sku",
  "mpn",
  "gtin",
  "asin",
  "price",
  "currency",
  "rawSnippet",
];

function toReviewedValue(value: string | number | null | undefined): ReviewedSnapshotFieldValue {
  return value ?? null;
}

function mergeReviewedSnapshotFields(
  existing: ReviewedSnapshotField[] | undefined,
  patch: WatchSnapshotPatch,
  previousSnapshot: Watch["lastSnapshot"] | undefined,
  nextSnapshot: Watch["lastSnapshot"],
): ReviewedSnapshotField[] | undefined {
  const provenance = patch.provenance;
  if (!provenance || !nextSnapshot) {
    return existing;
  }

  const changedEntries = SNAPSHOT_PATCH_FIELDS.flatMap((field) => {
    if (!(field in patch)) return [];
    const beforeValue = previousSnapshot?.[field];
    const afterValue = nextSnapshot[field];
    if (beforeValue === afterValue) return [];
    return [{
      field,
      originalValue: toReviewedValue(beforeValue),
      reviewedValue: toReviewedValue(afterValue),
      reviewSource: provenance.reviewSource,
      reviewedAt: provenance.reviewedAt ?? new Date().toISOString(),
      candidateType: provenance.candidateType,
      provider: provenance.provider,
      model: provenance.model,
      reasons: provenance.reasons ? [...provenance.reasons] : undefined,
    } satisfies ReviewedSnapshotField];
  });

  if (!changedEntries.length) {
    return existing;
  }

  const byField = new Map<ReviewedSnapshotFieldName, ReviewedSnapshotField>(
    (existing ?? []).map((entry) => [entry.field, { ...entry, reasons: entry.reasons ? [...entry.reasons] : undefined }]),
  );
  for (const entry of changedEntries) {
    byField.set(entry.field, entry);
  }
  return SNAPSHOT_PATCH_FIELDS.flatMap((field) => {
    const entry = byField.get(field);
    return entry ? [entry] : [];
  });
}

export function updateWatch(store: StoreFile, id: string, patch: WatchUpdatePatch): Watch | undefined {
  const watch = getWatch(store, id);
  if (!watch) return undefined;

  if ("url" in patch && patch.url != null) watch.url = patch.url;
  if ("label" in patch) watch.label = patch.label ?? undefined;
  if ("group" in patch) watch.group = normalizeGroup(patch.group ?? undefined);
  if ("tags" in patch) watch.tags = normalizeTags(patch.tags ?? undefined);
  if ("maxPrice" in patch) watch.maxPrice = patch.maxPrice ?? undefined;
  if ("percentDrop" in patch) watch.percentDrop = patch.percentDrop ?? undefined;
  if ("keywords" in patch) watch.keywords = patch.keywords ?? undefined;
  if ("checkIntervalHint" in patch) watch.checkIntervalHint = patch.checkIntervalHint ?? undefined;
  if ("enabled" in patch && patch.enabled != null) watch.enabled = patch.enabled;
  if (patch.clearLastSnapshot) watch.lastSnapshot = undefined;

  return watch;
}

export function applyWatchSnapshotPatch(store: StoreFile, id: string, patch: WatchSnapshotPatch): Watch | undefined {
  const watch = getWatch(store, id);
  if (!watch) return undefined;

  const previousSnapshot = watch.lastSnapshot ? cloneWatchSnapshot(watch.lastSnapshot) : undefined;
  const nextSnapshot = watch.lastSnapshot
    ? { ...watch.lastSnapshot }
    : { fetchedAt: patch.fetchedAt ?? new Date().toISOString() };

  if ("title" in patch) nextSnapshot.title = patch.title ?? undefined;
  if ("canonicalTitle" in patch) nextSnapshot.canonicalTitle = patch.canonicalTitle ?? undefined;
  if ("brand" in patch) nextSnapshot.brand = patch.brand ?? undefined;
  if ("modelId" in patch) nextSnapshot.modelId = patch.modelId ?? undefined;
  if ("sku" in patch) nextSnapshot.sku = patch.sku ?? undefined;
  if ("mpn" in patch) nextSnapshot.mpn = patch.mpn ?? undefined;
  if ("gtin" in patch) nextSnapshot.gtin = patch.gtin ?? undefined;
  if ("asin" in patch) nextSnapshot.asin = patch.asin ?? undefined;
  if ("price" in patch) nextSnapshot.price = patch.price ?? undefined;
  if ("currency" in patch) nextSnapshot.currency = patch.currency ?? undefined;
  if ("rawSnippet" in patch) nextSnapshot.rawSnippet = patch.rawSnippet ?? undefined;
  if ("fetchedAt" in patch && patch.fetchedAt) nextSnapshot.fetchedAt = patch.fetchedAt;
  nextSnapshot.reviewedFields = mergeReviewedSnapshotFields(previousSnapshot?.reviewedFields, patch, previousSnapshot, nextSnapshot);

  watch.lastSnapshot = nextSnapshot;
  return watch;
}

export type WatchBulkPatch = {
  group?: string | null;
  tags?: string[] | null;
  addTags?: string[];
  removeTags?: string[];
  maxPrice?: number | null;
  percentDrop?: number | null;
  keywords?: string[] | null;
  checkIntervalHint?: string | null;
  enabled?: boolean;
  clearLastSnapshot?: boolean;
};

export function bulkUpdateWatches(store: StoreFile, ids: string[], patch: WatchBulkPatch): {
  updatedIds: string[];
  missingIds: string[];
} {
  const updatedIds: string[] = [];
  const missingIds: string[] = [];
  const normalizedAddTags = normalizeTags(patch.addTags);
  const normalizedRemoveTags = new Set(normalizeTags(patch.removeTags) ?? []);

  for (const id of ids) {
    const watch = getWatch(store, id);
    if (!watch) {
      missingIds.push(id);
      continue;
    }

    updateWatch(store, id, {
      group: patch.group,
      tags: patch.tags,
      maxPrice: patch.maxPrice,
      percentDrop: patch.percentDrop,
      keywords: patch.keywords,
      checkIntervalHint: patch.checkIntervalHint,
      enabled: patch.enabled,
      clearLastSnapshot: patch.clearLastSnapshot,
    });

    if (patch.addTags || patch.removeTags) {
      const nextTags = new Set(normalizeTags(watch.tags) ?? []);
      for (const tag of normalizedAddTags ?? []) nextTags.add(tag);
      for (const tag of normalizedRemoveTags) nextTags.delete(tag);
      watch.tags = nextTags.size ? [...nextTags].sort() : undefined;
    }

    updatedIds.push(id);
  }

  return { updatedIds, missingIds };
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
