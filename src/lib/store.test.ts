import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { addSavedView, addWatch, appendWatchHistory, applyWatchSnapshotPatch, bulkUpdateWatches, importWatches, listSavedViews, loadStore, parseImportedWatchPayload, removeSavedView, removeWatch, saveStore, setWatchEnabled, updateSavedView, updateWatch } from "./store.js";

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
    await expect(loadStore(path)).resolves.toEqual({ version: 2, watches: [], savedViews: [] });
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
    await expect(loadStore(path)).resolves.toEqual({ version: 2, watches: [], savedViews: [] });
  });

  it("falls back to an empty store for invalid shapes", async () => {
    const path = await makeTempStorePath();
    await writeFile(path, JSON.stringify({ version: 2, nope: true }), "utf8");
    await expect(loadStore(path)).resolves.toEqual({ version: 2, watches: [], savedViews: [] });
  });

  it("migrates a version 1 watch-only store into version 2", async () => {
    const path = await makeTempStorePath();
    await writeFile(path, JSON.stringify({ version: 1, watches: [{ id: "watch-1", url: "http://shop.test/item", enabled: true, createdAt: "2026-03-20T00:00:00.000Z" }] }), "utf8");
    await expect(loadStore(path)).resolves.toEqual({
      version: 2,
      watches: [{ id: "watch-1", url: "http://shop.test/item", enabled: true, createdAt: "2026-03-20T00:00:00.000Z" }],
      savedViews: [],
    });
  });

  it("surfaces malformed JSON so corruption is visible", async () => {
    const path = await makeTempStorePath();
    await writeFile(path, "{not valid json", "utf8");
    await expect(loadStore(path)).rejects.toThrow();
  });

  it("does not leave temp files behind after save", async () => {
    const path = await makeTempStorePath();
    await saveStore(path, { version: 2, watches: [], savedViews: [] });

    const files = await readdir(dirname(path));
    expect(files).toEqual(["store.json"]);
  });

  it("updates mutable watch fields and can clear optional metadata", async () => {
    const store: import("../types.js").StoreFile = { version: 2, watches: [], savedViews: [] };
    const watch = addWatch(store, {
      url: "http://shop.test/item",
      label: "Demo",
      maxPrice: 25,
      keywords: ["rare"],
      checkIntervalHint: "daily",
    });

    const updated = updateWatch(store, watch.id, {
      label: "Updated Demo",
      group: "Deals",
      tags: ["Rare", "rare", "Clearance "],
      maxPrice: null,
      keywords: ["clearance"],
      checkIntervalHint: null,
      enabled: false,
      clearLastSnapshot: true,
    });

    expect(updated).toMatchObject({
      label: "Updated Demo",
      group: "Deals",
      tags: ["rare", "clearance"],
      maxPrice: undefined,
      keywords: ["clearance"],
      checkIntervalHint: undefined,
      enabled: false,
      lastSnapshot: undefined,
    });
  });

  it("applies reviewed snapshot fields onto an existing snapshot", () => {
    const store: import("../types.js").StoreFile = { version: 2, watches: [], savedViews: [] };
    const watch = addWatch(store, {
      url: "http://shop.test/item",
      lastSnapshot: {
        title: "Old Title",
        canonicalTitle: "old title",
        price: 20,
        currency: "USD",
        fetchedAt: "2026-03-20T00:00:00.000Z",
      },
    });

    const updated = applyWatchSnapshotPatch(store, watch.id, {
      title: "New Title",
      canonicalTitle: "new title",
      brand: "Acme",
      modelId: "W-1",
      price: 18,
      provenance: {
        reviewSource: "deal_llm_review_apply",
        candidateType: "extraction_review",
        provider: "ollama",
        model: "qwen2.5:1.5b",
        reasons: ["Low-confidence extraction was manually reviewed."],
        reviewedAt: "2026-03-20T01:00:00.000Z",
      },
    });

    expect(updated?.lastSnapshot).toMatchObject({
      title: "New Title",
      canonicalTitle: "new title",
      brand: "Acme",
      modelId: "W-1",
      price: 18,
      currency: "USD",
      fetchedAt: "2026-03-20T00:00:00.000Z",
    });
    expect(updated?.lastSnapshot?.reviewedFields).toEqual([
      {
        field: "title",
        originalValue: "Old Title",
        reviewedValue: "New Title",
        reviewSource: "deal_llm_review_apply",
        reviewedAt: "2026-03-20T01:00:00.000Z",
        candidateType: "extraction_review",
        provider: "ollama",
        model: "qwen2.5:1.5b",
        reasons: ["Low-confidence extraction was manually reviewed."],
      },
      {
        field: "canonicalTitle",
        originalValue: "old title",
        reviewedValue: "new title",
        reviewSource: "deal_llm_review_apply",
        reviewedAt: "2026-03-20T01:00:00.000Z",
        candidateType: "extraction_review",
        provider: "ollama",
        model: "qwen2.5:1.5b",
        reasons: ["Low-confidence extraction was manually reviewed."],
      },
      {
        field: "brand",
        originalValue: null,
        reviewedValue: "Acme",
        reviewSource: "deal_llm_review_apply",
        reviewedAt: "2026-03-20T01:00:00.000Z",
        candidateType: "extraction_review",
        provider: "ollama",
        model: "qwen2.5:1.5b",
        reasons: ["Low-confidence extraction was manually reviewed."],
      },
      {
        field: "modelId",
        originalValue: null,
        reviewedValue: "W-1",
        reviewSource: "deal_llm_review_apply",
        reviewedAt: "2026-03-20T01:00:00.000Z",
        candidateType: "extraction_review",
        provider: "ollama",
        model: "qwen2.5:1.5b",
        reasons: ["Low-confidence extraction was manually reviewed."],
      },
      {
        field: "price",
        originalValue: 20,
        reviewedValue: 18,
        reviewSource: "deal_llm_review_apply",
        reviewedAt: "2026-03-20T01:00:00.000Z",
        candidateType: "extraction_review",
        provider: "ollama",
        model: "qwen2.5:1.5b",
        reasons: ["Low-confidence extraction was manually reviewed."],
      },
    ]);
  });

  it("bulk-enables and reports missing watch ids", async () => {
    const store: import("../types.js").StoreFile = { version: 2, watches: [], savedViews: [] };
    const first = addWatch(store, { url: "http://shop.test/a", enabled: false });
    const second = addWatch(store, { url: "http://shop.test/b", enabled: false });

    const result = setWatchEnabled(store, [first.id, second.id, "missing-watch"], true);

    expect(result).toEqual({
      updatedIds: [first.id, second.id],
      missingIds: ["missing-watch"],
    });
    expect(store.watches.every((watch) => watch.enabled)).toBe(true);
  });

  it("bulk-updates tags and group metadata", () => {
    const store: import("../types.js").StoreFile = { version: 2, watches: [], savedViews: [] };
    const first = addWatch(store, { url: "http://shop.test/a", tags: ["alpha"], group: "Old" });
    const second = addWatch(store, { url: "http://shop.test/b" });

    const result = bulkUpdateWatches(store, [first.id, second.id], {
      group: "Featured",
      addTags: ["Rare", "Sale"],
      removeTags: ["alpha"],
    });

    expect(result).toEqual({
      updatedIds: [first.id, second.id],
      missingIds: [],
    });
    expect(store.watches[0]).toMatchObject({ group: "Featured", tags: ["rare", "sale"] });
    expect(store.watches[1]).toMatchObject({ group: "Featured", tags: ["rare", "sale"] });
  });

  it("records only meaningful committed history states", () => {
    const store: import("../types.js").StoreFile = { version: 2, watches: [], savedViews: [] };
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
      reviewMode: "off",
      reviewQueued: false,
      reviewApplied: false,
      reviewWarnings: [],
      reviewedFields: [],
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
      reviewMode: "off",
      reviewQueued: false,
      reviewApplied: false,
      reviewWarnings: [],
      reviewedFields: [],
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
      reviewMode: "off",
      reviewQueued: false,
      reviewApplied: false,
      reviewWarnings: [],
      reviewedFields: [],
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
    const store: import("../types.js").StoreFile = { version: 2, watches: [], savedViews: [] };
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
    const store: import("../types.js").StoreFile = { version: 2, watches: [], savedViews: [] };
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
    const store: import("../types.js").StoreFile = { version: 2, watches: [], savedViews: [] };
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

  it("records remote import source metadata when supplied", () => {
    const store: import("../types.js").StoreFile = { version: 2, watches: [], savedViews: [] };

    importWatches(
      store,
      [
        {
          url: "http://shop.test/new",
          label: "Remote Import",
        },
      ],
      "append",
      {
        importSourceOverride: {
          type: "url",
          url: "https://example.com/watchlist.json",
          importedAt: "2026-03-20T12:00:00.000Z",
        },
      },
    );

    expect(store.watches[0]?.importSource).toEqual({
      type: "url",
      url: "https://example.com/watchlist.json",
      importedAt: "2026-03-20T12:00:00.000Z",
    });
  });

  it("parses exported payload objects and preserves snapshot/history/source metadata", () => {
    const parsed = parseImportedWatchPayload({
      exportedAt: "2026-03-20T12:00:00.000Z",
      watches: [
        {
          url: "https://example.com/item",
          label: "Widget",
          importSource: {
            type: "url",
            url: "https://example.com/watchlist.json",
            importedAt: "2026-03-20T11:00:00.000Z",
          },
          lastSnapshot: {
            title: "Widget",
            price: 19.99,
            currency: "USD",
            fetchedAt: "2026-03-20T11:30:00.000Z",
          },
          history: [
            {
              fetchedAt: "2026-03-20T11:30:00.000Z",
              price: 19.99,
              currency: "USD",
              alertSeverity: "low",
            },
          ],
        },
      ],
    });

    expect(parsed).toEqual([
      {
        url: "https://example.com/item",
        label: "Widget",
        importSource: {
          type: "url",
          url: "https://example.com/watchlist.json",
          importedAt: "2026-03-20T11:00:00.000Z",
        },
        lastSnapshot: {
          title: "Widget",
          canonicalTitle: undefined,
          price: 19.99,
          currency: "USD",
          etag: undefined,
          lastModified: undefined,
          contentHash: undefined,
          fetchedAt: "2026-03-20T11:30:00.000Z",
          rawSnippet: undefined,
        },
        history: [
          {
            fetchedAt: "2026-03-20T11:30:00.000Z",
            price: 19.99,
            currency: "USD",
            title: undefined,
            canonicalTitle: undefined,
            contentHash: undefined,
            changeType: undefined,
            alertSeverity: "low",
            alerts: undefined,
            summaryLine: undefined,
          },
        ],
      },
    ]);
  });

  it("parses discovery import source metadata", () => {
    const parsed = parseImportedWatchPayload({
      watches: [
        {
          url: "https://shop-b.test/product/2",
          label: "Discovered Widget",
          importSource: {
            type: "discovery",
            importedAt: "2026-03-20T11:00:00.000Z",
            discoveryProvider: "firecrawl-search",
            sourceWatchId: "watch-1",
            sourceWatchUrl: "https://shop-a.test/product/1",
            sourceWatchLabel: "Anchor Widget",
            candidateUrl: "https://shop-b.test/product/2",
            searchQuery: "widget site:shop-b.test",
            searchRank: 2,
            searchTitle: "Widget Listing",
            searchDescription: "Widget description",
          },
        },
      ],
    });

    expect(parsed[0]?.importSource).toEqual({
      type: "discovery",
      importedAt: "2026-03-20T11:00:00.000Z",
      discoveryProvider: "firecrawl-search",
      sourceWatchId: "watch-1",
      sourceWatchUrl: "https://shop-a.test/product/1",
      sourceWatchLabel: "Anchor Widget",
      candidateUrl: "https://shop-b.test/product/2",
      searchQuery: "widget site:shop-b.test",
      searchRank: 2,
      searchTitle: "Widget Listing",
      searchDescription: "Widget description",
    });
  });

  it("rejects malformed remote import payloads", () => {
    expect(() => parseImportedWatchPayload({ watches: [{ label: "Missing URL" }] })).toThrow(/missing a string url/i);
    expect(() => parseImportedWatchPayload({ nope: true })).toThrow(/non-empty "watches" array/i);
  });

  it("stores, lists, and removes saved views", () => {
    const store: import("../types.js").StoreFile = { version: 2, watches: [], savedViews: [] };

    const saved = addSavedView(store, {
      name: "GPU alerts",
      description: "All GPU watches with signals",
      selector: { tag: "gpu", hasSignals: true, sortBy: "price", descending: false, limit: 25 },
    });

    expect(saved.name).toBe("GPU alerts");
    expect(listSavedViews(store)).toHaveLength(1);
    expect(listSavedViews(store)[0]).toMatchObject({
      id: saved.id,
      name: "GPU alerts",
      selector: { tag: "gpu", hasSignals: true, sortBy: "price", descending: false, limit: 25 },
    });

    expect(removeSavedView(store, saved.id)).toBe(true);
    expect(listSavedViews(store)).toEqual([]);
  });

  it("updates saved view metadata and selector fields", () => {
    const store: import("../types.js").StoreFile = { version: 2, watches: [], savedViews: [] };
    const saved = addSavedView(store, {
      name: "GPU alerts",
      description: "Old description",
      selector: { tag: "gpu", hasSignals: true },
    });

    const updated = updateSavedView(store, saved.id, {
      name: "GPU triage",
      description: null,
      selector: { tag: "gpu", enabled: true, hasSnapshot: true, limit: 10 },
    });

    expect(updated).toMatchObject({
      id: saved.id,
      name: "GPU triage",
      description: undefined,
      selector: { tag: "gpu", enabled: true, hasSnapshot: true, limit: 10 },
    });
  });
});
