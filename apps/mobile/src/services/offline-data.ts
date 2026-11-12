import { create } from "zustand";
import { kvDelete, kvGet, kvList, kvSet, productCount } from "../database";
import { request, useSession } from "./api";
import { businessRevisionKey } from "./dashboard-cache";
import { loadFinancial, loadInventory, loadMovements, loadSales, type LoadMeta } from "./report-data";
import { readCachedPolicy, refreshPolicy } from "./policy-cache";
import {
  OFFLINE_CACHE_VERSION, OFFLINE_PERIODS, cacheKeysToPrune, categoryStatus, periodRangeFor,
  shouldAutoPrepare, summarizeOffline, type OfflineCategoryKey, type OfflineCategoryStatus,
  type OfflineDataStatus, type OfflinePeriodKey, type OfflinePeriodStatus,
} from "./offline-policy";
import type { Dashboard } from "./local-dashboard";

export type { OfflineCategoryKey, OfflineCategoryStatus, OfflineDataStatus, OfflinePeriodKey, OfflinePeriodStatus } from "./offline-policy";

/**
 * Automatic offline preparation.
 *
 * Products, suppliers and local records are already maintained by the sync engine. This service
 * fills the server-side half: the current and previous month/year reports (including their rows and
 * sale details), profitability, team/approval/notification snapshots and the versioned shop policy.
 *
 * It is deliberately incremental and bounded:
 *  - one run at a time; a second request joins the in-flight run;
 *  - automatic runs are throttled (15 minutes, or 5 minutes after a business change);
 *  - manual refresh bypasses only the throttle, never the lock;
 *  - old report caches are pruned to a bounded, recent set;
 *  - a failed category is reported honestly and does not erase a previous good copy.
 */

const statusKey = (shopId: string) => `offline.data:${shopId}`;
const lastKey = (shopId: string, userId: string) => `offline.last:${shopId}:${userId}`;
const retryKey = (shopId: string, userId: string) => `offline.retry:${shopId}:${userId}`;
const DASHBOARD_VERSION = 3;

interface Snapshot<T> { version: 1; savedAt: string; data: T }

const snapshot = async <T>(key: string, data: T): Promise<T> => {
  await kvSet(key, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), data }));
  return data;
};

export async function readOfflineSnapshot<T>(key: string): Promise<{ data: T; savedAt: string } | null> {
  try {
    const raw = await kvGet(key);
    if (!raw) return null;
    const e = JSON.parse(raw) as Snapshot<T>;
    if (!e || e.version !== 1 || typeof e.savedAt !== "string" || Number.isNaN(Date.parse(e.savedAt))) return null;
    return { data: e.data, savedAt: e.savedAt };
  } catch {
    return null;
  }
}

export const snapshotKeys = {
  team: (shopId: string) => `offline.team:${shopId}`,
  approvals: (shopId: string) => `offline.approvals:${shopId}`,
  notifications: (shopId: string, userId: string) => `offline.notifications:${shopId}:${userId}`,
  me: (userId: string) => `offline.me:${userId}`,
  shop: (shopId: string) => `offline.shop:${shopId}`,
};

const saved = (m: LoadMeta) => m.source === "server" && m.savedLocally;

export const useOfflineData = create<{
  status: OfflineDataStatus | null;
  preparing: boolean;
  error: string | null;
  load: () => Promise<void>;
  refresh: () => Promise<void>;
}>((set, get) => ({
  status: null,
  preparing: false,
  error: null,
  load: async () => { set({ status: await getOfflineDataStatus() }); },
  refresh: async () => { await prepareOfflineData(true); },
}));

