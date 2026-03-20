import { describe, expect, it } from "vitest";
import type { ResolvedDealConfig } from "../config.js";
import type { StoreFile } from "../types.js";
import {
  buildAlertsSummary,
  buildBestPriceBoard,
  buildDoctorSummary,
  buildHealthSummary,
  buildHostReportSummary,
  buildHistorySummary,
  buildLlmReviewQueue,
  buildMarketCheckSummary,
  buildProductGroupsSummary,
  buildQuickstartGuide,
  buildScheduleAdvice,
  buildSampleSetup,
  buildStoreReport,
  buildTaxonomySummary,
  buildTopDropsSummary,
  buildTrendsSummary,
  buildViewReport,
  buildWorkflowBestOpportunities,
  buildWorkflowCleanup,
  buildWorkflowPortfolio,
  buildWorkflowTriage,
  buildWatchIdentitySummary,
  buildWatchInsights,
} from "./report.js";

const store: StoreFile = {
  version: 2,
  savedViews: [],
  watches: [
    {
      id: "watch-1",
      url: "http://shop.test/a",
      label: "Book",
      group: "books",
      tags: ["books", "collectibles"],
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
      history: [
        {
          fetchedAt: "2026-03-18T00:00:00.000Z",
          price: 20,
          currency: "USD",
          canonicalTitle: "rare book",
          changeType: "first_seen",
          alertSeverity: "none",
        },
        {
          fetchedAt: "2026-03-19T00:00:00.000Z",
          price: 15,
          currency: "USD",
          canonicalTitle: "rare book",
          changeType: "price_drop",
          alertSeverity: "high",
          summaryLine: "Rare Book: 15.00 USD; price dropped; high alert",
        },
      ],
    },
    {
      id: "watch-2",
      url: "http://shop.test/b",
      label: "Desk",
      enabled: false,
      createdAt: "2026-03-20T00:00:00.000Z",
    },
    {
      id: "watch-3",
      url: "http://shop.test/c",
      label: "GPU",
      group: "pc-build",
      tags: ["gpu", "pc"],
      enabled: true,
      maxPrice: 100,
      createdAt: "2026-03-20T01:00:00.000Z",
      lastSnapshot: {
        title: "GPU",
        canonicalTitle: "gpu",
        price: 0.01,
        currency: "USD",
        fetchedAt: "2026-03-21T00:00:00.000Z",
        rawSnippet: "flash sale",
      },
      history: [
        {
          fetchedAt: "2026-03-18T00:00:00.000Z",
          price: 150,
          currency: "USD",
          canonicalTitle: "gpu",
          changeType: "first_seen",
          alertSeverity: "none",
        },
        {
          fetchedAt: "2026-03-19T00:00:00.000Z",
          price: 120,
          currency: "USD",
          canonicalTitle: "gpu",
          changeType: "price_drop",
          alertSeverity: "medium",
        },
        {
          fetchedAt: "2026-03-20T00:00:00.000Z",
          price: 145,
          currency: "USD",
          canonicalTitle: "gpu",
          changeType: "price_increase",
          alertSeverity: "low",
        },
        {
          fetchedAt: "2026-03-21T00:00:00.000Z",
          price: 0.01,
          currency: "USD",
          canonicalTitle: "gpu",
          changeType: "price_drop",
          alertSeverity: "high",
          alerts: ["possible_price_glitch"],
          summaryLine: "GPU: 0.01 USD; price dropped; high alert",
        },
      ],
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
      total: 3,
      savedViewCount: 0,
      enabled: 2,
      disabled: 1,
      withSnapshots: 2,
      withHistory: 2,
      withSignals: 2,
    });
    expect(report.topSignals[0]?.watchId).toBe("watch-1");
    expect(report.priceLeaders[0]?.watchId).toBe("watch-3");
    expect(report.recentChanges[0]?.watchId).toBe("watch-3");
    expect(report.noisyWatches[0]?.watchId).toBe("watch-3");
    expect(report.glitchCandidates[0]).toMatchObject({
      watchId: "watch-3",
      glitchScore: 95,
    });
  });
});

