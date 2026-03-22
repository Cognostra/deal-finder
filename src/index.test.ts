import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "./index.js";

type RegisteredTool = {
  name: string;
  execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
  optional: boolean;
};

type FakeApi = {
  pluginConfig: Record<string, unknown>;
  registeredTools: RegisteredTool[];
  resolvePath: (input: string) => string;
  registerTool: (tool: { name: string; execute: RegisteredTool["execute"] }, options?: { optional?: boolean }) => void;
};

let tempDirs: string[] = [];

async function makeFakeApi(pluginConfig: Record<string, unknown> = {}): Promise<FakeApi> {
  const dir = await mkdtemp(join(tmpdir(), "deal-hunter-plugin-"));
  tempDirs.push(dir);
  const registeredTools: RegisteredTool[] = [];
  return {
    pluginConfig,
    registeredTools,
    resolvePath(input: string) {
      if (input.startsWith("~/")) {
        return join(dir, input.slice(2));
      }
      return input;
    },
    registerTool(tool, options) {
      registeredTools.push({
        name: tool.name,
        execute: tool.execute,
        optional: options?.optional ?? false,
      });
    },
  };
}

function parseJsonToolResult(result: unknown) {
  const payload = result as { details?: unknown; content?: Array<{ type: string; text?: string }> };
  if (payload.details && typeof payload.details === "object" && Object.keys(payload.details as object).length > 0) {
    return payload.details;
  }
  const text = payload.content?.find((entry) => entry.type === "text")?.text;
  return text ? JSON.parse(text) : undefined;
}

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("plugin metadata", () => {
  it("exposes the shipped 1.0.0 plugin contract", () => {
    expect(plugin.id).toBe("openclaw-deal-hunter");
    expect(plugin.name).toBe("Deal Hunter");
    expect(plugin.version).toBe("1.0.0");
    expect(plugin.description).toContain("Price watches");
  });

  it("keeps review and discovery config modes in the public schema", () => {
    const schema = plugin.configSchema.jsonSchema as {
      properties?: {
        llmReview?: { properties?: { mode?: { enum?: string[] } } };
        discovery?: { properties?: { provider?: { enum?: string[] } } };
      };
    };
    const llmReviewMode = schema.properties?.llmReview?.properties?.mode?.enum;
    const discoveryProvider = schema.properties?.discovery?.properties?.provider?.enum;

    expect(llmReviewMode).toEqual(["off", "queue", "auto_assist"]);
    expect(discoveryProvider).toEqual(["off", "manual", "firecrawl-search"]);
  });
});

describe("plugin registration", () => {
  it("registers the full stable Deal Hunter tool surface", async () => {
    const api = await makeFakeApi();
    plugin.register(api as never);

    const names = api.registeredTools.map((tool) => tool.name);
    expect(names).toEqual([
      "deal_discovery_backlog",
      "deal_discovery_policy",
      "deal_discovery_report",
      "deal_discovery_search",
      "deal_discovery_fetch",
      "deal_discovery_run",
      "deal_discovery_import",
      "deal_help",
      "deal_quickstart",
      "deal_report",
      "deal_digest",
      "deal_workflow_action_queue",
      "deal_watch_taxonomy",
      "deal_host_report",
      "deal_workflow_portfolio",
      "deal_workflow_triage",
      "deal_workflow_cleanup",
      "deal_workflow_best_opportunities",
      "deal_health",
      "deal_doctor",
      "deal_sample_setup",
      "deal_history",
      "deal_alerts",
      "deal_trends",
      "deal_top_drops",
      "deal_watch_insights",
      "deal_watch_provenance",
      "deal_watch_identity",
      "deal_market_check",
      "deal_market_check_candidates",
      "deal_product_groups",
      "deal_best_price_board",
      "deal_llm_review_queue",
      "deal_llm_review_run",
      "deal_llm_review_apply",
      "deal_schedule_advice",
      "deal_saved_view_list",
      "deal_saved_view_dashboard",
      "deal_saved_view_create",
      "deal_saved_view_run",
      "deal_saved_view_update",
      "deal_saved_view_delete",
      "deal_view_scan",
      "deal_view_report",
      "deal_template_list",
      "deal_watch_add_template",
      "deal_watch_export",
      "deal_watch_import",
      "deal_watch_import_url",
      "deal_watch_bulk_update",
      "deal_view_bulk_update",
      "deal_watch_tag",
      "deal_watch_dedupe",
      "deal_review_policy",
      "deal_scan",
      "deal_fetch_url",
      "deal_evaluate_text",
      "deal_extraction_debug",
      "deal_watch_list",
      "deal_watch_add",
      "deal_watch_update",
      "deal_watch_set_enabled",
      "deal_watch_remove",
      "deal_watch_search",
    ]);
    expect(new Set(names).size).toBe(names.length);
  });

  it("keeps representative read-only tool outputs stable", async () => {
    const api = await makeFakeApi({
      storePath: join(tmpdir(), "deal-hunter-phase-0", "store.json"),
      llmReview: { mode: "queue" },
      discovery: { enabled: false, provider: "off" },
    });
    plugin.register(api as never);

    const byName = new Map(api.registeredTools.map((tool) => [tool.name, tool]));

    const help = parseJsonToolResult(await byName.get("deal_help")!.execute("1", {})) as {
      topic: string;
      details: { installCommand: string; coreTools: string[] };
    };
    expect(help.topic).toBe("overview");
    expect(help.details.installCommand).toBe("openclaw plugins install openclaw-deal-hunter");
    expect(help.details.coreTools).toContain("deal_scan");
    expect(help.details.coreTools).toContain("deal_workflow_best_opportunities");

    const reviewPolicy = parseJsonToolResult(await byName.get("deal_review_policy")!.execute("1", {})) as {
      mode: string;
      summary: string;
    };
    expect(reviewPolicy.mode).toBe("queue");
    expect(reviewPolicy.summary).toContain("queued");

    const discoveryPolicy = parseJsonToolResult(await byName.get("deal_discovery_policy")!.execute("1", {})) as {
      enabled: boolean;
      provider: string;
    };
    expect(discoveryPolicy).toMatchObject({
      enabled: false,
      provider: "off",
    });

    const watchList = parseJsonToolResult(await byName.get("deal_watch_list")!.execute("1", {})) as {
      watches: unknown[];
      storePath: string;
    };
    expect(watchList.watches).toEqual([]);
    expect(watchList.storePath).toContain("store.json");
  });
});
