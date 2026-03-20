import { describe, expect, it } from "vitest";
import type { Watch } from "../types.js";
import { buildWatchSignals, searchWatches } from "./watch-view.js";

function makeWatch(overrides: Partial<Watch> = {}): Watch {
  return {
    id: "watch-1",
    url: "http://shop.test/item",
    enabled: true,
    createdAt: "2026-03-19T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildWatchSignals", () => {
  it("derives max-price and keyword signals from the last snapshot", () => {
    const watch = makeWatch({
      maxPrice: 60,
      keywords: ["rare"],
      lastSnapshot: {
        title: "Rare Widget",
        canonicalTitle: "rare widget",
        price: 50,
        currency: "USD",
        fetchedAt: "2026-03-19T00:00:00.000Z",
        rawSnippet: "rare sale today",
      },
    });

    expect(buildWatchSignals(watch)).toEqual(["max_price_hit:50", "keyword:rare"]);
  });
});

describe("searchWatches", () => {
  const watches = [
    makeWatch({
      id: "watch-a",
      label: "Camera",
      createdAt: "2026-03-18T00:00:00.000Z",
      lastSnapshot: { title: "Camera Pro", canonicalTitle: "camera pro", price: 800, fetchedAt: "2026-03-18T00:00:00.000Z" },
    }),
    makeWatch({
      id: "watch-b",
      label: "Book",
      enabled: false,
      createdAt: "2026-03-19T00:00:00.000Z",
      maxPrice: 20,
      lastSnapshot: { title: "Poetry Book", canonicalTitle: "poetry book", price: 15, fetchedAt: "2026-03-19T00:00:00.000Z", rawSnippet: "poetry sale" },
    }),
    makeWatch({
      id: "watch-c",
      label: "Desk",
      createdAt: "2026-03-20T00:00:00.000Z",
    }),
  ];

  it("filters by query and snapshot presence", () => {
    const result = searchWatches(watches, { query: "poetry", hasSnapshot: true, descending: false });
    expect(result.map((watch) => watch.id)).toEqual(["watch-b"]);
  });

  it("filters by enabled state and signals", () => {
    const result = searchWatches(watches, { enabled: false, hasSignals: true });
    expect(result.map((watch) => watch.id)).toEqual(["watch-b"]);
  });

  it("sorts by price ascending when requested", () => {
    const result = searchWatches(watches, { hasSnapshot: true, sortBy: "price", descending: false });
    expect(result.map((watch) => watch.id)).toEqual(["watch-b", "watch-a"]);
  });
});
