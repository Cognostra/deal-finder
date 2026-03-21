import type { LlmReviewCandidate, StoreFile, Watch, WatchHistoryEntry } from "../types.js";
import { getWatchIdentityFields } from "./product-identity.js";

function getHistoryEntries(watch: Watch): WatchHistoryEntry[] {
  return watch.history ?? [];
}

function buildExtractionCoverage(
  watch: Watch,
): {
  level: "none" | "low" | "medium" | "high";
  score: number;
  reasons: string[];
} {
  const snapshot = watch.lastSnapshot;
  if (!snapshot) {
    return {
      level: "none",
      score: 0,
      reasons: ["No committed snapshot is stored yet."],
    };
  }

  const reasons: string[] = [];
  let score = 0;
  if (snapshot.title || snapshot.canonicalTitle) {
    score += 35;
  } else {
    reasons.push("Missing extracted title.");
  }
  if (snapshot.price != null) {
    score += 35;
  } else {
    reasons.push("Missing extracted price.");
  }
  const identityCount = getWatchIdentityFields(watch).length;
  if (identityCount > 0) {
    score += Math.min(20, identityCount * 10);
  } else {
    reasons.push("No persistent product identifiers were extracted.");
  }
  if (snapshot.rawSnippet) {
    score += 10;
  }
  if (!reasons.length) {
    reasons.push("Snapshot includes title, price, and at least one persistent product identifier.");
  }

  const level = score >= 80 ? "high" : score >= 60 ? "medium" : score >= 30 ? "low" : "none";
  return { level, score, reasons };
}

