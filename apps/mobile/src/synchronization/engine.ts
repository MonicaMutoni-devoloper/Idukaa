import NetInfo from "@react-native-community/netinfo";
import { AppState } from "react-native";
import { create } from "zustand";
import { ApiError, getDeviceId, request, useSession } from "../services/api";
import { applyPull, applyResults, dueOps, kvGet, kvSet, markRetry, outboxCounts, retryNow } from "../database";
import type { OpResult, PullResponse } from "@sms/shared";

export const useSync = create<{ online: boolean; running: boolean; pending: number; issues: number; awaitingApproval: number; authRequired: boolean; lastSync: string | null; dataVersion: number }>(() => ({ online: true, running: false, pending: 0, issues: 0, awaitingApproval: 0, authRequired: false, lastSync: null, dataVersion: 0 }));
export const refreshCounts = async () => { const u = useSession.getState().user; if (!u) return; const c = await outboxCounts(u.id); useSync.setState({ pending: c.pending, issues: c.issues, awaitingApproval: c.awaitingApproval }); };

let inFlight: Promise<void> | null = null;
let rerunRequested = false;

/** One sync pass: push due operations in order (batches of 50), apply verdicts, then pull incrementally until caught up. */
async function runPass(force: boolean): Promise<void> {
  // The access token is refreshed on demand by `request`; only a signed-out user or the platform
  // administrator (who has no shop data) skips syncing.
  const s = useSession.getState(); if (!s.user || s.user.role === "system_admin") return;
  useSync.setState({ running: true, authRequired: false });
  try {
    if (force) await retryNow(s.user.id);
    const deviceId = await getDeviceId();
    for (;;) {
      const due = await dueOps(s.user.id); if (!due.length) break;
      const ops = due.map(r => ({ opId: r.op_id, deviceId, createdAt: r.created_at, type: r.type, payload: JSON.parse(r.payload) }));
      try {
        const { results } = await request<{ results: OpResult[] }>("/sync/push", { method: "POST", body: { operations: ops } });
        await applyResults(results);
        // Refresh after every batch so any progress UI shows how much of the queue is really left
        // instead of guessing — the counts are a cheap local query and the pass refreshes again at the end.
        await refreshCounts();
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) { useSync.setState({ authRequired: true }); return; } // queue is kept intact
        await markRetry(due.map(r => r.op_id), e instanceof ApiError ? `server_${e.status}` : "network"); break; // backoff; try again later
      }
    }
    for (;;) { // pull
      const cp = await kvGet(`cp:${s.user.id}`);
      const r = await request<PullResponse>(`/sync/pull${cp ? `?checkpoint=${encodeURIComponent(cp)}` : ""}`);
      // Never write another account's rows: if the signed-in user (or the shop the local cache is
      // bound to) changed while this response was in flight, discard it instead of advancing the
      // checkpoint — the new session re-pulls from scratch via bindShop().
      const bound = await kvGet("local.shop");
      if (useSession.getState().user?.id !== s.user.id || (bound && bound !== s.user.shopId)) break;
      await applyPull(r.changes as any); await kvSet(`cp:${s.user.id}`, r.checkpoint);
      if (!r.hasMore) break;
    }
    const at = new Date().toISOString(); await kvSet("last_sync", at); useSync.setState((x) => ({ lastSync: at, dataVersion: x.dataVersion + 1 }));
  } catch (e) { if (e instanceof ApiError && e.status === 401) useSync.setState({ authRequired: true }); }
  finally { useSync.setState({ running: false }); await refreshCounts(); }
}

/**
 * A user press is never lost: when a pass is already running, `force` schedules one more pass that
 * first clears the retry backoff. Without this, pressing "Sync now" right after reconnecting could
 * be swallowed by the automatic pass that started at the same moment.
 */
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
}
