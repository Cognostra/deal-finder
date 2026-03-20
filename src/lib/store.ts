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
  WatchImportSource,
  WatchSnapshot,
  WatchSelector,
} from "../types.js";

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

function emptyStore(): StoreFile {
  return { version: 2, watches: [], savedViews: [] };
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
  try {
    const raw = await readFile(path, "utf8");
    const data = JSON.parse(raw) as { version?: number; watches?: unknown; savedViews?: unknown };
    if (!data || !Array.isArray(data.watches)) {
      return emptyStore();
    }
    if (data.version === 1) {
      return {
        version: 2,
        watches: data.watches as Watch[],
        savedViews: [],
      };
    }
    if (data.version !== 2) {
      return emptyStore();
    }
    return {
      version: 2,
      watches: data.watches as Watch[],
      savedViews: Array.isArray(data.savedViews) ? (data.savedViews as SavedWatchView[]).map((view) => ({
        ...view,
        selector: normalizeSelector(view.selector),
      })) : [],
    };
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return emptyStore();
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

export type ImportedWatchInput = {
  id?: string;
  url: string;
  label?: string;
  group?: string;
  tags?: string[];
  maxPrice?: number;
  percentDrop?: number;
  keywords?: string[];
  checkIntervalHint?: string;
  enabled?: boolean;
  createdAt?: string;
  importSource?: WatchImportSource;
  lastSnapshot?: Watch["lastSnapshot"];
  history?: WatchHistoryEntry[];
};

export type ImportMode = "append" | "upsert" | "replace";

function cloneWatchSnapshot(snapshot: Watch["lastSnapshot"] | undefined): Watch["lastSnapshot"] {
  return snapshot
    ? {
        ...snapshot,
        reviewedFields: snapshot.reviewedFields?.map((entry) => ({
          ...entry,
          reasons: entry.reasons ? [...entry.reasons] : undefined,
        })),
      }
    : undefined;
}

function cloneHistory(history: WatchHistoryEntry[] | undefined): WatchHistoryEntry[] | undefined {
  return history?.map((entry) => ({
    ...entry,
    alerts: entry.alerts ? [...entry.alerts] : undefined,
  }));
}

function cloneImportSource(source: WatchImportSource | undefined): WatchImportSource | undefined {
  return source ? { ...source } : undefined;
}

function materializeImportedWatch(
  input: ImportedWatchInput,
  options?: { preserveId?: boolean; importSourceOverride?: WatchImportSource },
): Watch {
  return {
    id: options?.preserveId && input.id ? input.id : randomUUID(),
    url: input.url,
    label: input.label,
    group: normalizeGroup(input.group),
    tags: normalizeTags(input.tags),
    maxPrice: input.maxPrice,
    percentDrop: input.percentDrop,
    keywords: input.keywords ? [...input.keywords] : undefined,
    checkIntervalHint: input.checkIntervalHint,
    enabled: input.enabled ?? true,
    createdAt: input.createdAt ?? new Date().toISOString(),
    importSource: cloneImportSource(options?.importSourceOverride ?? input.importSource),
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

export function importWatches(
  store: StoreFile,
  watches: ImportedWatchInput[],
  mode: ImportMode,
  options?: {
    importSourceOverride?: WatchImportSource;
  },
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
        Object.assign(existingById, materializeImportedWatch(incoming, {
          preserveId: true,
          importSourceOverride: options?.importSourceOverride,
        }));
        imported.push(existingById);
        updated += 1;
        matchedById += 1;
        continue;
      }

      const existingByUrl = store.watches.find((watch) => watch.url === incoming.url);
      if (existingByUrl) {
        const replacement = materializeImportedWatch(incoming, {
          preserveId: true,
          importSourceOverride: options?.importSourceOverride,
        });
        replacement.id = existingByUrl.id;
        replacement.createdAt = existingByUrl.createdAt;
        Object.assign(existingByUrl, replacement);
        imported.push(existingByUrl);
        updated += 1;
        matchedByUrl += 1;
        continue;
      }
    }

    const addedWatch = materializeImportedWatch(incoming, {
      preserveId: mode === "replace" || mode === "upsert",
      importSourceOverride: options?.importSourceOverride,
    });
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

function expectOptionalString(value: unknown, field: string): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string") {
    throw new Error(`deal-hunter: imported watch field "${field}" must be a string when present`);
  }
  return value;
}

function expectOptionalNumber(value: unknown, field: string): number | undefined {
  if (value == null) return undefined;
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`deal-hunter: imported watch field "${field}" must be a number when present`);
  }
  return value;
}

function expectOptionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value == null) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`deal-hunter: imported watch field "${field}" must be a boolean when present`);
  }
  return value;
}

function expectOptionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`deal-hunter: imported watch field "${field}" must be an array of strings when present`);
  }
  return [...value];
}

