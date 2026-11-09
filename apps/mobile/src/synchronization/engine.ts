import NetInfo from "@react-native-community/netinfo";
import { AppState } from "react-native";
import { create } from "zustand";
import { ApiError, NetworkError, SYNC_TIMEOUT_MS, ensureSession, getDeviceId, request, sessionRejected, useSession } from "../services/api";
import { applyPull, applyResults, dueOps, kvGet, kvSet, markRetry, outboxCounts, productCount, resetSyncCursor, retryNow } from "../database";
import { failureMessage } from "./failure";
import { needsFullRepull, syncFailureCode } from "./catalogue";
import { startRealtime } from "./realtime";
import type { OpResult, PullResponse } from "@sms/shared";

/** `lastError` is a stable code (`network`, `server_<status>`) describing why the last pass failed,
 *  so an empty catalogue can say what is wrong instead of looking like an empty shop. */
export const useSync = create<{ online: boolean; /** The push channel is open: other devices' changes arrive without waiting for the poll. */ live: boolean; running: boolean; pending: number; issues: number; awaitingApproval: number; authRequired: boolean; lastSync: string | null; lastError: string | null; dataVersion: number; recordsVersion: number }>(() => ({ online: true, live: false, running: false, pending: 0, issues: 0, awaitingApproval: 0, authRequired: false, lastSync: null, lastError: null, dataVersion: 0, recordsVersion: 0 }));
/**
 * Refreshes the quality-of-sync counters AND bumps `recordsVersion`, the only signal the dashboard
 * listens to. It is called after every save and after every sync pass, so figures are recalculated
 * exactly when a record was added or its verdict changed — never on a timer of its own.
 */
export const refreshCounts = async () => {
  const u = useSession.getState().user; if (!u) return;
  const c = await outboxCounts(u.id);
  useSync.setState((x) => ({ pending: c.pending, issues: c.issues, awaitingApproval: c.awaitingApproval, recordsVersion: x.recordsVersion + 1 }));
};

let inFlight: Promise<void> | null = null;
let rerunRequested = false;

