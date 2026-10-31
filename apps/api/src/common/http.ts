import type { Request, Response } from "express";
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

const cookieBase = (req: Request) => ({
  secure: requestIsHttps(req),
  sameSite: "strict" as const,
});

/** Matches REFRESH_TOKEN_TTL_DAYS (clamped the same way as the server-side session). */
export const refreshCookieMaxAge = () => {
  const n = Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 30);
  return (Number.isFinite(n) && n >= 1 && n <= 365 ? n : 30) * 86_400_000;
};

/**
 * Web refresh tokens live in an HttpOnly, SameSite=Strict cookie scoped to /auth. A readable CSRF
 * cookie + required `x-csrf-token` header protect the cookie-based refresh/logout calls. Native
 * clients keep the refresh token in the platform keystore and send it in the request body.
 */
export function setAuthCookies(req: Request, res: Response, refreshToken: string, maxAgeMs: number) {
  res.cookie("sms_rt", refreshToken, { ...cookieBase(req), httpOnly: true, path: "/auth", maxAge: maxAgeMs });
  res.cookie("sms_csrf", newOpaqueToken(), { ...cookieBase(req), httpOnly: false, path: "/", maxAge: maxAgeMs });
}

export function clearAuthCookies(req: Request, res: Response) {
  res.clearCookie("sms_rt", { ...cookieBase(req), httpOnly: true, path: "/auth" });
  res.clearCookie("sms_csrf", { ...cookieBase(req), httpOnly: false, path: "/" });
}

/** Double-submit check for cookie-based session calls. */
export function cookieCsrfOk(req: Request) {
  const cookie = readCookie(req, "sms_csrf");
  const header = req.headers["x-csrf-token"];
  return !!cookie && typeof header === "string" && header === cookie;
}
