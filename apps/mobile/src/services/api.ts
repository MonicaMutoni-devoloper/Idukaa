import { Platform } from "react-native";
import Constants from "expo-constants";
import * as SecureStore from "expo-secure-store";
import { create } from "zustand";
import { bindShop, kvGet } from "../database";

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
const REFRESH_TIMEOUT_MS = 12_000;
const REQUEST_TIMEOUT_MS = 20_000;

let accessToken: string | null = null;
let challengeToken: string | null = null;
let refreshInFlight: Promise<boolean> | null = null;

const storage = {
  async get(key: string): Promise<string | null> {
    if (WEB) return typeof localStorage === "undefined" ? null : localStorage.getItem(key);
    return SecureStore.getItemAsync(key);
  },
  async set(key: string, value: string) {
    if (WEB) { if (typeof localStorage !== "undefined") localStorage.setItem(key, value); return; }
    await SecureStore.setItemAsync(key, value);
  },
  async del(key: string) {
    if (WEB) { if (typeof localStorage !== "undefined") localStorage.removeItem(key); return; }
    await SecureStore.deleteItemAsync(key);
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
export class NetworkError extends Error {}

interface RequestOptions { method?: string; body?: unknown; auth?: boolean }

async function fetchJson<T>(path: string, o: RequestOptions, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (o.auth !== false && accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const csrf = WEB ? readCookie("sms_csrf") : null;
  if (csrf) headers["x-csrf-token"] = csrf;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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
    throw new NetworkError("network_unavailable");
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

async function adopt(session: SessionResponse) {
  accessToken = session.token;
  if (!WEB) {
    await storage.set(ACCESS_KEY, session.token);
    if (session.refreshToken) await storage.set(REFRESH_KEY, session.refreshToken);
  }
  await storage.set(USER_KEY, JSON.stringify(session.user));
  // Before the UI can render: scope the local cache to this user's shop, so no leftovers from a
  // previously signed-in account are ever shown (and a switch triggers a clean re-pull).
  await bindShop(session.user.shopId);
  useSession.setState({ token: session.token, user: session.user });
}

/** One refresh at a time: concurrent 401s wait for the same rotation instead of racing. */
function refreshSession(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      let body: Record<string, unknown> = {};
      if (!WEB) {
        const stored = await storage.get(REFRESH_KEY);
        if (!stored) return false;
        body = { refreshToken: stored };
      }
      const session = await fetchJson<SessionResponse>("/auth/refresh", { method: "POST", body, auth: false }, REFRESH_TIMEOUT_MS);
      await adopt(session);
      return true;
    } catch {
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

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
  load: () => Promise<void>;
  login: (email: string, password: string) => Promise<{ twoFactorRequired: boolean }>;
  verifyTwoFactor: (code: string) => Promise<void>;
  cancelTwoFactor: () => void;
  logout: () => Promise<void>;
  logoutAll: () => Promise<void>;
  expire: () => void;
  apply: (p: { token?: string; refreshToken?: string; user?: SessionUser }) => Promise<void>;
}>((set) => ({
  token: null, user: null, ready: false,

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
    set({ token: null, user: null });
  },

  logoutAll: async () => {
    try { await fetchJson("/auth/logout-all", { method: "POST", body: {}, auth: true }, 6_000); }
    finally { await clearLocalSession(); set({ token: null, user: null }); }
  },

  // Keep `user` so the UI can say "sign in again"; local data and the outbox are untouched.
  expire: () => { accessToken = null; set({ token: null }); },

  // Persist a changed profile or a rotated session without touching the outbox.
  apply: async (p) => {
    if (p.token) { accessToken = p.token; if (!WEB) await storage.set(ACCESS_KEY, p.token); }
    if (p.refreshToken && !WEB) await storage.set(REFRESH_KEY, p.refreshToken);
    if (p.user) await storage.set(USER_KEY, JSON.stringify(p.user));
    set((s) => ({ token: p.token ?? s.token, user: p.user ?? s.user }));
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
    if (await refreshSession()) return fetchJson<T>(path, o);
    useSession.getState().expire();
    throw e;
  }
}

/** Called by the sync engine: makes sure an expired session has been refreshed once before pushing. */
export const ensureSession = async () => {
  if (!accessToken && useSession.getState().user) return refreshSession();
  return !!accessToken;
};

export const getDeviceId = async () => (await kvGet("device_id")) ?? "unknown";