/** One sync pass: push due operations in order (batches of 50), apply verdicts, then pull incrementally until caught up. */
async function runPass(force: boolean): Promise<void> {
  // The access token is refreshed on demand by `request`; only a signed-out user or the platform
  // administrator (who has no shop data) skips syncing.
  const s = useSession.getState(); if (!s.user || s.user.role === "system_admin") return;
  // The refresh credential was rejected by the server: stop calling the API (which only produces
  // more 401s) and wait for a sign-in. The queue and every local record stay exactly as they are.
  if (s.expired) { useSync.setState({ authRequired: true }); return; }
  // After an offline reload (web) there is no access token yet: get one before touching the queue,
  // bypassing the per-request backoff because this is a single attempt per pass.
  if (!(await ensureSession(true))) {
    if (sessionRejected()) useSync.setState({ authRequired: true });
    return;
  }
  useSync.setState({ running: true, authRequired: false });
  try {
    if (force) await retryNow(s.user.id);
    const deviceId = await getDeviceId();
    for (;;) {
      const due = await dueOps(s.user.id); if (!due.length) break;
      const ops = due.map(r => ({ opId: r.op_id, deviceId, createdAt: r.created_at, type: r.type, payload: JSON.parse(r.payload) }));
      try {
        const { results } = await request<{ results: OpResult[] }>("/sync/push", { method: "POST", body: { operations: ops }, timeoutMs: SYNC_TIMEOUT_MS });
        await applyResults(results);
        // Refresh after every batch so any progress UI shows how much of the queue is really left
        // instead of guessing — the counts are a cheap local query and the pass refreshes again at the end.
        await refreshCounts();
      } catch (e) {
        // Only a rejected credential needs the user to sign in; a token that is merely not available
        // yet (offline reload, refresh backing off) keeps the queue and retries on the next pass.
        if (e instanceof ApiError && e.status === 401 && sessionRejected()) { useSync.setState({ authRequired: true }); return; }
        // A 503 `schema_out_of_date` is recorded with the migration the server named, so the sync
        // screen can say "server update required" instead of showing a bare `server_503`.
        await markRetry(due.map(r => r.op_id), e instanceof ApiError ? failureMessage(e.status, e.body) : "network"); break; // backoff; try again later
      }
    }
    let healed = false;
    for (;;) { // pull
      const cp = await kvGet(`cp:${s.user.id}`);
      const r = await request<PullResponse>(`/sync/pull${cp ? `?checkpoint=${encodeURIComponent(cp)}` : ""}`, { timeoutMs: SYNC_TIMEOUT_MS });
      // Never write another account's rows: if the signed-in user (or the shop the local cache is
      // bound to) changed while this response was in flight, discard it instead of advancing the
      // checkpoint — the new session re-pulls from scratch via bindShop().
      const bound = await kvGet("local.shop");
      if (useSession.getState().user?.id !== s.user.id || (bound && bound !== s.user.shopId)) break;
      await applyPull(r.changes as any); await kvSet(`cp:${s.user.id}`, r.checkpoint);
      // "Nothing changed" while this device holds no products at all means the saved cursor is out
      // of step with the local rows (interrupted first pull, cache cleared by an older build, shop
      // re-bound mid-pull). Retrying can never repair that, so drop the cursor once and pull from
      // the start: the catalogue arrives, and the outbox is untouched.
      if (!healed && needsFullRepull({ productCount: await productCount(), hasCheckpoint: !!cp, productChanges: r.changes.filter((c: any) => c.entity === "product").length })) {
        healed = true; await resetSyncCursor(s.user.id); continue;
      }
      if (!r.hasMore) break;
    }
    const at = new Date().toISOString(); await kvSet("last_sync", at);
    useSync.setState((x) => ({ lastSync: at, lastError: null, dataVersion: x.dataVersion + 1 }));
  } catch (e) {
    // Never silent: a failed pull looks exactly like a shop with no stock unless it is reported.
    useSync.setState({ lastError: syncFailureCode(e, e instanceof ApiError ? e.status : undefined) });
    if (e instanceof ApiError && e.status === 401 && sessionRejected()) useSync.setState({ authRequired: true });
    else if (!(e instanceof ApiError) && !(e instanceof NetworkError)) console.warn("[sync] pass failed", e);
  }
  finally { useSync.setState({ running: false }); await refreshCounts(); }
}

/**
 * A user press is never lost: when a pass is already running, `force` schedules one more pass that
 * first clears the retry backoff. Without this, pressing "Sync now" right after reconnecting could
 * be swallowed by the automatic pass that started at the same moment.
 */
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

export function syncNow(force = false): Promise<void> {
  if (inFlight) {
    if (force) rerunRequested = true;
    return inFlight;
  }
  inFlight = (async () => {
    let runForce = force;
    do {
      rerunRequested = false;
      await runPass(runForce);
      runForce = rerunRequested && useSync.getState().online;
    } while (runForce);
  })().finally(() => { inFlight = null; });
  return inFlight;
}

let started = false;
export function startSyncEngine() {
  if (started) return; started = true;
  kvGet("last_sync").then(v => useSync.setState({ lastSync: v }));
  NetInfo.addEventListener(st => { const online = !!st.isConnected && st.isInternetReachable !== false; useSync.setState({ online }); if (online) void syncNow(); });
  setInterval(() => { if (useSync.getState().online) void syncNow(); }, 30_000);
  AppState.addEventListener("change", s => { if (s === "active") void syncNow(); });
  // Signing in again (after an expired session) resumes the queue immediately — the work recorded
  // while signed out was never discarded, so this is the only recovery step a user needs to take.
  useSession.subscribe((s, prev) => { if (s.token && !prev.token) void syncNow(); });
  // Push channel. It never carries data: a change frame simply runs the pass above, so the poll
  // remains a complete fallback and a missed frame cannot desynchronise a device.
  startRealtime({ onChange: () => void syncNow(), onStatus: (live) => useSync.setState({ live }) });
}
