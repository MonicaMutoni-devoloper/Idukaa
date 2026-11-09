import Constants from "expo-constants";
import NetInfo from "@react-native-community/netinfo";
import { AppState } from "react-native";
import { create } from "zustand";
import { request } from "./api";
import { kvGet, kvSet } from "../database";
import { decideUpdate, shouldCheck, UPDATE_CHECK_INTERVAL_MS, type UpdateManifest, type UpdateVerdict } from "./app-update";

/**
 * Update checks, deliberately cheap and non-blocking:
 *  - at start, when the app returns to the foreground and when connectivity returns;
 *  - at most every UPDATE_CHECK_INTERVAL_MS automatically — a foreground bounce is not a reason to
 *    call the server again (the sync engine already keeps the connection busy);
 *  - never on the critical path: any failure keeps the last known verdict and the app keeps working.
 *
 * Queued work is never touched. Installing a new APK replaces only the code: SQLite and the outbox
 * live in the app's data directory, which Android preserves across an update.
 */
const LAST_CHECK_KEY = "update.checked_at";

export const installedApp = () => ({
  version: Constants.expoConfig?.version ?? "0.0.0",
  versionCode: Number(Constants.expoConfig?.android?.versionCode ?? 0),
});

export const useAppUpdate = create<{
  verdict: UpdateVerdict;
  checking: boolean;
  checkedAt: number | null;
  error: boolean;
}>(() => ({ verdict: { kind: "up-to-date" }, checking: false, checkedAt: null, error: false }));

let inFlight: Promise<void> | null = null;

/** `force` is the user asking explicitly: it bypasses the throttle but never overlaps a running check. */
export function checkForUpdates(force = false): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const last = Number((await kvGet(LAST_CHECK_KEY).catch(() => null)) ?? 0);
    if (!force && !shouldCheck(Date.now(), last, UPDATE_CHECK_INTERVAL_MS)) return;
    useAppUpdate.setState({ checking: true });
    try {
      const manifest = await request<UpdateManifest>("/app/version", { auth: false });
      const checkedAt = Date.now();
      useAppUpdate.setState({ verdict: decideUpdate(installedApp(), manifest), checkedAt, error: false });
      await kvSet(LAST_CHECK_KEY, String(checkedAt)).catch(() => {});
    } catch {
      // Offline, a server that predates this endpoint, or a cold-start 502: keep the last verdict.
      useAppUpdate.setState({ error: true });
    } finally {
      useAppUpdate.setState({ checking: false });
    }
  })().finally(() => { inFlight = null; });
  return inFlight;
}

let started = false;
/** Called once from the signed-in area; idempotent. */
export function startUpdateChecks(): void {
  if (started) return;
  started = true;
  void checkForUpdates();
  AppState.addEventListener("change", (state) => { if (state === "active") void checkForUpdates(); });
  NetInfo.addEventListener((state) => { if (state.isConnected) void checkForUpdates(); });
}