function expectOptionalImportSource(value: unknown): WatchImportSource | undefined {
  if (value == null) return undefined;
  if (typeof value !== "object") {
    throw new Error('deal-hunter: imported watch field "importSource" must be an object when present');
  }
  const obj = value as Record<string, unknown>;
  if (obj.type === "url") {
    const url = expectOptionalString(obj.url, "importSource.url");
    const importedAt = expectOptionalString(obj.importedAt, "importSource.importedAt");
    if (!url || !importedAt) {
      throw new Error('deal-hunter: imported watch field "importSource" requires both url and importedAt');
    }
    return {
      type: "url",
      url,
      importedAt,
    };
  }
  if (obj.type === "discovery") {
    const importedAt = expectOptionalString(obj.importedAt, "importSource.importedAt");
    const discoveryProvider = expectOptionalString(obj.discoveryProvider, "importSource.discoveryProvider");
    const sourceWatchId = expectOptionalString(obj.sourceWatchId, "importSource.sourceWatchId");
    const sourceWatchUrl = expectOptionalString(obj.sourceWatchUrl, "importSource.sourceWatchUrl");
    const candidateUrl = expectOptionalString(obj.candidateUrl, "importSource.candidateUrl");
    if (
      !importedAt ||
      !sourceWatchId ||
      !sourceWatchUrl ||
      !candidateUrl ||
      (discoveryProvider !== "manual" && discoveryProvider !== "firecrawl-search")
    ) {
      throw new Error('deal-hunter: imported discovery "importSource" requires importedAt, discoveryProvider, sourceWatchId, sourceWatchUrl, and candidateUrl');
    }
    return {
      type: "discovery",
      importedAt,
      discoveryProvider,
      sourceWatchId,
      sourceWatchUrl,
      sourceWatchLabel: expectOptionalString(obj.sourceWatchLabel, "importSource.sourceWatchLabel"),
      candidateUrl,
      searchQuery: expectOptionalString(obj.searchQuery, "importSource.searchQuery"),
      searchRank:
        typeof obj.searchRank === "number" && Number.isInteger(obj.searchRank) && obj.searchRank > 0
          ? obj.searchRank
          : undefined,
      searchTitle: expectOptionalString(obj.searchTitle, "importSource.searchTitle"),
      searchDescription: expectOptionalString(obj.searchDescription, "importSource.searchDescription"),
    };
  }
  throw new Error('deal-hunter: imported watch field "importSource.type" must be "url" or "discovery"');
}

function expectOptionalReviewedFields(value: unknown): ReviewedSnapshotField[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value)) {
    throw new Error('deal-hunter: imported watch field "lastSnapshot.reviewedFields" must be an array when present');
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`deal-hunter: imported reviewed field at index ${index} must be an object`);
    }
    const obj = entry as Record<string, unknown>;
    const field = expectOptionalString(obj.field, `lastSnapshot.reviewedFields[${index}].field`) as ReviewedSnapshotFieldName | undefined;
    const reviewSource = expectOptionalString(obj.reviewSource, `lastSnapshot.reviewedFields[${index}].reviewSource`);
    const reviewedAt = expectOptionalString(obj.reviewedAt, `lastSnapshot.reviewedFields[${index}].reviewedAt`);
    if (!field || !reviewSource || !reviewedAt) {
      throw new Error(`deal-hunter: imported reviewed field at index ${index} requires field, reviewSource, and reviewedAt`);
    }
    const readValue = (candidate: unknown, fieldName: string): ReviewedSnapshotFieldValue => {
      if (candidate == null) return null;
      if (typeof candidate === "string" || typeof candidate === "number") return candidate;
      throw new Error(`deal-hunter: imported reviewed field "${fieldName}" must be a string, number, or null`);
    };
    return {
      field,
      originalValue: readValue(obj.originalValue, `lastSnapshot.reviewedFields[${index}].originalValue`),
      reviewedValue: readValue(obj.reviewedValue, `lastSnapshot.reviewedFields[${index}].reviewedValue`),
      reviewSource,
      reviewedAt,
      candidateType: expectOptionalString(obj.candidateType, `lastSnapshot.reviewedFields[${index}].candidateType`) as LlmReviewCandidateType | undefined,
      provider: expectOptionalString(obj.provider, `lastSnapshot.reviewedFields[${index}].provider`),
      model: expectOptionalString(obj.model, `lastSnapshot.reviewedFields[${index}].model`),
      reasons: expectOptionalStringArray(obj.reasons, `lastSnapshot.reviewedFields[${index}].reasons`),
    };
  });
}

