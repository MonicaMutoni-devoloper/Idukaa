/**
 * When an empty catalogue means "this device never received the stock list", not "the shop has no
 * products".
 *
 * The pull is incremental: the server sends only rows newer than the checkpoint saved on this
 * device. That is correct until the local rows and the cursor get out of step — an interrupted
 * first pull, a cache cleared by an older build, a shop re-bound mid-pull. From then on every pull
 * legitimately answers "nothing changed", so the product list stays empty while the web app shows
 * the whole catalogue, and no amount of retrying fixes it.
 *
 * The repair is a full re-pull: drop the cursor once and ask from the beginning. It is safe because
 * the pull is idempotent (rows are upserted by id) and the outbox is never touched, so unsynced work
 * survives. Kept free of React Native and database imports so the rule can be tested on plain Node.
 */
export interface CatalogueState {
  /** Products currently stored on this device. */
  productCount: number;
  /** A pull cursor was used for this request (so "no changes" is a cursor answer, not a first pull). */
  hasCheckpoint: boolean;
  /** Product rows in the response. */
  productChanges: number;
}

/**
 * True when the response says "nothing new" while the device holds no products at all: the cursor
 * cannot be trusted, so the caller must clear it and pull from the start exactly once.
 */
export function needsFullRepull(state: CatalogueState): boolean {
  return state.productCount === 0 && state.hasCheckpoint && state.productChanges === 0;
}

/**
 * Stable, translatable code for the last failed sync attempt. The UI renders words; the store keeps
 * a code so a failure is never shown as a bare HTTP status and never invented.
 *
 * The code has to separate causes the user can act on differently: a sleeping server (wait), an
 * expired session (sign in), a slow response (wait), a throttle (wait), a rejection (review) or a
 * device that cannot write (free space). All of them used to read "the server could not answer",
 * which is why a fixable problem looked like a server that had been down for days.
 */
export type SyncFailureCode =
  | "network" | "timeout" | "storage" | "auth" | "rate_limited" | "unavailable" | "unexpected" | `server_${number}`;

export function syncFailureCode(error: unknown, apiStatus?: number): SyncFailureCode {
  if (apiStatus !== undefined) {
    // `server_503` also covers an out-of-date server database; the sync screen names that case
    // through the stored outbox message, so this code stays the generic answer for pull failures.
    if (apiStatus === 401 || apiStatus === 403) return "auth";
    if (apiStatus === 429) return "rate_limited";
    if (apiStatus === 408 || apiStatus === 504) return "timeout";
    // 502/503 from the gateway are how a sleeping or restarting instance looks; 500 is not, because
    // the server answered and the failure is ours to fix.
    if (apiStatus === 502 || apiStatus === 503) return "unavailable";
    return `server_${apiStatus}`;
  }
  const e = error as { name?: string; code?: string; message?: string } | null;
  if (e?.name === "NetworkError") return e.message === "timeout" ? "timeout" : "network";
  // The browser refusing a write because the origin is out of quota looks exactly like "no
  // internet" to a user, but waiting never helps and reloading loses what was just downloaded.
  if (e?.name === "QuotaExceededError" || /quota|storage full/i.test(`${e?.name ?? ""} ${e?.message ?? ""}`)) return "storage";
  // A failed write on this device is NOT a server problem, and saying so sends the user (and the
  // next debugging session) after the wrong cause. SQLite reports statement errors as
  // ERR_INTERNAL_SQLITE_ERROR with the reason in the message (e.g. "13 values for 14 columns").
  if (e?.code === "ERR_INTERNAL_SQLITE_ERROR" || /sqlite|values for \d+ columns/i.test(`${e?.name ?? ""} ${e?.message ?? ""}`)) return "storage";
  return "unexpected";
}
