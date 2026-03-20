import { fetch as undiciFetch, Agent, ProxyAgent } from "undici";
import type { ResolvedDealConfig } from "../config.js";
import type { FetchMeta } from "../types.js";
import { fetchViaFirecrawl } from "./firecrawl.js";
import { assertPublicHostnameResolution, validateTargetUrl } from "./url-policy.js";

function pickUserAgent(cfg: ResolvedDealConfig): string {
  const list = cfg.userAgents;
  return list[Math.floor(Math.random() * list.length)] ?? list[0] ?? "OpenClaw-DealHunter/0.1";
}

function buildDispatcher(cfg: ResolvedDealConfig) {
  const agentOpts = {
    connect: { timeout: cfg.requestTimeoutMs },
    keepAliveTimeout: 60_000,
    keepAliveMaxTimeout: 600_000,
  };
  if (cfg.proxyUrl) {
    return new ProxyAgent({ uri: cfg.proxyUrl, ...agentOpts });
  }
  return new Agent(agentOpts);
}

type DispatcherEntry = {
  dispatcher: ReturnType<typeof buildDispatcher>;
  lastUsedAt: number;
};

const poolCache = new Map<string, DispatcherEntry>();
export const DISPATCHER_IDLE_TTL_MS = 5 * 60_000;

export function getDispatcherCacheKey(cfg: ResolvedDealConfig): string {
  return JSON.stringify({
    fetcher: cfg.fetcher,
    requestTimeoutMs: cfg.requestTimeoutMs,
    proxyUrl: cfg.proxyUrl ?? "",
  });
}

export async function pruneDispatcherCache(now = Date.now()): Promise<void> {
  const staleKeys: string[] = [];
  for (const [key, entry] of poolCache.entries()) {
    if (now - entry.lastUsedAt <= DISPATCHER_IDLE_TTL_MS) continue;
    staleKeys.push(key);
  }

  await Promise.all(
    staleKeys.map(async (key) => {
      const entry = poolCache.get(key);
      if (!entry) return;
      poolCache.delete(key);
      await entry.dispatcher.close().catch(() => {});
    }),
  );
}

export function getDispatcherCacheSizeForTests(): number {
  return poolCache.size;
}

export async function resetDispatcherCacheForTests(): Promise<void> {
  const entries = [...poolCache.values()];
  poolCache.clear();
  await Promise.all(entries.map((entry) => entry.dispatcher.close().catch(() => {})));
}

async function getDispatcher(cfg: ResolvedDealConfig) {
  await pruneDispatcherCache();
  const key = getDispatcherCacheKey(cfg);
  const cached = poolCache.get(key);
  if (cached) {
    cached.lastUsedAt = Date.now();
    return cached.dispatcher;
  }

  const dispatcher = buildDispatcher(cfg);
  poolCache.set(key, { dispatcher, lastUsedAt: Date.now() });
  return dispatcher;
}

export type CappedFetchResult = {
  meta: FetchMeta;
  text: string;
};

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

/**
 * GET with shared keep-alive dispatcher, streaming body cap, conditional headers.
 */
export async function cappedFetch(
  url: string,
  cfg: ResolvedDealConfig,
  options?: {
    ifNoneMatch?: string;
    ifModifiedSince?: string;
    signal?: AbortSignal;
  },
): Promise<CappedFetchResult> {
  const startUrl = validateTargetUrl(url, cfg).toString();
  await assertPublicHostnameResolution(new URL(startUrl).hostname);

  if (cfg.fetcher === "firecrawl") {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), cfg.requestTimeoutMs);
    const res = await fetchViaFirecrawl(startUrl, cfg, options?.signal ?? ac.signal);
    clearTimeout(t);
    const meta: FetchMeta = {
      status: res.ok ? 200 : res.status || 599,
      finalUrl: startUrl,
      bytesRead: res.bodyText.length,
    };
    if (!res.ok) {
      return {
        meta: { ...meta, status: 599 },
        text: res.error ?? res.bodyText,
      };
    }
    return { meta, text: res.bodyText };
  }

  const dispatcher = await getDispatcher(cfg);
  const headers: Record<string, string> = {
    "user-agent": pickUserAgent(cfg),
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
  };
  if (options?.ifNoneMatch) headers["if-none-match"] = options.ifNoneMatch;
  if (options?.ifModifiedSince) headers["if-modified-since"] = options.ifModifiedSince;

  let currentUrl = startUrl;
  let res = await undiciFetch(currentUrl, {
    dispatcher,
    redirect: "manual",
    signal: options?.signal,
    headers,
  });

  for (let redirects = 0; REDIRECT_STATUSES.has(res.status); redirects += 1) {
    const location = res.headers.get("location");
    if (!location) break;
    if (redirects >= MAX_REDIRECTS) {
      throw new Error(`deal-hunter: too many redirects while fetching ${startUrl}`);
    }
    await res.body?.cancel().catch(() => {});
    currentUrl = validateTargetUrl(new URL(location, currentUrl).toString(), cfg).toString();
    await assertPublicHostnameResolution(new URL(currentUrl).hostname);
    res = await undiciFetch(currentUrl, {
      dispatcher,
      redirect: "manual",
      signal: options?.signal,
      headers,
    });
  }

  const meta: FetchMeta = {
    status: res.status,
    finalUrl: currentUrl,
    bytesRead: 0,
    etag: res.headers.get("etag") ?? undefined,
    lastModified: res.headers.get("last-modified") ?? undefined,
  };

  if (res.status === 304) {
    meta.notModified = true;
    return { meta, text: "" };
  }

  if (!res.body) {
    return { meta, text: "" };
  }

  const max = cfg.maxBytesPerResponse;
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        const buf = Buffer.from(value);
        const take = Math.min(buf.length, Math.max(0, max - total));
        if (take > 0) chunks.push(buf.subarray(0, take));
        total += take;
        if (total >= max) {
          await reader.cancel();
          break;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  const text = Buffer.concat(chunks).toString("utf8");
  meta.bytesRead = text.length;
  return { meta, text };
}
