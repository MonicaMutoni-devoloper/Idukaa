import { presetRange, type PeriodRange } from "@sms/shared";

/**
 * Pure rules for automatic offline preparation and the offline-readiness indicator.
 *
 * Kept free of React Native and storage imports so Node tests can prove the retention window, the
 * throttling rule and the policy staleness rule without a device. The cache itself lives in
 * `offline-data.ts` / `policy-cache.ts`.
 */

export type OfflineCategoryKey =
  | "catalogue" | "reports" | "profitability" | "saleDetails"
  | "team" | "approvals" | "notifications" | "settings" | "policy";

export type OfflineCategoryState = "available" | "stale" | "missing" | "downloading" | "error" | "forbidden";

export interface OfflineCategoryStatus {
  key: OfflineCategoryKey;
  state: OfflineCategoryState;
  savedAt: string | null;
  error?: string | null;
}

export interface OfflinePeriodStatus {
  key: OfflinePeriodKey;
  from: string;
  to: string;
  modules: { dashboard: boolean; inventory: boolean; movements: boolean; sales: boolean; financial: boolean };
}

export type OfflinePeriodKey = "thisMonth" | "lastMonth" | "thisYear" | "lastYear";

export interface OfflineDataStatus {
  /** Cache format version. An older shape is ignored instead of rendered as current. */
  version: number;
  savedAt: string;
  shopId: string;
  userId: string;
  financials: boolean;
  complete: boolean;
  /** Business revision observed when this snapshot was prepared. */
  revision: string | null;
  categories: OfflineCategoryStatus[];
  periods: OfflinePeriodStatus[];
}

export const OFFLINE_CACHE_VERSION = 3;
/** The oldest category is still considered fresh for this long; automatic runs are also throttled. */
export const OFFLINE_STALE_MS = 12 * 60 * 60_000;
export const AUTO_MIN_INTERVAL_MS = 15 * 60_000;
export const POLICY_STALE_MS = 24 * 60 * 60_000;
export const MAX_REPORT_CACHES = 60;
export const REPORT_RETENTION_MS = 180 * 24 * 60 * 60_000;

export const OFFLINE_PERIODS: OfflinePeriodKey[] = ["thisMonth", "lastMonth", "thisYear", "lastYear"];

export const periodRangeFor = (key: OfflinePeriodKey, now = new Date()): PeriodRange =>
  key === "thisMonth" ? presetRange("month", now.getTime())
  : key === "lastMonth" ? presetRange("prevMonth", now.getTime())
  : key === "thisYear" ? presetRange("year", now.getTime())
  : presetRange("prevYear", now.getTime());

export function periodIsStale(savedAt: string | null | undefined, now = Date.now(), maxAge = OFFLINE_STALE_MS): boolean {
  if (!savedAt) return true;
  const t = Date.parse(savedAt);
  return Number.isNaN(t) || now - t > maxAge;
}

/** A category is "stale" only once it exists but is older than the refresh window. */
export function categoryStatus(
  key: OfflineCategoryKey,
  savedAt: string | null,
  now = Date.now(),
  opts: { missing?: boolean; error?: string | null; forbidden?: boolean } = {},
): OfflineCategoryStatus {
  if (opts.forbidden) return { key, state: "forbidden", savedAt };
  if (opts.error) return { key, state: savedAt ? "stale" : "error", savedAt, error: opts.error };
  if (opts.missing || !savedAt) return { key, state: "missing", savedAt: null };
  return { key, state: periodIsStale(savedAt, now) ? "stale" : "available", savedAt };
}

export interface OfflineSummary {
  available: number; stale: number; missing: number; downloading: number; errors: number; forbidden: number;
  ready: boolean; needsRefresh: boolean;
}

export function summarizeOffline(categories: OfflineCategoryStatus[]): OfflineSummary {
  const count = (s: OfflineCategoryState) => categories.filter((c) => c.state === s).length;
  const available = count("available");
  const stale = count("stale");
  const missing = count("missing");
  const downloading = count("downloading");
  const errors = count("error");
  const forbidden = count("forbidden");
  return {
    available, stale, missing, downloading, errors, forbidden,
    ready: categories.length > 0 && missing === 0 && errors === 0 && downloading === 0,
    needsRefresh: stale > 0 || missing > 0 || errors > 0,
  };
}

/** Automatic preparation is allowed only after the throttle window or when a change was seen. */
export function shouldAutoPrepare(lastPreparedAt: string | null | undefined, now = Date.now(), changed = false): boolean {
  if (!lastPreparedAt) return true;
  const t = Date.parse(lastPreparedAt);
  if (Number.isNaN(t)) return true;
  // A business change may shorten the wait, but never enough for the 30-second poll to become a
  // full-report download loop.
  return now - t > (changed ? 5 * 60_000 : AUTO_MIN_INTERVAL_MS);
}

/** Retention rule: keep recent caches and never grow the report cache without bound. */
export function cacheKeysToPrune(
  entries: { key: string; savedAt: string | null }[],
  now = Date.now(),
  retention = REPORT_RETENTION_MS,
  maxEntries = MAX_REPORT_CACHES,
): string[] {
  const expired = entries.filter((e) => periodIsStale(e.savedAt, now, retention)).map((e) => e.key);
  const fresh = entries.filter((e) => !expired.includes(e.key))
    .sort((a, b) => Date.parse(b.savedAt ?? "0") - Date.parse(a.savedAt ?? "0"));
  const overflow = fresh.slice(maxEntries).map((e) => e.key);
  return [...new Set([...expired, ...overflow])];
}

export interface PolicySnapshot {
  version: 1;
  shopId: string | null;
  fetchedAt: string;
  maxDiscountPercent: number;
  belowCostPolicy: "acknowledge" | "block";
  managerFinancialAccess: boolean;
}

export function readPolicySnapshot(raw: string | null, shopId: string | null): PolicySnapshot | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as PolicySnapshot;
    if (!p || p.version !== 1) return null;
    if ((p.shopId ?? null) !== (shopId ?? null)) return null;
    if (typeof p.fetchedAt !== "string" || Number.isNaN(Date.parse(p.fetchedAt))) return null;
    if (!Number.isInteger(p.maxDiscountPercent) || p.maxDiscountPercent < 0 || p.maxDiscountPercent > 100) return null;
    if (p.belowCostPolicy !== "acknowledge" && p.belowCostPolicy !== "block") return null;
    if (typeof p.managerFinancialAccess !== "boolean") return null;
    return p;
  } catch {
    return null;
  }
}

export const policyIsStale = (p: PolicySnapshot, now = Date.now(), maxAge = POLICY_STALE_MS): boolean =>
  periodIsStale(p.fetchedAt, now, maxAge);
