import { BadRequestException, Body, Controller, ForbiddenException, Get, Patch, Post, Req, Res, UnauthorizedException } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { Request, Response } from "express";
import { z } from "zod";
import { Me, Public, type AuthUser } from "../common/auth";
import { authLog, refreshFailureCategory } from "../common/auth-log";
import { clearAuthCookies, clientMeta, cookieCsrfOk, readCookie, refreshCookieMaxAge, setAuthCookies } from "../common/http";
import { AuthService } from "./auth.service";

const Login = z.object({ email: z.string().email(), password: z.string().min(1).max(200) });
const ProfilePatch = z.object({ fullName: z.string().trim().min(2).max(120) });
const PasswordChange = z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().min(10).max(200) });
const RefreshBody = z.object({ refreshToken: z.string().min(20).max(500).optional(), deviceId: z.string().max(64).optional() }).optional();
const LogoutBody = z.object({ refreshToken: z.string().min(20).max(500).optional() }).optional();
const Forgot = z.object({ email: z.string().email() });
const TokenBody = z.object({ token: z.string().min(10).max(500) });
const Reset = z.object({ token: z.string().min(10).max(500), password: z.string().min(1).max(200) });
const CodeBody = z.object({ password: z.string().min(1).max(200), code: z.string().min(6).max(32) });
const VerifyBody = z.object({ challengeToken: z.string().min(10).max(500), code: z.string().min(6).max(32) });

/** Pulls the refresh token from the native body first, then from the HttpOnly web cookie (CSRF-checked). */
function presentedRefreshToken(req: Request, bodyToken?: string): string | undefined {
  if (bodyToken) return bodyToken;
  const cookie = readCookie(req, "sms_rt");
  if (!cookie) return undefined;
  if (!cookieCsrfOk(req)) throw new ForbiddenException("csrf_failed");
  return cookie;
}

@Controller("auth")
export class AuthController {
  constructor(private auth: AuthService) {}

  @Public() @Throttle({ default: { limit: 8, ttl: 60_000 } }) @Post("login")
  async login(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { email, password } = Login.parse(body);
    const result = await this.auth.login(email, password, clientMeta(req));
    if ("twoFactorRequired" in result) {
      authLog(req, "login.challenged", "ok");
      return result; // no session and no cookie until the code is verified
    }
    authLog(req, "login.ok", "ok", { userId: result.user.id });
    setAuthCookies(req, res, result.refreshToken, refreshCookieMaxAge());
    return result;
  }

  /**
   * Rotates the refresh token. The old one keeps working for a short grace window (so a racing tab or
   * a lost cookie cannot lock the user out), then stops working entirely.
   */
  @Public() @Throttle({ default: { limit: 30, ttl: 60_000 } }) @Post("refresh")
  async refresh(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const b = RefreshBody.safeParse(body ?? {});
    const fromCookie = !!readCookie(req, "sms_rt");
    let presented: string | undefined;
    try {
      presented = presentedRefreshToken(req, b.success ? b.data?.refreshToken : undefined);
    } catch (e) {
      // The cookie arrived but the CSRF header did not match: a non-browser caller, never a real user.
      authLog(req, "refresh.failed", "csrf_rejected", { cookiePresent: fromCookie });
      throw e;
    }
    if (!presented) {
      // Evidence for the transport question: on a cross-site deployment a Strict cookie is simply
      // never sent, so this category with crossSite=true means "the browser dropped the cookie".
      authLog(req, "refresh.failed", "missing_refresh_credential", { cookiePresent: fromCookie, bodyToken: !!b.success && !!b.data?.refreshToken });
      throw new UnauthorizedException("refresh_invalid");
    }
    try {
      const session = await this.auth.refresh(presented, clientMeta(req));
      authLog(req, "refresh.ok", "ok", { userId: session.user.id, cookiePresent: fromCookie });
      setAuthCookies(req, res, session.refreshToken, refreshCookieMaxAge());
      return session;
    } catch (e) {
      const message = (e as Error).message;
      authLog(req, "refresh.failed", refreshFailureCategory(message), { cookiePresent: fromCookie, detail: message });
      throw e;
    }
  }

  @Public() @Throttle({ default: { limit: 30, ttl: 60_000 } }) @Post("logout")
  async logout(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const b = LogoutBody.safeParse(body ?? {});
    const presented = presentedRefreshToken(req, b.success ? b.data?.refreshToken : undefined);
    await this.auth.logout(presented);
    clearAuthCookies(req, res);
    return { ok: true };
  }

