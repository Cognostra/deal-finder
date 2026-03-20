import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { addWatch, loadStore, removeWatch, saveStore, setWatchEnabled, updateWatch } from "./store.js";

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
});
