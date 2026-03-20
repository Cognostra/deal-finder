import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { ResolvedDealConfig } from "../config.js";
import type {
  ExtractedListing,
  LlmReviewCandidate,
  LlmReviewCandidateType,
  ReviewedSnapshotField,
  ReviewedSnapshotFieldName,
  ReviewedSnapshotFieldValue,
  ScanResultItem,
  Watch,
  WatchSnapshot,
} from "../types.js";
import { canonicalizeTitle } from "./heuristics.js";
import { runLlmReviewCandidate } from "./llm-review.js";

type ReviewDecision = {
  shouldReview: boolean;
  reasons: string[];
  candidateType?: LlmReviewCandidateType;
};

type ReviewBudget = {
  maxReviews: number;
  usedReviews: number;
};

type ParsedReviewJson = Partial<Record<ReviewedSnapshotFieldName, string | number | null>> & {
  confidence?: { level?: string; reasons?: string[] };
};

function buildReviewDecision(result: ScanResultItem, cfg: ResolvedDealConfig): ReviewDecision {
  if (!result.ok || !result.after) {
    return { shouldReview: false, reasons: ["Only successful scans with snapshots can be reviewed."] };
  }
  if (cfg.llmReview.mode === "off") {
    return { shouldReview: false, reasons: ["Review mode is off."] };
  }
  if (result.extractionConfidence.score > cfg.llmReview.lowConfidenceThreshold) {
    return {
      shouldReview: false,
      reasons: [`Extraction confidence ${result.extractionConfidence.score} is above threshold ${cfg.llmReview.lowConfidenceThreshold}.`],
    };
  }
  return {
    shouldReview: true,
    candidateType: "extraction_review",
    reasons: [`Extraction confidence ${result.extractionConfidence.score} is at or below threshold ${cfg.llmReview.lowConfidenceThreshold}.`],
  };
}

