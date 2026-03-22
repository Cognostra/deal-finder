import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedDealConfig } from "../config.js";
import { writeFile } from "node:fs/promises";
import { addSavedView, addWatch, loadStore, saveStore, type ImportedWatchInput } from "../lib/store.js";
import { createJsonStoreMaintenancePort } from "./json-maintenance.js";
import type { ScanResultItem, StoreFile, Watch } from "../types.js";
import { createJsonSavedViewRepository, createJsonWatchRepository } from "./json-repositories.js";
import { createDiscoveryService } from "./services/discovery-service.js";
import { createReportingService } from "./services/reporting-service.js";
import { createReviewService } from "./services/review-service.js";
import { createSavedViewService } from "./services/saved-view-service.js";
import { createScanCommitService, createScanExecutionService } from "./services/scan-service.js";
import { createWatchService } from "./services/watch-service.js";

let tempDirs: string[] = [];

async function makeRuntime() {
  const dir = await mkdtemp(join(tmpdir(), "deal-hunter-core-services-"));
  tempDirs.push(dir);
  const storePath = join(dir, "store.json");
  const withStore = async <T>(fn: (store: StoreFile) => Promise<T>) => {
    const store = await loadStore(storePath);
    return fn(store);
  };
  return {
    storePath,
    withStore,
    watchRepository: createJsonWatchRepository({ storePath, withStore }),
    savedViewRepository: createJsonSavedViewRepository({ storePath, withStore }),
  };
}

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

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("json repositories", () => {
  it("persist watch and saved-view operations behind repository contracts", async () => {
    const runtime = await makeRuntime();
    const watch = await runtime.watchRepository.add({
      url: "https://shop.test/item",
      label: "Widget",
      enabled: true,
    });
    expect((await runtime.watchRepository.get(watch.id))?.label).toBe("Widget");

    const savedView = await runtime.savedViewRepository.create({
      name: "Widgets",
      selector: { query: "widget" },
    });
    const selection = await runtime.savedViewRepository.resolveSelection(savedView.id);
    expect(selection.savedView.name).toBe("Widgets");
    expect(selection.watches).toHaveLength(1);
  });

  it("round-trips import and export through the repository layer", async () => {
    const runtime = await makeRuntime();
    const watches: ImportedWatchInput[] = [
      { url: "https://shop.test/a", label: "Alpha" },
      { url: "https://shop.test/b", label: "Bravo" },
    ];
    expect((await runtime.watchRepository.importWatches(watches, "append")).added).toBe(2);
    expect((await runtime.watchRepository.exportWatches({})).count).toBe(2);
  });

  it("inspects JSON stores and reports recoverable entry-level corruption", async () => {
    const runtime = await makeRuntime();
    await writeFile(
      runtime.storePath,
      JSON.stringify({
        version: 2,
        watches: [
          {
            id: "watch-1",
            url: "https://shop.test/a",
            enabled: true,
            createdAt: "2026-03-20T00:00:00.000Z",
          },
          {
            id: "watch-2",
            label: "Broken",
          },
        ],
        savedViews: [
          {
            id: "view-1",
            name: "All",
            createdAt: "2026-03-20T00:00:00.000Z",
            selector: { query: "gpu", limit: 10 },
          },
          {
            id: "",
            name: "Broken",
            createdAt: "2026-03-20T00:00:00.000Z",
          },
        ],
      }),
      "utf8",
    );

    const inspection = await createJsonStoreMaintenancePort({ storePath: runtime.storePath }).inspect();
    expect(inspection.recovered).toBe(true);
    expect(inspection.store.watches).toHaveLength(1);
    expect(inspection.store.savedViews).toHaveLength(1);
    expect(inspection.warnings.join("\n")).toMatch(/Dropped watch/);
    expect(inspection.warnings.join("\n")).toMatch(/Dropped saved view/);
  });
});

