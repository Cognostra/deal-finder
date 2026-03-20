import type { ResolvedDealConfig } from "../config.js";

export type FirecrawlFetchResult = {
  ok: boolean;
  status: number;
  bodyText: string;
  error?: string;
};

export type FirecrawlSearchItem = {
  url: string;
  title?: string;
  description?: string;
};

export type FirecrawlSearchResult = {
  ok: boolean;
  status: number;
  results: FirecrawlSearchItem[];
  error?: string;
};

/** Best-effort Firecrawl scrape → markdown/text for heuristic parsing. */
export async function fetchViaFirecrawl(
  url: string,
  cfg: ResolvedDealConfig,
  signal?: AbortSignal,
): Promise<FirecrawlFetchResult> {
  const key = cfg.firecrawlApiKey;
  if (!key) {
    return { ok: false, status: 0, bodyText: "", error: "firecrawlApiKey not set" };
  }
  const base = cfg.firecrawlBaseUrl?.replace(/\/$/, "") ?? "https://api.firecrawl.dev";
  try {
    const res = await fetch(`${base}/v1/scrape`, {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url,
        formats: ["markdown"],
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        bodyText: text.slice(0, 2000),
        error: `Firecrawl HTTP ${res.status}`,
      };
    }
    let markdown = text;
    try {
      const j = JSON.parse(text) as {
        data?: { markdown?: string; content?: string };
        markdown?: string;
      };
      markdown = j.data?.markdown ?? j.data?.content ?? j.markdown ?? text;
    } catch {
      /* use raw */
    }
    return { ok: true, status: res.status, bodyText: markdown };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 0, bodyText: "", error: msg };
  }
}

export async function searchViaFirecrawl(args: {
  query: string;
  cfg: ResolvedDealConfig;
  limit: number;
  signal?: AbortSignal;
}): Promise<FirecrawlSearchResult> {
  const { query, cfg, limit, signal } = args;
  const key = cfg.firecrawlApiKey;
  if (!key) {
    return { ok: false, status: 0, results: [], error: "firecrawlApiKey not set" };
  }
  const base = cfg.firecrawlBaseUrl?.replace(/\/$/, "") ?? "https://api.firecrawl.dev";
  try {
    const res = await fetch(`${base}/v2/search`, {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        limit,
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        results: [],
        error: `Firecrawl search HTTP ${res.status}: ${text.slice(0, 500)}`,
      };
    }
    try {
      const parsed = JSON.parse(text) as {
        data?: { web?: Array<{ url?: string; title?: string; description?: string }> };
        results?: Array<{ url?: string; title?: string; description?: string }>;
      };
      const rawResults = parsed.data?.web ?? parsed.results ?? [];
      return {
        ok: true,
        status: res.status,
        results: rawResults
          .filter((item): item is { url: string; title?: string; description?: string } => typeof item.url === "string" && item.url.length > 0)
          .map((item) => ({
            url: item.url,
            title: item.title,
            description: item.description,
          })),
      };
    } catch {
      return {
        ok: false,
        status: res.status,
        results: [],
        error: "Firecrawl search returned invalid JSON",
      };
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 0, results: [], error: msg };
  }
}
