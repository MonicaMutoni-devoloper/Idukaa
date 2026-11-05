import type { CookieOptions, Request, Response } from "express";
import { newOpaqueToken } from "../auth/security";

/** Minimal cookie reader (no extra dependency). */
export function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return undefined; }
    }
  }
  return undefined;
}

export const requestIsHttps = (req: Request) =>
  process.env.COOKIE_SECURE === "true" || req.secure || req.headers["x-forwarded-proto"] === "https";

export const clientMeta = (req: Request) => ({
  deviceId: typeof req.headers["x-device-id"] === "string" ? req.headers["x-device-id"] : undefined,
  userAgent: req.headers["user-agent"],
  ip: req.ip ?? null,
});

/**
 * Registrable-site approximation used to decide whether the caller is cross-site.
 * `app.example.rw` and `api.example.rw` share `example.rw`; `x.vercel.app` and `y.onrender.com`
 * do not. Ports are ignored (cookies are host-scoped, not port-scoped) and IPs/localhost compare
 * as a whole.
 */
export function siteOf(host: string): string {
  const h = host.trim().toLowerCase().replace(/:\d+$/, "");
  if (!h) return "";
  if (h.includes(":") || /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || !h.includes(".")) return h; // IPv6 / IPv4 / localhost
  const parts = h.split(".");
  // Two-label suffixes that are themselves registrable units (co.uk, com.rw, ...) are the common
  // case here; the last two labels is the conservative choice that still separates vercel.app
  // from onrender.com.
  return parts.slice(-2).join(".");
}

/** True when the browser's Origin belongs to a different site than this API. */
export function originIsCrossSite(req: Request): boolean {
  const origin = req.headers.origin;
  if (!origin || origin === "null") return false;
  try { return siteOf(new URL(origin).hostname) !== siteOf(req.headers.host ?? ""); } catch { return false; }
}

/**
 * SameSite policy for the auth cookies.
 *  - Explicit COOKIE_SAMESITE=strict|lax|none always wins (documented escape hatch).
 *  - Otherwise it is derived per request from the caller's Origin: a cross-site deployment
 *    (web on *.vercel.app, API on *.onrender.com) gets "none", a same-domain deployment gets
 *    "strict". A hard-coded "strict" is exactly what made POST /auth/refresh return 401 in
 *    production: browsers drop a Strict cookie on a cross-site request, so the refresh cookie was
 *    never sent at all.
 *  - Browsers reject SameSite=None without Secure, so that mode forces Secure; both cookies stay
 *    behind the double-submit check (`x-csrf-token` must match the readable sms_csrf cookie), which
 *    is what actually blocks cross-site request forgery here.
 */
export function sameSitePolicy(req: Request): "strict" | "lax" | "none" {
  const v = (process.env.COOKIE_SAMESITE ?? "").toLowerCase();
  if (v === "lax" || v === "none" || v === "strict") return v;
  return originIsCrossSite(req) ? "none" : "strict";
}

const cookieBase = (req: Request): CookieOptions => {
  const sameSite = sameSitePolicy(req);
  const secure = requestIsHttps(req) || sameSite === "none";
  // A SameSite=None cookie read by a different site (web on *.vercel.app, API on *.onrender.com)
  // is a THIRD-PARTY cookie. Browsers that block third-party cookies drop it whatever SameSite
  // says, which is indistinguishable from "the session vanished". Partitioned (CHIPS) keeps it
  // in a per-top-level-site store where those browsers still send it. It stays HttpOnly + Secure
  // and is still bound to this host and path, so nothing about the credential's strength changes.
  const partitioned = sameSite === "none" && secure;
  return { secure, sameSite, ...(partitioned ? ({ partitioned: true } as CookieOptions) : {}) };
};

/** Matches REFRESH_TOKEN_TTL_DAYS (clamped the same way as the server-side session). */
export const refreshCookieMaxAge = () => {
  const n = Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 30);
  return (Number.isFinite(n) && n >= 1 && n <= 365 ? n : 30) * 86_400_000;
};

/**
 * Web refresh tokens live in an HttpOnly cookie scoped to /auth (SameSite derived from the caller's
 * origin, see sameSitePolicy). A readable CSRF cookie + required `x-csrf-token` header protect the
 * cookie-based refresh/logout calls. Native clients keep the refresh token in the platform keystore
 * and send it in the request body.
 */
export function setAuthCookies(req: Request, res: Response, refreshToken: string, maxAgeMs: number) {
  res.cookie("sms_rt", refreshToken, { ...cookieBase(req), httpOnly: true, path: "/auth", maxAge: maxAgeMs });
  res.cookie("sms_csrf", newOpaqueToken(), { ...cookieBase(req), httpOnly: false, path: "/", maxAge: maxAgeMs });
}

export function clearAuthCookies(req: Request, res: Response) {
  res.clearCookie("sms_rt", { ...cookieBase(req), httpOnly: true, path: "/auth" });
  res.clearCookie("sms_csrf", { ...cookieBase(req), httpOnly: false, path: "/" });
}

/** The web origins allowed to call this API with credentials (CORS_ORIGINS, comma separated). */
export const allowedOrigins = () => (process.env.CORS_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/** True when the request's Origin is one the API explicitly trusts. */
export function originAllowed(req: Request) {
  const origin = req.headers.origin;
  return typeof origin === "string" && allowedOrigins().includes(origin);
}

/**
 * CSRF check for cookie-based session calls (refresh / logout).
 *
 * Same-site deployment: strict double submit — `x-csrf-token` must equal the readable `sms_csrf`
 * cookie. Cross-site deployment (web on *.vercel.app, API on *.onrender.com) the browser cannot read
 * a cookie that belongs to the API host, so the values can never match; requiring it rejected every
 * legitimate refresh with 403 csrf_failed. In that case the defence is the browser's own,
 * unforgeable `Origin` header checked against the CORS allow-list: a cross-site page cannot set a
 * custom `x-csrf-token` header without this API approving its preflight, and an unapproved origin
 * never gets that approval.
 */
export function cookieCsrfOk(req: Request) {
  const header = req.headers["x-csrf-token"];
  if (typeof header !== "string" || !header) return false;
  const cookie = readCookie(req, "sms_csrf");
  if (cookie && header === cookie) return true;
  // A cookie the caller cannot read (cross-site) can never be echoed back, so fall through to the
  // Origin allow-list instead of rejecting a legitimate browser.
  return originIsCrossSite(req) && originAllowed(req);
}
