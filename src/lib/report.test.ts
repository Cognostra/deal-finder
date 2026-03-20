import { describe, expect, it } from "vitest";
import type { ResolvedDealConfig } from "../config.js";
import type { StoreFile } from "../types.js";
import {
  buildAlertsSummary,
  buildDoctorSummary,
  buildHealthSummary,
  buildHistorySummary,
  buildSampleSetup,
  buildStoreReport,
} from "./report.js";

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
    expect(sample.allowlist).toContain("deal_history");
    expect(sample.examplePrompts.length).toBeGreaterThan(0);
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
