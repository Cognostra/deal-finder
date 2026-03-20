import { describe, expect, it, vi } from "vitest";
import type { ResolvedDealConfig } from "../config.js";
import type { Watch } from "../types.js";

const { cappedFetchMock } = vi.hoisted(() => ({
  cappedFetchMock: vi.fn(),
}));
const { searchViaFirecrawlMock } = vi.hoisted(() => ({
  searchViaFirecrawlMock: vi.fn(),
}));

vi.mock("./fetch.js", () => ({
  cappedFetch: cappedFetchMock,
}));
vi.mock("./firecrawl.js", () => ({
  searchViaFirecrawl: searchViaFirecrawlMock,
}));

import { buildDiscoveryImportPreview, buildDiscoverySearchQuery, describeDiscoveryPolicy, fetchDiscoveryCandidates, normalizeDiscoveryUrls, searchDiscoveryCandidates } from "./discovery.js";

function makeConfig(overrides: Partial<ResolvedDealConfig> = {}): ResolvedDealConfig {
  return {
    storePath: "/tmp/deal-hunter-store.json",
    maxConcurrent: 4,
    maxBytesPerResponse: 4096,
    defaultMaxRpsPerHost: 10,
    requestTimeoutMs: 1_000,
    userAgents: ["UnitTest/1.0"],
    fetcher: "local",
    proxyUrl: undefined,
    allowedHosts: ["shop-a.test", "shop-b.test"],
    blockedHosts: undefined,
    firecrawlApiKey: undefined,
    firecrawlBaseUrl: "https://api.firecrawl.dev",
    llmReview: {
      mode: "off",
      lowConfidenceThreshold: 45,
      maxReviewsPerScan: 3,
      allowPriceRewrite: false,
      allowIdentityRewrite: true,
      provider: undefined,
      model: undefined,
      timeoutMs: 30_000,
    },
    discovery: {
      enabled: true,
      provider: "manual",
      maxSearchResults: 5,
      maxFetches: 5,
      allowedHosts: ["shop-a.test", "shop-b.test"],
      blockedHosts: undefined,
      timeoutMs: 20_000,
    },
    ...overrides,
  };
}

const watch: Watch = {
  id: "watch-1",
  url: "https://shop-a.test/product/1",
  label: "Sony A",
  enabled: true,
  createdAt: "2026-03-20T00:00:00.000Z",
  group: "audio",
  tags: ["sony"],
  lastSnapshot: {
    title: "Sony WH-1000XM5 Wireless Headphones",
    canonicalTitle: "sony wh-1000xm5 wireless headphones",
    brand: "Sony",
    modelId: "WH-1000XM5",
    mpn: "WH1000XM5/B",
    price: 299.99,
    currency: "USD",
    fetchedAt: "2026-03-20T00:00:00.000Z",
  },
};

describe("normalizeDiscoveryUrls", () => {
  it("canonicalizes and deduplicates candidate URLs", () => {
    const urls = normalizeDiscoveryUrls([
      "https://shop-b.test/product/2?utm_source=newsletter",
      "https://shop-b.test/product/2",
    ], makeConfig());
    expect(urls).toEqual(["https://shop-b.test/product/2"]);
  });
});

describe("buildDiscoverySearchQuery", () => {
  it("builds an identity-rich search query", () => {
    expect(buildDiscoverySearchQuery(watch, ["wireless", "black"])).toContain("Sony");
    expect(buildDiscoverySearchQuery(watch)).toContain("WH-1000XM5");
  });
});

