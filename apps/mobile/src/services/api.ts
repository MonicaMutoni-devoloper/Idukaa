import { Platform } from "react-native";
import Constants from "expo-constants";
import * as SecureStore from "expo-secure-store";
import { create } from "zustand";
import { bindShop, kvGet } from "../database";
import { refreshVerdict } from "./session-policy";

/**
 * Web talks to localhost. A phone in Expo Go cannot: `localhost` is the phone itself,
 * so derive the API host from the Metro dev-server URL (e.g. 192.168.1.10:8081).
 * An explicit, non-loopback EXPO_PUBLIC_API_URL always wins (needed for tunnels/production).
 */
function resolveApiUrl(): string {
  const fromEnv = process.env.EXPO_PUBLIC_API_URL;
  const loopback = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/i.test(fromEnv ?? "");
  if (Platform.OS === "web" || (fromEnv && !loopback)) return fromEnv ?? "http://localhost:3000";
  const hostUri = Constants.expoConfig?.hostUri;
  const host = hostUri?.replace(/^[a-z]+:\/\//i, "").split(":")[0];
  return host ? `http://${host}:3000` : fromEnv ?? "http://localhost:3000";
}
export const API_URL = resolveApiUrl();
export interface SessionUser { id: string; name: string; role: "owner" | "manager" | "system_admin"; shopId: string | null }
export interface SessionResponse { token: string; refreshToken?: string; expiresIn: number; user: SessionUser }
export interface TwoFactorRequired { twoFactorRequired: true; challengeToken: string; expiresIn: number }

/**
 * Token storage:
 *  - Native (Android/iOS): access token AND refresh token in SecureStore (Android Keystore).
 *  - Web: the refresh token never reaches JavaScript. The server sets it as an HttpOnly, SameSite=Strict
 *    cookie; the browser keeps only the short-lived access token in memory and re-exchanges the cookie
 *    after a reload. Nothing long-lived is written to localStorage.
 */
const WEB = Platform.OS === "web";
const ACCESS_KEY = "token";
const REFRESH_KEY = "refresh_token";
const USER_KEY = "user";
// The API sleeps on Render's free tier; a cold first request regularly takes 10-15s. Timing out
// mid-rotation is what loses the rotated cookie, so the refresh gets more room than a normal call.
const REFRESH_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 20_000;
// Sync is background work with its own retry/backoff, so it can afford to wait longer than a screen
// that a person is staring at. Measured on the production API: a sleeping free-tier instance took
// 32.9 s to answer its first request, which the 20 s default aborted — the pass then reported "no
// internet" while the phone was online, and the catalogue never arrived. A failed pass is retried;
// a pass cut off mid-download is not.
export const SYNC_TIMEOUT_MS = 60_000;
const REFRESH_BACKOFF_MS = 15_000;

let accessToken: string | null = null;
let challengeToken: string | null = null;
let refreshInFlight: Promise<boolean> | null = null;
/** Definitive rejection from the server: stop automatic refresh until the user signs in again. */
let refreshBlocked = false;
/** Transport/offline failure: wait a moment before the next automatic attempt (never a loop). */
let refreshRetryAt = 0;

const storage = {
  async get(key: string): Promise<string | null> {
    if (WEB) return typeof localStorage === "undefined" ? null : localStorage.getItem(key);
    try {
      return await SecureStore.getItemAsync(key);
    } catch (e) {
      console.warn("[storage] SecureStore read failed", key, e);
      return null;
    }
  },
  async set(key: string, value: string) {
    if (WEB) { if (typeof localStorage !== "undefined") localStorage.setItem(key, value); return; }
    try {
      await SecureStore.setItemAsync(key, value);
    } catch (e) {
      console.warn("[storage] SecureStore write failed", key, e);
    }
  },
  async del(key: string) {
    if (WEB) { if (typeof localStorage !== "undefined") localStorage.removeItem(key); return; }
    try {
      await SecureStore.deleteItemAsync(key);
    } catch (e) {
      console.warn("[storage] SecureStore delete failed", key, e);
    }
  },
};

const readCookie = (name: string): string | null => {
  if (!WEB || typeof document === "undefined") return null;
  for (const part of document.cookie.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
};

export class ApiError extends Error {
  constructor(public status: number, public body: any) {
    // Nest sends `{ error: "Bad Request", message: "at least 10 characters" }` for a plain string
    // exception, and `{ error: "invalid_credentials" }` for named errors. Prefer the meaningful one.
    const named = typeof body?.error === "string" && body.error !== "Bad Request" ? body.error : null;
    super(named ?? (typeof body?.message === "string" ? body.message : `HTTP ${status}`));
  }
}
// Named so failures the app reports can say "no internet" instead of a generic error: the sync store
// stores this name as its failure code (see synchronization/catalogue.ts).
export class NetworkError extends Error {
  constructor(message = "network_unavailable") { super(message); this.name = "NetworkError"; }
}

export interface RequestOptions { method?: string; body?: unknown; auth?: boolean; timeoutMs?: number; signal?: AbortSignal }

async function fetchJson<T>(path: string, o: RequestOptions, timeoutMs = o.timeoutMs ?? REQUEST_TIMEOUT_MS): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (o.auth !== false && accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const csrf = WEB ? readCookie("sms_csrf") : null;
  // On a cross-site deployment (web on one domain, API on another) the browser refuses to expose the
  // API's cookie to JavaScript, so its value is unknowable here. The header must still be present:
  // the API then trusts its own Origin allow-list instead of a double submit it could never verify.
  if (csrf) headers["x-csrf-token"] = csrf;
  else if (WEB) headers["x-csrf-token"] = "1";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const forwardAbort = () => controller.abort();
  o.signal?.addEventListener("abort", forwardAbort);
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: o.method ?? "GET",
      headers,
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
      signal: controller.signal,
      credentials: WEB ? "include" : "omit",
    });
  } catch {
    throw new NetworkError(o.signal?.aborted ? "download_cancelled" : "network_unavailable");
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener("abort", forwardAbort);
  }

  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

