import type { ExtractionConfidence, ExtractionDebugInfo, ExtractedListing } from "../types.js";
import {
  extractRetailerListing,
} from "./retailer-extractors.js";
export { extractRetailerListing } from "./retailer-extractors.js";
import { canonicalizeTitle, hashSnippet } from "./heuristics-normalize.js";
import {
  extractJsonLdProduct,
  extractMetaIdentity,
  extractOgTags,
  extractPriceFallback,
} from "./heuristics-metadata.js";
export { canonicalizeTitle, hashSnippet } from "./heuristics-normalize.js";
export { extractJsonLdProduct, extractOgTags, extractPriceFallback } from "./heuristics-metadata.js";

export function extractListing(html: string, maxSnippet = 4000): ExtractedListing {
  const retailer = extractRetailerListing(html);
  const ld = extractJsonLdProduct(html);
  const og = extractOgTags(html);
  const metaIdentity = extractMetaIdentity(html);
  const fb = extractPriceFallback(html);

  const title = retailer?.title ?? ld?.name ?? og.title;
  const price = retailer?.price ?? ld?.price ?? og.price ?? fb.price;
  const currency = retailer?.currency ?? ld?.currency ?? og.currency ?? fb.currency;
  const canonicalTitle = canonicalizeTitle(title);

  const snippet = html.slice(0, maxSnippet).replace(/\s+/g, " ").trim();

  return {
    title: title?.slice(0, 500),
    canonicalTitle,
    brand: retailer?.brand ?? ld?.brand ?? metaIdentity.brand,
    modelId: retailer?.modelId ?? metaIdentity.modelId,
    sku: retailer?.sku ?? ld?.sku ?? metaIdentity.sku,
    mpn: retailer?.mpn ?? ld?.mpn ?? metaIdentity.mpn,
    gtin: retailer?.gtin ?? ld?.gtin ?? metaIdentity.gtin,
    asin: retailer?.asin ?? metaIdentity.asin,
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
    extracted.modelId || extracted.sku || extracted.mpn || extracted.gtin || extracted.asin ? "identity" : null,
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
  const metaIdentity = extractMetaIdentity(html);
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

  const identityCandidates: ExtractionDebugInfo["identityCandidates"] = [];
  const addIdentityCandidate = (
    field: "brand" | "modelId" | "sku" | "mpn" | "gtin" | "asin",
    source: string,
    value: string | undefined,
  ) => {
    if (!value) return;
    identityCandidates.push({ field, source, value });
  };
  addIdentityCandidate("brand", retailer?.extractorId ?? "retailer", retailer?.brand);
  addIdentityCandidate("modelId", retailer?.extractorId ?? "retailer", retailer?.modelId);
  addIdentityCandidate("sku", retailer?.extractorId ?? "retailer", retailer?.sku);
  addIdentityCandidate("mpn", retailer?.extractorId ?? "retailer", retailer?.mpn);
  addIdentityCandidate("gtin", retailer?.extractorId ?? "retailer", retailer?.gtin);
  addIdentityCandidate("asin", retailer?.extractorId ?? "retailer", retailer?.asin);
  addIdentityCandidate("brand", "json_ld", ld?.brand);
  addIdentityCandidate("sku", "json_ld", ld?.sku);
  addIdentityCandidate("mpn", "json_ld", ld?.mpn);
  addIdentityCandidate("gtin", "json_ld", ld?.gtin);
  addIdentityCandidate("brand", "meta", metaIdentity.brand);
  addIdentityCandidate("modelId", "meta", metaIdentity.modelId);
  addIdentityCandidate("sku", "meta", metaIdentity.sku);
  addIdentityCandidate("mpn", "meta", metaIdentity.mpn);
  addIdentityCandidate("gtin", "meta", metaIdentity.gtin);
  addIdentityCandidate("asin", "meta", metaIdentity.asin);

  const chosenIdentityFields: ExtractionDebugInfo["chosen"]["identityFields"] = [];
  const pushChosenIdentity = (
    field: "brand" | "modelId" | "sku" | "mpn" | "gtin" | "asin",
    value: string | undefined,
    choices: Array<{ source: string; value: string }>,
  ) => {
    if (!value) return;
    const match = choices.find((choice) => choice.value === value);
    chosenIdentityFields.push({
      field,
      source: match?.source ?? "combined",
      value,
    });
  };
  pushChosenIdentity("brand", extracted.brand, identityCandidates.filter((candidate) => candidate.field === "brand"));
  pushChosenIdentity("modelId", extracted.modelId, identityCandidates.filter((candidate) => candidate.field === "modelId"));
  pushChosenIdentity("sku", extracted.sku, identityCandidates.filter((candidate) => candidate.field === "sku"));
  pushChosenIdentity("mpn", extracted.mpn, identityCandidates.filter((candidate) => candidate.field === "mpn"));
  pushChosenIdentity("gtin", extracted.gtin, identityCandidates.filter((candidate) => candidate.field === "gtin"));
  pushChosenIdentity("asin", extracted.asin, identityCandidates.filter((candidate) => candidate.field === "asin"));

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
      identityCandidates,
      chosen: {
        title: extracted.title && titleSource ? { source: titleSource, value: extracted.title } : undefined,
        price:
          extracted.price != null && priceSource
            ? { source: priceSource, value: extracted.price, currency: extracted.currency }
            : undefined,
        identityFields: chosenIdentityFields,
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
