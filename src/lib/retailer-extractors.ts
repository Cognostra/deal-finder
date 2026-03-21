export type RetailerExtraction = {
  extractorId: string;
  title?: string;
  brand?: string;
  modelId?: string;
  sku?: string;
  mpn?: string;
  gtin?: string;
  asin?: string;
  price?: number;
  currency?: string;
};

export function normalizeIdentityValue(value?: string | null): string | undefined {
  if (!value) return undefined;
  const normalized = value
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || undefined;
}

export function normalizeIdentifierCode(value?: string | null): string | undefined {
  const normalized = normalizeIdentityValue(value);
  return normalized ? normalized.toUpperCase() : undefined;
}

function parseCurrencySymbol(symbol?: string): string | undefined {
  if (!symbol) return undefined;
  if (symbol === "$") return "USD";
  if (symbol === "£") return "GBP";
  if (symbol === "€") return "EUR";
  return undefined;
}

export function parseCurrencyAmount(raw?: string): { price?: number; currency?: string } {
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
    asin: normalizeIdentifierCode(
      html.match(/(?:id|name)=["']ASIN["'][^>]*value=["']([^"']+)["']/i)?.[1] ??
        html.match(/data-asin=["']([^"']+)["']/i)?.[1],
    ),
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
    brand: normalizeIdentityValue(title?.split(" ")[0]),
    modelId: normalizeIdentifierCode(title?.match(/\b([A-Z]{1,5}-[A-Z0-9-]{3,})\b/)?.[1]),
    sku:
      normalizeIdentifierCode(html.match(/itemprop=["']sku["'][^>]*content=["']([^"']+)["']/i)?.[1]) ??
      normalizeIdentifierCode(html.match(/sku["':\s>#-]*([0-9]{5,})/i)?.[1]),
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
    brand: normalizeIdentityValue(title?.split(" ")[0]),
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
    brand: normalizeIdentityValue(title?.split(" ")[0]),
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
    brand: normalizeIdentityValue(title?.split(" ")[0]),
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
    brand: normalizeIdentityValue(title?.split(" ")[0]),
    modelId:
      normalizeIdentifierCode(title?.match(/\b(RX\s*\d{4}|RTX\s*\d{4}|[A-Z]{1,5}-[A-Z0-9-]{3,})\b/i)?.[1]?.replace(/\s+/g, " ")),
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
    brand: normalizeIdentityValue(title?.split(" ")[0]),
    price: amount.price,
    currency: amount.currency,
  };
}

function extractCostcoListing(html: string): RetailerExtraction | null {
  if (!/automation-id=["']productPriceOutput["']|data-testid=["']product-name["']/i.test(html)) return null;

  const title =
    html.match(/data-testid=["']product-name["'][^>]*>\s*([\s\S]*?)\s*<\/[^>]+>/i)?.[1]
      ?.replace(/\s+/g, " ")
      .trim() ??
    html.match(/<h1[^>]*>\s*([\s\S]*?)\s*<\/h1>/i)?.[1]
      ?.replace(/\s+/g, " ")
      .trim();
  const priceRaw =
    html.match(/automation-id=["']productPriceOutput["'][^>]*>\s*([$£€]\s*[\d,]+(?:\.\d+)?)\s*<\/[^>]+>/i)?.[1] ??
    html.match(/data-testid=["']product-price["'][^>]*>\s*([$£€]\s*[\d,]+(?:\.\d+)?)\s*<\/[^>]+>/i)?.[1];
  const amount = parseCurrencyAmount(priceRaw);

  if (!title && amount.price == null) return null;
  return {
    extractorId: "retailer_costco",
    title,
    brand: normalizeIdentityValue(title?.split(" ")[0]),
    price: amount.price,
    currency: amount.currency,
  };
}

function extractLowesListing(html: string): RetailerExtraction | null {
  if (!/data-testid=["']product-title["'][\s\S]*itemprop=["']price["']/i.test(html)) return null;

  const title =
    html.match(/data-testid=["']product-title["'][^>]*>\s*([\s\S]*?)\s*<\/[^>]+>/i)?.[1]
      ?.replace(/\s+/g, " ")
      .trim() ??
    html.match(/<h1[^>]*>\s*([\s\S]*?)\s*<\/h1>/i)?.[1]
      ?.replace(/\s+/g, " ")
      .trim();
  const priceRaw =
    html.match(/data-testid=["']product-price["'][^>]*>\s*([$£€]\s*[\d,]+(?:\.\d+)?)\s*<\/[^>]+>/i)?.[1] ??
    html.match(/itemprop=["']price["'][^>]*content=["']([\d.]+)["']/i)?.[1];
  const amount =
    priceRaw && /^[\d.]+$/.test(priceRaw)
      ? { price: Number.parseFloat(priceRaw), currency: "USD" }
      : parseCurrencyAmount(priceRaw);

  if (!title && amount.price == null) return null;
  return {
    extractorId: "retailer_lowes",
    title,
    brand: normalizeIdentityValue(title?.split(" ")[0]),
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
    extractLowesListing(html) ??
    extractWalmartListing(html) ??
    extractNeweggListing(html) ??
    extractHomeDepotListing(html) ??
    extractCostcoListing(html)
  );
}
