import { createHash } from "node:crypto";
import type { ExtractionConfidence, ExtractionDebugInfo, ExtractedListing } from "../types.js";

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

function parseCurrencySymbol(symbol?: string): string | undefined {
  if (!symbol) return undefined;
  if (symbol === "$") return "USD";
  if (symbol === "£") return "GBP";
  if (symbol === "€") return "EUR";
  return undefined;
}

function parseCurrencyAmount(raw?: string): { price?: number; currency?: string } {
  if (!raw) return {};
  const trimmed = raw.replace(/\s+/g, " ").trim();
  const match = trimmed.match(/([$£€])\s*([\d,]+(?:\.\d+)?)/);
  if (!match) return {};
  const price = Number.parseFloat(match[2]!.replace(/,/g, ""));
  if (Number.isNaN(price)) return {};
  return {
    price,
    currency: parseCurrencySymbol(match[1]),
  };
}

type RetailerExtraction = {
  extractorId: string;
  title?: string;
  price?: number;
  currency?: string;
};

function extractAmazonListing(html: string): RetailerExtraction | null {
  if (!/productTitle|a-price/i.test(html)) return null;

  const title = html.match(/id=["']productTitle["'][^>]*>\s*([\s\S]*?)\s*<\/span>/i)?.[1]
    ?.replace(/\s+/g, " ")
    .trim();
  const offscreen = html.match(/class=["'][^"']*a-offscreen[^"']*["'][^>]*>\s*([^<]+?)\s*<\/span>/i)?.[1];
  const amount = parseCurrencyAmount(offscreen);

  if (!title && amount.price == null) return null;
  return {
    extractorId: "retailer_amazon",
    title,
    price: amount.price,
    currency: amount.currency,
  };
}

function extractBestBuyListing(html: string): RetailerExtraction | null {
  if (!/priceView-customer-price/i.test(html)) return null;

  const title =
    html.match(/data-testid=["']product-title["'][^>]*>\s*([\s\S]*?)\s*<\/[^>]+>/i)?.[1]
      ?.replace(/\s+/g, " ")
      .trim() ??
    html.match(/<h1[^>]*class=["'][^"']*heading-[^"']*["'][^>]*>\s*([\s\S]*?)\s*<\/h1>/i)?.[1]
      ?.replace(/\s+/g, " ")
      .trim();
  const priceRaw =
    html.match(/class=["'][^"']*priceView-customer-price[^"']*["'][\s\S]{0,200}?([$£€]\s*[\d,]+(?:\.\d+)?)/i)?.[1] ??
    html.match(/aria-label=["']Current Price["'][\s\S]{0,80}?([$£€]\s*[\d,]+(?:\.\d+)?)/i)?.[1];
  const amount = parseCurrencyAmount(priceRaw);

  if (!title && amount.price == null) return null;
  return {
    extractorId: "retailer_best_buy",
    title,
    price: amount.price,
    currency: amount.currency,
  };
}

function extractEbayListing(html: string): RetailerExtraction | null {
  if (!/x-item-title__mainTitle|x-price-primary/i.test(html)) return null;

  const title =
    html.match(/class=["'][^"']*x-item-title__mainTitle[^"']*["'][^>]*>\s*<span[^>]*>\s*([\s\S]*?)\s*<\/span>/i)?.[1]
      ?.replace(/\s+/g, " ")
      .trim() ??
    html.match(/<h1[^>]*>\s*([\s\S]*?)\s*<\/h1>/i)?.[1]
      ?.replace(/\s+/g, " ")
      .trim();
  const priceRaw =
    html.match(/class=["'][^"']*x-price-primary[^"']*["'][\s\S]{0,120}?([$£€]\s*[\d,]+(?:\.\d+)?)/i)?.[1] ??
    html.match(/itemprop=["']price["'][^>]*content=["']([\d.]+)["']/i)?.[1];
  const amount =
    priceRaw && /^[\d.]+$/.test(priceRaw)
      ? { price: Number.parseFloat(priceRaw), currency: "USD" }
      : parseCurrencyAmount(priceRaw);

  if (!title && amount.price == null) return null;
  return {
    extractorId: "retailer_ebay",
    title,
    price: amount.price,
    currency: amount.currency,
  };
}

function extractTargetListing(html: string): RetailerExtraction | null {
  if (!/data-test=["']product-title["']|data-test=["']product-price["']/i.test(html)) return null;

  const title =
    html.match(/data-test=["']product-title["'][^>]*>\s*([\s\S]*?)\s*<\/[^>]+>/i)?.[1]
      ?.replace(/\s+/g, " ")
      .trim() ??
    html.match(/<h1[^>]*data-test=["']product-title["'][^>]*>\s*([\s\S]*?)\s*<\/h1>/i)?.[1]
      ?.replace(/\s+/g, " ")
      .trim();
  const priceRaw =
    html.match(/data-test=["']product-price["'][^>]*>\s*([$£€]\s*[\d,]+(?:\.\d+)?)\s*<\/[^>]+>/i)?.[1] ??
    html.match(/data-test=["']product-price["'][\s\S]{0,120}?([$£€]\s*[\d,]+(?:\.\d+)?)/i)?.[1];
  const amount = parseCurrencyAmount(priceRaw);

  if (!title && amount.price == null) return null;
  return {
    extractorId: "retailer_target",
    title,
    price: amount.price,
    currency: amount.currency,
  };
}

function extractWalmartListing(html: string): RetailerExtraction | null {
  if (!/itemprop=["']price["']|price-characteristic/i.test(html)) return null;

  const title =
    html.match(/itemprop=["']name["'][^>]*content=["']([^"']+)["']/i)?.[1]?.trim() ??
    html.match(/<h1[^>]*>\s*([\s\S]*?)\s*<\/h1>/i)?.[1]?.replace(/\s+/g, " ").trim();
  const priceRaw =
    html.match(/itemprop=["']price["'][^>]*content=["']([\d.]+)["']/i)?.[1] ??
    html.match(/price-characteristic=["']([\d.]+)["']/i)?.[1];
  const currency =
    html.match(/itemprop=["']priceCurrency["'][^>]*content=["']([^"']+)["']/i)?.[1]?.trim() ?? "USD";
  const amount =
    priceRaw && /^[\d.]+$/.test(priceRaw)
      ? { price: Number.parseFloat(priceRaw), currency }
      : parseCurrencyAmount(priceRaw);

  if (!title && amount.price == null) return null;
  return {
    extractorId: "retailer_walmart",
    title,
    price: amount.price,
    currency: amount.currency,
  };
}

function extractNeweggListing(html: string): RetailerExtraction | null {
  if (!/price-current/i.test(html)) return null;

  const title =
    html.match(/class=["'][^"']*product-title[^"']*["'][^>]*>\s*([\s\S]*?)\s*<\/h1>/i)?.[1]
      ?.replace(/\s+/g, " ")
      .trim() ??
    html.match(/itemprop=["']name["'][^>]*content=["']([^"']+)["']/i)?.[1]?.trim();

  const combinedPrice =
    html.match(/class=["'][^"']*price-current[^"']*["'][\s\S]{0,200}?\$\s*<strong>([\d,]+)<\/strong>\s*<sup>\.(\d+)<\/sup>/i);
  const price =
    combinedPrice
      ? Number.parseFloat(`${combinedPrice[1]!.replace(/,/g, "")}.${combinedPrice[2]!}`)
      : undefined;

  if (!title && price == null) return null;
  return {
    extractorId: "retailer_newegg",
    title,
    price,
    currency: price != null ? "USD" : undefined,
  };
}

function extractHomeDepotListing(html: string): RetailerExtraction | null {
  if (!/product-title|price-format__main-price|data-testid=["']product-price["']/i.test(html)) return null;

  const title =
    html.match(/data-testid=["']product-title["'][^>]*>\s*([\s\S]*?)\s*<\/[^>]+>/i)?.[1]
      ?.replace(/\s+/g, " ")
      .trim() ??
    html.match(/<h1[^>]*class=["'][^"']*product-title[^"']*["'][^>]*>\s*([\s\S]*?)\s*<\/h1>/i)?.[1]
      ?.replace(/\s+/g, " ")
      .trim();

  const priceRaw =
    html.match(/data-testid=["']product-price["'][^>]*>\s*([$£€]\s*[\d,]+(?:\.\d+)?)\s*<\/[^>]+>/i)?.[1] ??
    html.match(/class=["'][^"']*price-format__main-price[^"']*["'][^>]*>\s*([$£€]\s*[\d,]+(?:\.\d+)?)\s*<\/[^>]+>/i)?.[1];
  const amount = parseCurrencyAmount(priceRaw);

  if (!title && amount.price == null) return null;
  return {
    extractorId: "retailer_home_depot",
    title,
    price: amount.price,
    currency: amount.currency,
  };
}

export function extractRetailerListing(html: string): RetailerExtraction | null {
  return (
    extractAmazonListing(html) ??
    extractBestBuyListing(html) ??
    extractEbayListing(html) ??
    extractTargetListing(html) ??
    extractWalmartListing(html) ??
    extractNeweggListing(html) ??
    extractHomeDepotListing(html)
  );
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
  const retailer = extractRetailerListing(html);
  const ld = extractJsonLdProduct(html);
  const og = extractOgTags(html);
  const fb = extractPriceFallback(html);

  const title = retailer?.title ?? ld?.name ?? og.title;
  const price = retailer?.price ?? ld?.price ?? og.price ?? fb.price;
  const currency = retailer?.currency ?? ld?.currency ?? og.currency ?? fb.currency;
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

export function scoreExtractedListing(extracted: ExtractedListing): ExtractionConfidence {
  const extractedFields = [
    extracted.title ? "title" : null,
    extracted.price != null ? "price" : null,
    extracted.currency ? "currency" : null,
  ].filter((value): value is string => Boolean(value));

  return {
    score: extractedFields.length === 3 ? 90 : extractedFields.length === 2 ? 70 : extractedFields.length === 1 ? 40 : 10,
    level:
      extractedFields.length === 3
        ? "high"
        : extractedFields.length === 2
          ? "medium"
          : extractedFields.length === 1
            ? "low"
            : "none",
    reasons:
      extractedFields.length > 0
        ? [`Extracted fields: ${extractedFields.join(", ")}.`]
        : ["No reliable product fields were extracted from the response preview."],
  };
}

export function debugExtractListing(html: string, maxSnippet = 4000): {
  extracted: ExtractedListing;
  confidence: ExtractionConfidence;
  debug: ExtractionDebugInfo;
} {
  type PriceCandidate = { source: string; value: number; currency?: string };
  const retailer = extractRetailerListing(html);
  const ld = extractJsonLdProduct(html);
  const og = extractOgTags(html);
  const fb = extractPriceFallback(html);
  const extracted = extractListing(html, maxSnippet);

  const titleCandidates: Array<{ source: string; value: string }> = [];
  if (retailer?.title) titleCandidates.push({ source: retailer.extractorId, value: retailer.title });
  if (ld?.name) titleCandidates.push({ source: "json_ld", value: ld.name });
  if (og.title) titleCandidates.push({ source: "open_graph", value: og.title });

  const priceCandidates: PriceCandidate[] = [];
  if (retailer?.price != null) priceCandidates.push({ source: retailer.extractorId, value: retailer.price, currency: retailer.currency });
  if (ld?.price != null) priceCandidates.push({ source: "json_ld", value: ld.price, currency: ld.currency });
  if (og.price != null) priceCandidates.push({ source: "open_graph", value: og.price, currency: og.currency });
  if (fb.price != null) priceCandidates.push({ source: "price_regex_fallback", value: fb.price, currency: fb.currency });

  const titleSource =
    extracted.title && retailer?.title === extracted.title
      ? retailer.extractorId
      : extracted.title && ld?.name === extracted.title
      ? "json_ld"
      : extracted.title && og.title === extracted.title
        ? "open_graph"
        : undefined;

  const priceSource =
    extracted.price != null && retailer?.price === extracted.price
      ? retailer.extractorId
      : extracted.price != null && ld?.price === extracted.price
      ? "json_ld"
      : extracted.price != null && og.price === extracted.price
        ? "open_graph"
        : extracted.price != null && fb.price === extracted.price
          ? "price_regex_fallback"
          : undefined;

  return {
    extracted,
    confidence: scoreExtractedListing(extracted),
    debug: {
      matchedExtractor: retailer?.extractorId,
      titleCandidates,
      priceCandidates,
      chosen: {
        title: extracted.title && titleSource ? { source: titleSource, value: extracted.title } : undefined,
        price:
          extracted.price != null && priceSource
            ? { source: priceSource, value: extracted.price, currency: extracted.currency }
            : undefined,
      },
    },
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
