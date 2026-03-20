import type {
  ExtractedListing,
  ProductIdentityEntry,
  ProductIdentityField,
  ProductMatchCandidate,
  ProductMatchStrength,
  StoreFile,
  Watch,
} from "../types.js";

type IdentityLike = Pick<ExtractedListing, "canonicalTitle" | "brand" | "modelId" | "sku" | "mpn" | "gtin" | "asin" | "price">;

export function getWatchIdentityFields(watch: Watch): ProductIdentityEntry[] {
  const snapshot = watch.lastSnapshot;
  if (!snapshot) return [];
  return ([
    ["brand", snapshot.brand],
    ["modelId", snapshot.modelId],
    ["sku", snapshot.sku],
    ["mpn", snapshot.mpn],
    ["gtin", snapshot.gtin],
    ["asin", snapshot.asin],
  ] as const)
    .filter((entry): entry is [ProductIdentityField, string] => Boolean(entry[1]))
    .map(([field, value]) => ({ field, value }));
}

export function getIdentityFieldWeight(field: ProductIdentityField): number {
  if (field === "gtin") return 100;
  if (field === "asin") return 95;
  if (field === "mpn") return 85;
  if (field === "sku") return 75;
  if (field === "modelId") return 70;
  return 20;
}

export function getWatchHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function buildIdentityMap(watch: Watch): Map<ProductIdentityField, string> {
  return new Map(getWatchIdentityFields(watch).map((identifier) => [identifier.field, identifier.value]));
}

function buildIdentityMapFromLike(value: IdentityLike): Map<ProductIdentityField, string> {
  return new Map(
    ([
      ["brand", value.brand],
      ["modelId", value.modelId],
      ["sku", value.sku],
      ["mpn", value.mpn],
      ["gtin", value.gtin],
      ["asin", value.asin],
    ] as const)
      .filter((entry): entry is [ProductIdentityField, string] => Boolean(entry[1]))
      .map(([field, entryValue]) => [field, entryValue]),
  );
}

export function getWatchIdentityStrength(watch: Watch): {
  strength: ProductMatchStrength | "none";
  score: number;
  reasons: string[];
} {
  const identifiers = getWatchIdentityFields(watch);
  const reasons: string[] = [];
  if (!identifiers.length) {
    return {
      strength: "none",
      score: 0,
      reasons: ["No persistent product identifiers are stored on the latest snapshot."],
    };
  }

  const score = identifiers.reduce((total, identifier) => total + Math.max(1, Math.round(getIdentityFieldWeight(identifier.field) / 25)), 0);
  reasons.push(`Stored identifiers: ${identifiers.map((identifier) => `${identifier.field}=${identifier.value}`).join(", ")}.`);

  return {
    strength: score >= 6 ? "high" : score >= 3 ? "medium" : "low",
    score,
    reasons,
  };
}

export function buildProductMatchCandidates(
  anchor: Watch,
  watches: Watch[],
  options?: { includeLooseTitleFallback?: boolean },
): ProductMatchCandidate[] {
  return watches
    .filter((candidate) => candidate.id !== anchor.id)
    .map((candidate) =>
      buildIdentityLikeMatch(anchor, {
        url: candidate.url,
        watchId: candidate.id,
        label: candidate.label,
        latestPrice: candidate.lastSnapshot?.price,
        canonicalTitle: candidate.lastSnapshot?.canonicalTitle,
        brand: candidate.lastSnapshot?.brand,
        modelId: candidate.lastSnapshot?.modelId,
        sku: candidate.lastSnapshot?.sku,
        mpn: candidate.lastSnapshot?.mpn,
        gtin: candidate.lastSnapshot?.gtin,
        asin: candidate.lastSnapshot?.asin,
      }, options),
    )
    .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate))
    .sort((a, b) => b.matchScore - a.matchScore || (a.latestPrice ?? Number.POSITIVE_INFINITY) - (b.latestPrice ?? Number.POSITIVE_INFINITY))
    .slice(0, 12);
}