describe("buildHealthSummary", () => {
  it("surfaces config facts and recommendations", () => {
    const health = buildHealthSummary(store, cfg, cfg.storePath);
    expect(health).toMatchObject({
      storePath: "/tmp/store.json",
      watchCount: 3,
      enabledCount: 2,
      fetcher: "local",
      blockedHostsConfigured: true,
      allowedHostsConfigured: false,
    });
    expect(health.recommendations.length).toBeGreaterThan(0);
  });
});

describe("buildDoctorSummary", () => {
  it("reports obvious configuration issues and suggested commands", () => {
    const doctor = buildDoctorSummary(store, cfg, cfg.storePath);
    expect(doctor.issueCount).toBeGreaterThan(0);
    expect(doctor.recommendedCommands).toContain("deal_help");
  });
});

describe("buildSampleSetup", () => {
  it("returns install, config, and prompt examples", () => {
    const sample = buildSampleSetup();
    expect(sample.installCommand).toContain("openclaw plugins install");
    expect(sample.allowlist).toContain("deal_watch_add");
    expect(sample.allowlist).toContain("deal_watch_taxonomy");
    expect(sample.allowlist).toContain("deal_host_report");
    expect(sample.allowlist).toContain("deal_history");
    expect(sample.allowlist).toContain("deal_watch_import");
    expect(sample.allowlist).toContain("deal_watch_import_url");
    expect(sample.allowlist).toContain("deal_saved_view_create");
    expect(sample.allowlist).toContain("deal_market_check");
    expect(sample.allowlist).toContain("deal_llm_review_run");
    expect(sample.examplePrompts.length).toBeGreaterThan(0);
  });
});

describe("buildQuickstartGuide", () => {
  it("returns first-run guidance and safety reminders", () => {
    const guide = buildQuickstartGuide();
    expect(guide.installCommand).toContain("openclaw plugins install");
    expect(guide.firstRunChecklist.length).toBeGreaterThan(3);
    expect(guide.firstRunChecklist.some((item) => item.includes("deal_watch_taxonomy"))).toBe(true);
    expect(guide.firstRunChecklist.some((item) => item.includes("deal_host_report"))).toBe(true);
    expect(guide.firstRunChecklist.some((item) => item.includes("deal_llm_review_run"))).toBe(true);
    expect(guide.firstRunChecklist.some((item) => item.includes("deal_watch_import_url"))).toBe(true);
    expect(guide.firstRunChecklist.some((item) => item.includes("deal_saved_view_create"))).toBe(true);
    expect(guide.privacyAndSafety.some((item) => item.includes("allowedHosts"))).toBe(true);
    expect(guide.troubleshooting.some((item) => item.includes("deal_doctor"))).toBe(true);
  });
});

describe("buildTaxonomySummary", () => {
  it("summarizes groups, tags, and suggested saved views", () => {
    const taxonomy = buildTaxonomySummary(store);
    expect(taxonomy).toMatchObject({
      watchCount: 3,
      groupedCount: 2,
      ungroupedCount: 1,
      taggedCount: 2,
      untaggedCount: 1,
    });
    expect(taxonomy.groupBreakdown[0]).toMatchObject({
      group: "books",
      count: 1,
      activeSignals: 1,
    });
    expect(taxonomy.tagBreakdown.some((entry) => entry.tag === "books")).toBe(true);
    expect(taxonomy.suggestedSavedViews.some((view) => view.selector.group === "books")).toBe(false);
  });

  it("suggests saved views for repeated groups and tags", () => {
    const richerStore: StoreFile = {
      ...store,
      watches: [
        ...store.watches,
        {
          id: "watch-4",
          url: "http://shop.test/d",
          label: "GPU 2",
          group: "pc-build",
          tags: ["gpu"],
          enabled: true,
          createdAt: "2026-03-20T02:00:00.000Z",
          lastSnapshot: {
            title: "GPU 2",
            canonicalTitle: "gpu 2",
            price: 95,
            currency: "USD",
            fetchedAt: "2026-03-21T00:00:00.000Z",
          },
        },
      ],
    };
    const taxonomy = buildTaxonomySummary(richerStore);
    expect(taxonomy.suggestedSavedViews.some((view) => view.selector.group === "pc-build")).toBe(true);
    expect(taxonomy.suggestedSavedViews.some((view) => view.selector.tag === "gpu")).toBe(true);
    expect(taxonomy.actionSummary.some((item) => item.includes("Largest current group"))).toBe(true);
  });
});