function expectOptionalLastSnapshot(value: unknown): Watch["lastSnapshot"] {
  if (value == null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error('deal-hunter: imported watch field "lastSnapshot" must be an object when present');
  }
  const obj = value as Record<string, unknown>;
  const fetchedAt = expectOptionalString(obj.fetchedAt, "lastSnapshot.fetchedAt");
  if (!fetchedAt) {
    throw new Error('deal-hunter: imported watch field "lastSnapshot.fetchedAt" is required when lastSnapshot is present');
  }
  return {
    title: expectOptionalString(obj.title, "lastSnapshot.title"),
    canonicalTitle: expectOptionalString(obj.canonicalTitle, "lastSnapshot.canonicalTitle"),
    brand: expectOptionalString(obj.brand, "lastSnapshot.brand"),
    modelId: expectOptionalString(obj.modelId, "lastSnapshot.modelId"),
    sku: expectOptionalString(obj.sku, "lastSnapshot.sku"),
    mpn: expectOptionalString(obj.mpn, "lastSnapshot.mpn"),
    gtin: expectOptionalString(obj.gtin, "lastSnapshot.gtin"),
    asin: expectOptionalString(obj.asin, "lastSnapshot.asin"),
    price: expectOptionalNumber(obj.price, "lastSnapshot.price"),
    currency: expectOptionalString(obj.currency, "lastSnapshot.currency"),
    etag: expectOptionalString(obj.etag, "lastSnapshot.etag"),
    lastModified: expectOptionalString(obj.lastModified, "lastSnapshot.lastModified"),
    contentHash: expectOptionalString(obj.contentHash, "lastSnapshot.contentHash"),
    fetchedAt,
    rawSnippet: expectOptionalString(obj.rawSnippet, "lastSnapshot.rawSnippet"),
    fetchSource: expectOptionalString(obj.fetchSource, "lastSnapshot.fetchSource") as WatchSnapshot["fetchSource"],
    responseBytes: expectOptionalNumber(obj.responseBytes, "lastSnapshot.responseBytes"),
    responseTruncated: expectOptionalBoolean(obj.responseTruncated, "lastSnapshot.responseTruncated"),
    reviewedFields: expectOptionalReviewedFields(obj.reviewedFields),
  };
}

function expectOptionalHistory(value: unknown): WatchHistoryEntry[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value)) {
    throw new Error('deal-hunter: imported watch field "history" must be an array when present');
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`deal-hunter: imported history entry at index ${index} must be an object`);
    }
    const obj = entry as Record<string, unknown>;
    const fetchedAt = expectOptionalString(obj.fetchedAt, `history[${index}].fetchedAt`);
    if (!fetchedAt) {
      throw new Error(`deal-hunter: imported history entry at index ${index} requires fetchedAt`);
    }
    return {
      fetchedAt,
      price: expectOptionalNumber(obj.price, `history[${index}].price`),
      currency: expectOptionalString(obj.currency, `history[${index}].currency`),
      title: expectOptionalString(obj.title, `history[${index}].title`),
      canonicalTitle: expectOptionalString(obj.canonicalTitle, `history[${index}].canonicalTitle`),
      contentHash: expectOptionalString(obj.contentHash, `history[${index}].contentHash`),
      changeType: expectOptionalString(obj.changeType, `history[${index}].changeType`) as WatchHistoryEntry["changeType"],
      alertSeverity: expectOptionalString(obj.alertSeverity, `history[${index}].alertSeverity`) as WatchHistoryEntry["alertSeverity"],
      alerts: expectOptionalStringArray(obj.alerts, `history[${index}].alerts`),
      summaryLine: expectOptionalString(obj.summaryLine, `history[${index}].summaryLine`),
    };
  });
}

function parseImportedWatch(value: unknown, index: number): ImportedWatchInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`deal-hunter: imported watch at index ${index} must be an object`);
  }

  const obj = value as Record<string, unknown>;
  if (typeof obj.url !== "string" || !obj.url.trim()) {
    throw new Error(`deal-hunter: imported watch at index ${index} is missing a string url`);
  }

  return {
    id: expectOptionalString(obj.id, "id"),
    url: obj.url,
    label: expectOptionalString(obj.label, "label"),
    group: expectOptionalString(obj.group, "group"),
    tags: expectOptionalStringArray(obj.tags, "tags"),
    maxPrice: expectOptionalNumber(obj.maxPrice, "maxPrice"),
    percentDrop: expectOptionalNumber(obj.percentDrop, "percentDrop"),
    keywords: expectOptionalStringArray(obj.keywords, "keywords"),
    checkIntervalHint: expectOptionalString(obj.checkIntervalHint, "checkIntervalHint"),
    enabled: expectOptionalBoolean(obj.enabled, "enabled"),
    createdAt: expectOptionalString(obj.createdAt, "createdAt"),
    importSource: expectOptionalImportSource(obj.importSource),
    lastSnapshot: expectOptionalLastSnapshot(obj.lastSnapshot),
    history: expectOptionalHistory(obj.history),
  };
}

export function parseImportedWatchPayload(payload: unknown): ImportedWatchInput[] {
  const watchesPayload =
    Array.isArray(payload)
      ? payload
      : payload && typeof payload === "object" && Array.isArray((payload as Record<string, unknown>).watches)
        ? ((payload as Record<string, unknown>).watches as unknown[])
        : null;

  if (!watchesPayload?.length) {
    throw new Error('deal-hunter: imported payload must be a non-empty array of watches or an object with a non-empty "watches" array');
  }

  return watchesPayload.map((watch, index) => parseImportedWatch(watch, index));
}
