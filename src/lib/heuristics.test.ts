import { describe, expect, it } from "vitest";
import { canonicalizeTitle, evaluateListingText, extractListing, extractJsonLdProduct, hashSnippet } from "./heuristics.js";

describe("hashSnippet", () => {
  it("is stable short hex", () => {
    expect(hashSnippet("abc")).toBe(hashSnippet("abc"));
    expect(hashSnippet("abc")).toHaveLength(32);
  });
});

describe("extractJsonLdProduct", () => {
  it("parses single product", () => {
    const html = `<script type="application/ld+json">{"@type":"Product","name":"Widget","offers":{"@type":"Offer","price":9.99,"priceCurrency":"USD"}}</script>`;
    expect(extractJsonLdProduct(html)).toEqual({
      name: "Widget",
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