  /** Signs out every device: access tokens die on their next request and all refresh sessions are revoked. */
  @Post("logout-all")
  async logoutAll(@Me() u: AuthUser, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logoutAll(u.id, u.shopId);
    clearAuthCookies(req, res);
    return { ok: true };
  }

  @Get("me")
  me(@Me() u: AuthUser) { return this.auth.me(u.id); }

  @Patch("me")
  async updateMe(@Me() u: AuthUser, @Body() body: unknown) {
    const b = ProfilePatch.safeParse(body);
    if (!b.success) throw new BadRequestException(b.error.issues[0]?.message); // same shape as before: readable message
    return this.auth.updateName(u.id, u.shopId, b.data.fullName);
  }

  /** Changing a password revokes every other session; this device keeps a fresh session. */
  @Post("password") @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async changePassword(@Me() u: AuthUser, @Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const b = PasswordChange.safeParse(body);
    if (!b.success) throw new BadRequestException(b.error.issues[0]?.message);
    const session = await this.auth.changePassword(u.id, u.shopId, b.data.currentPassword, b.data.newPassword, clientMeta(req));
    setAuthCookies(req, res, session.refreshToken, refreshCookieMaxAge());
    return session;
  }

  /* ------------------------------------------------------------------ password recovery */

  @Public() @Throttle({ default: { limit: 5, ttl: 60_000 } }) @Post("password/forgot")
  forgot(@Body() body: unknown, @Req() req: Request) {
    const b = Forgot.safeParse(body);
    if (!b.success) return { ok: true }; // never validate-then-reveal: an unknown shape gets the generic answer
    return this.auth.requestPasswordReset(b.data.email, req.ip ?? null);
  }

  @Public() @Throttle({ default: { limit: 20, ttl: 60_000 } }) @Post("password/reset/verify")
  verifyReset(@Body() body: unknown) {
    const b = TokenBody.safeParse(body);
    if (!b.success) return { valid: false };
    return this.auth.verifyResetToken(b.data.token);
  }

  @Public() @Throttle({ default: { limit: 10, ttl: 60_000 } }) @Post("password/reset")
  async reset(@Body() body: unknown) {
    const b = Reset.safeParse(body);
    if (!b.success) throw new BadRequestException(b.error.issues[0]?.message);
    return this.auth.resetPassword(b.data.token, b.data.password);
  }

  /* ------------------------------------------------------------------ two-factor authentication */

  @Get("2fa") twoFactor(@Me() u: AuthUser) { return this.auth.twoFactorStatus(u.id); }

  @Post("2fa/setup") @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async setupTwoFactor(@Me() u: AuthUser, @Body() body: unknown) {
    const b = z.object({ password: z.string().min(1).max(200) }).safeParse(body);
    if (!b.success) throw new BadRequestException("current_password_incorrect");
    return this.auth.startTwoFactorEnrollment(u.id, b.data.password);
  }

  @Post("2fa/enable") @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async enableTwoFactor(@Me() u: AuthUser, @Body() body: unknown) {
    const b = CodeBody.safeParse(body);
    if (!b.success) throw new BadRequestException("invalid_code");
    return this.auth.enableTwoFactor(u.id, u.shopId, b.data.password, b.data.code);
  }

  @Post("2fa/disable") @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async disableTwoFactor(@Me() u: AuthUser, @Body() body: unknown) {
    const b = CodeBody.safeParse(body);
    if (!b.success) throw new BadRequestException("invalid_code");
    return this.auth.disableTwoFactor(u.id, u.shopId, b.data.password, b.data.code);
  }

  @Post("2fa/recovery-codes") @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async regenerateRecoveryCodes(@Me() u: AuthUser, @Body() body: unknown) {
    const b = CodeBody.safeParse(body);
    if (!b.success) throw new BadRequestException("invalid_code");
    return this.auth.regenerateRecoveryCodes(u.id, u.shopId, b.data.password, b.data.code);
  }

  @Public() @Throttle({ default: { limit: 10, ttl: 60_000 } }) @Post("2fa/verify")
  async verifyTwoFactor(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const b = VerifyBody.safeParse(body);
    if (!b.success) throw new BadRequestException("invalid_code");
    const session = await this.auth.verifyTwoFactorLogin(b.data.challengeToken, b.data.code, clientMeta(req));
    setAuthCookies(req, res, session.refreshToken, refreshCookieMaxAge());
    return session;
  }
}