export function buildScanReviewCandidate(watch: Watch, result: ScanResultItem, cfg: ResolvedDealConfig): LlmReviewCandidate | null {
  const decision = buildReviewDecision(result, cfg);
  if (!decision.shouldReview || !result.after) return null;

  return {
    watchId: watch.id,
    label: watch.label,
    url: watch.url,
    type: decision.candidateType ?? "extraction_review",
    priority: result.extractionConfidence.level === "none" ? "high" : "medium",
    reasons: [
      ...decision.reasons,
      ...result.extractionConfidence.reasons,
    ],
    currentSnapshot: {
      title: result.after.title,
      canonicalTitle: result.after.canonicalTitle,
      brand: result.after.brand,
      modelId: result.after.modelId,
      sku: result.after.sku,
      mpn: result.after.mpn,
      gtin: result.after.gtin,
      asin: result.after.asin,
      price: result.after.price,
      currency: result.after.currency,
      rawSnippet: result.after.rawSnippet,
    },
    prompt:
      "Review this low-confidence extraction and return conservative JSON with corrected title, canonicalTitle, optional product identifiers, price, currency, and confidence.",
    input: {
      watchId: watch.id,
      url: watch.url,
      label: watch.label,
      changeType: result.changeType,
      extractionConfidence: result.extractionConfidence,
      alerts: result.alerts,
      currentSnapshot: result.after,
      extracted: result.extracted ?? null,
    },
    suggestedSchema: {
      type: "object",
      properties: {
        title: { type: ["string", "null"] },
        canonicalTitle: { type: ["string", "null"] },
        brand: { type: ["string", "null"] },
        modelId: { type: ["string", "null"] },
        sku: { type: ["string", "null"] },
        mpn: { type: ["string", "null"] },
        gtin: { type: ["string", "null"] },
        asin: { type: ["string", "null"] },
        price: { type: ["number", "null"] },
        currency: { type: ["string", "null"] },
        rawSnippet: { type: ["string", "null"] },
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
      additionalProperties: false,
    },
  };
}

function toReviewedValue(value: string | number | undefined): ReviewedSnapshotFieldValue {
  return value ?? null;
}

function maybeSetField(
  next: WatchSnapshot,
  field: ReviewedSnapshotFieldName,
  value: string | number | null | undefined,
  options: {
    allowRewrite: boolean;
    warnings: string[];
    reasons: string[];
  },
): boolean {
  if (value === undefined) return false;
  const existing = next[field] as string | number | undefined;
  const normalizedValue = value ?? undefined;
  if (existing === normalizedValue) return false;
  if (existing != null && !options.allowRewrite) {
    options.warnings.push(`Skipped reviewed ${field} because rewrite is disabled and an existing value is already present.`);
    return false;
  }
  (next as unknown as Record<string, string | number | undefined>)[field] = normalizedValue as string | number | undefined;
  return true;
}

export function applyReviewJsonToSnapshot(
  snapshot: WatchSnapshot,
  reviewJson: unknown,
  execution: {
    reviewSource: string;
    reviewedAt?: string;
    candidateType: LlmReviewCandidateType;
    provider?: string;
    model?: string;
  },
  cfg: ResolvedDealConfig,
): {
  snapshot: WatchSnapshot;
  reviewedFields: ReviewedSnapshotFieldName[];
  warnings: string[];
} {
  const parsed = (reviewJson && typeof reviewJson === "object" ? reviewJson : {}) as ParsedReviewJson;
  const next: WatchSnapshot = {
    ...snapshot,
    reviewedFields: snapshot.reviewedFields ? snapshot.reviewedFields.map((entry) => ({ ...entry, reasons: entry.reasons ? [...entry.reasons] : undefined })) : undefined,
  };
  const warnings: string[] = [];
  const reviewedEntries: ReviewedSnapshotField[] = [];
  const reviewReasons = Array.isArray(parsed.confidence?.reasons)
    ? parsed.confidence?.reasons.filter((reason): reason is string => typeof reason === "string")
    : undefined;
  const reviewedAt = execution.reviewedAt ?? new Date().toISOString();

  const registerChange = (field: ReviewedSnapshotFieldName, originalValue: string | number | undefined) => {
    reviewedEntries.push({
      field,
      originalValue: toReviewedValue(originalValue),
      reviewedValue: toReviewedValue(next[field] as string | number | undefined),
      reviewSource: execution.reviewSource,
      reviewedAt,
      candidateType: execution.candidateType,
      provider: execution.provider,
      model: execution.model,
      reasons: reviewReasons,
    });
  };

  const titleChanged = maybeSetField(next, "title", typeof parsed.title === "string" ? parsed.title.trim() || null : parsed.title, {
    allowRewrite: true,
    warnings,
    reasons: reviewReasons ?? [],
  });
  if (titleChanged) {
    registerChange("title", snapshot.title);
  }

  const computedCanonicalTitle =
    typeof parsed.canonicalTitle === "string"
      ? parsed.canonicalTitle.trim() || null
      : typeof parsed.title === "string"
        ? canonicalizeTitle(parsed.title)
        : parsed.canonicalTitle;
  const canonicalChanged = maybeSetField(next, "canonicalTitle", computedCanonicalTitle, {
    allowRewrite: true,
    warnings,
    reasons: reviewReasons ?? [],
  });
  if (canonicalChanged) {
    registerChange("canonicalTitle", snapshot.canonicalTitle);
  }

  const identityFields: ReviewedSnapshotFieldName[] = ["brand", "modelId", "sku", "mpn", "gtin", "asin"];
  for (const field of identityFields) {
    const changed = maybeSetField(next, field, parsed[field], {
      allowRewrite: cfg.llmReview.allowIdentityRewrite,
      warnings,
      reasons: reviewReasons ?? [],
    });
    if (changed) {
      registerChange(field, snapshot[field] as string | undefined);
    }
  }

  const reviewedPrice = typeof parsed.price === "number" && Number.isFinite(parsed.price) ? parsed.price : parsed.price === null ? null : undefined;
  const reviewedCurrency = typeof parsed.currency === "string" ? parsed.currency.trim() || null : parsed.currency;

  if (reviewedPrice !== undefined) {
    if ((reviewedPrice != null && !reviewedCurrency && !next.currency) || !cfg.llmReview.allowPriceRewrite && next.price != null) {
      warnings.push("Skipped reviewed price because price rewrites are disabled or the reviewed payload lacked usable currency context.");
    } else {
      const changed = maybeSetField(next, "price", reviewedPrice, {
        allowRewrite: cfg.llmReview.allowPriceRewrite || next.price == null,
        warnings,
        reasons: reviewReasons ?? [],
      });
      if (changed) registerChange("price", snapshot.price);
      const currencyChanged = maybeSetField(next, "currency", reviewedCurrency ?? next.currency, {
        allowRewrite: true,
        warnings,
        reasons: reviewReasons ?? [],
      });
      if (currencyChanged) registerChange("currency", snapshot.currency);
    }
  } else if (reviewedCurrency !== undefined) {
    const changed = maybeSetField(next, "currency", reviewedCurrency, {
      allowRewrite: true,
      warnings,
      reasons: reviewReasons ?? [],
    });
    if (changed) registerChange("currency", snapshot.currency);
  }

  if (typeof parsed.rawSnippet === "string" || parsed.rawSnippet === null) {
    const changed = maybeSetField(next, "rawSnippet", parsed.rawSnippet, {
      allowRewrite: true,
      warnings,
      reasons: reviewReasons ?? [],
    });
    if (changed) registerChange("rawSnippet", snapshot.rawSnippet);
  }

  if (reviewedEntries.length) {
    const byField = new Map<ReviewedSnapshotFieldName, ReviewedSnapshotField>(
      (next.reviewedFields ?? []).map((entry) => [entry.field, entry]),
    );
    for (const entry of reviewedEntries) byField.set(entry.field, entry);
    next.reviewedFields = [...byField.values()];
  }

  return {
    snapshot: next,
    reviewedFields: reviewedEntries.map((entry) => entry.field),
    warnings,
  };
}

export async function applyScanReviewPolicy(args: {
  api: OpenClawPluginApi;
  cfg: ResolvedDealConfig;
  list: Watch[];
  results: ScanResultItem[];
}): Promise<ScanResultItem[]> {
  const { api, cfg, list, results } = args;
  const budget: ReviewBudget = { maxReviews: cfg.llmReview.maxReviewsPerScan, usedReviews: 0 };
  const byId = new Map(list.map((watch) => [watch.id, watch]));

  const reviewedResults: ScanResultItem[] = [];
  for (const result of results) {
    const base: ScanResultItem = {
      ...result,
      reviewMode: cfg.llmReview.mode,
      reviewQueued: false,
      reviewApplied: false,
      reviewWarnings: [...(result.reviewWarnings ?? [])],
      reviewedFields: [...(result.reviewedFields ?? [])],
    };
    const watch = byId.get(result.watchId);
    const candidate = watch ? buildScanReviewCandidate(watch, result, cfg) : null;
    if (!candidate) {
      reviewedResults.push(base);
      continue;
    }

    base.reviewQueued = true;
    base.reviewCandidateType = candidate.type;

    if (cfg.llmReview.mode !== "auto_assist") {
      reviewedResults.push(base);
      continue;
    }

    if (budget.usedReviews >= budget.maxReviews) {
      base.reviewWarnings.push(`Skipped automatic review because the per-scan review budget of ${budget.maxReviews} was exhausted.`);
      reviewedResults.push(base);
      continue;
    }

    if (!base.after) {
      reviewedResults.push(base);
      continue;
    }

    try {
      const execution = await runLlmReviewCandidate(api, candidate, {
        provider: cfg.llmReview.provider,
        model: cfg.llmReview.model,
        timeoutMs: cfg.llmReview.timeoutMs,
      });
      const applied = applyReviewJsonToSnapshot(
        base.after,
        execution.json,
        {
          reviewSource: "deal_scan_auto_assist",
          candidateType: candidate.type,
          provider: execution.provider,
          model: execution.model,
        },
        cfg,
      );
      budget.usedReviews += 1;
      reviewedResults.push({
        ...base,
        after: applied.snapshot,
        reviewApplied: applied.reviewedFields.length > 0,
        reviewedFields: applied.reviewedFields,
        reviewWarnings: [...base.reviewWarnings, ...applied.warnings],
        reviewProvider: execution.provider,
        reviewModel: execution.model,
      });
    } catch (error) {
      reviewedResults.push({
        ...base,
        reviewWarnings: [...base.reviewWarnings, `Automatic review failed: ${error instanceof Error ? error.message : String(error)}`],
      });
    }
  }

  return reviewedResults;
}

export function describeReviewPolicy(cfg: ResolvedDealConfig) {
  return {
    mode: cfg.llmReview.mode,
    lowConfidenceThreshold: cfg.llmReview.lowConfidenceThreshold,
    maxReviewsPerScan: cfg.llmReview.maxReviewsPerScan,
    allowPriceRewrite: cfg.llmReview.allowPriceRewrite,
    allowIdentityRewrite: cfg.llmReview.allowIdentityRewrite,
    provider: cfg.llmReview.provider,
    model: cfg.llmReview.model,
    timeoutMs: cfg.llmReview.timeoutMs,
    summary:
      cfg.llmReview.mode === "off"
        ? "Automatic scan-time review is disabled."
        : cfg.llmReview.mode === "queue"
          ? "Low-confidence scan results are queued for explicit review but no model is invoked automatically."
          : "Low-confidence scan results can trigger bounded automatic model review with explicit provenance.",
  };
}
