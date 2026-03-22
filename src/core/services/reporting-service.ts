import type { ResolvedDealConfig } from "../../config.js";
import {
  buildAlertsSummary,
  buildBestPriceBoard,
  buildDigestSummary,
  buildDoctorSummary,
  buildHealthSummary,
  buildHostReportSummary,
  buildHistorySummary,
  buildLlmReviewQueue,
  buildMarketCheckSummary,
  buildProductGroupsSummary,
  buildSavedViewDashboard,
  buildScheduleAdvice,
  buildStoreReport,
  buildTaxonomySummary,
  buildTopDropsSummary,
  buildTrendsSummary,
  buildViewReport,
  buildWatchIdentitySummary,
  buildWatchInsights,
  buildWatchProvenanceSummary,
  buildWorkflowActionQueue,
  buildWorkflowBestOpportunities,
  buildWorkflowCleanup,
  buildWorkflowPortfolio,
  buildWorkflowTriage,
} from "../../lib/report.js";
import { getWatch } from "../../lib/store.js";
import type { SavedViewRepository, WatchRepository } from "../repositories.js";

function buildScopedStore<T extends { version: number; savedViews: unknown[]; watches: unknown[] }>(store: T, watches: T["watches"]): T {
  return {
    ...store,
    watches,
  };
}

