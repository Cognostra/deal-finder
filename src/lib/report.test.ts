import { describe, expect, it } from "vitest";
import type { ResolvedDealConfig } from "../config.js";
import type { StoreFile } from "../types.js";
import { buildHealthSummary, buildStoreReport } from "./report.js";

const store: StoreFile = {
  version: 1,
  watches: [
    {
      id: "watch-1",
      url: "http://shop.test/a",
      label: "Book",
      enabled: true,
      maxPrice: 20,
      keywords: ["rare"],
      createdAt: "2026-03-19T00:00:00.000Z",
      lastSnapshot: {
        title: "Rare Book",
        canonicalTitle: "rare book",
        price: 15,
        currency: "USD",
        fetchedAt: "2026-03-19T00:00:00.000Z",
        rawSnippet: "rare sale",
      },
    },
    {
      id: "watch-2",
      url: "http://shop.test/b",
      label: "Desk",
      enabled: false,
      createdAt: "2026-03-20T00:00:00.000Z",
    },
  ],
};

const cfg: ResolvedDealConfig = {
  storePath: "/tmp/store.json",
  maxConcurrent: 8,
  maxBytesPerResponse: 1024,
  defaultMaxRpsPerHost: 1,
  requestTimeoutMs: 25_000,
  userAgents: ["UnitTest/1.0"],
  proxyUrl: undefined,
  allowedHosts: undefined,
  blockedHosts: ["localhost"],
  fetcher: "local",
  firecrawlApiKey: undefined,
  firecrawlBaseUrl: "https://api.firecrawl.dev",
};

describe("buildStoreReport", () => {
  it("summarizes watch counts and signal-heavy watches", () => {
    const report = buildStoreReport(store);
    expect(report).toMatchObject({
      total: 2,
      enabled: 1,
      disabled: 1,
      withSnapshots: 1,
      withSignals: 1,
    });
    expect(report.topSignals[0]?.watchId).toBe("watch-1");
  });
});

describe("buildHealthSummary", () => {
  it("surfaces config facts and recommendations", () => {
    const health = buildHealthSummary(store, cfg, cfg.storePath);
    expect(health).toMatchObject({
      storePath: "/tmp/store.json",
      watchCount: 2,
      enabledCount: 1,
      fetcher: "local",
      blockedHostsConfigured: true,
      allowedHostsConfigured: false,
    });
    expect(health.recommendations.length).toBeGreaterThan(0);
  });
});
