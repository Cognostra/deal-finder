import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { loadStore } from "./store.js";

let tempDirs: string[] = [];

async function writeFixtureToTempStore(fixtureName: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "deal-hunter-store-fixture-"));
  tempDirs.push(dir);
  const fixturePath = join(process.cwd(), "src", "lib", "fixtures", fixtureName);
  const destination = join(dir, "store.json");
  await writeFile(destination, await readFile(fixturePath, "utf8"), "utf8");
  return destination;
}

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("store fixture characterization", () => {
  it("migrates the representative version 1 fixture into version 2", async () => {
    const path = await writeFixtureToTempStore("store-v1-watch-only.json");
    const store = await loadStore(path);

    expect(store).toEqual({
      version: 2,
      watches: [
        {
          id: "watch-v1-1",
          url: "https://shop.test/item-1",
          label: "Legacy Widget",
          enabled: true,
          createdAt: "2026-03-01T00:00:00.000Z",
        },
      ],
      savedViews: [],
    });
  });

  it("loads a rich version 2 fixture with provenance, saved views, and history intact", async () => {
    const path = await writeFixtureToTempStore("store-v2-provenance.json");
    const store = await loadStore(path);

    expect(store.savedViews).toHaveLength(1);
    expect(store.savedViews[0]).toMatchObject({
      id: "view-1",
      name: "Active GPUs",
      selector: { tag: "gpu", enabled: true },
    });
    expect(store.watches).toHaveLength(1);
    expect(store.watches[0]).toMatchObject({
      id: "watch-rich-1",
      url: "https://shop.test/gpu",
      tags: ["gpu", "pc"],
      importSource: {
        type: "discovery",
        discoveryProvider: "firecrawl-search",
      },
      lastSnapshot: {
        title: "RTX GPU",
        responseTruncated: true,
        reviewedFields: [
          {
            field: "brand",
            reviewSource: "deal_llm_review_apply",
            provider: "ollama",
          },
        ],
      },
    });
    expect(store.watches[0]?.history?.[0]).toMatchObject({
      changeType: "price_drop",
      alertSeverity: "high",
      fetchSource: "node_http",
    });
  });
});
