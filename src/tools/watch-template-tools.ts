import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import { resolveDealConfig } from "../config.js";
import { addWatch, saveStore } from "../lib/store.js";
import { buildWatchFromTemplate, listWatchTemplates } from "../lib/templates.js";
import { canonicalizeWatchUrl } from "../lib/url-policy.js";
import { toWatchView, type ToolContext } from "./shared.js";

export function registerWatchTemplateTools(api: OpenClawPluginApi, ctx: ToolContext): void {
  const { storePath, withStore } = ctx;

  api.registerTool(
    {
      name: "deal_template_list",
      label: "Deal Hunter",
      description: "List built-in watch templates for common deal and restock tracking patterns.",
      parameters: Type.Object({}),
      execute: async () => {
        return jsonResult({
          count: listWatchTemplates().length,
          templates: listWatchTemplates(),
        });
      },
    },
    { optional: false },
  );

  api.registerTool(
    {
      name: "deal_watch_add_template",
      label: "Deal Hunter",
      description: "Create a watch from a built-in template. Supports dry-run preview before writing.",
      parameters: Type.Object({
        templateId: Type.Union([
          Type.Literal("price_cap"),
          Type.Literal("percent_drop"),
          Type.Literal("hybrid_deal"),
          Type.Literal("restock_signal"),
          Type.Literal("clearance_hunter"),
        ]),
        url: Type.String(),
        label: Type.Optional(Type.String()),
        group: Type.Optional(Type.String()),
        tags: Type.Optional(Type.Array(Type.String())),
        maxPrice: Type.Optional(Type.Number()),
        percentDrop: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
        keywords: Type.Optional(Type.Array(Type.String())),
        checkIntervalHint: Type.Optional(Type.String()),
        enabled: Type.Optional(Type.Boolean()),
        dryRun: Type.Optional(Type.Boolean()),
      }),
      execute: async (_id, params) => {
        const cfg = resolveDealConfig(api);
        const normalizedUrl = canonicalizeWatchUrl(params.url, cfg).toString();
        const built = buildWatchFromTemplate({
          templateId: params.templateId,
          url: normalizedUrl,
          label: params.label,
          group: params.group,
          tags: params.tags,
          maxPrice: params.maxPrice,
          percentDrop: params.percentDrop,
          keywords: params.keywords,
          checkIntervalHint: params.checkIntervalHint,
          enabled: params.enabled,
        });
        const { template, ...watchInput } = built;

        if (params.dryRun !== false) {
          return jsonResult({
            ok: true,
            dryRun: true,
            template,
            watch: toWatchView({
              id: "dry-run",
              createdAt: new Date().toISOString(),
              enabled: watchInput.enabled ?? true,
              ...watchInput,
            }),
          });
        }

        let watch = null;
        await withStore(async (store) => {
          watch = addWatch(store, watchInput);
          await saveStore(storePath, store);
        });

        return jsonResult({
          ok: true,
          dryRun: false,
          template,
          watch: toWatchView(watch!),
        });
      },
    },
    { optional: true },
  );
}