function buildIdentityLikeMatch(
  anchor: Watch,
  candidate: {
    url: string;
    watchId?: string;
    label?: string;
    latestPrice?: number;
    canonicalTitle?: string;
    brand?: string;
    modelId?: string;
    sku?: string;
    mpn?: string;
    gtin?: string;
    asin?: string;
  },
  options?: { includeLooseTitleFallback?: boolean },
): ProductMatchCandidate | null {
  const anchorSnapshot = anchor.lastSnapshot;
  const anchorIdentity = buildIdentityMap(anchor);
  const anchorTitle = anchorSnapshot?.canonicalTitle;
  const candidateIdentity = buildIdentityMapFromLike(candidate);
      const sharedIdentity: ProductIdentityField[] = [];
      const conflictingFields: ProductIdentityField[] = [];
      let matchScore = 0;
      const matchReasons: string[] = [];
      const matchWarnings: string[] = [];

      for (const [field, anchorValue] of anchorIdentity.entries()) {
        const candidateValue = candidateIdentity.get(field);
        if (!candidateValue) continue;
        if (candidateValue === anchorValue) {
          sharedIdentity.push(field);
          matchScore += getIdentityFieldWeight(field);
          matchReasons.push(`Shared ${field}=${anchorValue}.`);
        } else {
          conflictingFields.push(field);
          matchWarnings.push(`Conflicting ${field}: anchor=${anchorValue}, candidate=${candidateValue}.`);
          matchScore -= Math.max(10, Math.round(getIdentityFieldWeight(field) / 2));
        }
      }

      if (
        options?.includeLooseTitleFallback !== false &&
        anchorTitle &&
        candidate.canonicalTitle &&
        candidate.canonicalTitle === anchorTitle
      ) {
        matchScore += 30;
        matchReasons.push("Canonical titles match.");
      }

      if (!anchorIdentity.has("brand") && anchorSnapshot?.brand && candidate.brand && anchorSnapshot.brand === candidate.brand) {
        matchScore += 10;
        matchReasons.push("Brands match.");
      } else if (!anchorIdentity.has("brand") && anchorSnapshot?.brand && candidate.brand && anchorSnapshot.brand !== candidate.brand) {
        conflictingFields.push("brand");
        matchWarnings.push(`Conflicting brand: anchor=${anchorSnapshot.brand}, candidate=${candidate.brand}.`);
        matchScore -= 15;
      }

      if (matchScore <= 0) return null;

      const normalizedScore = Math.min(100, Math.max(1, matchScore));
      const matchStrength: ProductMatchStrength =
        normalizedScore >= 80 ? "high" : normalizedScore >= 45 ? "medium" : "low";

      return {
        watchId: candidate.watchId ?? candidate.url,
        label: candidate.label,
        url: candidate.url,
        latestPrice: candidate.latestPrice,
        sharedFields: [...new Set(sharedIdentity)],
        conflictingFields: [...new Set(conflictingFields)],
        matchScore: normalizedScore,
        matchStrength,
        matchReasons,
        matchWarnings,
      };
}

export function buildExternalProductMatchCandidate(
  anchor: Watch,
  candidate: {
    url: string;
    label?: string;
    extracted: ExtractedListing;
  },
  options?: { includeLooseTitleFallback?: boolean },
): ProductMatchCandidate | null {
  return buildIdentityLikeMatch(anchor, {
    url: candidate.url,
    label: candidate.label,
    latestPrice: candidate.extracted.price,
    canonicalTitle: candidate.extracted.canonicalTitle,
    brand: candidate.extracted.brand,
    modelId: candidate.extracted.modelId,
    sku: candidate.extracted.sku,
    mpn: candidate.extracted.mpn,
    gtin: candidate.extracted.gtin,
    asin: candidate.extracted.asin,
  }, options);
}

