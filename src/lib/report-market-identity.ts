import type { ProductIdentityEntry, StoreFile, Watch } from "../types.js";
import { buildProductMatchCandidates, getWatchIdentityFields, getWatchIdentityStrength } from "./product-identity.js";

export function buildWatchIdentitySummary(
  store: StoreFile,
  watch: Watch,
): {
  watchId: string;
  label?: string;
  url: string;
  identifiers: ProductIdentityEntry[];
  strength: "none" | "low" | "medium" | "high";
  reasons: string[];
  relatedWatches: Array<{
    watchId: string;
    label?: string;
    url: string;
    sharedFields: string[];
    conflictingFields: string[];
    matchScore: number;
    matchStrength: "low" | "medium" | "high";
    matchReasons: string[];
    matchWarnings: string[];
    latestPrice?: number;
  }>;
} {
  const identifiers = getWatchIdentityFields(watch);
  const identityStrength = getWatchIdentityStrength(watch);
  const reasons = [...identityStrength.reasons];
  const relatedWatches = buildProductMatchCandidates(watch, store.watches, { includeLooseTitleFallback: false }).map((candidate) => ({
    watchId: candidate.watchId,
    label: candidate.label,
    url: candidate.url,
    sharedFields: candidate.sharedFields,
    conflictingFields: candidate.conflictingFields,
    matchScore: candidate.matchScore,
    matchStrength: candidate.matchStrength,
    matchReasons: candidate.matchReasons,
    matchWarnings: candidate.matchWarnings,
    latestPrice: candidate.latestPrice,
  }));

  if (relatedWatches.length) {
    reasons.push(`Found ${relatedWatches.length} other watch${relatedWatches.length === 1 ? "" : "es"} sharing stored identifiers.`);
  }

  return {
    watchId: watch.id,
    label: watch.label,
    url: watch.url,
    identifiers,
    strength: identityStrength.strength,
    reasons,
    relatedWatches,
  };
}

export function buildMarketCheckSummary(
  store: StoreFile,
  watch: Watch,
  options?: { includeLooseTitleFallback?: boolean },
): {
  watchId: string;
  label?: string;
  url: string;
  anchorPrice?: number;
  identity: ProductIdentityEntry[];
  matchCount: number;
  bestKnownPrice?: number;
  highestKnownPrice?: number;
  spread?: {
    absolute: number;
    percentFromBest: number;
  };
  matches: Array<{
    watchId: string;
    label?: string;
    url: string;
    latestPrice?: number;
    sharedFields: string[];
    conflictingFields: string[];
    matchScore: number;
    matchStrength: "low" | "medium" | "high";
    matchReasons: string[];
    matchWarnings: string[];
  }>;
  reasons: string[];
} {
  const anchorPrice = watch.lastSnapshot?.price;
  const identity = getWatchIdentityFields(watch);
  const matches = buildProductMatchCandidates(watch, store.watches, options);
  const knownPrices = [anchorPrice, ...matches.map((match) => match.latestPrice)].filter((price): price is number => price != null);
  const bestKnownPrice = knownPrices.length ? Math.min(...knownPrices) : undefined;
  const highestKnownPrice = knownPrices.length ? Math.max(...knownPrices) : undefined;
  const spread =
    bestKnownPrice != null && highestKnownPrice != null && highestKnownPrice > bestKnownPrice
      ? {
          absolute: Number((highestKnownPrice - bestKnownPrice).toFixed(2)),
          percentFromBest: Number((((highestKnownPrice - bestKnownPrice) / bestKnownPrice) * 100).toFixed(1)),
        }
      : undefined;

  const reasons: string[] = [];
  if (!identity.length) {
    reasons.push("No strong stored identifiers are available on the anchor watch; comparison may rely on title/brand similarity.");
  } else {
    reasons.push(`Anchor identifiers: ${identity.map((identifier) => `${identifier.field}=${identifier.value}`).join(", ")}.`);
  }
  if (matches.length) {
    reasons.push(`Found ${matches.length} likely same-product watch${matches.length === 1 ? "" : "es"} in the current store.`);
  } else {
    reasons.push("No likely same-product watches were found in the current store.");
  }
  const conflictCount = matches.reduce((count, match) => count + match.conflictingFields.length, 0);
  if (conflictCount > 0) {
    reasons.push(`Detected ${conflictCount} identifier conflict${conflictCount === 1 ? "" : "s"} across the candidate set; review match warnings before acting.`);
  }
  if (spread) {
    reasons.push(`Observed internal market spread is ${spread.absolute.toFixed(2)} (${spread.percentFromBest.toFixed(1)}% from the best known price).`);
  }

  return {
    watchId: watch.id,
    label: watch.label,
    url: watch.url,
    anchorPrice,
    identity,
    matchCount: matches.length,
    bestKnownPrice,
    highestKnownPrice,
    spread,
    matches,
    reasons,
  };
}