export function createReportingService(args: {
  watchRepository: WatchRepository;
  savedViewRepository: SavedViewRepository;
}) {
  const { watchRepository, savedViewRepository } = args;

  const resolveScope = async (savedViewId?: string) => {
    const store = await watchRepository.loadStore();
    if (!savedViewId) return { store, scopedStore: store, selection: null as null | { summary: unknown; watches: typeof store.watches } };
    const selection = await savedViewRepository.resolveSelection(savedViewId);
    return {
      store,
      scopedStore: buildScopedStore(store, selection.watches),
      selection: {
        summary: {
          ...selection.savedView,
          matchCount: selection.watches.length,
          previewWatchIds: selection.watchIds.slice(0, 20),
        },
        watches: selection.watches,
      },
    };
  };

  return {
    async getStoreReport() {
      return buildStoreReport(await watchRepository.loadStore());
    },
    async getSavedViewDashboard(options: Parameters<typeof buildSavedViewDashboard>[1]) {
      return buildSavedViewDashboard(await watchRepository.loadStore(), options);
    },
    async getDigest(args: { savedViewId?: string; limit?: number; severity?: "low" | "medium" | "high" }) {
      const { scopedStore, selection } = await resolveScope(args.savedViewId);
      return {
        savedView: selection?.summary,
        ...buildDigestSummary(scopedStore, {
          limit: args.limit ?? 5,
          severity: args.severity ?? "medium",
          scopeLabel: (selection?.summary as { name?: string } | undefined)?.name ?? "watchlist",
        }),
      };
    },
    async getWorkflowActionQueue(args: { savedViewId?: string; limit?: number; severity?: "low" | "medium" | "high" }) {
      const { scopedStore, selection } = await resolveScope(args.savedViewId);
      return {
        savedView: selection?.summary,
        ...buildWorkflowActionQueue(scopedStore, {
          limit: args.limit ?? 10,
          severity: args.severity ?? "medium",
          scopeLabel: (selection?.summary as { name?: string } | undefined)?.name ?? "watchlist",
        }),
      };
    },
    async getTaxonomy(args: { savedViewId?: string; limit?: number }) {
      const { scopedStore, selection } = await resolveScope(args.savedViewId);
      return { savedView: selection?.summary, ...buildTaxonomySummary(scopedStore, args.limit ?? 10) };
    },
    async getHostReport(args: { savedViewId?: string; limit?: number }) {
      const { scopedStore, selection } = await resolveScope(args.savedViewId);
      return { savedView: selection?.summary, ...buildHostReportSummary(scopedStore, args.limit ?? 10) };
    },
    async getWorkflowPortfolio(args: { savedViewId?: string; limit?: number }) {
      const { scopedStore, selection } = await resolveScope(args.savedViewId);
      return { savedView: selection?.summary, ...buildWorkflowPortfolio(scopedStore, args.limit ?? 10) };
    },
    async getWorkflowTriage(args: { savedViewId?: string; limit?: number; severity?: "low" | "medium" | "high" }) {
      const { scopedStore, selection } = await resolveScope(args.savedViewId);
      return { savedView: selection?.summary, ...buildWorkflowTriage(scopedStore, args.limit ?? 5, args.severity ?? "medium") };
    },
    async getWorkflowCleanup(args: { savedViewId?: string; limit?: number }) {
      const { scopedStore, selection } = await resolveScope(args.savedViewId);
      return { savedView: selection?.summary, ...buildWorkflowCleanup(scopedStore, args.limit ?? 10) };
    },
    async getWorkflowBestOpportunities(args: { savedViewId?: string; limit?: number }) {
      const { scopedStore, selection } = await resolveScope(args.savedViewId);
      return { savedView: selection?.summary, ...buildWorkflowBestOpportunities(scopedStore, Math.min(args.limit ?? 5, 20)) };
    },
    async getHealth(cfg: ResolvedDealConfig, storePath: string) {
      return buildHealthSummary(await watchRepository.loadStore(), cfg, storePath);
    },
    async getDoctor(cfg: ResolvedDealConfig, storePath: string) {
      return buildDoctorSummary(await watchRepository.loadStore(), cfg, storePath);
    },
    async getHistory(args: { watchId?: string; limit?: number }) {
      const store = await watchRepository.loadStore();
      const limit = args.limit ?? 20;
      if (args.watchId) {
        const watch = getWatch(store, args.watchId);
        return watch ? buildHistorySummary(watch, limit) : null;
      }
      const watches = store.watches
        .filter((watch) => Boolean(watch.history?.length))
        .map((watch) => buildHistorySummary(watch, Math.min(limit, 5)))
        .sort((a, b) => (b.lastSeenAt ?? "").localeCompare(a.lastSeenAt ?? ""))
        .slice(0, limit);
      return { count: watches.length, watches };
    },
    async getAlerts(args: { severity?: "low" | "medium" | "high"; limit?: number }) {
      return buildAlertsSummary(await watchRepository.loadStore(), args.severity ?? "low", args.limit ?? 20);
    },
    async getTrends(limit?: number) {
      return buildTrendsSummary(await watchRepository.loadStore(), limit ?? 20);
    },
    async getTopDrops(metric?: "vs_peak" | "latest_change", limit?: number) {
      return buildTopDropsSummary(await watchRepository.loadStore(), metric ?? "vs_peak", limit ?? 10);
    },
    async getWatchInsights(watchId: string) {
      const store = await watchRepository.loadStore();
      const watch = getWatch(store, watchId);
      return watch ? buildWatchInsights(watch) : null;
    },
    async getWatchProvenance(watchId: string) {
      const store = await watchRepository.loadStore();
      const watch = getWatch(store, watchId);
      return watch ? buildWatchProvenanceSummary(watch) : null;
    },
    async getWatchIdentity(watchId: string) {
      const store = await watchRepository.loadStore();
      const watch = getWatch(store, watchId);
      return watch ? buildWatchIdentitySummary(store, watch) : null;
    },
    async getMarketCheck(watchId: string, options?: { includeLooseTitleFallback?: boolean }) {
      const store = await watchRepository.loadStore();
      const watch = getWatch(store, watchId);
      return watch ? buildMarketCheckSummary(store, watch, options) : null;
    },
    async getProductGroups(args: { savedViewId?: string; includeLooseTitleFallback?: boolean; minMatchScore?: number; limit?: number }) {
      const { scopedStore, selection } = await resolveScope(args.savedViewId);
      return {
        savedView: selection?.summary,
        ...buildProductGroupsSummary(scopedStore, {
          includeLooseTitleFallback: args.includeLooseTitleFallback,
          minMatchScore: args.minMatchScore,
          limit: args.limit ?? 20,
        }),
      };
    },
    async getBestPriceBoard(args: { savedViewId?: string; includeLooseTitleFallback?: boolean; minMatchScore?: number; limit?: number }) {
      const { scopedStore, selection } = await resolveScope(args.savedViewId);
      return {
        savedView: selection?.summary,
        ...buildBestPriceBoard(scopedStore, {
          includeLooseTitleFallback: args.includeLooseTitleFallback,
          minMatchScore: args.minMatchScore,
          limit: args.limit ?? 20,
        }),
      };
    },
    async getLlmReviewQueue(args: { savedViewId?: string; limit?: number }) {
      const { scopedStore, selection } = await resolveScope(args.savedViewId);
      return { savedView: selection?.summary, ...buildLlmReviewQueue(scopedStore, args.limit ?? 10) };
    },
    async getScheduleAdvice(mode?: "host" | "watch") {
      return buildScheduleAdvice(await watchRepository.loadStore(), mode ?? "host");
    },
    async getViewReport(args: { savedViewId: string; limit?: number; severity?: "low" | "medium" | "high" }) {
      const selection = await savedViewRepository.resolveSelection(args.savedViewId);
      return {
        savedView: {
          ...selection.savedView,
          matchCount: selection.watches.length,
          previewWatchIds: selection.watchIds.slice(0, 20),
        },
        ...buildViewReport(selection.store, selection.watches, {
          limit: args.limit ?? 5,
          severity: args.severity ?? "medium",
        }),
      };
    },
  };
}
