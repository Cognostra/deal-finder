import type { AlertSeverity, StoreFile } from "../types.js";
import { buildAlertsSummary, buildStoreReport } from "./report-history.js";
import { buildDiscoveryBacklog } from "./report-market.js";
import { listLlmReviewCandidates } from "./report-review.js";
import { buildWorkflowCleanup } from "./report-workflow-coverage.js";
import { buildWorkflowBestOpportunities, buildWorkflowTriage } from "./report-workflow-rankings.js";

export { buildWorkflowBestOpportunities, buildWorkflowTriage } from "./report-workflow-rankings.js";
export { buildWorkflowCleanup, buildWorkflowPortfolio } from "./report-workflow-coverage.js";

export function buildWorkflowActionQueue(
  store: StoreFile,
  options?: {
    limit?: number;
    severity?: AlertSeverity;
    scopeLabel?: string;
  },
): {
  scopeLabel: string;
  watchCount: number;
  itemCount: number;
  items: Array<{
    priority: "high" | "medium" | "low";
    category: "opportunity" | "alert" | "cleanup" | "discovery" | "review";
    title: string;
    reason: string;
    recommendedTool: string;
    watchId?: string;
    label?: string;
    url?: string;
  }>;
  actionSummary: string[];
} {
  const limit = options?.limit ?? 10;
  const triage = buildWorkflowTriage(store, Math.min(limit, 5), options?.severity ?? "medium");
  const cleanup = buildWorkflowCleanup(store, Math.min(limit, 5));
  const discovery = buildDiscoveryBacklog(store, Math.min(limit, 5));
  const reviewQueue = listLlmReviewCandidates(store).slice(0, Math.min(limit, 5));
  const items: Array<{
    priority: "high" | "medium" | "low";
    category: "opportunity" | "alert" | "cleanup" | "discovery" | "review";
    title: string;
    reason: string;
    recommendedTool: string;
    watchId?: string;
    label?: string;
    url?: string;
    score: number;
  }> = [];

  if (triage.bestOpportunity) {
    items.push({
      priority: "high",
      category: "opportunity",
      title: `Best current opportunity: ${triage.bestOpportunity.label ?? triage.bestOpportunity.watchId}`,
      reason: triage.bestOpportunity.rationale[0] ?? "This currently looks like the strongest likely-real deal.",
      recommendedTool: "deal_workflow_best_opportunities",
      watchId: triage.bestOpportunity.watchId,
      label: triage.bestOpportunity.label,
      url: triage.bestOpportunity.url,
      score: 100,
    });
  }

  for (const alert of triage.strongestAlerts.slice(0, Math.min(limit, 3))) {
    items.push({
      priority: alert.severity === "high" ? "high" : "medium",
      category: "alert",
      title: `Alert: ${alert.label ?? alert.watchId}`,
      reason: alert.summaryLine ?? "Threshold or keyword alert is currently active.",
      recommendedTool: "deal_alerts",
      watchId: alert.watchId,
      label: alert.label,
      url: alert.url,
      score: alert.severity === "high" ? 90 : 70,
    });
  }

  for (const duplicate of cleanup.duplicateGroups.slice(0, 2)) {
    items.push({
      priority: "medium",
      category: "cleanup",
      title: `Duplicate watch group on ${duplicate.canonicalUrl}`,
      reason: `Keep ${duplicate.keepWatchId} and review ${duplicate.duplicateWatchIds.length} duplicate watch${duplicate.duplicateWatchIds.length === 1 ? "" : "es"}.`,
      recommendedTool: "deal_watch_dedupe",
      watchId: duplicate.keepWatchId,
      url: duplicate.canonicalUrl,
      score: 60,
    });
  }

  for (const weak of cleanup.weakExtraction.slice(0, 2)) {
    items.push({
      priority: "medium",
      category: "cleanup",
      title: `Weak extraction: ${weak.label ?? weak.watchId}`,
      reason: weak.reasons[0] ?? "Extraction quality is too weak for reliable automation.",
      recommendedTool: "deal_extraction_debug",
      watchId: weak.watchId,
      label: weak.label,
      url: weak.url,
      score: 58,
    });
  }

  for (const backlog of discovery.backlog.slice(0, 2)) {
    items.push({
      priority: backlog.priority,
      category: "discovery",
      title: `Discovery target: ${backlog.label ?? backlog.watchId}`,
      reason: backlog.reasons[0] ?? "This watch would benefit from broader same-product coverage.",
      recommendedTool: "deal_discovery_backlog",
      watchId: backlog.watchId,
      label: backlog.label,
      url: backlog.url,
      score: backlog.priority === "high" ? 65 : backlog.priority === "medium" ? 45 : 30,
    });
  }

  for (const candidate of reviewQueue.slice(0, 2)) {
    items.push({
      priority: candidate.priority,
      category: "review",
      title: `Review candidate: ${candidate.label ?? candidate.watchId}`,
      reason: candidate.reasons[0] ?? "Manual or model-assisted review is recommended.",
      recommendedTool: "deal_llm_review_queue",
      watchId: candidate.watchId,
      label: candidate.label,
      url: candidate.url,
      score: candidate.priority === "high" ? 55 : 35,
    });
  }

  const deduped = new Map<string, (typeof items)[number]>();
  for (const item of items) {
    const key = `${item.category}:${item.watchId ?? item.title}`;
    const existing = deduped.get(key);
    if (!existing || item.score > existing.score) {
      deduped.set(key, item);
    }
  }

  const ranked = [...deduped.values()]
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, limit)
    .map(({ score: _score, ...item }) => item);

  const actionSummary: string[] = [];
  if (ranked[0]) {
    actionSummary.push(`Start with: ${ranked[0].title}.`);
  }
  const categoryCounts = new Map<string, number>();
  for (const item of ranked) {
    categoryCounts.set(item.category, (categoryCounts.get(item.category) ?? 0) + 1);
  }
  for (const [category, count] of categoryCounts.entries()) {
    actionSummary.push(`${count} ${category} action${count === 1 ? "" : "s"} surfaced in the current queue.`);
  }

  return {
    scopeLabel: options?.scopeLabel ?? "watchlist",
    watchCount: store.watches.length,
    itemCount: ranked.length,
    items: ranked,
    actionSummary,
  };
}
