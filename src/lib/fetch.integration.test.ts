import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { ResolvedDealConfig } from "../config.js";

vi.mock("./url-policy.js", async () => {
  const actual = await vi.importActual<typeof import("./url-policy.js")>("./url-policy.js");
  return {
    ...actual,
    validateTargetUrl(url: string) {
      return new URL(url);
    },
    async assertPublicHostnameResolution() {},
  };
});

import { cappedFetch, resetDispatcherCacheForTests } from "./fetch.js";

type RequestRecord = {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
};

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

async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse, requests: RequestRecord[]) => void,
): Promise<{ server: Server; baseUrl: string; requests: RequestRecord[] } | null> {
  const requests: RequestRecord[] = [];
  const server = createServer((req, res) => {
    requests.push({
      method: req.method ?? "GET",
      url: req.url ?? "/",
      headers: req.headers,
    });
    handler(req, res, requests);
  });

  const listening = await new Promise<boolean>((resolve, reject) => {
    server.once("error", (error) => {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "EPERM") {
        resolve(false);
        return;
      }
      reject(error);
    });
    server.listen(0, "127.0.0.1", () => resolve(true));
  });
  if (!listening) {
    server.close();
    return null;
  }

  const address = server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
  };
}

async function closeServer(server: Server): Promise<void> {
  server.close();
  await once(server, "close");
}

describe("cappedFetch integration", () => {
  let server: Server | undefined;

  beforeEach(async () => {
    await resetDispatcherCacheForTests();
  });

  afterEach(async () => {
    await resetDispatcherCacheForTests();
    if (server?.listening) {
      await closeServer(server);
    }
    server = undefined;
  });

  it("reuses ETag and Last-Modified headers against a real HTTP server", async () => {
    const etag = '"item-v1"';
    const lastModified = "Wed, 08 Feb 2023 21:02:32 GMT";
    const started = await startServer((req, res) => {
      if (req.headers["if-none-match"] === etag && req.headers["if-modified-since"] === lastModified) {
        res.writeHead(304, { ETag: etag, "Last-Modified": lastModified });
        res.end();
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        ETag: etag,
        "Last-Modified": lastModified,
      });
      res.end(`<html><body><meta property="og:title" content="Widget" /><p>$19.99</p></body></html>`);
    });
    if (!started) return;
    server = started.server;

    const first = await cappedFetch(`${started.baseUrl}/item`, makeConfig());
    const second = await cappedFetch(`${started.baseUrl}/item`, makeConfig(), {
      ifNoneMatch: first.meta.etag,
      ifModifiedSince: first.meta.lastModified,
    });

    expect(first.meta.status).toBe(200);
    expect(first.meta.etag).toBe(etag);
    expect(first.meta.lastModified).toBe(lastModified);
    expect(second.meta.status).toBe(304);
    expect(second.meta.notModified).toBe(true);
    expect(started.requests).toHaveLength(2);
    expect(started.requests[1]?.headers["if-none-match"]).toBe(etag);
    expect(started.requests[1]?.headers["if-modified-since"]).toBe(lastModified);
  });

  it("follows a redirect and reports the final URL against a real HTTP server", async () => {
    const started = await startServer((req, res) => {
      if (req.url === "/redirect") {
        res.writeHead(302, { Location: "/item" });
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<html><body><meta property="og:title" content="Redirected Widget" /><p>$24.99</p></body></html>`);
    });
    if (!started) return;
    server = started.server;

    const result = await cappedFetch(`${started.baseUrl}/redirect`, makeConfig());

    expect(result.meta.status).toBe(200);
    expect(result.meta.finalUrl).toBe(`${started.baseUrl}/item`);
    expect(result.text).toContain("Redirected Widget");
    expect(started.requests.map((request) => request.url)).toEqual(["/redirect", "/item"]);
  });
});
