import { kigaliDay } from "@sms/shared";
import { isFullMonthRange, periodRangeFor } from "./offline-policy.ts";

/**
 * Pure retention rules for downloaded cache. Nothing here reads storage or touches records:
 * permanent business rows and the outbox are deliberately outside this module's vocabulary.
 */

export type RetentionMode = "recent" | "months12" | "months24" | "auto";

export interface RetentionSettings {
  version: 1;
  mode: RetentionMode;
  /** Automatic cache ceiling in MB. Only used when mode is "auto". */
  limitMb: number;
  /** Restrict large historical downloads to Wi-Fi. */
  wifiOnly: boolean;
}

export const DEFAULT_RETENTION: RetentionSettings = {
  version: 1,
  mode: "auto",
  limitMb: 250,
  wifiOnly: false,
};

export const RETENTION_LIMIT_OPTIONS = [100, 250, 500] as const;
export const MB = 1024 * 1024;

export function readRetentionSettings(raw: string | null | undefined): RetentionSettings {
  if (!raw) return { ...DEFAULT_RETENTION };
  try {
    const p = JSON.parse(raw);
    if (!p || p.version !== 1) return { ...DEFAULT_RETENTION };
    const mode: RetentionMode = p.mode === "recent" || p.mode === "months12" || p.mode === "months24" || p.mode === "auto"
      ? p.mode : DEFAULT_RETENTION.mode;
    const limitMb = Number.isFinite(Number(p.limitMb)) && Number(p.limitMb) >= 50 && Number(p.limitMb) <= 5000
      ? Math.round(Number(p.limitMb)) : DEFAULT_RETENTION.limitMb;
    return { version: 1, mode, limitMb, wifiOnly: p.wifiOnly === true };
  } catch {
    return { ...DEFAULT_RETENTION };
  }
}

export type CacheKind = "report" | "dashboard" | "profitability" | "saleDetail" | "archiveMarker" | "otherCache";

export interface CacheEntry {
  key: string;
  bytes: number;
  savedAt: string | null;
  lastAccessAt: string | null;
  kind: CacheKind;
  shopId: string | null;
  /** Full Kigali month this entry belongs to, when it is a monthly snapshot. */
  period: string | null;
  /** True only for exact full-month ranges. */
  fullMonth: boolean;
  /** Set only for `archiveMarker` entries. */
  markerMonth?: string;
}

export interface ArchiveMarker {
  shopId: string;
  month: string;
  key: string;
}

export function monthKeyOf(iso: string | null | undefined): string | null {
  if (!iso || Number.isNaN(Date.parse(iso))) return null;
  return kigaliDay(iso).slice(0, 7);
}

export function shiftMonth(month: string, delta: number): string | null {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return null;
  let year = Number(m[1]);
  let index = Number(m[2]) - 1 + delta;
  while (index < 0) { index += 12; year -= 1; }
  while (index > 11) { index -= 12; year += 1; }
  return `${year}-${String(index + 1).padStart(2, "0")}`;
}

export function isArchiveMonth(month: string | null, now = Date.now()): boolean {
  if (!month) return false;
  const previous = shiftMonth(kigaliDay(now).slice(0, 7), -2);
  return !!previous && month <= previous;
}

/** Oldest month a retention mode promises to keep. `auto` has no fixed floor. */
export function retentionKeepFrom(settings: RetentionSettings, now = Date.now()): string | null {
  if (settings.mode === "auto") return null;
  const months = settings.mode === "recent" ? 3 : settings.mode === "months12" ? 12 : 24;
  return shiftMonth(kigaliDay(now).slice(0, 7), -(months - 1));
}

const ISO_INSTANT_SOURCE = "\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z";
const ISO_INSTANT = new RegExp(ISO_INSTANT_SOURCE, "g");

interface ParsedCacheKey {
  kind: CacheKind;
  shopId: string | null;
  from: string | null;
  to: string | null;
  markerMonth?: string;
}

