import { describe, expect, it } from "vitest";
import { buildWatchFromTemplate, listWatchTemplates } from "./templates.js";

describe("listWatchTemplates", () => {
  it("returns the built-in starter templates", () => {
    const templates = listWatchTemplates();
    expect(templates.map((template) => template.id)).toEqual([
      "price_cap",
      "percent_drop",
      "hybrid_deal",
      "restock_signal",
      "clearance_hunter",
    ]);
  });
});

describe("buildWatchFromTemplate", () => {
  it("builds a price-cap watch with template defaults", () => {
    const built = buildWatchFromTemplate({
      templateId: "price_cap",
      url: "https://example.com/item",
      maxPrice: 199.99,
      tags: ["gpu"],
    });

    expect(built).toMatchObject({
      url: "https://example.com/item",
      maxPrice: 199.99,
      checkIntervalHint: "daily",
      tags: ["price-cap", "gpu"],
    });
    expect(built.template?.id).toBe("price_cap");
  });

  it("merges keyword defaults for stock-oriented templates", () => {
    const built = buildWatchFromTemplate({
      templateId: "restock_signal",
      url: "https://example.com/item",
      keywords: ["notify me"],
    });

    expect(built.keywords).toEqual(["in stock", "available", "add to cart", "notify me"]);
    expect(built.checkIntervalHint).toBe("1h");
  });

  it("requires template-specific threshold fields when needed", () => {
    expect(() =>
      buildWatchFromTemplate({
        templateId: "price_cap",
        url: "https://example.com/item",
      }),
    ).toThrow(/requires maxPrice/i);

    expect(() =>
      buildWatchFromTemplate({
        templateId: "percent_drop",
        url: "https://example.com/item",
      }),
    ).toThrow(/requires percentDrop/i);
  });

  it("requires at least one threshold for the hybrid template", () => {
    expect(() =>
      buildWatchFromTemplate({
        templateId: "hybrid_deal",
        url: "https://example.com/item",
      }),
    ).toThrow(/hybrid_deal/i);
  });
});
