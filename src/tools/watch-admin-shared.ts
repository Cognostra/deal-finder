import { Type } from "@sinclair/typebox";

export const IMPORTED_WATCH_SCHEMA = Type.Object({
  id: Type.Optional(Type.String()),
  url: Type.String(),
  label: Type.Optional(Type.String()),
  group: Type.Optional(Type.String()),
  tags: Type.Optional(Type.Array(Type.String())),
  maxPrice: Type.Optional(Type.Number()),
  percentDrop: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
  keywords: Type.Optional(Type.Array(Type.String())),
  checkIntervalHint: Type.Optional(Type.String()),
  enabled: Type.Optional(Type.Boolean()),
  createdAt: Type.Optional(Type.String()),
  importSource: Type.Optional(
    Type.Union([
      Type.Object({
        type: Type.Literal("url"),
        url: Type.String(),
        importedAt: Type.String(),
      }),
      Type.Object({
        type: Type.Literal("discovery"),
        importedAt: Type.String(),
        discoveryProvider: Type.Union([Type.Literal("manual"), Type.Literal("firecrawl-search")]),
        sourceWatchId: Type.String(),
        sourceWatchUrl: Type.String(),
        sourceWatchLabel: Type.Optional(Type.String()),
        candidateUrl: Type.String(),
        searchQuery: Type.Optional(Type.String()),
        searchRank: Type.Optional(Type.Integer({ minimum: 1 })),
        searchTitle: Type.Optional(Type.String()),
        searchDescription: Type.Optional(Type.String()),
      }),
    ]),
  ),
  lastSnapshot: Type.Optional(
    Type.Object({
      title: Type.Optional(Type.String()),
      canonicalTitle: Type.Optional(Type.String()),
      brand: Type.Optional(Type.String()),
      modelId: Type.Optional(Type.String()),
      sku: Type.Optional(Type.String()),
      mpn: Type.Optional(Type.String()),
      gtin: Type.Optional(Type.String()),
      asin: Type.Optional(Type.String()),
      price: Type.Optional(Type.Number()),
      currency: Type.Optional(Type.String()),
      etag: Type.Optional(Type.String()),
      lastModified: Type.Optional(Type.String()),
      contentHash: Type.Optional(Type.String()),
      fetchedAt: Type.String(),
      rawSnippet: Type.Optional(Type.String()),
      fetchSource: Type.Optional(Type.Union([Type.Literal("node_http"), Type.Literal("firecrawl")])),
      responseBytes: Type.Optional(Type.Number()),
      responseTruncated: Type.Optional(Type.Boolean()),
      reviewedFields: Type.Optional(
        Type.Array(
          Type.Object({
            field: Type.Union([
              Type.Literal("title"),
              Type.Literal("canonicalTitle"),
              Type.Literal("brand"),
              Type.Literal("modelId"),
              Type.Literal("sku"),
              Type.Literal("mpn"),
              Type.Literal("gtin"),
              Type.Literal("asin"),
              Type.Literal("price"),
              Type.Literal("currency"),
              Type.Literal("rawSnippet"),
            ]),
            originalValue: Type.Union([Type.String(), Type.Number(), Type.Null()]),
            reviewedValue: Type.Union([Type.String(), Type.Number(), Type.Null()]),
            reviewSource: Type.String(),
            reviewedAt: Type.String(),
            candidateType: Type.Optional(Type.Union([Type.Literal("extraction_review"), Type.Literal("identity_resolution")])),
            provider: Type.Optional(Type.String()),
            model: Type.Optional(Type.String()),
            reasons: Type.Optional(Type.Array(Type.String())),
          }),
        ),
      ),
    }),
  ),
  history: Type.Optional(
    Type.Array(
      Type.Object({
        fetchedAt: Type.String(),
        price: Type.Optional(Type.Number()),
        currency: Type.Optional(Type.String()),
        title: Type.Optional(Type.String()),
        canonicalTitle: Type.Optional(Type.String()),
        contentHash: Type.Optional(Type.String()),
        changeType: Type.Optional(Type.String()),
        alertSeverity: Type.Optional(Type.Union([
          Type.Literal("none"),
          Type.Literal("low"),
          Type.Literal("medium"),
          Type.Literal("high"),
        ])),
        alerts: Type.Optional(Type.Array(Type.String())),
        summaryLine: Type.Optional(Type.String()),
      }),
    ),
  ),
});

export function mergeImportedTags(existingTags: string[] | undefined, extraTags: string[] | undefined): string[] | undefined {
  const merged = [...new Set([...(existingTags ?? []), ...(extraTags ?? [])].map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
  return merged.length ? merged : undefined;
}
