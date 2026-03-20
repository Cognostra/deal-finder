import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedDealConfig } from "../config.js";

const mocks = vi.hoisted(() => {
  const fetchMock = vi.fn();
  const lookupMock = vi.fn();
  const firecrawlMock = vi.fn();
  const dispatchers: Array<{ kind: string; opts: unknown; closed: boolean; close: () => Promise<void> }> = [];

  class FakeDispatcher {
    closed = false;

    constructor(
      public readonly kind: string,
      public readonly opts: unknown,
    ) {
      dispatchers.push(this);
    }

    async close(): Promise<void> {
      this.closed = true;
    }
  }

  class FakeAgent extends FakeDispatcher {
    constructor(opts: unknown) {
      super("agent", opts);
    }
  }

  class FakeProxyAgent extends FakeDispatcher {
    constructor(opts: unknown) {
      super("proxy", opts);
    }
  }

  return { fetchMock, lookupMock, firecrawlMock, dispatchers, FakeAgent, FakeProxyAgent };
});

vi.mock("node:dns/promises", () => ({
  lookup: mocks.lookupMock,
}));

vi.mock("./firecrawl.js", () => ({
  fetchViaFirecrawl: mocks.firecrawlMock,
}));

vi.mock("undici", () => ({
  fetch: mocks.fetchMock,
  Agent: mocks.FakeAgent,
  ProxyAgent: mocks.FakeProxyAgent,
}));

import {
  DISPATCHER_IDLE_TTL_MS,
  cappedFetch,
  getDispatcherCacheKey,
  getDispatcherCacheSizeForTests,
  pruneDispatcherCache,
  resetDispatcherCacheForTests,
} from "./fetch.js";