export async function getOfflineDataStatus(): Promise<OfflineDataStatus | null> {
  const user = useSession.getState().user;
  if (!user?.shopId) return null;
  try {
    const raw = await kvGet(statusKey(user.shopId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as OfflineDataStatus;
    if (!parsed || parsed.version !== OFFLINE_CACHE_VERSION) return null;
    if (parsed.shopId !== user.shopId || parsed.userId !== user.id) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function saveDashboard(shopId: string, from: string, to: string): Promise<boolean> {
  const user = useSession.getState().user;
  if (!user) return false;
  try {
    const data = await request<Dashboard>(`/reports/dashboard?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { auth: true });
    const revision = await kvGet(businessRevisionKey(shopId)).catch(() => null);
    await kvSet(`dashboard:v3:${shopId}:${user.id}:${user.role}:${from}:${to}`, JSON.stringify({
      version: DASHBOARD_VERSION, savedAt: new Date().toISOString(), data, revision,
    }));
    await kvSet(`dash.perms:${user.id}`, data.permissions?.financials ? "1" : "0");
    return true;
  } catch {
    return false;
  }
}

/** Cache the line detail for every sale in the downloaded period, so each receipt opens offline. */
async function cacheSaleDetails(shopId: string, sales: { id: string; at: string; by: string | null; payment_method: string; gross_amount: number; discount: number; amount_paid: number; status: string; lines?: any[] }[]): Promise<number> {
  let savedCount = 0;
  const now = new Date().toISOString();
  for (const row of sales) {
    if (!row.lines?.length) continue;
    const gross = Number(row.gross_amount);
    const discount = Number(row.discount);
    const net = gross - discount;
    const detail = {
      sale: {
        id: row.id, at: row.at, cashier: row.by ?? "—", paymentMethod: row.payment_method,
        status: row.status, grossAmount: gross, discount, amountPaid: Number(row.amount_paid), net,
        balance: Math.max(0, net - Number(row.amount_paid)), reversedAt: null, reversalReason: null,
      },
      lines: row.lines.map((l: any) => ({ ...l, discount: 0, net: Number(l.lineAmount) })),
    };
    await kvSet(`sale:${shopId}:${row.id}`, JSON.stringify({ savedAt: now, detail }));
    savedCount += 1;
  }
  return savedCount;
}

const cat = (categories: OfflineCategoryStatus[], key: OfflineCategoryKey, savedAt: string | null, opts?: { missing?: boolean; error?: string | null; forbidden?: boolean }) => {
  const next = categoryStatus(key, savedAt, Date.now(), opts);
  const i = categories.findIndex((c) => c.key === key);
  if (i >= 0) categories[i] = next; else categories.push(next);
};

const downloadingCategories = (previous: OfflineDataStatus | null): OfflineCategoryStatus[] =>
  (["catalogue", "reports", "profitability", "saleDetails", "team", "approvals", "notifications", "settings", "policy"] as OfflineCategoryKey[])
    .map((key) => ({ key, state: "downloading" as const, savedAt: previous?.categories.find((c) => c.key === key)?.savedAt ?? null }));

let controller: AbortController | null = null;

export function cancelOfflinePreparation() {
  controller?.abort();
  controller = null;
}

async function runPreparation(force: boolean, changed: boolean): Promise<OfflineDataStatus | null> {
  const user = useSession.getState().user;
  if (!user?.shopId) return null;
  const shopId = user.shopId;
  const previous = await getOfflineDataStatus();
  const last = await kvGet(lastKey(shopId, user.id)).catch(() => null);
  if (!force && !shouldAutoPrepare(last ?? previous?.savedAt, Date.now(), changed)) return previous;
  // A failed run backs off exponentially, while the next full sync still gets to retry after the
  // cap. A manual refresh bypasses this wait.
  if (!force) {
    try {
      const retry = JSON.parse((await kvGet(retryKey(shopId, user.id))) ?? "null");
      if (retry?.nextAt && Date.now() < retry.nextAt) return previous;
    } catch { /* a corrupt retry marker must not block preparation */ }
  }

  controller?.abort();
  controller = new AbortController();
  const signal = controller.signal;
  const started = new Date().toISOString();
  const categories = downloadingCategories(previous);
  const base: OfflineDataStatus = {
    version: OFFLINE_CACHE_VERSION, savedAt: started, shopId, userId: user.id,
    financials: user.role === "owner" || (await kvGet(`dash.perms:${user.id}`).catch(() => null)) === "1",
    complete: false, revision: await kvGet(businessRevisionKey(shopId)).catch(() => null),
    categories, periods: [],
  };
  useOfflineData.setState({ status: base, preparing: true, error: null });

  try {
    // Catalogue is maintained by /sync/pull; report it, never re-download it here.
    const products = await productCount().catch(() => 0);
    cat(categories, "catalogue", await kvGet("last_sync").catch(() => null), { missing: products === 0 });

    const periods: OfflinePeriodStatus[] = [];
    const ctxBase = { online: true, shopId, financials: base.financials };
    for (const key of OFFLINE_PERIODS) {
      if (signal.aborted) break;
      const range = periodRangeFor(key);
      const ctx = { ...ctxBase, from: range.from, to: range.to };
      const dashboard = await saveDashboard(shopId, range.from, range.to);
      const [inventory, movements, sales, financial] = await Promise.all([
        loadInventory(ctx), loadMovements(ctx), loadSales(ctx),
        base.financials ? loadFinancial(ctx) : Promise.resolve(null),
      ]);
      if (sales.data) await cacheSaleDetails(shopId, sales.data.sales);
      periods.push({
        key,
        ...range,
        modules: {
          dashboard,
          inventory: saved(inventory.meta),
          movements: saved(movements.meta),
          sales: saved(sales.meta),
          financial: financial ? saved(financial.meta) : false,
        },
      });
      const reportSavedAt = new Date().toISOString();
      const modulesOk = periods.at(-1)!.modules;
      const completePeriod = modulesOk.dashboard && modulesOk.inventory && modulesOk.movements && modulesOk.sales && (!base.financials || modulesOk.financial);
      cat(categories, "reports", completePeriod ? reportSavedAt : previous?.categories.find((c) => c.key === "reports")?.savedAt ?? null,
        { missing: !completePeriod && !previous?.categories.some((c) => c.key === "reports") });
      cat(categories, "saleDetails", sales.data ? reportSavedAt : previous?.categories.find((c) => c.key === "saleDetails")?.savedAt ?? null);
    }

    // Profitability is owner/financial-permission data only, scoped to this user and shop.
    if (base.financials && !signal.aborted) {
      let ok = 0; let forbidden = false; let failure: string | null = null;
      for (const key of OFFLINE_PERIODS) {
        const range = periodRangeFor(key);
        try {
          const data = await request<unknown>(`/reports/profitability?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`, { auth: true, signal });
          await snapshot(`profitability:${shopId}:${user.id}:${range.from}:${range.to}`, data);
          ok += 1;
        } catch (e: any) {
          if (e?.status === 403) forbidden = true;
          else failure = e?.message ?? "error";
        }
      }
      cat(categories, "profitability", ok > 0 ? new Date().toISOString() : previous?.categories.find((c) => c.key === "profitability")?.savedAt ?? null,
        { forbidden, error: ok > 0 ? null : failure ?? (forbidden ? null : "profitability_unavailable") });
    } else if (!base.financials) {
      cat(categories, "profitability", null, { forbidden: true });
    }

    // Small read-only operational snapshots. A failed/forbidden category keeps its last good copy.
    const snap = async (key: OfflineCategoryKey, cacheKey: string, path: string, forbidden = false) => {
      if (signal.aborted) return;
      if (forbidden) { cat(categories, key, null, { forbidden: true }); return; }
      try {
        const data = await request<unknown>(path, { auth: true, signal });
        await snapshot(cacheKey, data);
        cat(categories, key, new Date().toISOString());
      } catch (e: any) {
        cat(categories, key, previous?.categories.find((c) => c.key === key)?.savedAt ?? null,
          { forbidden: e?.status === 403, error: e?.status === 403 ? null : e?.message ?? "error" });
      }
    };

    await snap("team", snapshotKeys.team(shopId), "/shop/staff", user.role !== "owner");
    if (user.role === "owner" && !signal.aborted) {
      try {
        const [adjustments, investigations, conflicts, log] = await Promise.all([
          request<unknown[]>("/audit/adjustments/pending", { signal }),
          request<unknown[]>("/audit/investigations", { signal }),
          request<unknown[]>("/audit/conflicts", { signal }),
          request<unknown[]>("/audit/log", { signal }),
        ]);
        await snapshot(snapshotKeys.approvals(shopId), { adjustments, investigations, conflicts, log });
        cat(categories, "approvals", new Date().toISOString());
      } catch (e: any) {
        cat(categories, "approvals", previous?.categories.find((c) => c.key === "approvals")?.savedAt ?? null, { error: e?.message ?? "error" });
      }
    } else {
      cat(categories, "approvals", null, { forbidden: true });
    }

    await snap("notifications", snapshotKeys.notifications(shopId, user.id), "/notifications");

    try {
      const me = await request<unknown>("/auth/me", { auth: true, signal });
      await snapshot(snapshotKeys.me(user.id), me);
      if (user.shopId) {
        const shop = await request<unknown>("/shop/profile", { auth: true, signal });
        await snapshot(snapshotKeys.shop(shopId), shop);
      }
      cat(categories, "settings", new Date().toISOString());
    } catch (e: any) {
      cat(categories, "settings", previous?.categories.find((c) => c.key === "settings")?.savedAt ?? null, { error: e?.message ?? "error" });
    }

    try {
      const p = await refreshPolicy(shopId);
      cat(categories, "policy", p.fetchedAt);
    } catch (e: any) {
      const cached = await readCachedPolicy(shopId);
      cat(categories, "policy", cached?.fetchedAt ?? null, { error: cached ? null : e?.message ?? "error" });
    }

    // Bounded retention: prune old report/dashboard/profitability entries only. Never touch the
    // outbox, records, sync cursors or the policy snapshot.
    await pruneReportCaches(shopId).catch(() => undefined);

    const summary = summarizeOffline(categories);
    const status: OfflineDataStatus = {
      ...base, savedAt: new Date().toISOString(), complete: summary.ready,
      revision: await kvGet(businessRevisionKey(shopId)).catch(() => null),
      categories, periods,
    };
    await kvSet(statusKey(shopId), JSON.stringify(status));
    await kvSet(lastKey(shopId, user.id), status.savedAt);
    await kvDelete(retryKey(shopId, user.id)).catch(() => undefined);
    useOfflineData.setState({ status, preparing: false, error: summary.errors ? "Some offline categories could not be refreshed." : null });
    return status;
  } catch (e: any) {
    const status: OfflineDataStatus = {
      ...base, savedAt: new Date().toISOString(), complete: false,
      categories: categories.map((c) => c.state === "downloading" ? { ...c, state: "stale" } : c),
    };
    await kvSet(statusKey(shopId), JSON.stringify(status)).catch(() => undefined);
    try {
      const prior = JSON.parse((await kvGet(retryKey(shopId, user.id))) ?? "null");
      const attempts = Math.min(6, Number(prior?.attempts ?? 0) + 1);
      const delay = Math.min(30 * 60_000, 60_000 * 2 ** (attempts - 1));
      await kvSet(retryKey(shopId, user.id), JSON.stringify({ attempts, nextAt: Date.now() + delay }));
    } catch { /* the status still records the failure */ }
    useOfflineData.setState({ status, preparing: false, error: e?.message ?? "offline_preparation_failed" });
    return status;
  } finally {
    controller = null;
  }
}

let inFlight: Promise<OfflineDataStatus | null> | null = null;

/** One automatic/manual run at a time. Repeated calls share the same promise. */
export function prepareOfflineData(force = false, changed = false): Promise<OfflineDataStatus | null> {
  if (inFlight) return inFlight;
  inFlight = runPreparation(force, changed).finally(() => { inFlight = null; });
  return inFlight;
}

/** Called by the sync engine after a successful pass; obeys the throttle. */
export function queueOfflinePreparation(changed = false): void {
  if (useOfflineData.getState().preparing) return;
  void prepareOfflineData(false, changed).catch(() => undefined);
}

async function pruneReportCaches(shopId: string): Promise<void> {
  const prefixes = ["report:v2:", "dashboard:v3:", "profitability:"];
  const entries: { key: string; savedAt: string | null }[] = [];
  for (const prefix of prefixes) {
    const rows = await kvList(prefix);
    for (const row of rows) {
      if (!row.k.includes(shopId)) continue; // never prune another shop's copy
      let savedAt: string | null = null;
      try { savedAt = JSON.parse(row.v)?.savedAt ?? null; } catch { /* unreadable -> prunable */ }
      entries.push({ key: row.k, savedAt });
    }
  }
  for (const key of cacheKeysToPrune(entries)) await kvDelete(key);
}