/** Split cache keys around their ISO instants: ISO timestamps themselves contain colons. */
function parseCacheKey(key: string): ParsedCacheKey | null {
  if (key.startsWith("report:v2:")) {
    const rest = key.slice("report:v2:".length);
    const stamps = rest.match(ISO_INSTANT) ?? [];
    const from = stamps.at(-2) ?? null;
    const to = stamps.at(-1) ?? null;
    const shopId = from ? rest.slice(0, rest.indexOf(from)).split(":")[0] ?? null : null;
    return { kind: "report", shopId, from, to };
  }
  if (key.startsWith("dashboard:v3:")) {
    const rest = key.slice("dashboard:v3:".length);
    const stamps = rest.match(ISO_INSTANT) ?? [];
    const from = stamps.at(-2) ?? null;
    const to = stamps.at(-1) ?? null;
    const shopId = from ? rest.slice(0, rest.indexOf(from)).split(":")[0] ?? null : null;
    return { kind: "dashboard", shopId, from, to };
  }
  if (key.startsWith("profitability:")) {
    const rest = key.slice("profitability:".length);
    const stamps = rest.match(ISO_INSTANT) ?? [];
    const from = stamps.at(-2) ?? null;
    const to = stamps.at(-1) ?? null;
    const shopId = from ? rest.slice(0, rest.indexOf(from)).split(":")[0] ?? null : null;
    return { kind: "profitability", shopId, from, to };
  }
  if (key.startsWith("sale:")) {
    const parts = key.split(":");
    return { kind: "saleDetail", shopId: parts[1] ?? null, from: null, to: null };
  }
  if (key.startsWith("offline:archive:")) {
    const parts = key.split(":");
    return { kind: "archiveMarker", shopId: parts[2] ?? null, from: null, to: null, markerMonth: parts[4] || undefined };
  }
  if (key.startsWith("offline.") || key.startsWith("policy:") || key.startsWith("dash.perms:") || key.startsWith("bizrev:")) {
    return { kind: "otherCache", shopId: null, from: null, to: null };
  }
  return null;
}

/** Parse a cache key without reading its payload. Sale details use their payload timestamp separately. */
export function classifyCacheKey(key: string, shopId: string | null, parsed?: any): CacheEntry | null {
  const parsedKey = parseCacheKey(key);
  if (!parsedKey) return null;
  const { kind, shopId: owner, from, to, markerMonth } = parsedKey;
  if (kind !== "archiveMarker" && kind !== "otherCache" && shopId && owner && owner !== shopId) return null;

  const fullMonth = !!from && !!to && isFullMonthRange({ from, to });
  const period = kind === "saleDetail"
    ? (typeof parsed?.period === "string" ? parsed.period : monthKeyOf(parsed?.detail?.sale?.at))
    : fullMonth && from ? monthKeyOf(from) : null;
  const savedAt = typeof parsed?.savedAt === "string" && !Number.isNaN(Date.parse(parsed.savedAt)) ? parsed.savedAt : null;
  const lastAccessAt = typeof parsed?.lastAccessAt === "string" && !Number.isNaN(Date.parse(parsed.lastAccessAt)) ? parsed.lastAccessAt : null;
  return { key, bytes: 0, savedAt, lastAccessAt, kind, shopId: owner, period, fullMonth, markerMonth };
}

export type RetentionPlanReason = "older-archive" | "expired-browsing" | "over-limit";

export interface RetentionPlan {
  remove: CacheEntry[];
  bytesFreed: number;
  reasons: RetentionPlanReason[];
  protectedBytes: number;
}

export interface RetentionInput {
  entries: CacheEntry[];
  settings: RetentionSettings;
  now?: number;
  /** Real free space, when the platform reports it. Low free space triggers automatic cleanup. */
  availableBytes?: number | null;
}

const currentKeys = (now: number) => ({
  month: periodRangeFor("thisMonth", new Date(now)),
  prevMonth: periodRangeFor("lastMonth", new Date(now)),
  year: periodRangeFor("thisYear", new Date(now)),
  prevYear: periodRangeFor("lastYear", new Date(now)),
});

function isProtectedRange(from: string | null, to: string | null, now: number): boolean {
  if (!from || !to) return false;
  const p = currentKeys(now);
  return [p.month, p.prevMonth, p.year, p.prevYear].some((r) => r.from === from && r.to === to);
}

function isProtectedEntry(e: CacheEntry, now: number, parsedRanges: Map<string, { from: string; to: string }>): boolean {
  // Recently opened history stays until the next cleanup window, even if its month is old.
  const accessed = Date.parse(e.lastAccessAt ?? "");
  if (Number.isFinite(accessed) && now - accessed < 60 * 60_000) return true;
  if (e.kind === "saleDetail") {
    const month = e.period;
    if (!month) return false;
    const current = kigaliDay(now).slice(0, 7);
    const previous = shiftMonth(current, -1);
    return month === current || month === previous;
  }
  const range = parsedRanges.get(e.key);
  return !!range && isProtectedRange(range.from, range.to, now);
}