function makeConfig(overrides: Partial<ResolvedDealConfig> = {}): ResolvedDealConfig {
  return {
    storePath: "/tmp/deal-hunter-store.json",
    maxConcurrent: 4,
    maxBytesPerResponse: 4_096,
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

function makeResponse(args: {
  status: number;
  text?: string;
  headers?: Record<string, string>;
}) {
  const headers = new Map(
    Object.entries(args.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
  );
  const encoder = new TextEncoder();
  const bodyText = args.text ?? "";
  const body =
    args.status === 304
      ? null
      : new ReadableStream<Uint8Array>({
          start(controller) {
            if (bodyText) controller.enqueue(encoder.encode(bodyText));
            controller.close();
          },
        });

  return {
    status: args.status,
    headers: {
      get(name: string) {
        return headers.get(name.toLowerCase()) ?? null;
      },
    },
    body,
  };
}

afterEach(async () => {
  await resetDispatcherCacheForTests();
  mocks.fetchMock.mockReset();
  mocks.lookupMock.mockReset();
  mocks.firecrawlMock.mockReset();
  mocks.dispatchers.length = 0;
  vi.useRealTimers();
});

describe("dispatcher cache", () => {
  it("uses a stable cache key for equivalent configs", () => {
    const a = makeConfig();
    const b = makeConfig();
    expect(getDispatcherCacheKey(a)).toBe(getDispatcherCacheKey(b));
  });

  it("reuses a dispatcher across equivalent config objects", async () => {
    mocks.lookupMock.mockResolvedValue([{ address: "93.184.216.34" }]);
    mocks.fetchMock.mockResolvedValue(makeResponse({ status: 200, text: "hello" }));

    await cappedFetch("http://public.test/item", makeConfig());
    await cappedFetch("http://public.test/item", makeConfig());

    expect(getDispatcherCacheSizeForTests()).toBe(1);
    expect(mocks.dispatchers).toHaveLength(1);
  });

  it("closes idle dispatchers when pruned", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-19T00:00:00.000Z"));

    mocks.lookupMock.mockResolvedValue([{ address: "93.184.216.34" }]);
    mocks.fetchMock.mockResolvedValue(makeResponse({ status: 200, text: "hello" }));

    await cappedFetch("http://public.test/item", makeConfig());
    expect(getDispatcherCacheSizeForTests()).toBe(1);

    vi.setSystemTime(Date.now() + DISPATCHER_IDLE_TTL_MS + 1);
    await pruneDispatcherCache(Date.now());

    expect(getDispatcherCacheSizeForTests()).toBe(0);
    expect(mocks.dispatchers[0]?.closed).toBe(true);
  });
});

describe("cappedFetch", () => {
  it("truncates oversized responses", async () => {
    mocks.lookupMock.mockResolvedValue([{ address: "93.184.216.34" }]);
    mocks.fetchMock.mockResolvedValue(makeResponse({ status: 200, text: "abcdef" }));

    const result = await cappedFetch("http://public.test/item", makeConfig({ maxBytesPerResponse: 4 }));

    expect(result.text).toBe("abcd");
    expect(result.meta.bytesRead).toBe(4);
    expect(result.meta.truncated).toBe(true);
  });

  it("forwards conditional request headers", async () => {
    mocks.lookupMock.mockResolvedValue([{ address: "93.184.216.34" }]);
    mocks.fetchMock.mockResolvedValue(makeResponse({ status: 304 }));

    await cappedFetch("http://public.test/item", makeConfig(), {
      ifNoneMatch: '"etag"',
      ifModifiedSince: "Wed, 08 Feb 2023 21:02:32 GMT",
    });

    expect(mocks.fetchMock).toHaveBeenCalledTimes(1);
    const options = mocks.fetchMock.mock.calls[0]?.[1] as { headers?: Record<string, string> } | undefined;
    expect(options?.headers?.["if-none-match"]).toBe('"etag"');
    expect(options?.headers?.["if-modified-since"]).toBe("Wed, 08 Feb 2023 21:02:32 GMT");
  });

  it("rejects redirects to hostnames that resolve to private IPs", async () => {
    mocks.lookupMock.mockImplementation(async (host: string) => {
      if (host === "public.test") return [{ address: "93.184.216.34" }];
      if (host === "127.0.0.1.nip.io") return [{ address: "127.0.0.1" }];
      return [];
    });
    mocks.fetchMock.mockResolvedValueOnce(
      makeResponse({
        status: 302,
        headers: { location: "http://127.0.0.1.nip.io/private" },
      }),
    );

    await expect(cappedFetch("http://public.test/item", makeConfig())).rejects.toThrow(
      /resolves to private or non-public IP/i,
    );
    expect(mocks.fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns HTTP error metadata without throwing", async () => {
    mocks.lookupMock.mockResolvedValue([{ address: "93.184.216.34" }]);
    mocks.fetchMock.mockResolvedValue(makeResponse({ status: 503, text: "upstream down" }));

    const result = await cappedFetch("http://public.test/item", makeConfig());

    expect(result.meta.status).toBe(503);
    expect(result.text).toBe("upstream down");
  });

  it("uses Firecrawl without creating a dispatcher", async () => {
    mocks.lookupMock.mockResolvedValue([{ address: "93.184.216.34" }]);
    mocks.firecrawlMock.mockResolvedValue({ ok: true, bodyText: "ok", status: 200 });

    const result = await cappedFetch("http://public.test/item", makeConfig({ fetcher: "firecrawl" }));

    expect(result.text).toBe("ok");
    expect(result.meta.status).toBe(200);
    expect(getDispatcherCacheSizeForTests()).toBe(0);
  });

  it("applies the byte cap to Firecrawl responses too", async () => {
    mocks.lookupMock.mockResolvedValue([{ address: "93.184.216.34" }]);
    mocks.firecrawlMock.mockResolvedValue({ ok: true, bodyText: "abcdef", status: 200 });

    const result = await cappedFetch("http://public.test/item", makeConfig({ fetcher: "firecrawl", maxBytesPerResponse: 4 }));

    expect(result.text).toBe("abcd");
    expect(result.meta.bytesRead).toBe(4);
    expect(result.meta.truncated).toBe(true);
  });
});
