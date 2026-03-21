import type { ExtractedListing } from "../types.js";
import {
  normalizeIdentifierCode,
  normalizeIdentityValue,
} from "./retailer-extractors.js";

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

/** Pull Product-related JSON-LD from HTML (first match wins). */
export function extractJsonLdProduct(html: string): {
  name?: string;
  price?: number;
  currency?: string;
  brand?: string;
  sku?: string;
  mpn?: string;
  gtin?: string;
} | null {
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
        const brandNode = node.brand;
        const brand =
          typeof brandNode === "string"
            ? normalizeIdentityValue(brandNode)
            : brandNode && typeof brandNode === "object" && typeof (brandNode as Record<string, unknown>).name === "string"
              ? normalizeIdentityValue((brandNode as Record<string, unknown>).name as string)
              : undefined;
        const sku = normalizeIdentifierCode(typeof node.sku === "string" ? node.sku : undefined);
        const mpn = normalizeIdentifierCode(typeof node.mpn === "string" ? node.mpn : undefined);
        const gtin = normalizeIdentifierCode(
          (["gtin", "gtin13", "gtin14", "gtin12", "gtin8"] as const)
            .map((key) => (typeof node[key] === "string" ? node[key] : undefined))
            .find(Boolean),
        );
        if (offers && typeof offers === "object") {
          const o = offers as Record<string, unknown>;
          if (typeof o.price === "number") price = o.price;
          else if (typeof o.price === "string") price = Number.parseFloat(o.price);
          if (typeof o.priceCurrency === "string") currency = o.priceCurrency;
        }
        if (name || price != null || brand || sku || mpn || gtin) return { name, price, currency, brand, sku, mpn, gtin };
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

export function extractMetaIdentity(html: string): Pick<ExtractedListing, "brand" | "modelId" | "sku" | "mpn" | "gtin" | "asin"> {
  const brand =
    normalizeIdentityValue(matchMetaContent(html, "product:brand") ?? matchMetaContent(html, "brand")) ??
    normalizeIdentityValue(html.match(/itemprop=["']brand["'][^>]*content=["']([^"']+)["']/i)?.[1]);
  const sku =
    normalizeIdentifierCode(matchMetaContent(html, "sku")) ??
    normalizeIdentifierCode(html.match(/itemprop=["']sku["'][^>]*content=["']([^"']+)["']/i)?.[1]);
  const mpn =
    normalizeIdentifierCode(matchMetaContent(html, "mpn")) ??
    normalizeIdentifierCode(html.match(/itemprop=["']mpn["'][^>]*content=["']([^"']+)["']/i)?.[1]);
  const gtin =
    normalizeIdentifierCode(
      matchMetaContent(html, "gtin") ??
        matchMetaContent(html, "gtin13") ??
        matchMetaContent(html, "gtin14") ??
        matchMetaContent(html, "product:gtin") ??
        html.match(/itemprop=["']gtin(?:8|12|13|14)?["'][^>]*content=["']([^"']+)["']/i)?.[1],
    );
  const asin =
    normalizeIdentifierCode(
      html.match(/(?:id|name)=["']ASIN["'][^>]*value=["']([^"']+)["']/i)?.[1] ??
        html.match(/data-asin=["']([^"']+)["']/i)?.[1] ??
        matchMetaContent(html, "asin"),
    );
  const modelId =
    normalizeIdentifierCode(
      html.match(/itemprop=["']model["'][^>]*content=["']([^"']+)["']/i)?.[1] ??
        matchMetaContent(html, "model") ??
        html.match(/\b([A-Z]{1,5}-[A-Z0-9-]{3,}|\b[A-Z]{2,}\d[A-Z0-9-]{2,}\b)/)?.[1],
    );

  return { brand, modelId, sku, mpn, gtin, asin };
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
