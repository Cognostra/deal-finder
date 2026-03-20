import type { ResolvedDealConfig } from "../config.js";

export type FirecrawlFetchResult = {
  ok: boolean;
  status: number;
  bodyText: string;
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
