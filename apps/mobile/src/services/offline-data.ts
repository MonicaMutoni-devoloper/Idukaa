import { presetRange } from "@sms/shared";
import { kvGet, kvSet } from "../database";
import { request, useSession } from "./api";
import { businessRevisionKey, dashboardCacheKey } from "./dashboard-cache";
import { loadFinancial, loadInventory, loadMovements, loadSales, type LoadMeta } from "./report-data";
import type { Dashboard } from "./local-dashboard";

/**
 * Explicit offline report download.
 *
 * Products, suppliers, stock and locally recorded operations are already maintained by the sync
 * engine. This fills the other half of the offline experience on demand: the server answers behind
 * Overview, Inventory, Stock movements, Sales and Financial reports for the current month and year,
 * saved with the same shop/user/period/permission-scoped keys the screens read.
 *
 * A download is only marked complete after every payload is durably in SQLite/IndexedDB. A partial
 * download keeps the modules that succeeded and is reported as partial, never as complete.
 */

export interface OfflinePeriodStatus {
  key: "month" | "year";
  from: string;
  to: string;
  modules: { dashboard: boolean; inventory: boolean; movements: boolean; sales: boolean; financial: boolean };
}

export interface OfflineDataStatus {
  savedAt: string;
  shopId: string;
  userId: string;
  financials: boolean;
  complete: boolean;
  periods: OfflinePeriodStatus[];
}

const statusKey = (shopId: string) => `offline.data:${shopId}`;
const DASHBOARD_VERSION = 3;
let inFlight: Promise<OfflineDataStatus> | null = null;

export async function getOfflineDataStatus(): Promise<OfflineDataStatus | null> {
  const user = useSession.getState().user;
  if (!user?.shopId) return null;
  try {
    const raw = await kvGet(statusKey(user.shopId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as OfflineDataStatus;
    if (!parsed || parsed.shopId !== user.shopId || parsed.userId !== user.id) return null;
    return parsed;
  } catch {
    return null;
  }
}

const saved = (m: LoadMeta) => m.source === "server" && m.savedLocally;

async function saveDashboard(shopId: string, from: string, to: string): Promise<boolean> {
  const user = useSession.getState().user;
  if (!user) return false;
  try {
    const data = await request<Dashboard>(`/reports/dashboard?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { auth: true });
    const revision = await kvGet(businessRevisionKey(shopId)).catch(() => null);
    await kvSet(dashboardCacheKey(user, from, to), JSON.stringify({
      version: DASHBOARD_VERSION, savedAt: new Date().toISOString(), data, revision,
    }));
    await kvSet(`dash.perms:${user.id}`, data.permissions?.financials ? "1" : "0");
    return true;
  } catch {
    return false;
  }
}

async function runDownload(): Promise<OfflineDataStatus> {
  const user = useSession.getState().user;
  if (!user?.shopId) throw new Error("offline_download_requires_shop");
  const shopId = user.shopId;
  const financials = user.role === "owner" || (await kvGet(`dash.perms:${user.id}`).catch(() => null)) === "1";
  const periods: OfflinePeriodStatus[] = [];

  for (const key of ["month", "year"] as const) {
    const range = presetRange(key);
    const ctx = { online: true, shopId, from: range.from, to: range.to, financials };
    const [dashboard, inventory, movements, sales, financial] = await Promise.all([
      saveDashboard(shopId, range.from, range.to),
      loadInventory(ctx),
      loadMovements(ctx),
      loadSales(ctx),
      financials ? loadFinancial(ctx) : Promise.resolve(null),
    ]);
    periods.push({
      key, from: range.from, to: range.to,
      modules: {
        dashboard,
        inventory: saved(inventory.meta),
        movements: saved(movements.meta),
        sales: saved(sales.meta),
        financial: financial ? saved(financial.meta) : false,
      },
    });
  }

  const wanted = (p: OfflinePeriodStatus) => Object.entries(p.modules)
    .filter(([name]) => name !== "financial" || financials)
    .every(([, ok]) => ok);
  const status: OfflineDataStatus = {
    savedAt: new Date().toISOString(),
    shopId, userId: user.id, financials,
    complete: periods.every(wanted),
    periods,
  };
  await kvSet(statusKey(shopId), JSON.stringify(status));
  return status;
}

/** One download at a time: repeated taps share the same run instead of duplicating requests. */
export function downloadOfflineData(): Promise<OfflineDataStatus> {
  if (!inFlight) inFlight = runDownload().finally(() => { inFlight = null; });
  return inFlight;
}
