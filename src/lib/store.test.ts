import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { addWatch, appendWatchHistory, importWatches, loadStore, removeWatch, saveStore, setWatchEnabled, updateWatch } from "./store.js";

let tempDirs: string[] = [];

async function makeTempStorePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "deal-hunter-store-"));
  tempDirs.push(dir);
  return join(dir, "store.json");
}

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("store", () => {
  it("returns an empty store when the file is missing", async () => {
    const path = await makeTempStorePath();
    await expect(loadStore(path)).resolves.toEqual({ version: 1, watches: [] });
  });

  it("persists add/remove operations", async () => {
    const path = await makeTempStorePath();
    const store = await loadStore(path);

    const added = addWatch(store, {
      url: "http://shop.test/item",
      label: "Demo",
      maxPrice: 42,
      keywords: ["demo"],
    });
    await saveStore(path, store);

    const reloaded = await loadStore(path);
    expect(reloaded.watches).toHaveLength(1);
    expect(reloaded.watches[0]?.id).toBe(added.id);
    expect(removeWatch(reloaded, added.id)).toBe(true);

    await saveStore(path, reloaded);
    await expect(loadStore(path)).resolves.toEqual({ version: 1, watches: [] });
  });

  it("falls back to an empty store for invalid shapes", async () => {
    const path = await makeTempStorePath();
    await writeFile(path, JSON.stringify({ version: 2, nope: true }), "utf8");
    await expect(loadStore(path)).resolves.toEqual({ version: 1, watches: [] });
  });

  it("surfaces malformed JSON so corruption is visible", async () => {
    const path = await makeTempStorePath();
    await writeFile(path, "{not valid json", "utf8");
    await expect(loadStore(path)).rejects.toThrow();
  });

  it("does not leave temp files behind after save", async () => {
    const path = await makeTempStorePath();
    await saveStore(path, { version: 1, watches: [] });

    const files = await readdir(dirname(path));
    expect(files).toEqual(["store.json"]);
  });

  it("updates mutable watch fields and can clear optional metadata", async () => {
    const store: { version: 1; watches: import("../types.js").Watch[] } = { version: 1, watches: [] };
    const watch = addWatch(store, {
      url: "http://shop.test/item",
      label: "Demo",
      maxPrice: 25,
      keywords: ["rare"],
      checkIntervalHint: "daily",
    });

    const updated = updateWatch(store, watch.id, {
      label: "Updated Demo",
      maxPrice: null,
      keywords: ["clearance"],
      checkIntervalHint: null,
      enabled: false,
      clearLastSnapshot: true,
    });

    expect(updated).toMatchObject({
      label: "Updated Demo",
      maxPrice: undefined,
      keywords: ["clearance"],
      checkIntervalHint: undefined,
      enabled: false,
      lastSnapshot: undefined,
    });
  });

  it("bulk-enables and reports missing watch ids", async () => {
    const store: { version: 1; watches: import("../types.js").Watch[] } = { version: 1, watches: [] };
    const first = addWatch(store, { url: "http://shop.test/a", enabled: false });
    const second = addWatch(store, { url: "http://shop.test/b", enabled: false });

    const result = setWatchEnabled(store, [first.id, second.id, "missing-watch"], true);

    expect(result).toEqual({
      updatedIds: [first.id, second.id],
      missingIds: ["missing-watch"],
    });
    expect(store.watches.every((watch) => watch.enabled)).toBe(true);
  });

  it("records only meaningful committed history states", () => {
    const store: { version: 1; watches: import("../types.js").Watch[] } = { version: 1, watches: [] };
    const watch = addWatch(store, { url: "http://shop.test/a" });

    const firstChanged = appendWatchHistory(watch, {
      watchId: watch.id,
      url: watch.url,
      fetchSource: "node_http",
      fetchSourceNote: "Fetched directly over HTTP by the Node engine.",
      ok: true,
      changed: true,
      changeType: "first_seen",
      changeReasons: ["Initial snapshot captured for this watch."],
      alertSeverity: "low",
      alertScore: 20,
      extractionConfidence: { score: 90, level: "high", reasons: ["ok"] },
      summaryLine: "Widget: 20.00 USD; first snapshot",
      timingMs: { fetch: 1, parse: 1, total: 2 },
      after: {
        fetchedAt: "2026-03-19T00:00:00.000Z",
        price: 20,
        currency: "USD",
        title: "Widget",
        canonicalTitle: "widget",
        contentHash: "hash-1",
      },
      alerts: [],
    });

    const duplicateState = appendWatchHistory(watch, {
      watchId: watch.id,
      url: watch.url,
      fetchSource: "node_http",
      fetchSourceNote: "Fetched directly over HTTP by the Node engine.",
      ok: true,
      changed: false,
      changeType: "unchanged",
      changeReasons: ["No material change detected."],
      alertSeverity: "none",
      alertScore: 0,
      extractionConfidence: { score: 90, level: "high", reasons: ["ok"] },
      summaryLine: "Widget: 20.00 USD; no material change",
      timingMs: { fetch: 1, parse: 1, total: 2 },
      after: {
        fetchedAt: "2026-03-20T00:00:00.000Z",
        price: 20,
        currency: "USD",
        title: "Widget",
        canonicalTitle: "widget",
        contentHash: "hash-1",
      },
      alerts: [],
    });

    const changedAgain = appendWatchHistory(watch, {
      watchId: watch.id,
      url: watch.url,
      fetchSource: "node_http",
      fetchSourceNote: "Fetched directly over HTTP by the Node engine.",
      ok: true,
      changed: true,
      changeType: "price_drop",
      changeReasons: ["Price dropped."],
      alertSeverity: "high",
      alertScore: 90,
      extractionConfidence: { score: 90, level: "high", reasons: ["ok"] },
      summaryLine: "Widget: 15.00 USD; price dropped",
      timingMs: { fetch: 1, parse: 1, total: 2 },
      after: {
        fetchedAt: "2026-03-21T00:00:00.000Z",
        price: 15,
        currency: "USD",
        title: "Widget",
        canonicalTitle: "widget",
        contentHash: "hash-2",
      },
      alerts: ["price_drop_25.0_percent"],
    });

    expect(firstChanged).toBe(true);
    expect(duplicateState).toBe(false);
    expect(changedAgain).toBe(true);
    expect(watch.history).toHaveLength(2);
    expect(watch.history?.[1]).toMatchObject({
      price: 15,
      changeType: "price_drop",
      alertSeverity: "high",
    });
  });

  it("imports watches in append mode without overwriting existing entries", () => {
    const store: { version: 1; watches: import("../types.js").Watch[] } = { version: 1, watches: [] };
    const existing = addWatch(store, { url: "http://shop.test/a", label: "Existing" });

    const result = importWatches(
      store,
      [
        {
          id: existing.id,
          url: "http://shop.test/a",
          label: "Imported Copy",
          enabled: false,
        },
      ],
      "append",
    );

    expect(result).toMatchObject({
      added: 1,
      updated: 0,
      replaced: false,
    });
    expect(store.watches).toHaveLength(2);
    expect(store.watches[0]?.label).toBe("Existing");
    expect(store.watches[1]?.label).toBe("Imported Copy");
  });

  it("imports watches in upsert mode by id or url", () => {
    const store: { version: 1; watches: import("../types.js").Watch[] } = { version: 1, watches: [] };
    const first = addWatch(store, { url: "http://shop.test/a", label: "Alpha" });
    const second = addWatch(store, { url: "http://shop.test/b", label: "Bravo" });

    const result = importWatches(
      store,
      [
        {
          id: first.id,
          url: "http://shop.test/a",
          label: "Alpha Updated",
          enabled: false,
        },
        {
          url: "http://shop.test/b",
          label: "Bravo Updated",
          maxPrice: 25,
        },
        {
          url: "http://shop.test/c",
          label: "Charlie",
        },
      ],
      "upsert",
    );

    expect(result).toMatchObject({
      added: 1,
      updated: 2,
      matchedById: 1,
      matchedByUrl: 1,
    });
    expect(store.watches).toHaveLength(3);
    expect(store.watches.find((watch) => watch.id === first.id)).toMatchObject({
      label: "Alpha Updated",
      enabled: false,
    });
    expect(store.watches.find((watch) => watch.id === second.id)).toMatchObject({
      label: "Bravo Updated",
      maxPrice: 25,
    });
  });

  it("imports watches in replace mode by swapping the watchlist", () => {
    const store: { version: 1; watches: import("../types.js").Watch[] } = { version: 1, watches: [] };
    addWatch(store, { url: "http://shop.test/a", label: "Old" });

    const result = importWatches(
      store,
      [
        {
          id: "imported-1",
          url: "http://shop.test/new",
          label: "New",
          createdAt: "2026-03-20T00:00:00.000Z",
        },
      ],
      "replace",
    );

    expect(result).toMatchObject({
      added: 1,
      updated: 0,
      replaced: true,
    });
    expect(store.watches).toHaveLength(1);
    expect(store.watches[0]).toMatchObject({
      id: "imported-1",
      url: "http://shop.test/new",
      label: "New",
    });
  });
});
