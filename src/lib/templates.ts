import type { Watch } from "../types.js";

export type WatchTemplateId =
  | "price_cap"
  | "percent_drop"
  | "hybrid_deal"
  | "restock_signal"
  | "clearance_hunter";

type WatchTemplateDefinition = {
  id: WatchTemplateId;
  name: string;
  description: string;
  recommendedFor: string[];
  requiredFields: Array<"maxPrice" | "percentDrop" | "url">;
  defaults: {
    keywords?: string[];
    checkIntervalHint?: string;
    tags?: string[];
  };
  suggestions: string[];
};

const WATCH_TEMPLATES: WatchTemplateDefinition[] = [
  {
    id: "price_cap",
    name: "Price Cap",
    description: "Track one product until it falls to or below a concrete target price.",
    recommendedFor: ["steady price watches", "simple buy-when-under-X cases"],
    requiredFields: ["url", "maxPrice"],
    defaults: {
      checkIntervalHint: "daily",
      tags: ["price-cap"],
    },
    suggestions: [
      "Use when you already know the maximum acceptable buy price.",
      "Works best for stable products where threshold hits matter more than trend context.",
    ],
  },
  {
    id: "percent_drop",
    name: "Percent Drop",
    description: "Alert when the latest committed price drops by a chosen percentage.",
    recommendedFor: ["seasonal sales", "price volatility watches", "bigger-ticket items"],
    requiredFields: ["url", "percentDrop"],
    defaults: {
      checkIntervalHint: "6h",
      tags: ["percent-drop"],
    },
    suggestions: [
      "Use when the product swings often and historical context matters more than a fixed cap.",
      "Good default for GPUs, monitors, appliances, and other high-variance items.",
    ],
  },
  {
    id: "hybrid_deal",
    name: "Hybrid Deal",
    description: "Combine a price cap, percent drop, and optional keywords for a higher-signal deal watch.",
    recommendedFor: ["primary buy targets", "high-interest products", "agent-managed portfolios"],
    requiredFields: ["url"],
    defaults: {
      checkIntervalHint: "4h",
      tags: ["hybrid-deal"],
    },
    suggestions: [
      "Best general-purpose template when you want both thresholds and trend context.",
      "Add keywords when specific deal language or bundle terms matter.",
    ],
  },
  {
    id: "restock_signal",
    name: "Restock Signal",
    description: "Focus on stock or add-to-cart language rather than purely on price thresholds.",
    recommendedFor: ["hard-to-find items", "restocks", "low-stock drops"],
    requiredFields: ["url"],
    defaults: {
      keywords: ["in stock", "available", "add to cart"],
      checkIntervalHint: "1h",
      tags: ["restock"],
    },
    suggestions: [
      "Good for scarce products where availability matters more than price movement.",
      "Customize keywords for retailer-specific stock language if needed.",
    ],
  },
  {
    id: "clearance_hunter",
    name: "Clearance Hunter",
    description: "Bias the watch toward clearance, open-box, coupon, and liquidation-style language.",
    recommendedFor: ["clearance pages", "warehouse deals", "open-box hunting"],
    requiredFields: ["url"],
    defaults: {
      keywords: ["clearance", "open box", "refurbished", "coupon"],
      checkIntervalHint: "6h",
      tags: ["clearance"],
    },
    suggestions: [
      "Useful when language and merchandising patterns are part of the signal.",
      "Often pairs well with maxPrice for tighter filtering.",
    ],
  },
];

function uniqueStrings(values: string[] | undefined): string[] | undefined {
  if (!values?.length) return undefined;
  const normalized = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  return normalized.length ? normalized : undefined;
}

export function listWatchTemplates() {
  return WATCH_TEMPLATES.map((template) => ({
    ...template,
    defaults: {
      ...template.defaults,
      keywords: template.defaults.keywords ? [...template.defaults.keywords] : undefined,
      tags: template.defaults.tags ? [...template.defaults.tags] : undefined,
    },
  }));
}

export function getWatchTemplate(templateId: string) {
  return WATCH_TEMPLATES.find((template) => template.id === templateId);
}

export function buildWatchFromTemplate(input: {
  templateId: WatchTemplateId;
  url: string;
  label?: string;
  group?: string;
  tags?: string[];
  maxPrice?: number;
  percentDrop?: number;
  keywords?: string[];
  checkIntervalHint?: string;
  enabled?: boolean;
}): Omit<Watch, "id" | "createdAt" | "enabled"> & { enabled?: boolean; template: ReturnType<typeof getWatchTemplate> } {
  const template = getWatchTemplate(input.templateId);
  if (!template) {
    throw new Error(`deal-hunter: unknown watch template "${input.templateId}"`);
  }

  if (template.requiredFields.includes("maxPrice") && input.maxPrice == null) {
    throw new Error(`deal-hunter: template "${template.id}" requires maxPrice`);
  }
  if (template.requiredFields.includes("percentDrop") && input.percentDrop == null) {
    throw new Error(`deal-hunter: template "${template.id}" requires percentDrop`);
  }
  if (template.id === "hybrid_deal" && input.maxPrice == null && input.percentDrop == null) {
    throw new Error('deal-hunter: template "hybrid_deal" requires maxPrice, percentDrop, or both');
  }

  return {
    url: input.url,
    label: input.label,
    group: input.group,
    tags: uniqueStrings([...(template.defaults.tags ?? []), ...(input.tags ?? [])]),
    maxPrice: input.maxPrice,
    percentDrop: input.percentDrop,
    keywords: uniqueStrings([...(template.defaults.keywords ?? []), ...(input.keywords ?? [])]),
    checkIntervalHint: input.checkIntervalHint ?? template.defaults.checkIntervalHint,
    enabled: input.enabled,
    template,
  };
}
