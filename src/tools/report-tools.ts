import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import { resolveDealConfig } from "../config.js";
import {
  buildDigestSummary,
  buildDoctorSummary,
  buildHealthSummary,
  buildHostReportSummary,
  buildQuickstartGuide,
  buildSampleSetup,
  buildStoreReport,
  buildTaxonomySummary,
  buildWorkflowActionQueue,
  buildWorkflowBestOpportunities,
  buildWorkflowCleanup,
  buildWorkflowPortfolio,
  buildWorkflowTriage,
} from "../lib/report.js";
import { loadStore } from "../lib/store.js";
import { buildScopedStore, resolveSavedViewSelection, toWatchView, type ToolContext } from "./shared.js";
import { registerReportInsightTools } from "./report-insight-tools.js";

export function registerReportTools(api: OpenClawPluginApi, ctx: ToolContext): void {
  const { storePath, withStore } = ctx;

  api.registerTool(
    {
      name: "deal_help",
      label: "Deal Hunter",
      description: "Show install, tool, cron, import/export, troubleshooting, and safety guidance for Deal Hunter.",
      parameters: Type.Object({
        topic: Type.Optional(Type.Union([
          Type.Literal("overview"),
          Type.Literal("install"),
          Type.Literal("tools"),
          Type.Literal("cron"),
          Type.Literal("safety"),
          Type.Literal("import_export"),
          Type.Literal("troubleshooting"),
          Type.Literal("privacy"),
        ])),
      }),
      execute: async (_id, params) => {
        const topics = {
          overview: {
            installCommand: "openclaw plugins install openclaw-deal-hunter",
            coreTools: [
              "deal_template_list", "deal_watch_add", "deal_watch_add_template", "deal_watch_update", "deal_watch_set_enabled",
              "deal_watch_search", "deal_watch_taxonomy", "deal_host_report", "deal_saved_view_list", "deal_saved_view_create",
              "deal_saved_view_update", "deal_saved_view_run", "deal_saved_view_dashboard", "deal_saved_view_delete", "deal_view_scan",
              "deal_view_report", "deal_watch_bulk_update", "deal_view_bulk_update", "deal_watch_tag", "deal_watch_dedupe",
              "deal_watch_export", "deal_watch_import", "deal_watch_import_url", "deal_scan", "deal_digest",
              "deal_workflow_action_queue", "deal_workflow_portfolio", "deal_workflow_triage", "deal_workflow_cleanup",
              "deal_workflow_best_opportunities", "deal_history", "deal_alerts", "deal_trends", "deal_top_drops",
              "deal_market_check", "deal_product_groups", "deal_best_price_board", "deal_llm_review_queue",
              "deal_llm_review_run", "deal_llm_review_apply", "deal_watch_insights", "deal_watch_provenance",
              "deal_watch_identity", "deal_schedule_advice",
            ],
            firstPrompt:
              "Use deal_watch_list and deal_watch_search to show me my current watches and call out any threshold or keyword signals.",
          },
          install: {
            sourceRepo: "https://github.com/Cognostra/deal-finder",
            installCommand: "openclaw plugins install openclaw-deal-hunter",
            note: "GitHub is the source/support repo. Native OpenClaw installs should use the npm package spec.",
          },
          tools: {
            readOnlyTools: [
              "deal_watch_list", "deal_template_list", "deal_watch_search", "deal_watch_taxonomy", "deal_host_report",
              "deal_saved_view_list", "deal_saved_view_run", "deal_saved_view_dashboard", "deal_view_scan", "deal_view_report",
              "deal_watch_export", "deal_fetch_url", "deal_extraction_debug", "deal_evaluate_text", "deal_help", "deal_digest",
              "deal_workflow_action_queue", "deal_history", "deal_alerts", "deal_trends", "deal_top_drops", "deal_market_check",
              "deal_product_groups", "deal_best_price_board", "deal_llm_review_queue", "deal_llm_review_run",
              "deal_watch_insights", "deal_watch_provenance", "deal_watch_identity", "deal_schedule_advice",
              "deal_workflow_portfolio", "deal_workflow_triage", "deal_workflow_cleanup", "deal_workflow_best_opportunities",
            ],
            writeTools: [
              "deal_watch_add", "deal_watch_add_template", "deal_watch_update", "deal_watch_set_enabled", "deal_saved_view_create",
              "deal_saved_view_update", "deal_saved_view_delete", "deal_watch_bulk_update", "deal_view_bulk_update",
              "deal_watch_tag", "deal_watch_dedupe", "deal_watch_remove", "deal_watch_import", "deal_watch_import_url",
              "deal_scan", "deal_llm_review_run", "deal_llm_review_apply",
            ],
            examplePrompt:
              "Use deal_template_list to choose the right starter template, then use deal_watch_add_template in dry-run mode before saving a new watch.",
          },
          cron: {
            example:
              "openclaw cron add --name \"Deal scan\" --cron \"0 * * * *\" --session isolated --message \"Run deal_scan with commit true for all enabled watches. Summarize any alerts.\" --announce",
          },
          import_export: {
            exportPrompt:
              "Use deal_watch_export with includeHistory true so I can back up my active watches before I reorganize them.",
            importPrompt:
              "Prepare a deal_watch_import dry run in upsert mode so I can preview which watches would be added or updated.",
            importUrlPrompt:
              "Use deal_watch_import_url in dry-run mode to preview a shared remote watchlist before applying it.",
            modes: ["append", "upsert", "replace"],
          },
          troubleshooting: {
            firstChecks: ["deal_doctor", "deal_health", "deal_fetch_url"],
            note: "If a scan is blocked, verify the target host against your allowedHosts and blockedHosts policy. Use deal_extraction_debug when parsed fields look suspicious, and deal_llm_review_queue when you want a prepared manual review queue for low-confidence cases.",
          },
          privacy: {
            storeNote: "Watch metadata and committed scan history are stored in the configured JSON store path.",
            backupNote: "Use deal_watch_export when you want a reviewable backup before major edits or migration.",
            networkNote: "Only http/https targets that pass the host safety policy are fetched.",
          },
          safety: {
            guardrails: [
              "Only http/https targets are allowed.",
              "Localhost, private IPs, and hostnames resolving to private IPs are blocked.",
              "Responses are byte-capped and rate-limited per host.",
            ],
          },
        } as const;
        const topic = (params.topic ?? "overview") as keyof typeof topics;
        return jsonResult({ topic, details: topics[topic] });
      },
    },
    { optional: false },
  );

  api.registerTool({ name: "deal_quickstart", label: "Deal Hunter", description: "Show a first-run checklist, recommended prompts, and privacy/safety reminders for new users.", parameters: Type.Object({}), execute: async () => jsonResult(buildQuickstartGuide()) }, { optional: false });

  api.registerTool({ name: "deal_report", label: "Deal Hunter", description: "Summarize the current watchlist, snapshots, and signal-heavy watches.", parameters: Type.Object({}), execute: async () => {
    const store = await loadStore(storePath);
    const report = buildStoreReport(store);
    return jsonResult({ ...report, watches: store.watches.map(toWatchView) });
  } }, { optional: false });

  api.registerTool({ name: "deal_digest", label: "Deal Hunter", description: "Produce a concise announcement-ready digest of what changed, what matters, and what to review next for the whole watchlist or a saved view.", parameters: Type.Object({
    savedViewId: Type.Optional(Type.String()),
    severity: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")])),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  }), execute: async (_id, params) => {
    const store = await loadStore(storePath);
    const selection = params.savedViewId ? resolveSavedViewSelection(store, params.savedViewId) : null;
    const scopedStore = selection ? buildScopedStore(store, selection.watches) : store;
    return jsonResult({ savedView: selection?.summary, ...buildDigestSummary(scopedStore, { limit: params.limit ?? 5, severity: params.severity ?? "medium", scopeLabel: selection?.summary?.name ?? "watchlist" }) });
  } }, { optional: false });

  api.registerTool({ name: "deal_workflow_action_queue", label: "Deal Hunter", description: "Build a prioritized next-actions queue from current opportunities, alerts, cleanup issues, discovery targets, and review candidates.", parameters: Type.Object({
    savedViewId: Type.Optional(Type.String()),
    severity: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")])),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  }), execute: async (_id, params) => {
    const store = await loadStore(storePath);
    const selection = params.savedViewId ? resolveSavedViewSelection(store, params.savedViewId) : null;
    const scopedStore = selection ? buildScopedStore(store, selection.watches) : store;
    return jsonResult({ savedView: selection?.summary, ...buildWorkflowActionQueue(scopedStore, { limit: params.limit ?? 10, severity: params.severity ?? "medium", scopeLabel: selection?.summary?.name ?? "watchlist" }) });
  } }, { optional: false });

  api.registerTool({ name: "deal_watch_taxonomy", label: "Deal Hunter", description: "Summarize how the watchlist is organized across groups and tags, and suggest reusable saved views.", parameters: Type.Object({
    savedViewId: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  }), execute: async (_id, params) => {
    const store = await loadStore(storePath);
    const selection = params.savedViewId ? resolveSavedViewSelection(store, params.savedViewId) : null;
    const scopedStore = selection ? buildScopedStore(store, selection.watches) : store;
    return jsonResult({ savedView: selection?.summary, ...buildTaxonomySummary(scopedStore, params.limit ?? 10) });
  } }, { optional: false });

  api.registerTool({ name: "deal_host_report", label: "Deal Hunter", description: "Summarize watches by retailer host, including signals, alert density, and recommended cadence.", parameters: Type.Object({
    savedViewId: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  }), execute: async (_id, params) => {
    const store = await loadStore(storePath);
    const selection = params.savedViewId ? resolveSavedViewSelection(store, params.savedViewId) : null;
    const scopedStore = selection ? buildScopedStore(store, selection.watches) : store;
    return jsonResult({ savedView: selection?.summary, ...buildHostReportSummary(scopedStore, params.limit ?? 10) });
  } }, { optional: false });

  api.registerTool({ name: "deal_workflow_portfolio", label: "Deal Hunter", description: "Produce a portfolio-style dashboard for the whole watchlist or a saved view.", parameters: Type.Object({
    savedViewId: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  }), execute: async (_id, params) => {
    const store = await loadStore(storePath);
    const selection = params.savedViewId ? resolveSavedViewSelection(store, params.savedViewId) : null;
    const scopedStore = selection ? buildScopedStore(store, selection.watches) : store;
    return jsonResult({ savedView: selection?.summary, ...buildWorkflowPortfolio(scopedStore, params.limit ?? 10) });
  } }, { optional: false });

  api.registerTool({ name: "deal_workflow_triage", label: "Deal Hunter", description: "Answer what changed, what matters, what looks noisy, and what should be reviewed first.", parameters: Type.Object({
    savedViewId: Type.Optional(Type.String()),
    severity: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")])),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  }), execute: async (_id, params) => {
    const store = await loadStore(storePath);
    const selection = params.savedViewId ? resolveSavedViewSelection(store, params.savedViewId) : null;
    const scopedStore = selection ? buildScopedStore(store, selection.watches) : store;
    return jsonResult({ savedView: selection?.summary, ...buildWorkflowTriage(scopedStore, params.limit ?? 5, params.severity ?? "medium") });
  } }, { optional: false });

  api.registerTool({ name: "deal_workflow_cleanup", label: "Deal Hunter", description: "Surface duplicate, stale, weak-extraction, and noisy watches that are good cleanup candidates.", parameters: Type.Object({
    savedViewId: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  }), execute: async (_id, params) => {
    const store = await loadStore(storePath);
    const selection = params.savedViewId ? resolveSavedViewSelection(store, params.savedViewId) : null;
    const scopedStore = selection ? buildScopedStore(store, selection.watches) : store;
    return jsonResult({ savedView: selection?.summary, ...buildWorkflowCleanup(scopedStore, params.limit ?? 10) });
  } }, { optional: false });

  api.registerTool({ name: "deal_workflow_best_opportunities", label: "Deal Hunter", description: "Rank the strongest likely-real deals, suspicious glitches, and best same-product internal spreads.", parameters: Type.Object({
    savedViewId: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  }), execute: async (_id, params) => {
    const store = await loadStore(storePath);
    const selection = params.savedViewId ? resolveSavedViewSelection(store, params.savedViewId) : null;
    const scopedStore = selection ? buildScopedStore(store, selection.watches) : store;
    return jsonResult({ savedView: selection?.summary, ...buildWorkflowBestOpportunities(scopedStore, Math.min(params.limit ?? 5, 20)) });
  } }, { optional: false });

  api.registerTool({ name: "deal_health", label: "Deal Hunter", description: "Show configuration, storage, safety posture, and operational recommendations.", parameters: Type.Object({}), execute: async () => {
    const cfg = resolveDealConfig(api);
    const store = await loadStore(storePath);
    return jsonResult(buildHealthSummary(store, cfg, storePath));
  } }, { optional: false });

  api.registerTool({ name: "deal_doctor", label: "Deal Hunter", description: "Run a lightweight configuration and watchlist sanity check.", parameters: Type.Object({}), execute: async () => {
    const cfg = resolveDealConfig(api);
    const store = await loadStore(storePath);
    return jsonResult(buildDoctorSummary(store, cfg, storePath));
  } }, { optional: false });

  api.registerTool({ name: "deal_sample_setup", label: "Deal Hunter", description: "Show example install, config, allowlist, prompts, and cron setup for Deal Hunter.", parameters: Type.Object({}), execute: async () => jsonResult(buildSampleSetup()) }, { optional: false });

  registerReportInsightTools(api, ctx);
}
