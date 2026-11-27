import NetInfo from "@react-native-community/netinfo";
import { AppState } from "react-native";
import { create } from "zustand";
import { ApiError, NetworkError, SYNC_TIMEOUT_MS, ensureSession, getDeviceId, request, sessionRejected, useSession } from "../services/api";
import { applyPull, applyResults, dueOps, kvGet, kvSet, markRetry, outboxCounts, productCount, resetSyncCursor, retryNow } from "../database";
import { failureMessage } from "./failure";
import { needsFullRepull, syncFailureCode } from "./catalogue";
import { nextStreak, retryDelay, type PassOutcome } from "./backoff";
import { startRealtime } from "./realtime";
import { queueOfflinePreparation } from "../services/offline-data";
import type { OpResult, PullResponse } from "@sms/shared";

/** `lastError` is a stable code (`network`, `server_<status>`) describing why the last pass failed,
 *  so an empty catalogue can say what is wrong instead of looking like an empty shop. */
export const useSync = create<{
  online: boolean;
  /** The push channel is open: other devices' changes arrive without waiting for the poll. */ live: boolean;
  running: boolean; pending: number; issues: number; awaitingApproval: number; authRequired: boolean;
  lastSync: string | null; lastError: string | null;
  /** Epoch ms of the last attempt and of the next scheduled automatic one, for honest feedback. */
  lastAttemptAt: number | null; retryAt: number | null;
  /** Catalogue rows changed (sell/stock screens). */ dataVersion: number;
  /** Local records or outbox verdicts changed (offline figures). */ recordsVersion: number;
  /** A pull observed a new dashboard-visible business revision (server figures). */ businessVersion: number;
}>(() => ({ online: true, live: false, running: false, pending: 0, issues: 0, awaitingApproval: 0, authRequired: false, lastSync: null, lastError: null, lastAttemptAt: null, retryAt: null, dataVersion: 0, recordsVersion: 0, businessVersion: 0 }));
/**
 * Refreshes the quality-of-sync counters and, when a verdict or queue size changed, bumps
 * `recordsVersion` so reports recalculate without reopening the screen. `forceVersion` is used once
 * at the end of a pass: a pull can change server-side rows (another device's sale/expense) without
 * changing any local outbox count, and the visible figures still need to reconcile.
 */
export const refreshCounts = async (localChanged = false) => {
  const u = useSession.getState().user; if (!u) return;
  const c = await outboxCounts(u.id, u.shopId);
  useSync.setState((x) => {
    const countsChanged = c.pending !== x.pending || c.issues !== x.issues || c.awaitingApproval !== x.awaitingApproval;
    if (!countsChanged && !localChanged) return x;
    return { pending: c.pending, issues: c.issues, awaitingApproval: c.awaitingApproval, recordsVersion: x.recordsVersion + 1 };
  });
};

let inFlight: Promise<void> | null = null;
let rerunRequested = false;
/** Consecutive failed passes; reset the moment one succeeds, so recovery is immediate. */
let failureStreak = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

/** The one place a delayed retry is scheduled, so a burst of failures never arms several timers. */
function scheduleRetry(delay: number) {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    // Offline: the reconnect listener starts the next pass as soon as there is a connection.
    if (!useSync.getState().online) return;
    if (inFlight) { rerunRequested = true; return; }
    void syncNow();
  }, delay);
}

/** A pass that got through (or a user asking now) cancels the wait: there is nothing to back off from. */
function clearRetry() {
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  if (useSync.getState().retryAt !== null) useSync.setState({ retryAt: null });
}

/** One queued operation as the store returns it; only the fields needed to build a push are named. */
type Queued = { op_id: string; created_at: string; type: string; payload: string };

/**
 * The cause recorded for the screen. A 401 only means "sign in again" when the server actually
 * rejected the refresh credential; if getting one failed for a transport reason, the session is
 * fine and telling the user to sign in would be a dead end.
 */
function failureCodeOf(e: unknown) {
  const code = syncFailureCode(e, e instanceof ApiError ? e.status : undefined);
  return code === "auth" && !sessionRejected() ? "unavailable" : code;
}

