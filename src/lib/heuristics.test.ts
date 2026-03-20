import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalizeTitle, debugExtractListing, evaluateListingText, extractListing, extractJsonLdProduct, extractRetailerListing, hashSnippet, scoreExtractedListing } from "./heuristics.js";

function loadFixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

describe("hashSnippet", () => {
  it("is stable short hex", () => {
    expect(hashSnippet("abc")).toBe(hashSnippet("abc"));
    expect(hashSnippet("abc")).toHaveLength(32);
  });
});

describe("extractJsonLdProduct", () => {
  it("parses single product", () => {
    const html = `<script type="application/ld+json">{"@type":"Product","name":"Widget","brand":{"@type":"Brand","name":"Acme"},"sku":"WID-001","mpn":"WID-001-BL","gtin13":"0123456789012","offers":{"@type":"Offer","price":9.99,"priceCurrency":"USD"}}</script>`;
    expect(extractJsonLdProduct(html)).toEqual({
      name: "Widget",
      brand: "Acme",
      sku: "WID-001",
      mpn: "WID-001-BL",
      gtin: "0123456789012",
      price: 9.99,
      currency: "USD",
    });
  });
});

describe("extractListing", () => {
  it("merges ld+json and og", () => {
    const html = `
      <meta property="og:title" content="Shiny" />
      <script type="application/ld+json">{"@type":"Product","name":"Real Name","offers":{"price":5,"priceCurrency":"USD"}}</script>
    `;
    const x = extractListing(html);
    expect(x.title).toBe("Real Name");
    expect(x.price).toBe(5);
    expect(x.currency).toBe("USD");
  });

  it("adds a canonical title form", () => {
    const html = `<meta property="og:title" content="  Widget™ Pro — Blue  " />`;
    const x = extractListing(html);
    expect(x.title).toBe("Widget™ Pro — Blue");
    expect(x.canonicalTitle).toBe("widget pro - blue");
  });

  it("extracts brand and product identifiers when available", () => {
    const html = loadFixture("bestbuy-product.html");
    const x = extractListing(html);
    expect(x.brand).toBe("Sony");
    expect(x.modelId).toBe("WH-1000XM5");
    expect(x.sku).toBe("6505727");
    expect(x.mpn).toBe("WH1000XM5/B");
  });
});

describe("debugExtractListing", () => {
  it("returns candidate sources and chosen fields", () => {
    const html = `
      <meta property="og:title" content="Shiny" />
      <script type="application/ld+json">{"@type":"Product","name":"Real Name","offers":{"price":5,"priceCurrency":"USD"}}</script>
    `;
    const debug = debugExtractListing(html);
    expect(debug.debug.titleCandidates).toContainEqual({ source: "json_ld", value: "Real Name" });
    expect(debug.debug.priceCandidates).toContainEqual({ source: "json_ld", value: 5, currency: "USD" });
    expect(debug.debug.chosen.title).toEqual({ source: "json_ld", value: "Real Name" });
    expect(debug.debug.chosen.price).toEqual({ source: "json_ld", value: 5, currency: "USD" });
    expect(debug.confidence.level).toBe("high");
  });

  it("surfaces retailer extractor provenance when matched", () => {
    const html = loadFixture("amazon-product.html");
    const debug = debugExtractListing(html);
    expect(debug.debug.matchedExtractor).toBe("retailer_amazon");
    expect(debug.debug.chosen.title).toEqual({ source: "retailer_amazon", value: "Echo Dot (5th Gen) Smart Speaker" });
    expect(debug.debug.chosen.price).toEqual({ source: "retailer_amazon", value: 34.99, currency: "USD" });
    expect(debug.debug.chosen.identityFields).toContainEqual({ field: "asin", source: "retailer_amazon", value: "B09B8V1LZ3" });
  });
});

describe("canonicalizeTitle", () => {
  it("normalizes cosmetic title differences", () => {
    expect(canonicalizeTitle("  Widget™ Pro — Blue  ")).toBe("widget pro - blue");
  });
});

describe("evaluateListingText", () => {
  it("flags free", () => {
    const e = evaluateListingText("This item is free today only");
    expect(e.score).toBeGreaterThan(0);
    expect(e.flags).toContain("possible_free_or_full_discount");
  });
});

describe("scoreExtractedListing", () => {
  it("scores sparse extraction lower than complete extraction", () => {
    expect(scoreExtractedListing({ title: "Widget", price: 5, currency: "USD" }).level).toBe("high");
    expect(scoreExtractedListing({ title: "Widget" }).level).toBe("low");
  });
});

describe("extractRetailerListing fixtures", () => {
  it("extracts from amazon fixture", () => {
    expect(extractRetailerListing(loadFixture("amazon-product.html"))).toEqual({
      extractorId: "retailer_amazon",
      title: "Echo Dot (5th Gen) Smart Speaker",
      asin: "B09B8V1LZ3",
      price: 34.99,
      currency: "USD",
    });
  });

  it("extracts from best buy fixture", () => {
    expect(extractRetailerListing(loadFixture("bestbuy-product.html"))).toEqual({
      extractorId: "retailer_best_buy",
      title: "Sony WH-1000XM5 Wireless Headphones",
      brand: "Sony",
      modelId: "WH-1000XM5",
      sku: "6505727",
      price: 299.99,
      currency: "USD",
    });
  });

  it("extracts from ebay fixture", () => {
    expect(extractRetailerListing(loadFixture("ebay-product.html"))).toEqual({
      extractorId: "retailer_ebay",
      title: "Vintage Nintendo GameCube Console",
      brand: "Vintage",
      price: 89.5,
      currency: "USD",
    });
  });

  it("extracts from target fixture", () => {
    expect(extractRetailerListing(loadFixture("target-product.html"))).toEqual({
      extractorId: "retailer_target",
      title: "LEGO Star Wars X-Wing Starfighter",
      brand: "LEGO",
      price: 47.99,
      currency: "USD",
    });
  });

  it("extracts from walmart fixture", () => {
    expect(extractRetailerListing(loadFixture("walmart-product.html"))).toEqual({
      extractorId: "retailer_walmart",
      title: "Apple AirPods Pro (2nd Generation)",
      brand: "Apple",
      price: 189,
      currency: "USD",
    });
  });

  it("extracts from newegg fixture", () => {
    expect(extractRetailerListing(loadFixture("newegg-product.html"))).toEqual({
      extractorId: "retailer_newegg",
      title: "ASRock Radeon RX 7600 Challenger 8GB",
      brand: "ASRock",
      modelId: "RX 7600",
      price: 249.99,
      currency: "USD",
    });
  });

  it("extracts from home depot fixture", () => {
    expect(extractRetailerListing(loadFixture("home-depot-product.html"))).toEqual({
      extractorId: "retailer_home_depot",
      title: "DEWALT 20V MAX Cordless Drill Kit",
      brand: "DEWALT",
      price: 129,
      currency: "USD",
    });
  });
});