async function adopt(session: SessionResponse) {
  accessToken = session.token;
  refreshBlocked = false;
  refreshRetryAt = 0;
  if (!WEB) {
    await storage.set(ACCESS_KEY, session.token);
    if (session.refreshToken) await storage.set(REFRESH_KEY, session.refreshToken);
  }
  await storage.set(USER_KEY, JSON.stringify(session.user));
  // Before the UI can render: scope the local cache to this user's shop, so no leftovers from a
  // previously signed-in account are ever shown (and a switch triggers a clean re-pull).
  await bindShop(session.user.shopId);
  useSession.setState({ token: session.token, user: session.user, expired: false });
}

/**
 * Only a 401/403 in which the server actually examined a credential proves that credential is dead.
 * Everything else — a 429 from the throttle, a Render 502/503 during a cold start, a 500 while the
 * database reconnects, or a 401 saying no credential arrived at all — says nothing about the session.
 * The rule lives in `session-policy.ts` so it can be unit-tested on its own.
 */
const rejected = (e: ApiError) => refreshVerdict(e.status, e.body) === "rejected";

/** The server rejected the refresh credential: the session is over until a new sign-in. */
function blockSession(status: number, reason: string) {
  refreshBlocked = true;
  refreshRetryAt = 0;
  // Safe diagnostic: never a token, only the verdict and HTTP status (categories match the API logs).
  console.warn("[auth] refresh rejected", { status, reason });
  useSession.getState().expire();
}

/** A refresh that failed for a reason unrelated to the credential: back off, keep the session. */
function deferRefresh(status: number) {
  refreshRetryAt = Date.now() + REFRESH_BACKOFF_MS;
  console.warn("[auth] refresh deferred", { status });
}