export function listLlmReviewCandidates(store: StoreFile): LlmReviewCandidate[] {
  const titleCounts = new Map<string, number>();
  for (const watch of store.watches) {
    const canonicalTitle = watch.lastSnapshot?.canonicalTitle?.trim().toLowerCase();
    if (canonicalTitle) {
      titleCounts.set(canonicalTitle, (titleCounts.get(canonicalTitle) ?? 0) + 1);
    }
  }

  const extractionCandidates = store.watches
    .map((watch) => {
      const coverage = buildExtractionCoverage(watch);
      if (coverage.level !== "none" && coverage.level !== "low") return null;
      return {
        watchId: watch.id,
        label: watch.label,
        url: watch.url,
        type: "extraction_review" as const,
        priority: coverage.level === "none" ? "high" as const : "medium" as const,
        reasons: coverage.reasons,
        currentSnapshot: watch.lastSnapshot
          ? {
              title: watch.lastSnapshot.title,
              canonicalTitle: watch.lastSnapshot.canonicalTitle,
              brand: watch.lastSnapshot.brand,
              modelId: watch.lastSnapshot.modelId,
              sku: watch.lastSnapshot.sku,
              mpn: watch.lastSnapshot.mpn,
              gtin: watch.lastSnapshot.gtin,
              asin: watch.lastSnapshot.asin,
              price: watch.lastSnapshot.price,
              currency: watch.lastSnapshot.currency,
              rawSnippet: watch.lastSnapshot.rawSnippet,
            }
          : null,
        prompt:
          "Review the product page extraction. Return the best-guess normalized product title, optional brand/model identifiers, price, currency, stock status if obvious, and a confidence explanation.",
        input: {
          url: watch.url,
          label: watch.label,
          latestSnapshot: watch.lastSnapshot ?? null,
          recentHistory: getHistoryEntries(watch).slice(-3),
        },
        suggestedSchema: {
          type: "object",
          properties: {
            title: { type: ["string", "null"] },
            brand: { type: ["string", "null"] },
            modelId: { type: ["string", "null"] },
            sku: { type: ["string", "null"] },
            mpn: { type: ["string", "null"] },
            gtin: { type: ["string", "null"] },
            asin: { type: ["string", "null"] },
            price: { type: ["number", "null"] },
            currency: { type: ["string", "null"] },
            stockState: { type: ["string", "null"] },
            confidence: {
              type: "object",
              properties: {
                level: { type: "string", enum: ["low", "medium", "high"] },
                reasons: { type: "array", items: { type: "string" } },
              },
              required: ["level", "reasons"],
              additionalProperties: false,
            },
          },
          required: ["title", "confidence"],
          additionalProperties: false,
        },
      };
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate));

  const identityCandidates = store.watches
    .map((watch) => {
      const title = watch.lastSnapshot?.canonicalTitle?.trim().toLowerCase();
      if (!watch.lastSnapshot || !title) return null;
      if (getWatchIdentityFields(watch).length > 0) return null;
      if ((titleCounts.get(title) ?? 0) < 2) return null;

      const peerTitles = store.watches
        .filter((candidate) => candidate.id !== watch.id && candidate.lastSnapshot?.canonicalTitle?.trim().toLowerCase() === title)
        .map((candidate) => ({
          watchId: candidate.id,
          label: candidate.label,
          url: candidate.url,
          price: candidate.lastSnapshot?.price,
          brand: candidate.lastSnapshot?.brand,
        }))
        .slice(0, 5);

      return {
        watchId: watch.id,
        label: watch.label,
        url: watch.url,
        type: "identity_resolution" as const,
        priority: "medium" as const,
        reasons: [
          "Canonical title appears on multiple watches, but this watch has no persistent identifiers.",
          "Same-product grouping would be stronger with model/SKU/MPN/GTIN confirmation.",
        ],
        currentSnapshot: {
          title: watch.lastSnapshot.title,
          canonicalTitle: watch.lastSnapshot.canonicalTitle,
          brand: watch.lastSnapshot.brand,
          modelId: watch.lastSnapshot.modelId,
          sku: watch.lastSnapshot.sku,
          mpn: watch.lastSnapshot.mpn,
          gtin: watch.lastSnapshot.gtin,
          asin: watch.lastSnapshot.asin,
          price: watch.lastSnapshot.price,
          currency: watch.lastSnapshot.currency,
          rawSnippet: watch.lastSnapshot.rawSnippet,
        },
        prompt:
          "Resolve likely product identity for this watch. Infer any reliable persistent identifiers only if supported by the provided snapshot/title context. Be conservative.",
        input: {
          url: watch.url,
          label: watch.label,
          latestSnapshot: watch.lastSnapshot,
          peerWatchesWithSameCanonicalTitle: peerTitles,
        },
        suggestedSchema: {
          type: "object",
          properties: {
            sameProductAsPeers: { type: "boolean" },
            brand: { type: ["string", "null"] },
            modelId: { type: ["string", "null"] },
            sku: { type: ["string", "null"] },
            mpn: { type: ["string", "null"] },
            gtin: { type: ["string", "null"] },
            asin: { type: ["string", "null"] },
            confidence: {
              type: "object",
              properties: {
                level: { type: "string", enum: ["low", "medium", "high"] },
                reasons: { type: "array", items: { type: "string" } },
              },
              required: ["level", "reasons"],
              additionalProperties: false,
            },
          },
          required: ["sameProductAsPeers", "confidence"],
          additionalProperties: false,
        },
      };
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate));

  return [...extractionCandidates, ...identityCandidates]
    .sort((a, b) => Number(b.priority === "high") - Number(a.priority === "high") || a.url.localeCompare(b.url));
}

export function buildLlmReviewQueue(
  store: StoreFile,
  limit = 10,
): {
  integrationStatus: "deferred_cleanly";
  reason: string;
  candidateCount: number;
  candidates: LlmReviewCandidate[];
  notes: string[];
} {
  const candidates = listLlmReviewCandidates(store).slice(0, limit);

  return {
    integrationStatus: "deferred_cleanly",
    reason:
      "Automatic LLM fallback remains intentionally disabled; use deal_llm_review_run when you want explicit opt-in JSON review for one queued candidate.",
    candidateCount: candidates.length,
    candidates,
    notes: [
      "This queue is safe for manual review, deal_llm_review_run, or a separate workflow that explicitly enables the bundled llm-task plugin.",
      "The suggested prompt/input/schema fields are designed to stay portable across manual review, embedded execution, or JSON-only llm-task workflows.",
    ],
  };
}
