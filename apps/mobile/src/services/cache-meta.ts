import { kvGet, kvSet } from "../database";

/** One hour is enough to tell "recently used" from "untouched for months" without a write per read. */
export const CACHE_ACCESS_THROTTLE_MS = 60 * 60_000;

/**
 * Records that a downloaded cache entry was read. The write is best-effort and throttled: losing
 * an access marker must never break a report, and a cache shared by several screens must not turn
 * every render into a database write.
 */
export async function touchCacheAccess(key: string, raw?: string | null, now = Date.now()): Promise<void> {
  try {
    const text = raw ?? (await kvGet(key));
    if (!text) return;
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const previous = typeof parsed.lastAccessAt === "string" ? Date.parse(parsed.lastAccessAt) : NaN;
    if (Number.isFinite(previous) && now - previous < CACHE_ACCESS_THROTTLE_MS) return;
    parsed.lastAccessAt = new Date(now).toISOString();
    await kvSet(key, JSON.stringify(parsed));
  } catch {
    /* an unreadable entry is handled by the cache validator, not here */
  }
}

/** Metadata written whenever a downloaded entry is refreshed. */
export const cacheWriteMeta = (now = new Date().toISOString()) => ({
  lastRefreshAt: now,
  lastAccessAt: now,
});
