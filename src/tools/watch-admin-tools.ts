import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { ToolContext } from "./shared.js";
import { registerWatchImportTools } from "./watch-import-tools.js";
import { registerWatchTemplateTools } from "./watch-template-tools.js";

export function registerWatchAdminTools(api: OpenClawPluginApi, ctx: ToolContext): void {
  registerWatchTemplateTools(api, ctx);
  registerWatchImportTools(api, ctx);
}
