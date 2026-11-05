import { listProducts, listRecords } from "../database";
import { computeLocalDashboard, type LocalDashboardResult } from "./local-dashboard";

/**
 * Loads this device's durable records and products, then calculates the dashboard for one range.
 * Kept apart from the calculation so the maths can be tested without SQLite/IndexedDB.
 */
export async function buildLocalDashboard(opts: {
  from: string; to: string; role: "owner" | "manager" | "system_admin"; financials: boolean;
}): Promise<LocalDashboardResult> {
  const [records, products] = await Promise.all([listRecords(), listProducts("")]);
  return computeLocalDashboard({ ...opts, records, products });
}
