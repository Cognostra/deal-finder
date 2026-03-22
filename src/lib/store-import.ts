import { randomUUID } from "node:crypto";
import type {
  LlmReviewCandidateType,
  ReviewedSnapshotField,
  ReviewedSnapshotFieldName,
  ReviewedSnapshotFieldValue,
  Watch,
  WatchHistoryEntry,
  WatchImportSource,
  WatchSnapshot,
} from "../types.js";

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

function normalizeTags(tags: string[] | undefined): string[] | undefined {
  if (!tags?.length) return undefined;
  const normalized = [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
  return normalized.length ? normalized : undefined;
}

function normalizeGroup(group: string | undefined): string | undefined {
  const normalized = group?.trim();
  return normalized ? normalized : undefined;
}

export function cloneWatchSnapshot(snapshot: Watch["lastSnapshot"] | undefined): Watch["lastSnapshot"] {
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

export function importWatches(
  store: { watches: Watch[] },
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
      fetchSource: expectOptionalString(obj.fetchSource, `history[${index}].fetchSource`) as WatchHistoryEntry["fetchSource"],
      responseTruncated: expectOptionalBoolean(obj.responseTruncated, `history[${index}].responseTruncated`),
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