/**
 * Push one batch. A batch the server refuses as too large can never succeed as it stands, and
 * retrying it unchanged is what leaves a queue stuck for ever; halving it finds the operations
 * that do fit and isolates the single one that does not. Every verdict is applied here, so a
 * partially delivered batch still moves forward.
 *
 * `incomplete` means the server answered fewer operations than were sent: it stopped at one it
 * could not process. The rest were held by `applyResults` (they stay behind that operation in the
 * queue), and the pass must not treat the quiet queue as a success.
 */
type Chunk = { failure: unknown | null; incomplete: boolean };

async function pushChunk(rows: Queued[], deviceId: string): Promise<Chunk> {
  const ops = rows.map(r => ({ opId: r.op_id, deviceId, createdAt: r.created_at, type: r.type, payload: JSON.parse(r.payload) }));
  try {
    const { results } = await request<{ results: OpResult[] }>("/sync/push", { method: "POST", body: { operations: ops }, timeoutMs: SYNC_TIMEOUT_MS });
    await applyResults(results);
    // Refresh after every batch so any progress UI shows how much of the queue is really left
    // instead of guessing — the counts are a cheap local query and the pass refreshes again at the end.
    await refreshCounts();
    return { failure: null, incomplete: results.length < ops.length };
  } catch (e) {
    if (e instanceof ApiError && (e.status === 413 || e.status === 415 || e.status === 431) && rows.length > 1) {
      const mid = Math.ceil(rows.length / 2);
      const first = await pushChunk(rows.slice(0, mid), deviceId);
      return first.failure ? first : pushChunk(rows.slice(mid), deviceId);
    }
    return { failure: e, incomplete: false };
  }
}
// Set by any pass that observed a new business revision. It is published once, after the queued
// rerun has also finished, so a burst of realtime events produces one dashboard invalidation.
let businessChangePending = false;

/**
 * One sync pass: push due operations in order (batches of 50), apply verdicts, then pull
 * incrementally until caught up. Returns how it ended, so the caller can decide whether to retry
 * soon, back off, or stop asking (a signed-out user has nothing to retry).
 */