describe("buildHostReportSummary", () => {
  it("summarizes hosts with signal and cadence context", () => {
    const hostReport = buildHostReportSummary(store);
    expect(hostReport).toMatchObject({
      hostCount: 1,
    });
    expect(hostReport.hosts[0]).toMatchObject({
      host: "shop.test",
      watchCount: 3,
      enabledCount: 2,
      withSnapshots: 2,
      activeSignals: 2,
      mediumOrHigherAlerts: 2,
      noisyCount: 1,
      glitchyCount: 1,
    });
    expect(hostReport.actionSummary.some((item) => item.includes("Most time-sensitive host cadence"))).toBe(true);
  });
});

describe("buildHistorySummary", () => {
  it("summarizes bounds and recent entries for one watch", () => {
    const history = buildHistorySummary(store.watches[0]!, 1);
    expect(history).toMatchObject({
      watchId: "watch-1",
      historyCount: 2,
      lowestSeenPrice: 15,
      highestSeenPrice: 20,
      priceDelta: -5,
      percentDelta: -25,
    });
    expect(history.recent).toHaveLength(1);
    expect(history.recent[0]?.price).toBe(15);
  });
});

describe("buildAlertsSummary", () => {
  it("surfaces watches with active signals or recent high-severity history", () => {
    const alerts = buildAlertsSummary(store, "medium");
    expect(alerts.count).toBe(2);
    expect(alerts.alerts[0]).toMatchObject({
      watchId: "watch-3",
      severity: "high",
      latestPrice: 0.01,
      glitchScore: 95,
    });
    expect(alerts.alerts[1]).toMatchObject({
      watchId: "watch-1",
      severity: "high",
      latestPrice: 15,
      lowestSeenPrice: 15,
    });
  });
});

describe("buildTrendsSummary", () => {
  it("classifies volatile and falling watches with sparkline context", () => {
    const trends = buildTrendsSummary(store, 10);
    expect(trends.count).toBeGreaterThan(0);
    expect(trends.trends.find((item) => item.watchId === "watch-3")).toMatchObject({
      direction: "volatile",
      trend: "volatile",
    });
    expect(trends.trends.find((item) => item.watchId === "watch-1")).toMatchObject({
      direction: "down",
      trend: "falling",
    });
  });
});

describe("buildTopDropsSummary", () => {
  it("ranks watches by distance from peak and latest change", () => {
    const peak = buildTopDropsSummary(store, "vs_peak", 5);
    expect(peak.drops[0]).toMatchObject({
      watchId: "watch-3",
      savingsPercentFromPeak: 100,
    });

    const latest = buildTopDropsSummary(store, "latest_change", 5);
    expect(latest.drops[0]).toMatchObject({
      watchId: "watch-3",
    });
    expect((latest.drops[0]?.recentPercentDelta ?? 0)).toBeLessThan(0);
  });
});

describe("buildWatchInsights", () => {
  it("explains one watch with volatility and glitch context", () => {
    const insights = buildWatchInsights(store.watches[2]!);
    expect(insights).toMatchObject({
      watchId: "watch-3",
      historyCount: 4,
    });
    expect(insights.trend.direction).toBe("volatile");
    expect(insights.glitch.score).toBeGreaterThanOrEqual(90);
    expect(insights.sparkline.length).toBeGreaterThan(0);
    expect(insights.identity).toEqual([]);
  });
});

