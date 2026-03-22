import { inspectStore } from "../lib/store-maintenance.js";
import type { StoreMaintenancePort } from "./maintenance.js";

export function createJsonStoreMaintenancePort(args: {
  storePath: string;
}): StoreMaintenancePort {
  const { storePath } = args;
  return {
    inspect() {
      return inspectStore(storePath);
    },
  };
}
