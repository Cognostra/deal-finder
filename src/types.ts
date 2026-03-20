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
  llmReview?: {
    mode?: LlmReviewMode;
    lowConfidenceThreshold?: number;
    maxReviewsPerScan?: number;
    allowPriceRewrite?: boolean;
    allowIdentityRewrite?: boolean;
    provider?: string;
    model?: string;
    timeoutMs?: number;
  };
  discovery?: {
    enabled?: boolean;
    provider?: DiscoveryProvider;
    maxSearchResults?: number;
    maxFetches?: number;
    allowedHosts?: string[];
    blockedHosts?: string[];
    timeoutMs?: number;
  };
};

export type LlmReviewMode = "off" | "queue" | "auto_assist";
export type DiscoveryProvider = "off" | "manual" | "firecrawl-search";

export type ReviewedSnapshotFieldName =
  | "title"
  | "canonicalTitle"
  | "brand"
  | "modelId"
  | "sku"
  | "mpn"
  | "gtin"
  | "asin"
  | "price"
  | "currency"
  | "rawSnippet";

export type ReviewedSnapshotFieldValue = string | number | null;

export type ReviewedSnapshotField = {
  field: ReviewedSnapshotFieldName;
  originalValue: ReviewedSnapshotFieldValue;
  reviewedValue: ReviewedSnapshotFieldValue;
  reviewSource: string;
  reviewedAt: string;
  candidateType?: LlmReviewCandidateType;
  provider?: string;
  model?: string;
  reasons?: string[];
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
  reviewedFields?: ReviewedSnapshotField[];
};

export type ProductIdentityField = "brand" | "modelId" | "sku" | "mpn" | "gtin" | "asin";

export type ProductIdentityEntry = {
  field: ProductIdentityField;
  value: string;
};

export type ProductMatchStrength = "low" | "medium" | "high";

export type ProductMatchCandidate = {
  watchId: string;
  label?: string;
  url: string;
  latestPrice?: number;
  sharedFields: ProductIdentityField[];
  conflictingFields: ProductIdentityField[];
  matchScore: number;
  matchStrength: ProductMatchStrength;
  matchReasons: string[];
  matchWarnings: string[];
};

export type DiscoveryCandidate = {
  url: string;
  host: string;
  sourceWatchId: string;
  searchQuery?: string;
  searchRank?: number;
  searchTitle?: string;
  searchDescription?: string;
  matchScore?: number;
  matchStrength?: ProductMatchStrength;
  matchedFields: ProductIdentityField[];
  conflictingFields: ProductIdentityField[];
  matchReasons: string[];
  matchWarnings: string[];
  extractedTitle?: string;
  canonicalTitle?: string;
  brand?: string;
  modelId?: string;
  sku?: string;
  mpn?: string;
  gtin?: string;
  asin?: string;
  price?: number;
  currency?: string;
  fetchStatus: "ok" | "blocked" | "failed";
  blockedReason?: string;
  recommendedAction: "strong_candidate_for_import" | "review_before_import" | "likely_not_same_product" | "blocked_or_failed";
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

export type WatchImportSource =
  | {
      type: "url";
      url: string;
      importedAt: string;
    }
  | {
      type: "discovery";
      importedAt: string;
      discoveryProvider: Exclude<DiscoveryProvider, "off">;
      sourceWatchId: string;
      sourceWatchUrl: string;
      sourceWatchLabel?: string;
      candidateUrl: string;
      searchQuery?: string;
      searchRank?: number;
      searchTitle?: string;
      searchDescription?: string;
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

export type LlmReviewCandidateType = "extraction_review" | "identity_resolution";

export type LlmReviewCandidate = {
  watchId: string;
  label?: string;
  url: string;
  type: LlmReviewCandidateType;
  priority: "high" | "medium";
  reasons: string[];
  currentSnapshot: {
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
    rawSnippet?: string;
  } | null;
  prompt: string;
  input: Record<string, unknown>;
  suggestedSchema: Record<string, unknown>;
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
  reviewMode: LlmReviewMode;
  reviewQueued: boolean;
  reviewApplied: boolean;
  reviewWarnings: string[];
  reviewedFields: ReviewedSnapshotFieldName[];
  reviewProvider?: string;
  reviewModel?: string;
  reviewCandidateType?: LlmReviewCandidateType;
};