async function runPass(force: boolean): Promise<PassOutcome> {
  // The access token is refreshed on demand by `request`; only a signed-out user or the platform
  // administrator (who has no shop data) skips syncing.
  const s = useSession.getState(); if (!s.user || s.user.role === "system_admin") return "ok";
  // The refresh credential was rejected by the server: stop calling the API (which only produces
  // more 401s) and wait for a sign-in. The queue and every local record stay exactly as they are.
  if (s.expired) { useSync.setState({ authRequired: true }); return "ok"; }
  // After an offline reload (web) there is no access token yet: get one before touching the queue,
  // bypassing the per-request backoff because this is a single attempt per pass.
  if (!(await ensureSession(true))) {
    if (sessionRejected()) { useSync.setState({ authRequired: true }); return "ok"; }
    // The session may still be perfectly valid: the server was unreachable while getting a token.
    return "failed";
  }
  useSync.setState({ running: true, authRequired: false, lastAttemptAt: Date.now() });
  let pulled = false;
  // Set when a batch could not be pushed. A push failure used to be invisible at pass level (only
  // the per-row message changed), so the screen could show a fresh "last sync" while the queue sat
  // still; it is now the pass's error, with the cause the server actually gave.
  let pushError: unknown = null;
  try {
    if (force) await retryNow(s.user.id, s.user.shopId);
    const deviceId = await getDeviceId();
    let drained = false;
    // A malformed/lost response must not turn into an endless hot loop. If a very large queue is
    // still due after 100 batches, leave the rest for the next scheduled pass; every pushed
    // operation is already durable and idempotent.
    for (let batch = 0; batch < 100; batch++) {
      const due = await dueOps(s.user.id, s.user.shopId) as Queued[]; if (!due.length) { drained = true; break; }
      const { failure, incomplete } = await pushChunk(due, deviceId);
      // The server stopped at an operation it could not process. Everything from there on is held
      // with its own backoff, so this pass ends here instead of pushing later work out of order.
      if (incomplete) { drained = false; break; }
      if (failure) {
        // Only a rejected credential needs the user to sign in; a token that is merely not available
        // yet (offline reload, refresh backing off) keeps the queue and retries on the next pass.
        if (failure instanceof ApiError && failure.status === 401 && sessionRejected()) { useSync.setState({ authRequired: true }); return "ok"; }
        // A 503 `schema_out_of_date` is recorded with the migration the server named, so the sync
        // screen can say "server update required" instead of showing a bare `server_503`.
        await markRetry(
          due.map(r => r.op_id),
          failure instanceof ApiError ? failureMessage(failure.status, failure.body)
            : failure instanceof NetworkError && failure.message === "timeout" ? "timeout" : "network",
        );
        pushError = failure;
        break;
      }
    }
    let healed = false;
    let serverRevision: string | undefined;
    let pages = 0;
    for (;;) { // pull
      // A server that keeps answering "hasMore" (or a cursor that does not advance) must not hold
      // the single in-flight pass for ever: manual retries and the poll would queue behind it and
      // appear to do nothing. Stop and let the next pass continue from the saved checkpoint.
      if (++pages > 200) break;
      const cp = await kvGet(`cp:${s.user.id}`);
      const r = await request<PullResponse>(`/sync/pull${cp ? `?checkpoint=${encodeURIComponent(cp)}` : ""}`, { timeoutMs: SYNC_TIMEOUT_MS });
      // Never write another account's rows: if the signed-in user (or the shop the local cache is
      // bound to) changed while this response was in flight, discard it instead of advancing the
      // checkpoint — the new session re-pulls from scratch via bindShop().
      const bound = await kvGet("local.shop");
      if (useSession.getState().user?.id !== s.user.id || (bound && bound !== s.user.shopId)) break;
      await applyPull(r.changes as any); await kvSet(`cp:${s.user.id}`, r.checkpoint);
      if (r.changes.length > 0) pulled = true;
      if (r.revision) serverRevision = r.revision;
      // "Nothing changed" while this device holds no products at all means the saved cursor is out
      // of step with the local rows (interrupted first pull, cache cleared by an older build, shop
      // re-bound mid-pull). Retrying can never repair that, so drop the cursor once and pull from
      // the start: the catalogue arrives, and the outbox is untouched.
      if (!healed && needsFullRepull({ productCount: await productCount(), hasCheckpoint: !!cp, productChanges: r.changes.filter((c: any) => c.entity === "product").length })) {
        healed = true; await resetSyncCursor(s.user.id); continue;
      }
      if (!r.hasMore) break;
    }
    // `pulled` now means "something local changed", not "the request succeeded". A successful
    // no-op pull must not invalidate every screen; that was the dashboard reload loop.
    let businessChanged = false;
    if (serverRevision !== undefined) {
      const revKey = `bizrev:${s.user.shopId ?? "none"}`;
      const previous = await kvGet(revKey);
      businessChanged = previous !== serverRevision;
      if (businessChanged) await kvSet(revKey, serverRevision);
    } else {
      // Older API: without a revision, only real pulled rows are proof of a change.
      businessChanged = pulled;
    }
    const at = new Date().toISOString(); await kvSet("last_sync", at);
    useSync.setState((x) => ({
      lastSync: at,
      // A successful pull does not excuse a queue that could not be pushed: the pass reports what
      // actually happened, and the cause is the one the push received, not "server" by default.
      lastError: pushError ? failureCodeOf(pushError) : null,
      dataVersion: pulled ? x.dataVersion + 1 : x.dataVersion,
    }));
    if (businessChanged) businessChangePending = true;
    if (pushError) return "failed";
    // Automatic offline preparation follows a successful pass, throttled inside the service so the
    // 30-second poll never becomes a full-report download loop.
    queueOfflinePreparation(pulled || businessChanged);
    return drained ? "ok" : "incomplete";
  } catch (e) {
    // Never silent: a failed pull looks exactly like a shop with no stock unless it is reported.
    useSync.setState({ lastError: failureCodeOf(e) });
    if (e instanceof ApiError && e.status === 401 && sessionRejected()) useSync.setState({ authRequired: true });
    else if (!(e instanceof ApiError) && !(e instanceof NetworkError)) console.warn("[sync] pass failed", e);
    return "failed";
  }
  finally { useSync.setState({ running: false }); await refreshCounts(pulled); }
}

