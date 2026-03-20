export type DealHunterPluginConfig = {
  /** Override default JSON store location */
  storePath?: string;
  maxConcurrent?: number;
  maxBytesPerResponse?: number;
  defaultMaxRpsPerHost?: number;
  requestTimeoutMs?: number;
  userAgents?: string[];
  proxyUrl?: string;
  allowedHosts?: string[];
  blockedHosts?: string[];
  fetcher?: "local" | "firecrawl";
  firecrawlApiKey?: string;
  firecrawlBaseUrl?: string;
};

export type WatchSnapshot = {
  title?: string;
  canonicalTitle?: string;
  brand?: string;
  modelId?: string;
  sku?: string;
  mpn?: string;
  gtin?: string;
  asin?: string;
  price?: number;
  currency?: string;
  etag?: string;
  lastModified?: string;
  contentHash?: string;
  fetchedAt: string;
  rawSnippet?: string;
};

export type WatchHistoryEntry = {
  fetchedAt: string;
  price?: number;
  currency?: string;
  title?: string;
  canonicalTitle?: string;
  contentHash?: string;
  changeType?: ScanChangeType;
  alertSeverity?: AlertSeverity;
  alerts?: string[];
  summaryLine?: string;
};

export type WatchImportSource = {
  type: "url";
  url: string;
  importedAt: string;
};

export type WatchSearchSortBy = "createdAt" | "label" | "price";

export type WatchSelector = {
  query?: string;
  enabled?: boolean;
  hasSnapshot?: boolean;
  hasSignals?: boolean;
  tag?: string;
  group?: string;
  sortBy?: WatchSearchSortBy;
  descending?: boolean;
  limit?: number;
};

export type SavedWatchView = {
  id: string;
  name: string;
  description?: string;
  selector: WatchSelector;
  createdAt: string;
};

export type Watch = {
  id: string;
  url: string;
  label?: string;
  group?: string;
  tags?: string[];
  maxPrice?: number;
  percentDrop?: number;
  keywords?: string[];
  checkIntervalHint?: string;
  enabled: boolean;
  createdAt: string;
  importSource?: WatchImportSource;
  lastSnapshot?: WatchSnapshot;
  history?: WatchHistoryEntry[];
};

export type StoreFile = {
  version: 2;
  watches: Watch[];
  savedViews: SavedWatchView[];
};

export type FetchMeta = {
  status: number;
  finalUrl: string;
  bytesRead: number;
  etag?: string;
  lastModified?: string;
  notModified?: boolean;
};

export type ExtractedListing = {
  title?: string;
  canonicalTitle?: string;
  brand?: string;
  modelId?: string;
  sku?: string;
  mpn?: string;
  gtin?: string;
  asin?: string;
  price?: number;
  currency?: string;
  snippet?: string;
};

export type ExtractionDebugInfo = {
  matchedExtractor?: string;
  titleCandidates: Array<{ source: string; value: string }>;
  priceCandidates: Array<{ source: string; value: number; currency?: string }>;
  identityCandidates: Array<{ field: "brand" | "modelId" | "sku" | "mpn" | "gtin" | "asin"; source: string; value: string }>;
  chosen: {
    title?: { source: string; value: string };
    price?: { source: string; value: number; currency?: string };
    identityFields: Array<{ field: "brand" | "modelId" | "sku" | "mpn" | "gtin" | "asin"; source: string; value: string }>;
  };
};

export type ExtractionConfidence = {
  score: number;
  level: "none" | "low" | "medium" | "high";
  reasons: string[];
};

export type ScanChangeType =
  | "fetch_failed"
  | "not_modified"
  | "first_seen"
  | "unchanged"
  | "price_drop"
  | "price_increase"
  | "content_changed";

export type AlertSeverity = "none" | "low" | "medium" | "high";

export type FetchSource = "node_http" | "firecrawl";

export type ScanResultItem = {
  watchId: string;
  label?: string;
  url: string;
  fetchSource: FetchSource;
  fetchSourceNote: string;
  ok: boolean;
  error?: string;
  changed: boolean;
  changeType: ScanChangeType;
  changeReasons: string[];
  previousPrice?: number;
  currentPrice?: number;
  previousCurrency?: string;
  currentCurrency?: string;
  priceDelta?: number;
  percentDelta?: number;
  alertSeverity: AlertSeverity;
  alertScore: number;
  extractionConfidence: ExtractionConfidence;
  summaryLine: string;
  timingMs: { fetch: number; parse: number; total: number };
  meta?: FetchMeta;
  before?: WatchSnapshot;
  after?: WatchSnapshot;
  extracted?: ExtractedListing;
  alerts: string[];
};
