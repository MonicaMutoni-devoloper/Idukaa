import { kigaliDay, presetRange, type PeriodRange } from "@sms/shared";

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

export interface OfflineArchiveStatus {
  /** Oldest month that can contain this shop's data (YYYY-MM), from the shop profile. */
  earliestMonth: string | null;
  /** Oldest month already saved for this user, or null when no older month is saved yet. */
  oldestSavedMonth: string | null;
  savedMonths: number;
  totalMonths: number;
  complete: boolean;
}

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
  /** Rolling month-by-month archive back to the shop's creation month. */
  archive?: OfflineArchiveStatus;
}

export const OFFLINE_CACHE_VERSION = 4;
/** The oldest category is still considered fresh for this long; automatic runs are also throttled. */
export const OFFLINE_STALE_MS = 12 * 60 * 60_000;
export const AUTO_MIN_INTERVAL_MS = 15 * 60_000;
export const POLICY_STALE_MS = 24 * 60 * 60_000;
export const MAX_REPORT_CACHES = 60;
export const REPORT_RETENTION_MS = 180 * 24 * 60 * 60_000;
/** Older months are fetched a few at a time so a large shop never blocks one sync for minutes. */
export const ARCHIVE_MONTHS_PER_RUN = 3;

export const OFFLINE_PERIODS: OfflinePeriodKey[] = ["thisMonth", "lastMonth", "thisYear", "lastYear"];

export const periodRangeFor = (key: OfflinePeriodKey, now = new Date()): PeriodRange =>
  key === "thisMonth" ? presetRange("month", now.getTime())
  : key === "lastMonth" ? presetRange("prevMonth", now.getTime())
  : key === "thisYear" ? presetRange("year", now.getTime())
  : presetRange("prevYear", now.getTime());

/** Exact Kigali month range for a YYYY-MM key. Null for malformed keys. */
export function monthRangeFor(month: string): PeriodRange | null {
  const m = /^(\d{4})-(\d{2})$/.exec(month.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const monthIndex = Number(m[2]) - 1;
  if (monthIndex < 0 || monthIndex > 11) return null;
  // A mid-month instant avoids month-end rollover when presetRange resolves the month.
  return presetRange("month", Date.UTC(year, monthIndex, 15));
}

/**
 * Months that still need an archive, newest first, from two months ago back to the shop's
 * creation month. The current and previous month already have full report caches.
 */
export function archiveMonthKeys(createdAt: string | null | undefined, now = Date.now()): string[] {
  if (!createdAt) return [];
  const created = Date.parse(createdAt);
  if (Number.isNaN(created)) return [];
  const earliest = kigaliDay(created).slice(0, 7);
  const current = kigaliDay(now);
  let year = Number(current.slice(0, 4));
  let month = Number(current.slice(5, 7)) - 1; // 0-based
  month -= 2;
  while (month < 0) { month += 12; year -= 1; }
  const keys: string[] = [];
  while (true) {
    const key = `${year}-${String(month + 1).padStart(2, "0")}`;
    if (key < earliest) break;
    keys.push(key);
    month -= 1;
    if (month < 0) { month = 11; year -= 1; }
  }
  return keys;
}

/** True when the range is exactly one Kigali calendar month, used to protect archives from pruning. */
export function isFullMonthRange(range: PeriodRange): boolean {
  const month = monthRangeFor(kigaliDay(range.from).slice(0, 7));
  return !!month && month.from === range.from && month.to === range.to;
}

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

/**
 * Retention rule for on-demand caches. Entries marked `keep` are the automatic full-month
 * archives: they are never expired or counted against the small browsing cache cap.
 */
export function cacheKeysToPrune(
  entries: { key: string; savedAt: string | null; keep?: boolean }[],
  now = Date.now(),
  retention = REPORT_RETENTION_MS,
  maxEntries = MAX_REPORT_CACHES,
): string[] {
  const prunable = entries.filter((e) => !e.keep);
  const expired = prunable.filter((e) => periodIsStale(e.savedAt, now, retention)).map((e) => e.key);
  const fresh = prunable.filter((e) => !expired.includes(e.key))
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