const refreshOnce = (body: Record<string, unknown>) =>
  fetchJson<SessionResponse>("/auth/refresh", { method: "POST", body, auth: false }, REFRESH_TIMEOUT_MS);

/**
 * One refresh at a time, and never a loop.
 *  - Concurrent 401s (dashboard + reports + sync at once) share the same rotation.
 *  - A definitive rejection (401/403) stops automatic refresh until login, preserves the outbox and
 *    flips the session to "expired" so the UI asks for a sign-in instead of reporting a network error.
 *  - A transport failure backs off; the session may still be perfectly valid, so it is not expired.
 *  - A lost response is retried once: the server's reuse grace window makes the retry safe (if the
 *    rotation did happen, the retry picks up the live successor instead of revoking the family).
 */
function refreshSession(force = false): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  if (refreshBlocked) return Promise.resolve(false);
  // `force` is used by the sync pass: one attempt per pass, not per request, so the backoff must not
  // swallow it (an offline reload leaves no access token and the queue would wait for nothing).
  if (!force && Date.now() < refreshRetryAt) return Promise.resolve(false);
  refreshInFlight = (async () => {
    try {
      let body: Record<string, unknown> = {};
      if (!WEB) {
        const stored = await storage.get(REFRESH_KEY);
        if (!stored) { blockSession(401, "missing_refresh_credential"); return false; }
        body = { refreshToken: stored };
      }
      let session: SessionResponse;
      try {
        session = await refreshOnce(body);
      } catch (e) {
        if (e instanceof ApiError && rejected(e)) { blockSession(e.status, String(e.message)); return false; }
        // A transient answer (502/503/429/500) or a dropped connection: one immediate retry, then
        // back off for a while. The refresh credential was never declared invalid, so the session stays.
        await new Promise((r) => setTimeout(r, 400));
        session = await refreshOnce(body);
      }
      await adopt(session);
      return true;
    } catch (e) {
      if (e instanceof ApiError) {
        if (rejected(e)) blockSession(e.status, String(e.message));
        else deferRefresh(e.status);
      } else refreshRetryAt = Date.now() + REFRESH_BACKOFF_MS;
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

/** True once the refresh credential has been definitively rejected (user must sign in again). */
export const sessionRejected = () => refreshBlocked;

async function clearLocalSession() {
  accessToken = null;
  challengeToken = null;
  if (!WEB) { await storage.del(ACCESS_KEY); await storage.del(REFRESH_KEY); }
  await storage.del(USER_KEY);
}

export const useSession = create<{
  token: string | null;
  user: SessionUser | null;
  ready: boolean;
  /** The refresh credential was rejected: everything local is intact, a sign-in is required. */
  expired: boolean;
  load: () => Promise<void>;
  login: (email: string, password: string) => Promise<{ twoFactorRequired: boolean }>;
  verifyTwoFactor: (code: string) => Promise<void>;
  cancelTwoFactor: () => void;
  logout: () => Promise<void>;
  logoutAll: () => Promise<void>;
  expire: () => void;
  apply: (p: { token?: string; refreshToken?: string; user?: SessionUser }) => Promise<void>;
}>((set) => ({
  token: null, user: null, ready: false, expired: false,

  load: async () => {
    const rawUser = await storage.get(USER_KEY);
    let user: SessionUser | null = null;
    try { user = rawUser ? JSON.parse(rawUser) as SessionUser : null; } catch { user = null; }
    accessToken = WEB ? null : await storage.get(ACCESS_KEY);
    if (user) await bindShop(user.shopId); // restore scoped to this account's shop before screens read
    set({ user, token: accessToken });
    // On the web the cookie is the credential, so a reload needs one refresh to get an access token.
    // Offline this fails quietly: cached data stays visible and sync resumes when the network returns.
    if (WEB && user) await refreshSession();
    set({ ready: true });
  },

  login: async (email, password) => {
    const r = await fetchJson<SessionResponse | TwoFactorRequired>("/auth/login", { method: "POST", body: { email, password }, auth: false });
    if ("twoFactorRequired" in r) {
      challengeToken = r.challengeToken;
      return { twoFactorRequired: true };
    }
    await adopt(r);
    return { twoFactorRequired: false };
  },

  verifyTwoFactor: async (code) => {
    if (!challengeToken) throw new ApiError(401, { error: "two_factor_challenge_invalid" });
    const r = await fetchJson<SessionResponse>("/auth/2fa/verify", { method: "POST", body: { challengeToken, code }, auth: false });
    challengeToken = null;
    await adopt(r);
  },

  cancelTwoFactor: () => { challengeToken = null; },

  // Logout keeps the outbox: unsynced work is NEVER deleted. It stays tied to its user_id and syncs
  // after that user signs in again.
  logout: async () => {
    try {
      const stored = WEB ? undefined : (await storage.get(REFRESH_KEY)) ?? undefined;
      await fetchJson("/auth/logout", { method: "POST", body: stored ? { refreshToken: stored } : {}, auth: false }, 6_000);
    } catch { /* the local sign-out still happens */ }
    await clearLocalSession();
    refreshBlocked = false; refreshRetryAt = 0;
    set({ token: null, user: null, expired: false });
  },

  logoutAll: async () => {
    try { await fetchJson("/auth/logout-all", { method: "POST", body: {}, auth: true }, 6_000); }
    finally {
      await clearLocalSession();
      refreshBlocked = false; refreshRetryAt = 0;
      set({ token: null, user: null, expired: false });
    }
  },

  // Keep `user` so the UI can say "sign in again"; local data and the outbox are untouched.
  expire: () => { accessToken = null; set({ token: null, expired: true }); },

  // Persist a changed profile or a rotated session without touching the outbox.
  apply: async (p) => {
    if (p.token) { accessToken = p.token; if (!WEB) await storage.set(ACCESS_KEY, p.token); }
    if (p.refreshToken && !WEB) await storage.set(REFRESH_KEY, p.refreshToken);
    if (p.user) await storage.set(USER_KEY, JSON.stringify(p.user));
    set((s) => ({ token: p.token ?? s.token, user: p.user ?? s.user, expired: false }));
  },
}));

/**
 * Authenticated request. A 401 is answered by one refresh attempt and a single retry; a failed refresh
 * clears the local token (never the queued work) and surfaces the error. Network failures are raised as
 * NetworkError so screens can fall back to cached data instead of pretending the session is valid.
 */
export async function request<T>(path: string, o: RequestOptions = {}): Promise<T> {
  if (o.auth !== false && !accessToken && useSession.getState().user) await refreshSession();
  try {
    return await fetchJson<T>(path, o);
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 401 || o.auth === false) throw e;
    // Force one refresh for this 401 even if a previous failure is still backing off: a 401 means
    // the server answered, so the credential is worth exactly one more attempt. Single-flight keeps
    // every concurrent 401 sharing it, and the retry below happens at most once per request.
    if (await refreshSession(true)) return fetchJson<T>(path, o);
    // The refresh already marked the session expired when the server rejected the credential. A
    // transport failure leaves the session intact (it may still be valid) and backs off instead.
    throw e;
  }
}

/** The live access token, for transports that authenticate outside an HTTP header (WebSocket). */
export const currentToken = () => accessToken;

/** Called by the sync engine: makes sure an expired session has been refreshed once before pushing. */
export const ensureSession = async (force = false) => {
  if (refreshBlocked) return false;
  if (!accessToken && useSession.getState().user) return refreshSession(force);
  return !!accessToken;
};

/**
 * The realtime server closes an authorized socket when its access token expires. The HTTP layer may
 * not have made a request yet, so the client explicitly rotates once before reconnecting instead
 * of retrying the same expired token forever.
 */
export const refreshAccessToken = (force = true) => refreshSession(force);

export const getDeviceId = async () => (await kvGet("device_id")) ?? "unknown";
