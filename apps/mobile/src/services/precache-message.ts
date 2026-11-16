/**
 * The message the service worker posts while it saves the app for offline use.
 * Browser-free on purpose: the store imports it, and the tests import it without a DOM.
 */

export interface PrecacheProgress {
  done: number;
  total: number;
}

export const PRECACHE_MESSAGE = "idukaa-precache";

/** Accept only a well-formed message, clamped to its own total. Unknown data is ignored. */
export const readPrecacheMessage = (data: unknown): PrecacheProgress | null => {
  if (!data || typeof data !== "object") return null;
  const m = data as Record<string, unknown>;
  if (m.type !== PRECACHE_MESSAGE) return null;
  if (typeof m.done !== "number" || typeof m.total !== "number") return null;
  if (!Number.isFinite(m.done) || !Number.isFinite(m.total) || m.total <= 0) return null;
  const total = Math.round(m.total);
  return { done: Math.min(Math.max(Math.round(m.done), 0), total), total };
};