/**
 * Decide which downloaded cache entries may be removed. The returned list never includes records,
 * outbox rows or small operational snapshots; callers can only delete these entries.
 */
export function planRetention(input: RetentionInput): RetentionPlan {
  const now = input.now ?? Date.now();
  const { settings } = input;
  const rangeMap = new Map<string, { from: string; to: string }>();
  for (const e of input.entries) {
    const parsed = parseCacheKey(e.key);
    if (parsed?.from && parsed.to) rangeMap.set(e.key, { from: parsed.from, to: parsed.to });
  }
  const removable = input.entries.filter((e) => e.kind === "report" || e.kind === "dashboard" || e.kind === "profitability" || e.kind === "saleDetail");
  const protectedEntries = removable.filter((e) => isProtectedEntry(e, now, rangeMap));
  const protectedBytes = protectedEntries.reduce((n, e) => n + e.bytes, 0);
  const candidates = removable.filter((e) => !protectedEntries.includes(e));
  const reasons = new Set<RetentionPlanReason>();
  let remove: CacheEntry[] = [];

  if (settings.mode === "recent" || settings.mode === "months12" || settings.mode === "months24") {
    const months = settings.mode === "recent" ? 3 : settings.mode === "months12" ? 12 : 24;
    const current = kigaliDay(now).slice(0, 7);
    const keepFrom = shiftMonth(current, -(months - 1));
    const browsingCutoff = settings.mode === "recent" ? 30 * 86_400_000 : 180 * 86_400_000;
    remove = candidates.filter((e) => {
      if (e.period) {
        const old = !!keepFrom && e.period < keepFrom;
        if (old) reasons.add("older-archive");
        return old;
      }
      const seen = Date.parse(e.lastAccessAt ?? e.savedAt ?? "");
      const expired = !Number.isFinite(seen) || now - seen > browsingCutoff;
      if (expired) reasons.add("expired-browsing");
      return expired;
    });
  } else {
    const limit = settings.limitMb * MB;
    const downloaded = input.entries
      .filter((e) => e.kind === "report" || e.kind === "dashboard" || e.kind === "profitability" || e.kind === "saleDetail")
      .reduce((n, e) => n + e.bytes, 0);
    const lowDeviceSpace = input.availableBytes !== null && input.availableBytes !== undefined && input.availableBytes < 100 * MB;
    if (downloaded > limit || lowDeviceSpace) {
      reasons.add("over-limit");
      const target = lowDeviceSpace ? Math.max(0, downloaded - 50 * MB) : Math.floor(limit * 0.8);
      let remaining = downloaded;
      const ordered = [...candidates].sort((a, b) => {
        const ap = a.period ?? "9999-99";
        const bp = b.period ?? "9999-99";
        if (ap !== bp) return ap.localeCompare(bp); // oldest months first
        return Date.parse(a.lastAccessAt ?? a.savedAt ?? "0") - Date.parse(b.lastAccessAt ?? b.savedAt ?? "0");
      });
      for (const e of ordered) {
        if (remaining <= target) break;
        remove.push(e);
        remaining -= e.bytes;
      }
    }
  }

  const seen = new Set<string>();
  remove = remove.filter((e) => (seen.has(e.key) ? false : (seen.add(e.key), true)));
  return { remove, bytesFreed: remove.reduce((n, e) => n + e.bytes, 0), reasons: [...reasons], protectedBytes };
}

export type StorageLevel = "normal" | "warning" | "critical";

/** Both the configured cache ceiling and real free space can make storage unsafe. */
export function storageLevel(downloadedBytes: number, limitMb: number, availableBytes: number | null): StorageLevel {
  if (availableBytes !== null && availableBytes < 100 * MB) return "critical";
  if (limitMb > 0 && downloadedBytes >= limitMb * MB * 0.95) return "critical";
  if (availableBytes !== null && availableBytes < 250 * MB) return "warning";
  if (limitMb > 0 && downloadedBytes >= limitMb * MB * 0.7) return "warning";
  return "normal";
}

/** Human-readable file size; the UI never prints raw byte values. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "—";
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < MB) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * MB) return `${(n / MB).toFixed(n < 10 * MB ? 1 : 0)} MB`;
  return `${(n / (1024 * MB)).toFixed(1)} GB`;
}
