import { vi, afterEach, describe, expect, it } from "vitest";
import type { ResolvedDealConfig } from "../config.js";
import type { StoreFile, WatchSnapshot } from "../types.js";
import { extractListing, hashSnippet } from "./heuristics.js";

const { cappedFetchMock } = vi.hoisted(() => ({
  cappedFetchMock: vi.fn(),
}));

vi.mock("./fetch.js", () => ({
  cappedFetch: cappedFetchMock,
}));

import { mergeCommittedScanResults, runScan } from "./engine.js";

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
    ...overrides,
  };
}

function makeApi() {
  return {
    logger: {
      debug: vi.fn(),
    },
  } as unknown as import("openclaw/plugin-sdk").OpenClawPluginApi;
}

function makeStore(snapshot?: WatchSnapshot, overrides: Partial<StoreFile["watches"][number]> = {}): StoreFile {
  return {
    version: 1,
    watches: [
      {
        id: "watch-1",
        url: "http://shop.test/item",
        enabled: true,
        createdAt: "2026-03-19T00:00:00.000Z",
        ...overrides,
        lastSnapshot: snapshot,
      },
    ],
  };
}

function snapshotFromHtml(html: string): WatchSnapshot {
  const extracted = extractListing(html);
  const rawSnippet = extracted.snippet?.slice(0, 2000);
  return {
    title: extracted.title,
    canonicalTitle: extracted.canonicalTitle,
    price: extracted.price,
    currency: extracted.currency,
    contentHash: rawSnippet ? hashSnippet(rawSnippet) : undefined,
    rawSnippet,
    fetchedAt: "2026-03-19T00:00:00.000Z",
  };
}

afterEach(() => {
  cappedFetchMock.mockReset();
});