describe("buildWatchIdentitySummary", () => {
  it("summarizes stored identifiers and related watches", () => {
    const identityStore: StoreFile = {
      version: 2,
      savedViews: [],
      watches: [
        {
          id: "watch-a",
          url: "http://shop.test/a",
          label: "Headphones A",
          enabled: true,
          createdAt: "2026-03-20T00:00:00.000Z",
          lastSnapshot: {
            title: "Sony WH-1000XM5 Wireless Headphones",
            canonicalTitle: "sony wh-1000xm5 wireless headphones",
            brand: "Sony",
            modelId: "WH-1000XM5",
            sku: "6505727",
            price: 299.99,
            currency: "USD",
            fetchedAt: "2026-03-20T00:00:00.000Z",
          },
        },
        {
          id: "watch-b",
          url: "http://shop.test/b",
          label: "Headphones B",
          enabled: true,
          createdAt: "2026-03-20T00:05:00.000Z",
          lastSnapshot: {
            title: "Sony WH-1000XM5",
            canonicalTitle: "sony wh-1000xm5",
            brand: "Sony",
            modelId: "WH-1000XM5",
            price: 279.99,
            currency: "USD",
            fetchedAt: "2026-03-20T00:05:00.000Z",
          },
        },
      ],
    };

    const summary = buildWatchIdentitySummary(identityStore, identityStore.watches[0]!);
    expect(summary.strength).toBe("high");
    expect(summary.identifiers).toContainEqual({ field: "modelId", value: "WH-1000XM5" });
    expect(summary.relatedWatches[0]).toMatchObject({
      watchId: "watch-b",
      sharedFields: ["brand", "modelId"],
    });
  });
});

describe("buildMarketCheckSummary", () => {
  it("compares likely same-product watches and summarizes spread", () => {
    const marketStore: StoreFile = {
      version: 2,
      savedViews: [],
      watches: [
        {
          id: "watch-a",
          url: "http://shop.test/a",
          label: "Headphones A",
          enabled: true,
          createdAt: "2026-03-20T00:00:00.000Z",
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
        },
        {
          id: "watch-b",
          url: "http://shop.test/b",
          label: "Headphones B",
          enabled: true,
          createdAt: "2026-03-20T00:05:00.000Z",
          lastSnapshot: {
            title: "Sony WH-1000XM5",
            canonicalTitle: "sony wh-1000xm5",
            brand: "Sony",
            modelId: "WH-1000XM5",
            price: 279.99,
            currency: "USD",
            fetchedAt: "2026-03-20T00:05:00.000Z",
          },
        },
        {
          id: "watch-c",
          url: "http://shop.test/c",
          label: "Different Product",
          enabled: true,
          createdAt: "2026-03-20T00:10:00.000Z",
          lastSnapshot: {
            title: "Desk Lamp",
            canonicalTitle: "desk lamp",
            brand: "Acme",
            price: 19.99,
            currency: "USD",
            fetchedAt: "2026-03-20T00:10:00.000Z",
          },
        },
      ],
    };

    const summary = buildMarketCheckSummary(marketStore, marketStore.watches[0]!);
    expect(summary.matchCount).toBe(1);
    expect(summary.bestKnownPrice).toBe(279.99);
    expect(summary.highestKnownPrice).toBe(299.99);
    expect(summary.spread).toEqual({
      absolute: 20,
      percentFromBest: 7.1,
    });
    expect(summary.matches[0]).toMatchObject({
      watchId: "watch-b",
      matchScore: 100,
    });
  });
});

