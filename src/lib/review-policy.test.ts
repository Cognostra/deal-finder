import { describe, expect, it } from "vitest";
import type { ResolvedDealConfig } from "../config.js";
import type { ScanResultItem, Watch } from "../types.js";
import { applyReviewJsonToSnapshot, buildScanReviewCandidate, describeReviewPolicy } from "./review-policy.js";

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
    allowedHosts: undefined,
    blockedHosts: undefined,
    firecrawlApiKey: undefined,
    firecrawlBaseUrl: "https://api.firecrawl.dev",
    llmReview: {
      mode: "queue",
      lowConfidenceThreshold: 60,
      maxReviewsPerScan: 3,
      allowPriceRewrite: false,
      allowIdentityRewrite: true,
      provider: undefined,
      model: undefined,
      timeoutMs: 30_000,
    },
    discovery: {
      enabled: false,
      provider: "off",
      maxSearchResults: 5,
      maxFetches: 5,
      allowedHosts: undefined,
      blockedHosts: undefined,
      timeoutMs: 25_000,
    },
    ...overrides,
  };
}

const watch: Watch = {
  id: "watch-1",
  url: "http://shop.test/item",
  enabled: true,
  createdAt: "2026-03-20T00:00:00.000Z",
  lastSnapshot: {
    title: "Mystery Listing",
    canonicalTitle: "mystery listing",
    fetchedAt: "2026-03-20T00:00:00.000Z",
    rawSnippet: "Mystery Listing",
  },
};

const lowConfidenceResult: ScanResultItem = {
  watchId: "watch-1",
  url: "http://shop.test/item",
  fetchSource: "node_http",
  fetchSourceNote: "Fetched directly over HTTP by the Node engine.",
  ok: true,
  changed: true,
  changeType: "first_seen",
  changeReasons: ["Initial snapshot captured for this watch."],
  alertSeverity: "none",
  alertScore: 0,
  extractionConfidence: {
    score: 30,
    level: "low",
    reasons: ["Only a title was extracted."],
  },
  summaryLine: "Mystery Listing: no price extracted",
  timingMs: { fetch: 1, parse: 1, total: 2 },
  after: {
    title: "Mystery Listing",
    canonicalTitle: "mystery listing",
    fetchedAt: "2026-03-20T00:00:00.000Z",
    rawSnippet: "Mystery Listing",
  },
  extracted: {
    title: "Mystery Listing",
    canonicalTitle: "mystery listing",
    snippet: "Mystery Listing",
  },
  alerts: [],
  reviewMode: "off",
  reviewQueued: false,
  reviewApplied: false,
  reviewWarnings: [],
  reviewedFields: [],
};

describe("buildScanReviewCandidate", () => {
  it("creates a candidate for low-confidence successful scans", () => {
    const candidate = buildScanReviewCandidate(watch, lowConfidenceResult, makeConfig());
    expect(candidate).toMatchObject({
      watchId: "watch-1",
      type: "extraction_review",
      priority: "medium",
    });
  });

  it("skips candidate creation when review mode is off", () => {
    expect(buildScanReviewCandidate(watch, lowConfidenceResult, makeConfig({
      llmReview: { ...makeConfig().llmReview, mode: "off" },
    }))).toBeNull();
  });
});

describe("applyReviewJsonToSnapshot", () => {
  it("adds reviewed provenance and respects disabled price rewrites", () => {
    const applied = applyReviewJsonToSnapshot(
      {
        title: "Mystery Listing",
        canonicalTitle: "mystery listing",
        price: 50,
        currency: "USD",
        fetchedAt: "2026-03-20T00:00:00.000Z",
      },
      {
        title: "Reviewed Widget",
        price: 19.99,
        currency: "USD",
        brand: "Acme",
        confidence: { level: "medium", reasons: ["Filled sparse extraction."] },
      },
      {
        reviewSource: "deal_scan_auto_assist",
        candidateType: "extraction_review",
        provider: "ollama",
        model: "qwen2.5:1.5b",
      },
      makeConfig(),
    );

    expect(applied.snapshot.title).toBe("Reviewed Widget");
    expect(applied.snapshot.brand).toBe("Acme");
    expect(applied.snapshot.price).toBe(50);
    expect(applied.reviewedFields).toEqual(["title", "canonicalTitle", "brand"]);
    expect(applied.warnings.some((warning) => warning.includes("price"))).toBe(true);
    expect(applied.snapshot.reviewedFields?.[0]).toMatchObject({
      reviewSource: "deal_scan_auto_assist",
      provider: "ollama",
      model: "qwen2.5:1.5b",
    });
  });
});

describe("describeReviewPolicy", () => {
  it("describes effective mode and thresholds", () => {
    const description = describeReviewPolicy(makeConfig());
    expect(description.mode).toBe("queue");
    expect(description.lowConfidenceThreshold).toBe(60);
    expect(description.summary).toContain("queued");
  });
});
