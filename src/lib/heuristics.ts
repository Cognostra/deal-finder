import { createHash } from "node:crypto";
import type { ExtractedListing } from "../types.js";

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function hashSnippet(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 32);
}

export function canonicalizeTitle(title?: string): string | undefined {
  if (!title) return undefined;
  const normalized = title
    .replace(/[™®©]/g, "")
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return undefined;
  return normalized.toLowerCase();
}

/** Pull Product-related JSON-LD from HTML (first match wins). */
export function extractJsonLdProduct(html: string): { name?: string; price?: number; currency?: string } | null {
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1]?.trim();
    if (!raw) continue;
    try {
      const data = JSON.parse(raw) as unknown;
      const fromProduct = (node: Record<string, unknown>) => {
        const types = node["@type"];
        const typeStr = Array.isArray(types) ? types.join(",") : String(types ?? "");
        if (!/Product/i.test(typeStr)) return null;
        const name = typeof node.name === "string" ? node.name : undefined;
        const offers = node.offers;
        let price: number | undefined;
        let currency: string | undefined;
        if (offers && typeof offers === "object") {
          const o = offers as Record<string, unknown>;
          if (typeof o.price === "number") price = o.price;
          else if (typeof o.price === "string") price = Number.parseFloat(o.price);
          if (typeof o.priceCurrency === "string") currency = o.priceCurrency;
        }
        if (name || price != null) return { name, price, currency };
        return null;
      };

      if (Array.isArray(data)) {
        for (const node of data) {
          if (!node || typeof node !== "object") continue;
          const hit = fromProduct(node as Record<string, unknown>);
          if (hit) return hit;
        }
      } else if (data && typeof data === "object") {
        const obj = data as Record<string, unknown>;
        const hit = fromProduct(obj);
        if (hit) return hit;
        const graph = obj["@graph"];
        if (Array.isArray(graph)) {
          for (const g of graph) {
            if (!g || typeof g !== "object") continue;
            const h = fromProduct(g as Record<string, unknown>);
            if (h) return h;
          }
        }
      }
    } catch {
      /* invalid JSON-LD */
    }
  }
  return null;
}

export function extractOgTags(html: string): { title?: string; price?: number; currency?: string } {
  const title = matchMetaContent(html, "og:title");
  const priceRaw = matchMetaContent(html, "og:price:amount") ?? matchMetaContent(html, "product:price:amount");
  const currency =
    matchMetaContent(html, "og:price:currency") ?? matchMetaContent(html, "product:price:currency");
  let price: number | undefined;
  if (priceRaw) {
    const n = Number.parseFloat(priceRaw.replace(/,/g, ""));
    if (!Number.isNaN(n)) price = n;
  }
  return { title: title ?? undefined, price, currency: currency ?? undefined };
}

function matchMetaContent(html: string, key: string): string | null {
  const k = escapeRe(key);
  let m = html.match(
    new RegExp(`<meta[^>]*property=["']${k}["'][^>]*content=["']([^"']+)["']`, "i"),
  );
  if (m?.[1]) return m[1].trim();
  m = html.match(new RegExp(`<meta[^>]*content=["']([^"']+)["'][^>]*property=["']${k}["']`, "i"));
  if (m?.[1]) return m[1].trim();
  m = html.match(new RegExp(`<meta[^>]*name=["']${k}["'][^>]*content=["']([^"']+)["']`, "i"));
  if (m?.[1]) return m[1].trim();
  return null;
}

/** Regex fallback on visible price-like tokens (bounded scan; picks lowest positive match). */
export function extractPriceFallback(html: string): { price?: number; currency?: string } {
  const slice = html.slice(0, 400_000);
  let bestPrice = Infinity;
  let bestCur = "USD";
  const patterns: Array<{ re: RegExp; cur: string }> = [
    { re: /\$\s*([\d,]+\.?\d*)/g, cur: "USD" },
    { re: /£\s*([\d,]+\.?\d*)/g, cur: "GBP" },
    { re: /€\s*([\d,.]+)/g, cur: "EUR" },
  ];
  for (const { re, cur } of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(slice)) !== null) {
      const n = Number.parseFloat(m[1].replace(/,/g, ""));
      if (!Number.isNaN(n) && n > 0 && n < bestPrice) {
        bestPrice = n;
        bestCur = cur;
      }
    }
  }
  if (bestPrice === Infinity) return {};
  return { price: bestPrice, currency: bestCur };
}

export function extractListing(html: string, maxSnippet = 4000): ExtractedListing {
  const ld = extractJsonLdProduct(html);
  const og = extractOgTags(html);
  const fb = extractPriceFallback(html);

  const title = ld?.name ?? og.title;
  const price = ld?.price ?? og.price ?? fb.price;
  const currency = ld?.currency ?? og.currency ?? fb.currency;
  const canonicalTitle = canonicalizeTitle(title);

  const snippet = html.slice(0, maxSnippet).replace(/\s+/g, " ").trim();

  return {
    title: title?.slice(0, 500),
    canonicalTitle,
    price,
    currency,
    snippet: snippet.slice(0, maxSnippet),
  };
}

export type DealEvaluation = {
  score: number;
  reasons: string[];
  flags: string[];
};

/** Heuristic “is this interesting?” without network (for pasted text). */
export function evaluateListingText(text: string, opts?: { maxPrice?: number }): DealEvaluation {
  const reasons: string[] = [];
  const flags: string[] = [];
  let score = 0;
  const lower = text.toLowerCase();

  if (/\bfree\b|100%\s*off|£0\.00|\$0\.00|€0,00/.test(lower)) {
    score += 40;
    flags.push("possible_free_or_full_discount");
    reasons.push("Mentions free or 100% off.");
  }

  const priceHints = text.match(/\$\s*[\d,.]+|[£€]\s*[\d,.]+/g);
  if (priceHints?.length) {
    score += 10;
    reasons.push(`Found price-like tokens: ${priceHints.slice(0, 3).join(", ")}`);
  }

  if (/\b(glitch|price.error|misprice|oops)\b/i.test(text)) {
    score += 15;
    flags.push("hype_language");
    reasons.push("Contains deal-hunter hype terms.");
  }

  if (opts?.maxPrice != null) {
    const nums = [...text.matchAll(/\$?\s*([\d]+(?:[.,]\d{2})?)/g)].map((x) => Number.parseFloat(x[1].replace(",", ".")));
    const valid = nums.filter((n) => !Number.isNaN(n));
    const minN = valid.length ? Math.min(...valid) : null;
    if (minN != null && minN <= opts.maxPrice) {
      score += 25;
      reasons.push(`Parsed amount ${minN} ≤ maxPrice ${opts.maxPrice}.`);
    }
  }

  return { score: Math.min(100, score), reasons, flags };
}
