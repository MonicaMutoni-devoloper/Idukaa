/**
 * Reading the offline install's state from /sw-assets.json and the shell cache.
 *
 * Browser-free on purpose (the tests import it under Node). The app counts what the worker has
 * already saved instead of waiting for a message from it: WebKit does not reliably deliver a
 * worker's `postMessage` while it installs, and "how much of the app is saved" is exactly the number
 * of entries in the shell cache.
 */

export interface PrecacheProgress {
  done: number;
  total: number;
}

/** What the build wrote: the files to save, and the cache name they are saved in. */
export interface PrecacheManifest {
  cache: string;
  total: number;
}

export const readPrecacheManifest = (body: unknown): PrecacheManifest | null => {
  if (!body || typeof body !== "object") return null;
  const m = body as Record<string, unknown>;
  if (typeof m.cache !== "string" || !m.cache) return null;
  if (!Array.isArray(m.assets) || m.assets.length === 0) return null;
  return { cache: m.cache, total: m.assets.length };
};

/**
 * Clamp a saved-entry count to the manifest's total. A count above the total is normal (the shell
 * page, icons and launch bundle are saved before the manifest pass), so it is not an error.
 */
export const describeProgress = (cached: unknown, total: unknown): PrecacheProgress | null => {
  if (typeof cached !== "number" || typeof total !== "number") return null;
  if (!Number.isFinite(cached) || !Number.isFinite(total) || total <= 0) return null;
  const whole = Math.round(total);
  return { done: Math.min(Math.max(Math.round(cached), 0), whole), total: whole };
};
