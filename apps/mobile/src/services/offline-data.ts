import { create } from "zustand";
import NetInfo from "@react-native-community/netinfo";
import { Platform } from "react-native";
import { kigaliDay } from "@sms/shared";
import { earliestRecordAt, kvDelete, kvGet, kvList, kvSet, productCount } from "../database";
import { request, useSession } from "./api";
import { businessRevisionKey } from "./dashboard-cache";
import {
  loadFinancial, loadInventory, loadMovements, loadSales, saveReportCache,
  type FinancialData, type InventoryData, type LoadMeta, type MovementsData, type SalesData,
} from "./report-data";
import { readCachedPolicy, refreshPolicy } from "./policy-cache";
import { cacheWriteMeta, touchCacheAccess } from "./cache-meta";
import { DEFAULT_RETENTION, retentionKeepFrom, type RetentionSettings } from "./offline-retention";
import { readArchiveFloor, readRetention, runCacheCleanup } from "./offline-storage";
import {
  ARCHIVE_MONTHS_PER_RUN, OFFLINE_CACHE_VERSION, OFFLINE_PERIODS, archiveMonthKeys, cacheKeysToPrune,
  categoryStatus, isFullMonthRange, monthRangeFor, periodRangeFor, shouldAutoPrepare, summarizeOffline,
  type OfflineArchiveStatus, type OfflineCategoryKey, type OfflineCategoryStatus,
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
 *  - older months are archived a few at a time back to the shop's creation month;
 *  - browsing caches are pruned, while the automatic month archive is kept;
 *  - a failed category is reported honestly and does not erase a previous good copy.
 */

const statusKey = (shopId: string) => `offline.data:${shopId}`;
const lastKey = (shopId: string, userId: string) => `offline.last:${shopId}:${userId}`;
const retryKey = (shopId: string, userId: string) => `offline.retry:${shopId}:${userId}`;
const archiveKey = (shopId: string, userId: string, month: string) => `offline.archive:${shopId}:${userId}:${month}`;
const DASHBOARD_VERSION = 3;

async function archiveDownloadAllowed(wifiOnly: boolean): Promise<boolean> {
  if (!wifiOnly) return true;
  if (Platform.OS === "web") return true;
  try {
    const network = await NetInfo.fetch();
    return network.type === "wifi" || network.type === "ethernet";
  } catch {
    return false;
  }
}

async function archiveSelection(
  createdAt: string,
  retention: RetentionSettings,
  shopId: string,
  userId: string,
): Promise<{ months: string[]; floor: string | null; limited: boolean }> {
  const policyFloor = retentionKeepFrom(retention);
  const cleanupFloor = await readArchiveFloor(shopId, userId).catch(() => null);
  const floor = policyFloor && cleanupFloor ? (policyFloor > cleanupFloor ? policyFloor : cleanupFloor) : policyFloor ?? cleanupFloor;
  const all = archiveMonthKeys(createdAt);
  const months = floor ? all.filter((month) => month >= floor) : all;
  return { months, floor, limited: all.length > months.length };
}

interface Snapshot<T> { version: 1; savedAt: string; data: T }

const snapshot = async <T>(key: string, data: T): Promise<T> => {
  const now = new Date().toISOString();
  await kvSet(key, JSON.stringify({ version: 1, savedAt: now, data, ...cacheWriteMeta(now) }));
  return data;
};

export async function readOfflineSnapshot<T>(key: string): Promise<{ data: T; savedAt: string } | null> {
  try {
    const raw = await kvGet(key);
    if (!raw) return null;
    const e = JSON.parse(raw) as Snapshot<T>;
    if (!e || e.version !== 1 || typeof e.savedAt !== "string" || Number.isNaN(Date.parse(e.savedAt))) return null;
    void touchCacheAccess(key, raw);
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

async function fetchDashboard(from: string, to: string, signal?: AbortSignal): Promise<Dashboard> {
  return request<Dashboard>(`/reports/dashboard?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { auth: true, signal });
}

async function writeDashboard(shopId: string, from: string, to: string, data: Dashboard): Promise<void> {
  const user = useSession.getState().user;
  if (!user) throw new Error("no_session");
  const revision = await kvGet(businessRevisionKey(shopId)).catch(() => null);
  const now = new Date().toISOString();
  await kvSet(`dashboard:v3:${shopId}:${user.id}:${user.role}:${from}:${to}`, JSON.stringify({
    version: DASHBOARD_VERSION, savedAt: now, data, revision, ...cacheWriteMeta(now),
  }));
  await kvSet(`dash.perms:${user.id}`, data.permissions?.financials ? "1" : "0");
}

async function saveDashboard(shopId: string, from: string, to: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const data = await fetchDashboard(from, to, signal);
    await writeDashboard(shopId, from, to, data);
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
    await kvSet(`sale:${shopId}:${row.id}`, JSON.stringify({
      savedAt: now, detail, period: kigaliDay(row.at).slice(0, 7), ...cacheWriteMeta(now),
    }));
    savedCount += 1;
  }
  return savedCount;
}

const cat = (categories: OfflineCategoryStatus[], key: OfflineCategoryKey, savedAt: string | null, opts?: { missing?: boolean; error?: string | null; forbidden?: boolean }) => {
  const next = categoryStatus(key, savedAt, Date.now(), opts);
  const i = categories.findIndex((c) => c.key === key);
  if (i >= 0) categories[i] = next; else categories.push(next);
};

interface PeriodCacheResult {
  modules: OfflinePeriodStatus["modules"];
  hasSalesData: boolean;
  /** In staged mode the caller writes these only after every module succeeded. */
  data?: {
    dashboard: Dashboard;
    inventory: InventoryData | null;
    movements: MovementsData | null;
    sales: SalesData | null;
    financial: FinancialData | null;
  };
}

/** Download one exact period. The archive reuses this for every older month. */
async function cacheReportPeriod(
  shopId: string,
  range: { from: string; to: string },
  financials: boolean,
  opts: { inventory?: boolean; signal?: AbortSignal; persist?: boolean } = {},
): Promise<PeriodCacheResult> {
  const persist = opts.persist !== false;
  const ctx = { online: true, shopId, financials, from: range.from, to: range.to, persist };
  const dashboardData = persist
    ? null
    : await fetchDashboard(range.from, range.to, opts.signal).catch(() => null);
  const dashboard = dashboardData ? true : persist ? await saveDashboard(shopId, range.from, range.to, opts.signal) : false;
  const inventoryP = opts.inventory === false ? Promise.resolve(null) : loadInventory(ctx);
  const [inventory, movements, sales, financial] = await Promise.all([
    inventoryP,
    loadMovements(ctx), loadSales(ctx),
    financials ? loadFinancial(ctx) : Promise.resolve(null),
  ]);
  const fetched = (m: LoadMeta) => persist ? saved(m) : m.source === "server" && !m.failed;
  if (persist && sales.data) await cacheSaleDetails(shopId, sales.data.sales);
  return {
    hasSalesData: !!sales.data,
    modules: {
      dashboard,
      inventory: inventory ? fetched(inventory.meta) : false,
      movements: fetched(movements.meta),
      sales: fetched(sales.meta),
      financial: financial ? fetched(financial.meta) : false,
    },
    data: dashboardData ? {
      dashboard: dashboardData,
      inventory: inventory?.data ?? null,
      movements: movements.data,
      sales: sales.data,
      financial: financial?.data ?? null,
    } : undefined,
  };
}

interface ShopProfileLite { createdAt?: string | null; created_at?: string | null }

/** Accept both the current camelCase profile and an older API that returned the SQL column name. */
function profileCreatedAt(data: ShopProfileLite | null | undefined): string | null {
  const value = data?.createdAt ?? data?.created_at;
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
}

async function fetchShopProfile(shopId: string, signal?: AbortSignal): Promise<{ data: unknown; createdAt: string | null }> {
  const data = await request<ShopProfileLite>("/shop/profile", { auth: true, signal });
  await snapshot(snapshotKeys.shop(shopId), data);
  return { data, createdAt: profileCreatedAt(data) };
}

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
    categories, periods: [], archive: previous?.archive,
  };
  useOfflineData.setState({ status: base, preparing: true, error: null });

  try {
    // Catalogue is maintained by /sync/pull; report it, never re-download it here.
    const products = await productCount().catch(() => 0);
    cat(categories, "catalogue", await kvGet("last_sync").catch(() => null), { missing: products === 0 });

    // Fetch the shop profile once: its creation month is the history boundary, and the same
    // response is reused for the settings snapshot below.
    let shopProfile: { data: unknown; createdAt: string | null } | null = null;
    try { shopProfile = await fetchShopProfile(shopId, signal); } catch { /* settings reports this */ }

    const periods: OfflinePeriodStatus[] = [];
    for (const key of OFFLINE_PERIODS) {
      if (signal.aborted) break;
      const range = periodRangeFor(key);
      const result = await cacheReportPeriod(shopId, range, base.financials, { signal });
      periods.push({ key, ...range, modules: result.modules });
      const reportSavedAt = new Date().toISOString();
      const modulesOk = result.modules;
      const completePeriod = modulesOk.dashboard && modulesOk.inventory && modulesOk.movements && modulesOk.sales && (!base.financials || modulesOk.financial);
      cat(categories, "reports", completePeriod ? reportSavedAt : previous?.categories.find((c) => c.key === "reports")?.savedAt ?? null,
        { missing: !completePeriod && !previous?.categories.some((c) => c.key === "reports") });
      cat(categories, "saleDetails", result.hasSalesData ? reportSavedAt : previous?.categories.find((c) => c.key === "saleDetails")?.savedAt ?? null);
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
      if (user.shopId && !shopProfile) shopProfile = await fetchShopProfile(shopId, signal);
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

    // Rolling history: fill in a few missing months per successful sync, newest first, stopping at
    // the shop's creation month. The retention policy and any cleanup floor cap how far back the
    // automatic loop goes, so a storage cleanup is not immediately undone by the next sync.
    const retention = await readRetention(shopId).catch(() => ({ ...DEFAULT_RETENTION }));
    let archive: OfflineArchiveStatus | undefined = shopProfile?.createdAt ? undefined : previous?.archive;
    if (shopProfile?.createdAt) {
      let selection = await archiveSelection(shopProfile.createdAt, retention, shopId, user.id);
      const allowed = await archiveDownloadAllowed(retention.wifiOnly);
      if (allowed) {
        let savedMonths = new Set<string>();
        for (const month of selection.months) {
          if (await kvGet(archiveKey(shopId, user.id, month)).catch(() => null)) savedMonths.add(month);
        }
        const missing = selection.months.filter((month) => !savedMonths.has(month));
        for (const month of missing.slice(0, ARCHIVE_MONTHS_PER_RUN)) {
          if (signal.aborted) break;
          const range = monthRangeFor(month);
          if (!range) continue;
          const result = await cacheReportPeriod(shopId, range, base.financials, { signal, persist: false });
          const complete = result.modules.dashboard && result.modules.movements && result.modules.sales
            && (!base.financials || result.modules.financial);
          if (!complete || !result.data) continue;
          let profit: unknown = null;
          if (base.financials) {
            try {
              profit = await request<unknown>(
                `/reports/profitability?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`,
                { auth: true, signal },
              );
            } catch {
              continue; // retry this month on the next run rather than marking it complete
            }
          }
          // The month is staged in memory first. Only after every required payload has arrived
          // are the saved copies replaced, and only after those writes is the month marked done.
          try {
            await writeDashboard(shopId, range.from, range.to, result.data.dashboard);
            const ctx = { online: true, shopId, financials: base.financials, from: range.from, to: range.to, persist: true };
            if (result.data.inventory && !(await saveReportCache(ctx, "analytics:inventory", result.data.inventory))) continue;
            if (result.data.movements && !(await saveReportCache(ctx, "analytics:movements", result.data.movements))) continue;
            if (result.data.sales && !(await saveReportCache(ctx, "analytics:sales", result.data.sales))) continue;
            if (base.financials && result.data.financial && !(await saveReportCache(ctx, "analytics:financial", result.data.financial))) continue;
            if (result.data.sales) await cacheSaleDetails(shopId, result.data.sales.sales);
            if (base.financials && profit !== null) {
              await snapshot(`profitability:${shopId}:${user.id}:${range.from}:${range.to}`, profit);
            }
          } catch {
            continue;
          }
          await kvSet(archiveKey(shopId, user.id, month), "1");
          savedMonths.add(month);
        }
      }

      // Enforce the selected retention policy after downloading. Only downloaded cache is eligible;
      // the cleanup service never receives records or outbox rows. A cleanup can raise the archive
      // floor, so recalculate the visible selection afterwards instead of showing deleted months.
      const cleanup = await runCacheCleanup(shopId, user.id, retention).catch(() => null);
      if (cleanup?.months.length) {
        selection = await archiveSelection(shopProfile.createdAt, retention, shopId, user.id);
      }
      const savedMonths = new Set<string>();
      for (const month of selection.months) {
        if (await kvGet(archiveKey(shopId, user.id, month)).catch(() => null)) savedMonths.add(month);
      }
      const oldestSavedMonth = [...selection.months].reverse().find((month) => savedMonths.has(month)) ?? null;
      archive = {
        earliestMonth: selection.months.at(-1) ?? null,
        oldestSavedMonth,
        savedMonths: savedMonths.size,
        totalMonths: selection.months.length,
        complete: selection.months.every((month) => savedMonths.has(month)),
        limited: selection.limited || !!cleanup?.months.length,
        waitingForWifi: !allowed,
        lastCleanupBytes: cleanup?.bytesFreed ?? 0,
      };
    }

    // Bounded retention: prune old browsing caches only. Never touch the automatic month archive,
    // the outbox, records, sync cursors or the policy snapshot.
    await pruneReportCaches(shopId).catch(() => undefined);

    const summary = summarizeOffline(categories);
    const status: OfflineDataStatus = {
      ...base, savedAt: new Date().toISOString(), complete: summary.ready && (archive?.complete ?? true),
      revision: await kvGet(businessRevisionKey(shopId)).catch(() => null),
      categories, periods, archive,
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

/**
 * History boundary for the archive. Prefer the shop profile, then fall back to the earliest business
 * record already on this device. Some deployed APIs predate the profile's creation date; without a
 * boundary the archive could never start, even though the device already knows where its history begins.
 */
export async function getShopCreatedAt(shopId: string): Promise<string | null> {
  const cached = await readOfflineSnapshot<ShopProfileLite>(snapshotKeys.shop(shopId)).catch(() => null);
  const cachedCreatedAt = profileCreatedAt(cached?.data);
  if (cachedCreatedAt) return cachedCreatedAt;
  const localStart = await earliestRecordAt(shopId).catch(() => null);
  if (localStart) return localStart;
  try {
    const profile = await fetchShopProfile(shopId);
    return profile.createdAt;
  } catch {
    return null;
  }
}

/**
 * Re-download one archive month after an explicit user action. The archive marker is written only
 * after every required module has answered, so a failed refresh is retried rather than presented
 * as complete.
 */
export async function refreshArchiveMonth(month: string): Promise<{ ok: boolean; error?: string }> {
  const user = useSession.getState().user;
  if (!user?.shopId) return { ok: false, error: "no_shop" };
  if (inFlight) return { ok: false, error: "busy" };
  const range = monthRangeFor(month);
  if (!range) return { ok: false, error: "invalid_month" };
  const retention = await readRetention(user.shopId).catch(() => ({ ...DEFAULT_RETENTION }));
  if (!(await archiveDownloadAllowed(retention.wifiOnly))) return { ok: false, error: "wifi_required" };
  const financials = user.role === "owner" || (await kvGet(`dash.perms:${user.id}`).catch(() => null)) === "1";
  const result = await cacheReportPeriod(user.shopId, range, financials, { persist: false });
  const complete = result.modules.dashboard && result.modules.movements && result.modules.sales
    && (!financials || result.modules.financial) && !!result.data;
  if (!complete || !result.data) return { ok: false, error: "incomplete" };
  let profit: unknown = null;
  if (financials) {
    try {
      profit = await request<unknown>(
        `/reports/profitability?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`,
        { auth: true },
      );
    } catch {
      return { ok: false, error: "profitability" };
    }
  }
  try {
    await writeDashboard(user.shopId, range.from, range.to, result.data.dashboard);
    const ctx = { online: true, shopId: user.shopId, financials, from: range.from, to: range.to, persist: true };
    if (result.data.inventory && !(await saveReportCache(ctx, "analytics:inventory", result.data.inventory))) return { ok: false, error: "inventory" };
    if (result.data.movements && !(await saveReportCache(ctx, "analytics:movements", result.data.movements))) return { ok: false, error: "movements" };
    if (result.data.sales && !(await saveReportCache(ctx, "analytics:sales", result.data.sales))) return { ok: false, error: "sales" };
    if (financials && result.data.financial && !(await saveReportCache(ctx, "analytics:financial", result.data.financial))) return { ok: false, error: "financial" };
    if (result.data.sales) await cacheSaleDetails(user.shopId, result.data.sales.sales);
    if (financials && profit !== null) {
      await snapshot(`profitability:${user.shopId}:${user.id}:${range.from}:${range.to}`, profit);
    }
  } catch {
    return { ok: false, error: "storage" };
  }
  await kvSet(archiveKey(user.shopId, user.id, month), "1");
  return { ok: true };
}

const ISO_INSTANT = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;

/** A cache entry's period, from its payload when present or from the ISO instants in its key. */
function cacheRange(key: string, parsed: any): { from: string; to: string } | null {
  if (typeof parsed?.from === "string" && typeof parsed?.to === "string") return { from: parsed.from, to: parsed.to };
  const matches = key.match(ISO_INSTANT);
  const from = matches?.at(-2);
  const to = matches?.at(-1);
  return from && to ? { from, to } : null;
}

async function pruneReportCaches(shopId: string): Promise<void> {
  const prefixes = ["report:v2:", "dashboard:v3:", "profitability:"];
  const entries: { key: string; savedAt: string | null; keep: boolean }[] = [];
  for (const prefix of prefixes) {
    const rows = await kvList(prefix);
    for (const row of rows) {
      if (!row.k.includes(shopId)) continue; // never prune another shop's copy
      let savedAt: string | null = null;
      let keep = false;
      try {
        const parsed = JSON.parse(row.v);
        savedAt = parsed?.savedAt ?? null;
        const range = cacheRange(row.k, parsed);
        // A completed calendar month is part of the rolling history archive, not a browsing cache.
        keep = !!range && isFullMonthRange(range);
      } catch { /* unreadable -> prunable */ }
      entries.push({ key: row.k, savedAt, keep });
    }
  }
  for (const key of cacheKeysToPrune(entries)) await kvDelete(key);
}