/**
 * Manual recovery for "the server has my products but this device shows none": forget the
 * incremental cursor and pull the whole catalogue again. Safe at any time — the pull upserts by id,
 * and the outbox, records and queued sales are never part of it.
 */
export async function fullResync(): Promise<void> {
  const u = useSession.getState().user; if (!u) return;
  await resetSyncCursor(u.id);
  await syncNow(true);
}

/**
 * A user press is never lost: when a pass is already running, `force` schedules one more pass that
 * first clears the retry backoff. Without this, pressing "Sync now" right after reconnecting could
 * be swallowed by the automatic pass that started at the same moment.
 *
 * The returned promise settles when the work (including the follow-up pass) is finished, so the
 * screen can await a real attempt and report its outcome instead of only changing a label.
 */
export function syncNow(force = false): Promise<void> {
  if (inFlight) {
    if (force) rerunRequested = true;
    return inFlight;
  }
  // A press is a fresh start: drop the backoff so the attempt is not delayed by it.
  if (force) { failureStreak = 0; clearRetry(); }
  inFlight = (async () => {
    let runForce = force;
    do {
      rerunRequested = false;
      const outcome = await runPass(runForce);
      failureStreak = nextStreak(failureStreak, outcome);
      if (outcome === "ok") clearRetry();
      else {
        // Every failure schedules its own next attempt, further away each time. The poll below still
        // runs, but a sleeping server no longer gets hit by every device every 30 seconds.
        const delay = retryDelay(failureStreak || 1);
        useSync.setState({ retryAt: Date.now() + delay });
        scheduleRetry(delay);
      }
      runForce = rerunRequested && useSync.getState().online;
    } while (runForce);
  })().finally(() => {
    // Publish only now: all coalesced passes have written the same latest state, so the dashboard
    // reconciles once instead of once per event.
    if (businessChangePending) {
      businessChangePending = false;
      useSync.setState((x) => ({ businessVersion: x.businessVersion + 1 }));
    }
    inFlight = null;
  });
  return inFlight;
}

/**
 * A realtime frame can arrive while a pass is already running. In that case the normal de-duplicating
 * `syncNow()` would return the in-flight pass and the new event would be missed until the next poll.
 * A nudge schedules exactly one extra pass after the current one, without pressing the manual
 * "clear backoff" path. The pass's pull is what bumps the screen revision, so one remote change
 * costs one reconciliation rather than one immediate reload plus another after the pull.
 */
export function nudgeSync() {
  if (inFlight) { rerunRequested = true; return; }
  void syncNow();
}

let started = false;
let lastPoll = 0;
export function startSyncEngine() {
  if (started) return; started = true;
  kvGet("last_sync").then(v => useSync.setState({ lastSync: v }));
  NetInfo.addEventListener(st => {
    const online = !!st.isConnected && st.isInternetReachable !== false;
    useSync.setState({ online });
    // Coming back online is the one moment a wait makes no sense: try immediately and reset the
    // schedule, so reconnecting after an outage recovers at once instead of after the backoff.
    if (online) { failureStreak = 0; clearRetry(); void syncNow(); }
  });
  // The realtime channel already delivers changes instantly. When it is healthy, a 30-second full
  // pass is wasted battery/data, so keep a five-minute safety poll; without it, poll normally.
  setInterval(() => {
    if (!useSync.getState().online) return;
    // A retry is already scheduled at a time chosen by the backoff; polling through it would make
    // the schedule meaningless and hammer a server that is still starting up.
    if (useSync.getState().retryAt) return;
    const live = useSync.getState().live;
    if (live && Date.now() - lastPoll < 5 * 60_000) return;
    lastPoll = Date.now();
    void syncNow();
  }, 30_000);
  AppState.addEventListener("change", s => { if (s === "active") void syncNow(); });
  // Signing in again (after an expired session) resumes the queue immediately — the work recorded
  // while signed out was never discarded, so this is the only recovery step a user needs to take.
  useSession.subscribe((s, prev) => { if (s.token && !prev.token) void syncNow(); });
  // Push channel. It never carries data: a change frame runs the same pass above, so the poll
  // remains a complete fallback and a missed frame cannot desynchronise a device.
  startRealtime({ onChange: nudgeSync, onStatus: (live) => useSync.setState({ live }) });
}