describe("buildProductGroupsSummary", () => {
  it("clusters likely same-product watches into explainable groups", () => {
    const marketStore: StoreFile = {
      version: 2,
      savedViews: [],
      watches: [
        {
          id: "watch-a",
          url: "http://shop.test/a",
          label: "Headphones A",
          enabled: true,
          createdAt: "2026-03-20T00:00:00.000Z",
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
        },
        {
          id: "watch-b",
          url: "http://alt-shop.test/b",
          label: "Headphones B",
          enabled: true,
          createdAt: "2026-03-20T00:05:00.000Z",
          lastSnapshot: {
            title: "Sony WH-1000XM5",
            canonicalTitle: "sony wh-1000xm5",
            brand: "Sony",
            modelId: "WH-1000XM5",
            price: 279.99,
            currency: "USD",
            fetchedAt: "2026-03-20T00:05:00.000Z",
          },
        },
        {
          id: "watch-c",
          url: "http://other.test/c",
          label: "Desk Lamp",
          enabled: true,
          createdAt: "2026-03-20T00:10:00.000Z",
          lastSnapshot: {
            title: "Desk Lamp",
            canonicalTitle: "desk lamp",
            brand: "Acme",
            price: 19.99,
            currency: "USD",
            fetchedAt: "2026-03-20T00:10:00.000Z",
          },
        },
      ],
    };

    const groups = buildProductGroupsSummary(marketStore);
    expect(groups.groupCount).toBe(1);
    expect(groups.groupedWatchCount).toBe(2);
    expect(groups.groups[0]).toMatchObject({
      watchCount: 2,
      bestPrice: 279.99,
      highestPrice: 299.99,
      bestWatchId: "watch-b",
    });
    expect(groups.groups[0]?.matchBasis.some((value) => value.includes("modelId=WH-1000XM5"))).toBe(true);
  });
});

describe("buildBestPriceBoard", () => {
  it("ranks grouped same-product opportunities by internal spread", () => {
    const marketStore: StoreFile = {
      version: 2,
      savedViews: [],
      watches: [
        {
          id: "watch-a",
          url: "http://shop.test/a",
          label: "Headphones A",
          enabled: true,
          createdAt: "2026-03-20T00:00:00.000Z",
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
        },
        {
          id: "watch-b",
          url: "http://alt-shop.test/b",
          label: "Headphones B",
          enabled: true,
          createdAt: "2026-03-20T00:05:00.000Z",
          lastSnapshot: {
            title: "Sony WH-1000XM5",
            canonicalTitle: "sony wh-1000xm5",
            brand: "Sony",
            modelId: "WH-1000XM5",
            price: 279.99,
            currency: "USD",
            fetchedAt: "2026-03-20T00:05:00.000Z",
          },
        },
      ],
    };

    const board = buildBestPriceBoard(marketStore);
    expect(board.groupCount).toBe(1);
    expect(board.opportunities[0]).toMatchObject({
      bestWatchId: "watch-b",
      bestHost: "alt-shop.test",
      bestPrice: 279.99,
      highestPrice: 299.99,
      alternateCount: 1,
    });
    expect(board.opportunities[0]?.spread).toEqual({
      absolute: 20,
      percentFromBest: 7.1,
    });
  });
});

describe("buildLlmReviewQueue", () => {
  it("prepares low-confidence extraction and identity cases without auto-invoking an LLM", () => {
    const reviewStore: StoreFile = {
      version: 2,
      savedViews: [],
      watches: [
        {
          id: "watch-1",
          url: "http://shop.test/a",
          label: "Weak Extraction",
          enabled: true,
          createdAt: "2026-03-20T00:00:00.000Z",
          lastSnapshot: {
            title: "Mystery Product",
            canonicalTitle: "mystery product",
            fetchedAt: "2026-03-20T00:00:00.000Z",
          },
        },
        {
          id: "watch-2",
          url: "http://shop.test/b",
          label: "Peer A",
          enabled: true,
          createdAt: "2026-03-20T00:01:00.000Z",
          lastSnapshot: {
            title: "Sony WH-1000XM5",
            canonicalTitle: "sony wh-1000xm5",
            fetchedAt: "2026-03-20T00:01:00.000Z",
            price: 299.99,
            currency: "USD",
          },
        },
        {
          id: "watch-3",
          url: "http://alt-shop.test/c",
          label: "Peer B",
          enabled: true,
          createdAt: "2026-03-20T00:02:00.000Z",
          lastSnapshot: {
            title: "Sony WH-1000XM5 Wireless Headphones",
            canonicalTitle: "sony wh-1000xm5",
            fetchedAt: "2026-03-20T00:02:00.000Z",
            price: 279.99,
            currency: "USD",
          },
        },
      ],
    };

    const queue = buildLlmReviewQueue(reviewStore, 10);
    expect(queue.integrationStatus).toBe("deferred_cleanly");
    expect(queue.candidateCount).toBeGreaterThanOrEqual(2);
    expect(queue.candidates.find((item) => item.watchId === "watch-1")).toMatchObject({
      type: "extraction_review",
      priority: "medium",
    });
    expect(queue.candidates.find((item) => item.watchId === "watch-2")).toMatchObject({
      type: "identity_resolution",
      priority: "medium",
    });
  });
});

