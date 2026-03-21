import type { StoreFile, Watch } from "../types.js";
import { getWatchHost } from "./product-identity.js";
import { buildScheduleAdvice } from "./report-market.js";
import {
  buildGlitchAssessment,
  buildNoiseAssessment,
  summarizeHistory,
} from "./report-history-primitives.js";
import { buildWatchSignals } from "./watch-view.js";

export function buildHostReportSummary(
  store: StoreFile,
  limit = 10,
): {
  hostCount: number;
  hosts: Array<{
    host: string;
    watchCount: number;
    enabledCount: number;
    withSnapshots: number;
    activeSignals: number;
    mediumOrHigherAlerts: number;
    noisyCount: number;
    glitchyCount: number;
    topTags: string[];
    topGroups: string[];
    recommendedMinutes: number;
    cadenceBasis: string;
    sampleWatchIds: string[];
  }>;
  actionSummary: string[];
} {
  const scheduleByHost = new Map(
    buildScheduleAdvice(store, "host").recommendations.map((recommendation) => [recommendation.target, recommendation]),
  );
  const groups = new Map<string, Watch[]>();
  for (const watch of store.watches) {
    const host = getWatchHost(watch.url);
    const existing = groups.get(host) ?? [];
    existing.push(watch);
    groups.set(host, existing);
  }

  const hosts = [...groups.entries()]
    .map(([host, watches]) => {
      const tagCounts = new Map<string, number>();
      const groupCounts = new Map<string, number>();
      let activeSignals = 0;
      let mediumOrHigherAlerts = 0;
      let noisyCount = 0;
      let glitchyCount = 0;

      for (const watch of watches) {
        const signals = buildWatchSignals(watch);
        if (signals.length) activeSignals += 1;

        const history = summarizeHistory(watch);
        const latestSeverity = history.latestEntry?.alertSeverity;
        if (latestSeverity === "medium" || latestSeverity === "high") {
          mediumOrHigherAlerts += 1;
        }

        if (buildNoiseAssessment(watch, history).score >= 60) {
          noisyCount += 1;
        }

        if (buildGlitchAssessment(watch, history, signals).score >= 70) {
          glitchyCount += 1;
        }

        for (const tag of watch.tags ?? []) {
          tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
        }
        if (watch.group?.trim()) {
          groupCounts.set(watch.group, (groupCounts.get(watch.group) ?? 0) + 1);
        }
      }

      const cadence = scheduleByHost.get(host) ?? {
        recommendedMinutes: 360,
        basis: "Insufficient history; defaulting to every 6 hours.",
        sampleWatchIds: watches.slice(0, 5).map((watch) => watch.id),
      };

      return {
        host,
        watchCount: watches.length,
        enabledCount: watches.filter((watch) => watch.enabled).length,
        withSnapshots: watches.filter((watch) => Boolean(watch.lastSnapshot)).length,
        activeSignals,
        mediumOrHigherAlerts,
        noisyCount,
        glitchyCount,
        topTags: [...tagCounts.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, 3)
          .map(([tag]) => tag),
        topGroups: [...groupCounts.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, 3)
          .map(([group]) => group),
        recommendedMinutes: cadence.recommendedMinutes,
        cadenceBasis: cadence.basis,
        sampleWatchIds: cadence.sampleWatchIds,
      };
    })
    .sort(
      (a, b) =>
        b.watchCount - a.watchCount ||
        b.activeSignals - a.activeSignals ||
        a.recommendedMinutes - b.recommendedMinutes ||
        a.host.localeCompare(b.host),
    )
    .slice(0, limit);

  const actionSummary: string[] = [];
  if (hosts[0]) {
    actionSummary.push(`Largest host footprint: ${hosts[0].host} (${hosts[0].watchCount} watches).`);
  }
  const hottestHost = hosts
    .filter((host) => host.activeSignals > 0 || host.mediumOrHigherAlerts > 0)
    .sort((a, b) => b.activeSignals + b.mediumOrHigherAlerts - (a.activeSignals + a.mediumOrHigherAlerts))[0];
  if (hottestHost) {
    actionSummary.push(`Most active host right now: ${hottestHost.host} (${hottestHost.activeSignals} active signals, ${hottestHost.mediumOrHigherAlerts} medium+ alerts).`);
  }
  const fastestHost = hosts
    .slice()
    .sort((a, b) => a.recommendedMinutes - b.recommendedMinutes || b.watchCount - a.watchCount)[0];
  if (fastestHost) {
    actionSummary.push(`Most time-sensitive host cadence: ${fastestHost.host} every ${fastestHost.recommendedMinutes} minutes.`);
  }

  return {
    hostCount: groups.size,
    hosts,
    actionSummary,
  };
}
