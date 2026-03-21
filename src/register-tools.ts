import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { withFileLock } from "openclaw/plugin-sdk";
import { resolveDealConfig } from "./config.js";
import { loadStore } from "./lib/store.js";
import { registerDiscoveryTools } from "./tools/discovery-tools.js";
import { registerReportTools } from "./tools/report-tools.js";
import { registerSavedViewTools } from "./tools/saved-view-tools.js";
import { registerWatchAdminTools } from "./tools/watch-admin-tools.js";
import { registerWatchMaintenanceTools } from "./tools/watch-maintenance-tools.js";
import { registerWatchOpsTools } from "./tools/watch-ops-tools.js";
import { registerWatchStateTools } from "./tools/watch-state-tools.js";

const LOCK_OPTS = {
  retries: { retries: 20, factor: 1.5, minTimeout: 40, maxTimeout: 800, randomize: true },
  stale: 120_000,
} as const;

export function registerDealTools(api: OpenClawPluginApi): void {
  const cfgBase = resolveDealConfig(api);
  const storePath = cfgBase.storePath;

  const withStore = async <T>(fn: (store: Awaited<ReturnType<typeof loadStore>>) => Promise<T>): Promise<T> => {
    return withFileLock(`${storePath}.lock`, LOCK_OPTS, async () => {
      const store = await loadStore(storePath);
      return fn(store);
    });
  };

  registerDiscoveryTools(api, { storePath, withStore });
  registerReportTools(api, { storePath, withStore });
  registerSavedViewTools(api, { storePath, withStore });
  registerWatchAdminTools(api, { storePath, withStore });
  registerWatchMaintenanceTools(api, { storePath, withStore });
  registerWatchOpsTools(api, { storePath, withStore });
  registerWatchStateTools(api, { storePath, withStore });

}
