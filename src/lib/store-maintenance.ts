import { readFile } from "node:fs/promises";
import type { SavedWatchView, StoreFile, Watch, WatchSelector } from "../types.js";
import { parseImportedWatchPayload } from "./store-import.js";

export type StoreInspection = {
  store: StoreFile;
  warnings: string[];
  recovered: boolean;
  migratedFromVersion?: 1;
  source: "missing" | "parsed";
};

function emptyStore(): StoreFile {
  return { version: 2, watches: [], savedViews: [] };
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

function parseSavedViews(values: unknown, warnings: string[]): SavedWatchView[] {
  if (!Array.isArray(values)) return [];
  const savedViews: SavedWatchView[] = [];
  for (const [index, value] of values.entries()) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      warnings.push(`Dropped saved view at index ${index}: entry must be an object.`);
      continue;
    }
    const obj = value as Record<string, unknown>;
    if (
      typeof obj.id !== "string" ||
      !obj.id.trim() ||
      typeof obj.name !== "string" ||
      !obj.name.trim() ||
      typeof obj.createdAt !== "string" ||
      !obj.createdAt.trim()
    ) {
      warnings.push(`Dropped saved view at index ${index}: id, name, and createdAt are required strings.`);
      continue;
    }
    savedViews.push({
      id: obj.id,
      name: obj.name.trim(),
      description: typeof obj.description === "string" ? obj.description.trim() || undefined : undefined,
      selector: normalizeSelector(obj.selector as WatchSelector | undefined),
      createdAt: obj.createdAt,
    });
  }
  return savedViews;
}

function parseWatches(values: unknown, warnings: string[]): Watch[] {
  if (!Array.isArray(values)) return [];
  const watches: Watch[] = [];
  for (const [index, value] of values.entries()) {
    try {
      const parsed = parseImportedWatchPayload([value])[0];
      if (!parsed) {
        warnings.push(`Dropped watch at index ${index}: parser returned no watch.`);
        continue;
      }
      if (!parsed.id || !parsed.createdAt) {
        warnings.push(`Dropped watch at index ${index}: id and createdAt are required in persisted stores.`);
        continue;
      }
      watches.push({
        id: parsed.id,
        url: parsed.url,
        label: parsed.label,
        group: parsed.group,
        tags: parsed.tags,
        maxPrice: parsed.maxPrice,
        percentDrop: parsed.percentDrop,
        keywords: parsed.keywords,
        checkIntervalHint: parsed.checkIntervalHint,
        enabled: parsed.enabled ?? true,
        createdAt: parsed.createdAt,
        importSource: parsed.importSource,
        lastSnapshot: parsed.lastSnapshot,
        history: parsed.history,
      });
    } catch (error) {
      warnings.push(`Dropped watch at index ${index}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return watches;
}

export function inspectParsedStoreData(data: unknown): StoreInspection {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return {
      store: emptyStore(),
      warnings: ["Store root is not an object; using an empty store."],
      recovered: true,
      source: "parsed",
    };
  }

  const obj = data as { version?: number; watches?: unknown; savedViews?: unknown };
  const warnings: string[] = [];

  if (!Array.isArray(obj.watches)) {
    return {
      store: emptyStore(),
      warnings: ['Store is missing a valid "watches" array; using an empty store.'],
      recovered: true,
      source: "parsed",
    };
  }

  if (obj.version === 1) {
    const watches = parseWatches(obj.watches, warnings);
    return {
      store: {
        version: 2,
        watches,
        savedViews: [],
      },
      warnings,
      recovered: warnings.length > 0,
      migratedFromVersion: 1,
      source: "parsed",
    };
  }

  if (obj.version !== 2) {
    return {
      store: emptyStore(),
      warnings: [`Unsupported store version "${String(obj.version)}"; using an empty store.`],
      recovered: true,
      source: "parsed",
    };
  }

  const watches = parseWatches(obj.watches, warnings);
  const savedViews = parseSavedViews(obj.savedViews, warnings);

  return {
    store: {
      version: 2,
      watches,
      savedViews,
    },
    warnings,
    recovered: warnings.length > 0,
    source: "parsed",
  };
}

export async function inspectStore(path: string): Promise<StoreInspection> {
  try {
    const raw = await readFile(path, "utf8");
    return inspectParsedStoreData(JSON.parse(raw));
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return {
        store: emptyStore(),
        warnings: [],
        recovered: false,
        source: "missing",
      };
    }
    throw e;
  }
}