describe("runScan", () => {
  it("produces first-seen alerts for max price and keywords", async () => {
    const text = `
      <meta property="og:title" content="Poetry Book" />
      <p>Only $50.00 today</p>
      <div>Great poetry deal</div>
    `;
    cappedFetchMock.mockResolvedValue({
      meta: { status: 200, finalUrl: "http://shop.test/item", bytesRead: text.length },
      text,
    });

    const [result] = await runScan({
      api: makeApi(),
      cfg: makeConfig(),
      store: makeStore(undefined, { label: "Books Demo", maxPrice: 60, keywords: ["poetry"] }),
      storePath: "/tmp/unused.json",
      commit: false,
    });

    expect(result.ok).toBe(true);
    expect(result.changeType).toBe("first_seen");
    expect(result.alerts).toContain("price_50_at_or_below_max_60");
    expect(result.alerts).toContain("keyword:poetry");
    expect(result.alertSeverity).toBe("high");
    expect(result.summaryLine).toContain("first snapshot");
    expect(result.fetchSource).toBe("node_http");
    expect(result.fetchSourceNote).toContain("Node engine");
    expect(result.after?.canonicalTitle).toBe("poetry book");
  });

  it("flags percent drops and price glitches", async () => {
    cappedFetchMock
      .mockResolvedValueOnce({
        meta: { status: 200, finalUrl: "http://shop.test/item", bytesRead: 32 },
        text: `<meta property="og:title" content="Widget" /><p>$70.00</p>`,
      })
      .mockResolvedValueOnce({
        meta: { status: 200, finalUrl: "http://shop.test/item", bytesRead: 31 },
        text: `<meta property="og:title" content="Widget" /><p>$0.01</p>`,
      });

    const before: WatchSnapshot = {
      title: "Widget",
      canonicalTitle: "widget",
      price: 100,
      currency: "USD",
      fetchedAt: "2026-03-19T00:00:00.000Z",
    };

    const [dropResult] = await runScan({
      api: makeApi(),
      cfg: makeConfig(),
      store: makeStore(before, { percentDrop: 20 }),
      storePath: "/tmp/unused.json",
      commit: false,
    });

    expect(dropResult.changeType).toBe("price_drop");
    expect(dropResult.alerts).toContain("price_drop_30.0_percent");

    const [glitchResult] = await runScan({
      api: makeApi(),
      cfg: makeConfig(),
      store: makeStore(before),
      storePath: "/tmp/unused.json",
      commit: false,
    });

    expect(glitchResult.alerts).toContain("possible_price_glitch");
    expect(glitchResult.alertSeverity).toBe("high");
  });

  it("treats identical 200 responses as unchanged", async () => {
    const html = `<meta property="og:title" content="Same Widget" /><p>$50.00</p>`;
    const extracted = extractListing(html);
    const rawSnippet = extracted.snippet?.slice(0, 2000);
    const before: WatchSnapshot = {
      title: extracted.title,
      canonicalTitle: extracted.canonicalTitle,
      price: extracted.price,
      currency: extracted.currency,
      contentHash: rawSnippet ? hashSnippet(rawSnippet) : undefined,
      rawSnippet,
      fetchedAt: "2026-03-19T00:00:00.000Z",
    };

    cappedFetchMock.mockResolvedValue({
      meta: { status: 200, finalUrl: "http://shop.test/item", bytesRead: html.length },
      text: html,
    });

    const [result] = await runScan({
      api: makeApi(),
      cfg: makeConfig(),
      store: makeStore(before),
      storePath: "/tmp/unused.json",
      commit: false,
    });

    expect(result.changeType).toBe("unchanged");
    expect(result.changed).toBe(false);
    expect(result.alerts).toEqual([]);
  });

  it("reuses the previous snapshot for 304 responses", async () => {
    const before: WatchSnapshot = {
      title: "Widget",
      canonicalTitle: "widget",
      price: 51.77,
      currency: "GBP",
      etag: '"etag"',
      lastModified: "Wed, 08 Feb 2023 21:02:32 GMT",
      fetchedAt: "2026-03-19T00:00:00.000Z",
      contentHash: "abc123",
      rawSnippet: "same",
    };

    cappedFetchMock.mockResolvedValue({
      meta: {
        status: 304,
        finalUrl: "http://shop.test/item",
        bytesRead: 0,
        notModified: true,
        etag: before.etag,
        lastModified: before.lastModified,
      },
      text: "",
    });

    const [result] = await runScan({
      api: makeApi(),
      cfg: makeConfig(),
      store: makeStore(before, { label: "Books Demo" }),
      storePath: "/tmp/unused.json",
      commit: false,
    });

    expect(result.changeType).toBe("not_modified");
    expect(result.changed).toBe(false);
    expect(result.after).toEqual(before);
    expect(result.extractionConfidence.level).toBe("high");
    expect(result.summaryLine).toContain("unchanged");
    expect(result.fetchSource).toBe("node_http");
  });

  it("treats HTTP error responses as fetch failures", async () => {
    cappedFetchMock.mockResolvedValue({
      meta: { status: 503, finalUrl: "http://shop.test/item", bytesRead: 12 },
      text: "upstream down",
    });

    const [result] = await runScan({
      api: makeApi(),
      cfg: makeConfig(),
      store: makeStore(),
      storePath: "/tmp/unused.json",
      commit: false,
    });

    expect(result.ok).toBe(false);
    expect(result.changeType).toBe("fetch_failed");
    expect(result.error).toBe("HTTP 503");
    expect(result.fetchSource).toBe("node_http");
  });

  it("marks Firecrawl scans explicitly in the result metadata", async () => {
    const html = `<meta property="og:title" content="Widget" /><p>$45.00</p>`;
    cappedFetchMock.mockResolvedValue({
      meta: { status: 200, finalUrl: "http://shop.test/item", bytesRead: html.length },
      text: html,
    });

    const [result] = await runScan({
      api: makeApi(),
      cfg: makeConfig({ fetcher: "firecrawl" }),
      store: makeStore(),
      storePath: "/tmp/unused.json",
      commit: false,
    });

    expect(result.fetchSource).toBe("firecrawl");
    expect(result.fetchSourceNote).toContain("Firecrawl");
  });

  const fixtures = [
    {
      name: "price drop with alerting",
      beforeHtml: `<meta property="og:title" content="Widget" /><p>$100.00</p><div>standard edition</div>`,
      afterHtml: `<meta property="og:title" content="Widget" /><p>$75.00</p><div>rare sale today</div>`,
      watch: { percentDrop: 20, keywords: ["rare"] },
      expected: {
        changeType: "price_drop",
        changed: true,
        currentPrice: 75,
        currentCurrency: "USD",
        alerts: ["price_drop_25.0_percent", "keyword:rare"],
        alertSeverity: "high",
      },
    },
    {
      name: "content-only change",
      beforeHtml: `<meta property="og:title" content="Widget" /><p>$50.00</p><div>old copy</div>`,
      afterHtml: `<meta property="og:title" content="Widget Deluxe" /><p>$50.00</p><div>new copy</div>`,
      watch: {},
      expected: {
        changeType: "content_changed",
        changed: true,
        currentPrice: 50,
        currentCurrency: "USD",
        alerts: [],
        alertSeverity: "none",
      },
    },
  ] satisfies Array<{
    name: string;
    beforeHtml: string;
    afterHtml: string;
    watch: Partial<StoreFile["watches"][number]>;
    expected: {
      changeType: string;
      changed: boolean;
      currentPrice?: number;
      currentCurrency?: string;
      alerts: string[];
      alertSeverity: string;
    };
  }>;

  for (const fixture of fixtures) {
    it(`matches expected outputs for fixture: ${fixture.name}`, async () => {
      const before = snapshotFromHtml(fixture.beforeHtml);
      const store = makeStore(before, fixture.watch);
      const meta = {
        status: 200,
        finalUrl: "http://shop.test/item",
        bytesRead: fixture.afterHtml.length,
      };

      cappedFetchMock.mockResolvedValue({
        meta,
        text: fixture.afterHtml,
      });

      const [nodeResult] = await runScan({
        api: makeApi(),
        cfg: makeConfig(),
        store,
        storePath: "/tmp/unused.json",
        commit: false,
      });

      expect(nodeResult.changeType).toBe(fixture.expected.changeType);
      expect(nodeResult.changed).toBe(fixture.expected.changed);
      expect(nodeResult.currentPrice).toBe(fixture.expected.currentPrice);
      expect(nodeResult.currentCurrency).toBe(fixture.expected.currentCurrency);
      expect(nodeResult.alerts).toEqual(fixture.expected.alerts);
      expect(nodeResult.alertSeverity).toBe(fixture.expected.alertSeverity);
      expect(nodeResult.after?.canonicalTitle).toBe(nodeResult.extracted?.canonicalTitle);
    });
  }
});

describe("mergeCommittedScanResults", () => {
  it("skips updates when the watch URL changed during the scan", () => {
    const store = makeStore(undefined, { url: "http://shop.test/new" });
    const summary = mergeCommittedScanResults(
      store,
      [
        {
          watchId: "watch-1",
          url: "http://shop.test/old",
          fetchSource: "node_http",
          fetchSourceNote: "Fetched directly over HTTP by the Node engine.",
          ok: true,
          changed: true,
          changeType: "first_seen",
          changeReasons: ["Initial snapshot captured for this watch."],
          alertSeverity: "none",
          alertScore: 0,
          extractionConfidence: { score: 0, level: "none", reasons: [] },
          summaryLine: "summary",
          timingMs: { fetch: 1, parse: 0, total: 1 },
          after: { fetchedAt: "2026-03-19T00:00:00.000Z", price: 10, canonicalTitle: "widget" },
          alerts: [],
        },
      ],
      makeConfig(),
    );

    expect(summary).toEqual({
      updated: 0,
      skippedMissing: 0,
      skippedUrlChanged: 1,
      skippedInvalidCurrentUrl: 0,
    });
    expect(store.watches[0]?.lastSnapshot).toBeUndefined();
  });
});