describe("buildScheduleAdvice", () => {
  it("recommends cadence by host and watch", () => {
    const hostAdvice = buildScheduleAdvice(store, "host");
    expect(hostAdvice.recommendations[0]).toMatchObject({
      target: "shop.test",
    });
    expect(hostAdvice.recommendations[0]?.recommendedMinutes).toBeGreaterThanOrEqual(30);

    const watchAdvice = buildScheduleAdvice(store, "watch");
    expect(watchAdvice.recommendations.some((item) => item.target === "watch-1")).toBe(true);
  });
});

describe("buildViewReport", () => {
  it("composes a compact multi-signal report for a scoped watch subset", () => {
    const scoped = buildViewReport(store, [store.watches[0]!, store.watches[2]!], {
      limit: 5,
      severity: "medium",
      metric: "vs_peak",
    });

    expect(scoped.scopedCount).toBe(2);
    expect(scoped.alerts.count).toBe(2);
    expect(scoped.topDrops.drops[0]?.watchId).toBe("watch-3");
    expect(scoped.bestOpportunities.topRealDeals[0]?.watchId).toBe("watch-1");
  });
});

describe("buildWorkflowBestOpportunities", () => {
  it("separates likely-real deals from suspicious glitch candidates", () => {
    const summary = buildWorkflowBestOpportunities(store, 5);

    expect(summary.watchCount).toBe(3);
    expect(summary.topRealDeals[0]).toMatchObject({
      watchId: "watch-1",
      severity: "high",
    });
    expect(summary.suspiciousDeals[0]).toMatchObject({
      watchId: "watch-3",
      glitchScore: 95,
    });
    expect(summary.strongestAlerts.length).toBeGreaterThan(0);
  });
});

describe("buildWorkflowCleanup", () => {
  it("surfaces no-snapshot, weak-extraction, and noisy cleanup candidates", () => {
    const cleanup = buildWorkflowCleanup(store, 10);

    expect(cleanup.noSnapshot).toContainEqual({
      watchId: "watch-2",
      label: "Desk",
      url: "http://shop.test/b",
      enabled: false,
    });
    expect(cleanup.weakExtraction.some((item) => item.watchId === "watch-2")).toBe(true);
    expect(cleanup.noisyWatches[0]?.watchId).toBe("watch-3");
  });
});

describe("buildWorkflowPortfolio", () => {
  it("builds an executive portfolio dashboard from the current store", () => {
    const portfolio = buildWorkflowPortfolio(store, 5);

    expect(portfolio.watchCount).toBe(3);
    expect(portfolio.overview.total).toBe(3);
    expect(portfolio.strongestAlerts.alerts[0]?.watchId).toBe("watch-3");
    expect(portfolio.topDrops.drops.length).toBeGreaterThan(0);
  });
});

describe("buildWorkflowTriage", () => {
  it("answers what changed, what matters, and what looks noisy", () => {
    const triage = buildWorkflowTriage(store, 5, "medium");

    expect(triage.changed[0]?.watchId).toBe("watch-3");
    expect(triage.bestOpportunity).toMatchObject({
      watchId: "watch-1",
    });
    expect(triage.probableNoise[0]?.watchId).toBe("watch-3");
  });
});