export function buildProductGroups(
  store: StoreFile,
  options?: { includeLooseTitleFallback?: boolean; minMatchScore?: number },
): Array<{
  groupId: string;
  title?: string;
  canonicalTitle?: string;
  identifiers: Array<{ field: ProductIdentityField; value: string; count: number }>;
  matchBasis: string[];
  watchCount: number;
  bestPrice?: number;
  highestPrice?: number;
  spread?: {
    absolute: number;
    percentFromBest: number;
  };
  bestWatchId?: string;
  members: Array<{
    watchId: string;
    label?: string;
    url: string;
    host: string;
    latestPrice?: number;
    currency?: string;
    enabled: boolean;
    sharedIdentityCount: number;
  }>;
}> {
  const minMatchScore = options?.minMatchScore ?? 80;
  const parent = new Map<string, string>();
  const watchesWithSnapshots = store.watches.filter((watch) => Boolean(watch.lastSnapshot));

  function find(id: string): string {
    const current = parent.get(id);
    if (!current || current === id) {
      parent.set(id, id);
      return id;
    }
    const root = find(current);
    parent.set(id, root);
    return root;
  }

  function union(a: string, b: string) {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) {
      parent.set(rootB, rootA);
    }
  }

  for (const watch of watchesWithSnapshots) {
    parent.set(watch.id, watch.id);
  }

  for (const watch of watchesWithSnapshots) {
    const matches = buildProductMatchCandidates(watch, watchesWithSnapshots, options);
    for (const match of matches) {
      if (match.matchScore >= minMatchScore) {
        union(watch.id, match.watchId);
      }
    }
  }

  const groups = new Map<string, Watch[]>();
  for (const watch of watchesWithSnapshots) {
    const root = find(watch.id);
    const existing = groups.get(root) ?? [];
    existing.push(watch);
    groups.set(root, existing);
  }

  return [...groups.values()]
    .filter((group) => group.length > 1)
    .map((group) => {
      const orderedByTitle = [...group].sort(
        (a, b) =>
          (b.lastSnapshot?.canonicalTitle?.length ?? 0) - (a.lastSnapshot?.canonicalTitle?.length ?? 0) ||
          (a.label ?? a.url).localeCompare(b.label ?? b.url),
      );
      const representative = orderedByTitle[0]!;
      const title = representative.lastSnapshot?.title ?? representative.label;
      const canonicalTitle = representative.lastSnapshot?.canonicalTitle;

      const identifierCounts = new Map<string, { field: ProductIdentityField; value: string; count: number }>();
      for (const watch of group) {
        for (const identifier of getWatchIdentityFields(watch)) {
          const key = `${identifier.field}:${identifier.value}`;
          const existing = identifierCounts.get(key);
          if (existing) {
            existing.count += 1;
          } else {
            identifierCounts.set(key, { ...identifier, count: 1 });
          }
        }
      }
      const identifiers = [...identifierCounts.values()]
        .sort((a, b) => b.count - a.count || getIdentityFieldWeight(b.field) - getIdentityFieldWeight(a.field))
        .slice(0, 6);

      const matchBasis = identifiers
        .filter((identifier) => identifier.count >= 2)
        .map((identifier) => `${identifier.field}=${identifier.value}`)
        .slice(0, 4);
      if (!matchBasis.length && canonicalTitle) {
        matchBasis.push(`canonicalTitle=${canonicalTitle}`);
      }

      const members = group
        .map((watch) => ({
          watchId: watch.id,
          label: watch.label,
          url: watch.url,
          host: getWatchHost(watch.url),
          latestPrice: watch.lastSnapshot?.price,
          currency: watch.lastSnapshot?.currency,
          enabled: watch.enabled,
          sharedIdentityCount: getWatchIdentityFields(watch).filter((identifier) =>
            identifiers.some((groupIdentifier) => groupIdentifier.field === identifier.field && groupIdentifier.value === identifier.value),
          ).length,
        }))
        .sort(
          (a, b) =>
            (a.latestPrice ?? Number.POSITIVE_INFINITY) - (b.latestPrice ?? Number.POSITIVE_INFINITY) ||
            Number(b.enabled) - Number(a.enabled) ||
            (a.label ?? a.url).localeCompare(b.label ?? b.url),
        );

      const prices = members
        .map((member) => member.latestPrice)
        .filter((price): price is number => price != null);
      const bestPrice = prices.length ? Math.min(...prices) : undefined;
      const highestPrice = prices.length ? Math.max(...prices) : undefined;
      const bestWatchId = bestPrice != null ? members.find((member) => member.latestPrice === bestPrice)?.watchId : undefined;
      const spread =
        bestPrice != null && highestPrice != null && highestPrice > bestPrice
          ? {
              absolute: Number((highestPrice - bestPrice).toFixed(2)),
              percentFromBest: Number((((highestPrice - bestPrice) / bestPrice) * 100).toFixed(1)),
            }
          : undefined;

      return {
        groupId: group.map((watch) => watch.id).sort()[0]!,
        title,
        canonicalTitle,
        identifiers,
        matchBasis,
        watchCount: group.length,
        bestPrice,
        highestPrice,
        spread,
        bestWatchId,
        members,
      };
    })
    .sort(
      (a, b) =>
        (b.spread?.percentFromBest ?? 0) - (a.spread?.percentFromBest ?? 0) ||
        b.watchCount - a.watchCount ||
        (a.title ?? a.groupId).localeCompare(b.title ?? b.groupId),
    );
}