describe("core services", () => {
  it("generate reports through the reporting service", async () => {
    const runtime = await makeRuntime();
    const store: StoreFile = { version: 2, watches: [], savedViews: [] };
    const watch = addWatch(store, {
      url: "https://shop.test/gpu",
      label: "GPU",
      enabled: true,
      lastSnapshot: {
        title: "GPU",
        canonicalTitle: "gpu",
        price: 499.99,
        currency: "USD",
        fetchedAt: "2026-03-20T00:00:00.000Z",
      },
      history: [
        {
          fetchedAt: "2026-03-20T00:00:00.000Z",
          price: 499.99,
          currency: "USD",
          canonicalTitle: "gpu",
          changeType: "price_drop",
          alertSeverity: "high",
          summaryLine: "GPU: 499.99 USD; price dropped; high alert",
        },
      ],
    });
    addSavedView(store, {
      name: "GPU alerts",
      selector: { query: "gpu" },
    });
    await saveStore(runtime.storePath, store);

    const reporting = createReportingService({
      watchRepository: runtime.watchRepository,
      savedViewRepository: runtime.savedViewRepository,
    });

    const digest = await reporting.getDigest({ severity: "medium" });
    const history = await reporting.getHistory({ watchId: watch.id, limit: 5 });

    expect(digest).toMatchObject({ headline: expect.any(String) });
    expect(history).toMatchObject({ watchId: watch.id });
  });

  it("handle watch lifecycle operations through the watch service", async () => {
    const runtime = await makeRuntime();
    const watchService = createWatchService({ watchRepository: runtime.watchRepository });
    const cfg = makeConfig();

    const added = await watchService.add(
      {
        url: "https://shop.test/item?ref=abc",
        label: "Widget",
        enabled: true,
      },
      cfg,
    );
    expect(added.url).toBe("https://shop.test/item?ref=abc");
    expect((await watchService.list()).map((watch) => watch.id)).toContain(added.id);

    const updated = await watchService.update(
      added.id,
      {
        url: "https://shop.test/item?ref=def",
        label: "Widget 2",
      },
      cfg,
    );
    expect(updated?.label).toBe("Widget 2");
    expect(updated?.url).toBe("https://shop.test/item?ref=def");

    const enabledResult = await watchService.setEnabled([added.id], false);
    expect(enabledResult.updatedIds).toEqual([added.id]);
    expect((await watchService.list()).map((watch) => watch.id)).not.toContain(added.id);
    expect((await watchService.list(true)).map((watch) => watch.id)).toContain(added.id);
  });

  it("handle saved-view lifecycle operations through the saved-view service", async () => {
    const runtime = await makeRuntime();
    const watchService = createWatchService({ watchRepository: runtime.watchRepository });
    const savedViewService = createSavedViewService({
      watchRepository: runtime.watchRepository,
      savedViewRepository: runtime.savedViewRepository,
    });
    const cfg = makeConfig();

    const watch = await watchService.add(
      {
        url: "https://shop.test/gpu",
        label: "GPU",
        enabled: true,
      },
      cfg,
    );
    const created = await savedViewService.create({
      name: "GPUs",
      selector: { query: "gpu" },
    });

    expect(created.name).toBe("GPUs");
    expect(created.matchCount).toBe(1);

    const run = await savedViewService.run(created.id);
    expect(run.watchIds).toEqual([watch.id]);

    const updated = await savedViewService.update(created.id, {
      name: "GPU Deals",
    });
    expect(updated.name).toBe("GPU Deals");

    await expect(savedViewService.create({
      name: "gpu deals",
      selector: { query: "gpu" },
    })).rejects.toThrow(/already exists/);

    await expect(savedViewService.remove(created.id)).resolves.toBe(true);
  });

  it("describe review policy and review candidate selection through the review service", () => {
    const reviewService = createReviewService();
    const watch: Watch = {
      id: "watch-1",
      url: "https://shop.test/item",
      enabled: true,
      createdAt: "2026-03-20T00:00:00.000Z",
      lastSnapshot: {
        title: "Sparse Listing",
        canonicalTitle: "sparse listing",
        fetchedAt: "2026-03-20T00:00:00.000Z",
      },
    };
    const result: ScanResultItem = {
      watchId: "watch-1",
      url: "https://shop.test/item",
      fetchSource: "node_http",
      fetchSourceNote: "Fetched directly over HTTP by the Node engine.",
      responseTruncated: false,
      ok: true,
      changed: true,
      changeType: "first_seen",
      changeReasons: ["Initial snapshot captured."],
      alertSeverity: "none",
      alertScore: 0,
      extractionConfidence: { score: 30, level: "low", reasons: ["Only title extracted."] },
      summaryLine: "Sparse Listing: no price extracted",
      timingMs: { fetch: 1, parse: 1, total: 2 },
      after: {
        title: "Sparse Listing",
        canonicalTitle: "sparse listing",
        fetchedAt: "2026-03-20T00:00:00.000Z",
      },
      alerts: [],
      reviewMode: "off",
      reviewQueued: false,
      reviewApplied: false,
      reviewWarnings: [],
      reviewedFields: [],
    };
    expect(reviewService.describePolicy(makeConfig()).mode).toBe("queue");
    expect(reviewService.buildScanCandidate(watch, result, makeConfig())?.type).toBe("extraction_review");
  });

  it("run scan and commit reconciliation through scan services", async () => {
    const reviewService = createReviewService();
    const scanExecution = createScanExecutionService(reviewService);
    const scanCommit = createScanCommitService();
    const store: StoreFile = {
      version: 2,
      savedViews: [],
      watches: [
        {
          id: "watch-1",
          url: "not a url",
          label: "Broken",
          enabled: true,
          createdAt: "2026-03-20T00:00:00.000Z",
        },
      ],
    };

    const results = await scanExecution.run({
      cfg: makeConfig(),
      store,
      logger: { debug: vi.fn() },
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(false);
    expect(scanCommit.merge(store, results, makeConfig())).toEqual({
      updated: 0,
      skippedMissing: 0,
      skippedUrlChanged: 0,
      skippedInvalidCurrentUrl: 0,
    });
  });

  it("expose bounded discovery behaviors through the discovery service", () => {
    const discovery = createDiscoveryService();
    const cfg = makeConfig({
      discovery: {
        enabled: true,
        provider: "manual",
        maxSearchResults: 5,
        maxFetches: 5,
        allowedHosts: ["shop.test"],
        blockedHosts: undefined,
        timeoutMs: 25_000,
      },
    });
    expect(discovery.describePolicy(cfg).provider).toBe("manual");
    expect(discovery.buildSearchQuery({
      id: "watch-1",
      url: "https://shop.test/item",
      enabled: true,
      createdAt: "2026-03-20T00:00:00.000Z",
      lastSnapshot: {
        title: "Sony WH-1000XM5",
        canonicalTitle: "sony wh-1000xm5",
        brand: "Sony",
        modelId: "WH-1000XM5",
        fetchedAt: "2026-03-20T00:00:00.000Z",
      },
    })).toContain("Sony");
  });
});