describe("searchDiscoveryCandidates", () => {
  it("searches explicit hosts and filters unsafe results", async () => {
    searchViaFirecrawlMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      results: [
        { url: "https://shop-b.test/product/2?utm_source=search", title: "Sony WH-1000XM5" },
        { url: "https://evil.test/other", title: "bad" },
      ],
    });
    const result = await searchDiscoveryCandidates({
      watch,
      cfg: makeConfig({
        firecrawlApiKey: "fc-test",
        discovery: {
          ...makeConfig().discovery,
          provider: "firecrawl-search",
          allowedHosts: ["shop-b.test"],
        },
      }),
      allowedHosts: ["shop-b.test"],
    });

    expect(result.query).toContain("Sony");
    expect(result.searchHosts).toEqual(["shop-b.test"]);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      url: "https://shop-b.test/product/2",
      searchRank: 1,
      searchTitle: "Sony WH-1000XM5",
    });
    expect(result.skippedResults[0]?.reason).toContain("allowedHosts");
  });
});

describe("fetchDiscoveryCandidates", () => {
  it("fetches explicit candidates and returns ranked matches", async () => {
    const html = `
      <meta property="og:title" content="Sony WH-1000XM5 Wireless Headphones" />
      <script type="application/ld+json">{"@type":"Product","name":"Sony WH-1000XM5 Wireless Headphones","brand":{"@type":"Brand","name":"Sony"},"mpn":"WH1000XM5/B","offers":{"price":279.99,"priceCurrency":"USD"}}</script>
    `;
    cappedFetchMock.mockResolvedValue({
      meta: { status: 200, finalUrl: "https://shop-b.test/product/2", bytesRead: html.length },
      text: html,
    });

    const [candidate] = await fetchDiscoveryCandidates({
      watch,
      candidateUrls: ["https://shop-b.test/product/2"],
      cfg: makeConfig(),
    });

    expect(candidate).toMatchObject({
      url: "https://shop-b.test/product/2",
      fetchStatus: "ok",
      matchStrength: "high",
      recommendedAction: "strong_candidate_for_import",
    });
    expect(candidate.matchedFields).toContain("brand");
    expect(candidate.matchedFields).toContain("mpn");
  });
});

describe("buildDiscoveryImportPreview", () => {
  it("marks duplicates and produces append-ready watch inputs", () => {
    const preview = buildDiscoveryImportPreview({
      watch,
      existingWatches: [watch],
      discoveryProvider: "manual",
      candidates: [
        {
          url: "https://shop-b.test/product/2",
          host: "shop-b.test",
          sourceWatchId: watch.id,
          matchScore: 95,
          matchStrength: "high",
          matchedFields: ["brand", "mpn"],
          conflictingFields: [],
          matchReasons: ["Shared mpn=WH1000XM5/B."],
          matchWarnings: [],
          extractedTitle: "Sony WH-1000XM5 Wireless Headphones",
          canonicalTitle: "sony wh-1000xm5 wireless headphones",
          brand: "Sony",
          mpn: "WH1000XM5/B",
          price: 279.99,
          currency: "USD",
          fetchStatus: "ok",
          recommendedAction: "strong_candidate_for_import",
        },
      ],
      group: "imports",
      addTags: ["candidate"],
    });

    expect(preview[0]).toMatchObject({
      importable: true,
      duplicateWatchId: undefined,
    });
    expect(preview[0]?.watchInput).toMatchObject({
      url: "https://shop-b.test/product/2",
      group: "imports",
      tags: ["sony", "candidate"],
      importSource: {
        type: "discovery",
        discoveryProvider: "manual",
        sourceWatchId: "watch-1",
        sourceWatchUrl: "https://shop-a.test/product/1",
        sourceWatchLabel: "Sony A",
        candidateUrl: "https://shop-b.test/product/2",
      },
    });
  });
});

describe("describeDiscoveryPolicy", () => {
  it("describes provider-backed search posture and missing api key state", () => {
    const policy = describeDiscoveryPolicy(makeConfig({
      discovery: {
        ...makeConfig().discovery,
        provider: "firecrawl-search",
        allowedHosts: ["shop-b.test"],
      },
    }));

    expect(policy).toMatchObject({
      enabled: true,
      provider: "firecrawl-search",
      firecrawlConfigured: false,
    });
    expect(policy.notes.join(" ")).toContain("Firecrawl search is selected but firecrawlApiKey is not configured.");
  });
});
