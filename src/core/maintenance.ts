import type { StoreInspection } from "../lib/store-maintenance.js";

export interface StoreMaintenancePort {
  inspect(): Promise<StoreInspection>;
}
