import { describe, expect, it } from "vitest";
import type { StoreFile } from "../types.js";
import { buildExternalProductMatchCandidate, buildProductGroups, buildProductMatchCandidates, getWatchHost, getWatchIdentityFields } from "./product-identity.js";

const store: StoreFile = {
  version: 2,
  savedViews: [],
  watches: [
    {
      id: "a",
      url: "https://shop-a.test/product/1",
      label: "Sony A",
      enabled: true,
      createdAt: "2026-03-20T00:00:00.000Z",
      lastSnapshot: {
        title: "Sony Headphones",
        canonicalTitle: "sony headphones",
        brand: "Sony",
        modelId: "WH-1000XM5",
        mpn: "WH1000XM5/B",
        price: 299.99,
        currency: "USD",
        fetchedAt: "2026-03-20T00:00:00.000Z",
      },
    },
    {
      id: "b",
      url: "https://shop-b.test/p/2",
      label: "Sony B",
      enabled: true,
      createdAt: "2026-03-20T00:00:00.000Z",
      lastSnapshot: {
        title: "Sony Headphones Wireless",
        canonicalTitle: "sony headphones wireless",
        brand: "Sony",
        modelId: "WH-1000XM5",
        mpn: "WH1000XM5/B",
        price: 279.99,
        currency: "USD",
        fetchedAt: "2026-03-20T00:00:00.000Z",
      },
    },
    {
      id: "c",
      url: "https://shop-c.test/p/3",
      label: "Other",
      enabled: true,
      createdAt: "2026-03-20T00:00:00.000Z",
      lastSnapshot: {
        title: "Different Product",
        canonicalTitle: "different product",
        brand: "Acme",
        sku: "ACME-1",
        price: 50,
        currency: "USD",
        fetchedAt: "2026-03-20T00:00:00.000Z",
      },
    },
  ],
};

describe("getWatchIdentityFields", () => {
  it("collects persistent identity fields from the latest snapshot", () => {
    expect(getWatchIdentityFields(store.watches[0]!)).toEqual([
      { field: "brand", value: "Sony" },
      { field: "modelId", value: "WH-1000XM5" },
      { field: "mpn", value: "WH1000XM5/B" },
    ]);
  });
});

describe("buildProductMatchCandidates", () => {
  it("scores likely same-product matches ahead of unrelated products", () => {
    const matches = buildProductMatchCandidates(store.watches[0]!, store.watches);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      watchId: "b",
      sharedFields: ["brand", "modelId", "mpn"],
    });
    expect(matches[0]!.matchScore).toBeGreaterThanOrEqual(100);
  });
});

describe("buildProductGroups", () => {
  it("groups likely same-product watches and computes spread", () => {
    const groups = buildProductGroups(store);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      watchCount: 2,
      bestPrice: 279.99,
      highestPrice: 299.99,
      bestWatchId: "b",
    });
  });
});

describe("buildExternalProductMatchCandidate", () => {
  it("scores an extracted external candidate against an anchor watch", () => {
    const match = buildExternalProductMatchCandidate(store.watches[0]!, {
      url: "https://shop-d.test/product/sony-headphones",
      extracted: {
        title: "Sony WH-1000XM5 Wireless Headphones",
        canonicalTitle: "sony headphones",
        brand: "Sony",
        modelId: "WH-1000XM5",
        mpn: "WH1000XM5/B",
        price: 269.99,
        currency: "USD",
      },
    });

    expect(match).toMatchObject({
      url: "https://shop-d.test/product/sony-headphones",
      sharedFields: ["brand", "modelId", "mpn"],
      conflictingFields: [],
      matchStrength: "high",
      latestPrice: 269.99,
    });
    expect(match?.matchScore).toBeGreaterThanOrEqual(100);
  });
});

describe("getWatchHost", () => {
  it("extracts the host from valid URLs", () => {
    expect(getWatchHost("https://shop-a.test/product/1")).toBe("shop-a.test");
  });
});
