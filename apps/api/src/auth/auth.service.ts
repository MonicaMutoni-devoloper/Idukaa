import { BadRequestException, ForbiddenException, Injectable, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import bcrypt from "bcryptjs";
import QRCode from "qrcode";
import { randomUUID } from "node:crypto";
import { Db } from "../db/db.service";
import { audit } from "../audits/audit";
import { NotificationService } from "../notifications/notifications.service";
import {
  decryptSecret, encryptSecret, generateRecoveryCodes, hashRecoveryCode, hashToken, isEncryptionConfigured,
  looksLikeRecoveryCode, newChallengeToken, newOpaqueToken, newTotpSecret, otpauthUri, passwordSchema,
  sameHash, totpStep, verifyTotp,
} from "./security";

export interface SessionUser { id: string; name: string; role: "owner" | "manager" | "system_admin"; shopId: string | null }
export interface SessionMeta { deviceId?: string; userAgent?: string; ip?: string | null }
export interface SessionPayload { token: string; refreshToken: string; expiresIn: number; user: SessionUser }
export interface TwoFactorChallenge { twoFactorRequired: true; challengeToken: string; expiresIn: number }

const refreshTtlDays = () => {
  const n = Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 30);
  return Number.isFinite(n) && n >= 1 && n <= 365 ? n : 30;
};
const challengeTtlMinutes = () => {
  const n = Number(process.env.TWO_FACTOR_CHALLENGE_MINUTES ?? 5);
  return Number.isFinite(n) && n >= 1 && n <= 30 ? n : 5;
};
const resetTtlMinutes = () => {
  const n = Number(process.env.PASSWORD_RESET_TTL_MINUTES ?? 30);
  return Number.isFinite(n) && n >= 5 && n <= 240 ? n : 30;
};
const devResetEnabled = () => process.env.NODE_ENV !== "production" && process.env.PASSWORD_RESET_DEV_MODE === "true";
const resetUrl = (token: string) => {
  const base = (process.env.PASSWORD_RESET_URL ?? "http://localhost:8081/reset-password").split("?")[0]!;
  return `${base}?token=${encodeURIComponent(token)}`;
};

const sessionUser = (u: any): SessionUser => ({ id: u.id, name: u.full_name, role: u.role, shopId: u.shop_id ?? null });

/**
 * Authentication beyond the password: rotating refresh sessions, single-use password resets and
 * optional TOTP two-factor authentication. Nothing here stores a plaintext token or TOTP secret.
 */
@Injectable()
export class AuthService {
  constructor(private db: Db, private jwt: JwtService, private notifications: NotificationService) {}

  /* ------------------------------------------------------------------ sessions */

  private async signAccess(u: any) {
    const token = await this.jwt.signAsync({ sub: u.id, tv: u.token_version });
    const decoded: any = this.jwt.decode(token);
    const expiresIn = decoded?.exp ? Math.max(1, decoded.exp - Math.floor(Date.now() / 1000)) : 900;
    return { token, expiresIn };
  }

  /**
   * Hygiene: expired refresh rows are kept 30 days for audit and reuse detection, then dropped
   * opportunistically at every new session. This must never be the reason a sign-in fails.
   */
  private async purgeExpiredSessions(c = this.db.pool) {
    try {
      await c.query("DELETE FROM refresh_sessions WHERE expires_at < now() - interval '30 days'");
    } catch { /* best-effort housekeeping; the index in migration 007 keeps it cheap */ }
  }

  private async createSession(user: any, meta: SessionMeta, familyId = randomUUID(), c = this.db.pool): Promise<SessionPayload> {
    await this.purgeExpiredSessions(c);
    const refreshToken = newOpaqueToken();
    const expiresAt = new Date(Date.now() + refreshTtlDays() * 86_400_000);
    await c.query(
      `INSERT INTO refresh_sessions(user_id, family_id, token_hash, device_id, user_agent, ip, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [user.id, familyId, hashToken(refreshToken), meta.deviceId ?? null, meta.userAgent?.slice(0, 300) ?? null, meta.ip ?? null, expiresAt],
    );
    const { token, expiresIn } = await this.signAccess(user);
    return { token, refreshToken, expiresIn, user: sessionUser(user) };
  }

  async login(email: string, password: string, meta: SessionMeta): Promise<SessionPayload | TwoFactorChallenge> {
    const [u] = await this.db.query("SELECT * FROM users WHERE lower(email)=lower($1)", [email]);
    const okPassword = !!u && (await bcrypt.compare(password, u.password_hash));
    if (!u || !okPassword) {
      if (u) {
        await audit(this.db.pool, { shopId: u.shop_id, actorId: null, action: "auth.login.failed", entity: "user", entityId: u.id, newValue: { reason: "invalid_credentials" } });
        throw new UnauthorizedException("invalid_credentials");
      }
      // No account for this address yet. It may belong to a shop applicant whose file is still
      // under review or was rejected: only a caller who proves the password chosen at registration
      // learns that state — everyone else still gets the same generic answer as a wrong password.
      const [app] = await this.db.query(
        `SELECT id, status, password_hash FROM owner_applications
          WHERE lower(email)=lower($1) AND password_hash IS NOT NULL
            AND status IN ('PENDING_REVIEW','ADDITIONAL_INFORMATION_REQUIRED','REJECTED')`, [email]);
      if (app && (await bcrypt.compare(password, app.password_hash))) {
        await audit(this.db.pool, { shopId: null, actorId: null, action: "auth.login.blocked", entity: "owner_application", entityId: app.id, newValue: { reason: app.status } });
        // The applicant learns exactly one thing: which state their file is in. There is no account
        // yet, so "info required" is the one signal that lets them open their status page and reply.
        throw new ForbiddenException(
          app.status === "REJECTED" ? "application_rejected"
          : app.status === "ADDITIONAL_INFORMATION_REQUIRED" ? "application_info_required"
            : "application_pending_review",
        );
      }
      throw new UnauthorizedException("invalid_credentials");
    }
    // The password proved the caller owns the address, so the account STATE may now be named.
    // Before that, the same generic answer is returned for every unknown or wrong-password login.
    if (u.account_status === "pending_activation") {
      await audit(this.db.pool, { shopId: u.shop_id, actorId: u.id, action: "auth.login.blocked", entity: "user", entityId: u.id, newValue: { reason: "pending_activation" } });
      throw new ForbiddenException("account_not_activated");
    }
    if (u.account_status !== "active" || !u.active) {
      await audit(this.db.pool, { shopId: u.shop_id, actorId: u.id, action: "auth.login.blocked", entity: "user", entityId: u.id, newValue: { reason: "suspended" } });
      throw new ForbiddenException("account_suspended");
    }
    // A suspended shop is suspended for everyone in it: sign-in is refused until an administrator
    // reactivates it. The reason is recorded on the shop and in the audit log.
    if (u.shop_id) {
      const [sh] = await this.db.query("SELECT status FROM shops WHERE id=$1", [u.shop_id]);
      if (sh?.status === "suspended") {
        await audit(this.db.pool, { shopId: u.shop_id, actorId: u.id, action: "auth.login.blocked", entity: "user", entityId: u.id, newValue: { reason: "shop_suspended" } });
        throw new ForbiddenException("shop_suspended");
      }
    }

    if (u.totp_enabled_at) {
      const challengeToken = newChallengeToken();
      const expiresAt = new Date(Date.now() + challengeTtlMinutes() * 60_000);
      await this.db.query("DELETE FROM two_factor_challenges WHERE user_id=$1 AND (consumed_at IS NOT NULL OR expires_at < now())", [u.id]);
      await this.db.query(
        "INSERT INTO two_factor_challenges(user_id, token_hash, expires_at) VALUES ($1,$2,$3)",
        [u.id, hashToken(challengeToken), expiresAt],
      );
      await audit(this.db.pool, { shopId: u.shop_id, actorId: u.id, action: "auth.2fa.challenged", entity: "user", entityId: u.id });
      return { twoFactorRequired: true, challengeToken, expiresIn: challengeTtlMinutes() * 60 };
    }

    const session = await this.createSession(u, meta);
    await audit(this.db.pool, { shopId: u.shop_id, actorId: u.id, action: "auth.login", entity: "user", entityId: u.id });
    return session;
  }

  /** Rotates the refresh token. A reused (already rotated) token revokes its whole session family. */
  async refresh(presented: string, meta: SessionMeta): Promise<SessionPayload> {
    const hash = hashToken(presented);
    const [row] = await this.db.query("SELECT * FROM refresh_sessions WHERE token_hash=$1", [hash]);
    if (!row) throw new UnauthorizedException("refresh_invalid");

    if (row.revoked_at) {
      await this.revokeFamily(row.family_id, "reuse_detected");
      await audit(this.db.pool, {
        shopId: null, actorId: row.user_id, action: "auth.refresh.reuse_detected", entity: "session", entityId: row.id,
      });
      throw new UnauthorizedException("refresh_reused");
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      await this.db.query("UPDATE refresh_sessions SET revoked_at=now(), revoke_reason='expired' WHERE id=$1 AND revoked_at IS NULL", [row.id]);
      throw new UnauthorizedException("refresh_expired");
    }
    const [u] = await this.db.query("SELECT * FROM users WHERE id=$1", [row.user_id]);
    if (!u || !u.active || u.account_status !== "active") throw new UnauthorizedException("session_revoked");

    const newId = randomUUID();
    const refreshToken = newOpaqueToken();
    try {
      await this.db.tx(async (c) => {
        // Claim the presented row exactly once, even under concurrent requests.
        const claim = await c.query(
          "UPDATE refresh_sessions SET revoked_at=now(), revoke_reason='rotated', last_used_at=now() WHERE id=$1 AND revoked_at IS NULL RETURNING id",
          [row.id],
        );
        if (!claim.rowCount) throw new Error("refresh_reused");
        await c.query(
          `INSERT INTO refresh_sessions(id, user_id, family_id, token_hash, device_id, user_agent, ip, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [newId, u.id, row.family_id, hashToken(refreshToken), meta.deviceId ?? row.device_id,
            meta.userAgent?.slice(0, 300) ?? row.user_agent, meta.ip ?? row.ip,
            new Date(Date.now() + refreshTtlDays() * 86_400_000)],
        );
        await c.query("UPDATE refresh_sessions SET replaced_by=$2 WHERE id=$1", [row.id, newId]);
      });
    } catch (e) {
      if ((e as Error).message === "refresh_reused") {
        await this.revokeFamily(row.family_id, "reuse_detected");
        await audit(this.db.pool, { shopId: null, actorId: row.user_id, action: "auth.refresh.reuse_detected", entity: "session", entityId: row.id });
        throw new UnauthorizedException("refresh_reused");
      }
      throw e;
    }

    const { token, expiresIn } = await this.signAccess(u);
    return { token, refreshToken, expiresIn, user: sessionUser(u) };
  }

  async logout(presented: string | undefined) {
    if (!presented) return { ok: true };
    const [row] = await this.db.query(
      "UPDATE refresh_sessions SET revoked_at=now(), revoke_reason='logout' WHERE token_hash=$1 AND revoked_at IS NULL RETURNING id, user_id",
      [hashToken(presented)],
    );
    if (row) await audit(this.db.pool, { shopId: null, actorId: row.user_id, action: "auth.logout", entity: "session", entityId: row.id });
    return { ok: true };
  }

  async logoutAll(userId: string, shopId: string | null) {
    await this.db.tx(async (c) => {
      await c.query("UPDATE users SET token_version=token_version+1 WHERE id=$1", [userId]);
      await c.query("UPDATE refresh_sessions SET revoked_at=now(), revoke_reason='logout_all' WHERE user_id=$1 AND revoked_at IS NULL", [userId]);
    });
    await audit(this.db.pool, { shopId, actorId: userId, action: "auth.logout_all", entity: "user", entityId: userId });
    return { ok: true };
  }

  private async revokeFamily(familyId: string, reason: string) {
    await this.db.query(
      "UPDATE refresh_sessions SET revoked_at=COALESCE(revoked_at, now()), revoke_reason=COALESCE(revoke_reason, $2) WHERE family_id=$1",
      [familyId, reason],
    );
  }

  private async revokeAllForUser(userId: string, reason: string) {
    await this.db.query("UPDATE refresh_sessions SET revoked_at=COALESCE(revoked_at, now()), revoke_reason=COALESCE(revoke_reason, $2) WHERE user_id=$1", [userId, reason]);
  }

  /* ------------------------------------------------------------------ profile + password change */

  async me(userId: string) {
    const [row] = await this.db.query(
      `SELECT u.id, u.email, u.full_name, u.role, u.shop_id, u.totp_enabled_at, s.name AS shop_name
       FROM users u LEFT JOIN shops s ON s.id=u.shop_id WHERE u.id=$1`, [userId]);
    if (!row) throw new UnauthorizedException("session_expired");
    return {
      id: row.id, email: row.email, name: row.full_name, role: row.role, shopId: row.shop_id, shopName: row.shop_name ?? null,
      twoFactorEnabled: !!row.totp_enabled_at,
    };
  }

  async updateName(userId: string, shopId: string | null, fullName: string) {
    const [row] = await this.db.query(
      `UPDATE users SET full_name=$2 WHERE id=$1 RETURNING id, email, full_name, role, shop_id, totp_enabled_at, NULL::text AS shop_name`,
      [userId, fullName]);
    await audit(this.db.pool, { shopId, actorId: userId, action: "user.profile.update", entity: "user", entityId: userId, newValue: { fullName: row.full_name } });
    return {
      id: row.id, email: row.email, name: row.full_name, role: row.role, shopId: row.shop_id, shopName: row.shop_name ?? null,
      twoFactorEnabled: !!row.totp_enabled_at,
    };
  }

  async changePassword(userId: string, shopId: string | null, currentPassword: string, newPassword: string, meta: SessionMeta): Promise<SessionPayload> {
    const [row] = await this.db.query("SELECT * FROM users WHERE id=$1", [userId]);
    if (!row || !(await bcrypt.compare(currentPassword, row.password_hash))) throw new BadRequestException("current_password_incorrect");
    const parsed = passwordSchema.safeParse(newPassword);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
    if (await bcrypt.compare(newPassword, row.password_hash)) throw new BadRequestException("password_unchanged");

    const hash = await bcrypt.hash(newPassword, 12);
    const [updated] = await this.db.query(
      "UPDATE users SET password_hash=$2, token_version=token_version+1 WHERE id=$1 RETURNING *", [userId, hash]);
    await this.revokeAllForUser(userId, "password_changed");
    // The device that made the change stays signed in on a brand-new session.
    const session = await this.createSession(updated, meta);
    await audit(this.db.pool, { shopId, actorId: userId, action: "user.password.change", entity: "user", entityId: userId });
    await this.notifications.security(userId, shopId, "password_changed");
    return session;
  }

  /* ------------------------------------------------------------------ password reset */

  async requestPasswordReset(email: string, ip: string | null) {
    const [u] = await this.db.query("SELECT id, shop_id, full_name FROM users WHERE lower(email)=lower($1) AND active=true", [email]);
    // Always the same answer: a request never reveals whether an account exists.
    if (!u) return { ok: true as const };

    const token = newOpaqueToken();
    const expiresAt = new Date(Date.now() + resetTtlMinutes() * 60_000);
    await this.db.tx(async (c) => {
      // Only the newest reset link is valid; earlier unused links are invalidated.
      await c.query("UPDATE password_reset_tokens SET used_at=now() WHERE user_id=$1 AND used_at IS NULL", [u.id]);
      await c.query(
        "INSERT INTO password_reset_tokens(user_id, token_hash, expires_at, requested_ip) VALUES ($1,$2,$3,$4)",
        [u.id, hashToken(token), expiresAt, ip],
      );
    });
    await audit(this.db.pool, { shopId: u.shop_id, actorId: u.id, action: "auth.password.reset.request", entity: "user", entityId: u.id });
    await this.notifications.security(u.id, u.shop_id, "password_reset_requested");

    if (devResetEnabled()) {
      // Development/test only: the token is returned so the flow is usable without an e-mail provider.
      console.info(`[dev] password reset link for ${email}: ${resetUrl(token)}`);
      return { ok: true as const, devToken: token, devUrl: resetUrl(token), devExpiresAt: expiresAt.toISOString() };
    }
    return { ok: true as const };
  }

  async verifyResetToken(token: string) {
    if (!token) return { valid: false };
    const [row] = await this.db.query(
      "SELECT 1 FROM password_reset_tokens WHERE token_hash=$1 AND used_at IS NULL AND expires_at > now()",
      [hashToken(token)],
    );
    return { valid: !!row };
  }

  async resetPassword(token: string, newPassword: string) {
    const parsed = passwordSchema.safeParse(newPassword);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
    const hash = await bcrypt.hash(newPassword, 12);
    let userId: string | null = null;
    let shopId: string | null = null;
    await this.db.tx(async (c) => {
      const claim = await c.query(
        "UPDATE password_reset_tokens SET used_at=now() WHERE token_hash=$1 AND used_at IS NULL AND expires_at > now() RETURNING user_id",
        [hashToken(token)],
      );
      if (!claim.rowCount) throw new BadRequestException("reset_token_invalid");
      userId = claim.rows[0].user_id;
      const upd = await c.query(
        "UPDATE users SET password_hash=$2, token_version=token_version+1 WHERE id=$1 AND active=true RETURNING shop_id",
        [userId, hash],
      );
      if (!upd.rowCount) throw new BadRequestException("reset_token_invalid");
      shopId = upd.rows[0].shop_id;
      // Every other outstanding link and every session dies with this reset.
      await c.query("UPDATE password_reset_tokens SET used_at=now() WHERE user_id=$1 AND used_at IS NULL", [userId]);
      await c.query("UPDATE refresh_sessions SET revoked_at=now(), revoke_reason='password_reset' WHERE user_id=$1 AND revoked_at IS NULL", [userId]);
    });
    await audit(this.db.pool, { shopId, actorId: userId, action: "auth.password.reset", entity: "user", entityId: userId ?? undefined });
    if (userId) await this.notifications.security(userId, shopId, "password_reset_completed");
    return { ok: true };
  }

  /* ------------------------------------------------------------------ two-factor authentication */

  async twoFactorStatus(userId: string) {
    const [u] = await this.db.query("SELECT totp_enabled_at FROM users WHERE id=$1", [userId]);
    const [codes] = await this.db.query(
      "SELECT count(*)::int AS n FROM totp_recovery_codes WHERE user_id=$1 AND used_at IS NULL", [userId]);
    return {
      enabled: !!u?.totp_enabled_at,
      recoveryCodesRemaining: Number(codes?.n ?? 0),
      encryptionConfigured: isEncryptionConfigured(),
    };
  }

  private async requirePassword(userId: string, password: string) {
    const [u] = await this.db.query("SELECT * FROM users WHERE id=$1", [userId]);
    if (!u || !(await bcrypt.compare(password, u.password_hash))) throw new BadRequestException("current_password_incorrect");
    return u;
  }

  private requireEncryption() {
    if (!isEncryptionConfigured()) throw new ServiceUnavailableException("two_factor_not_configured");
  }

  /** Starts enrollment: the secret exists only in `totp_pending_secret` until a code is confirmed. */
  async startTwoFactorEnrollment(userId: string, password: string) {
    this.requireEncryption();
    const u = await this.requirePassword(userId, password);
    if (u.totp_enabled_at) throw new BadRequestException("two_factor_already_enabled");
    const secret = newTotpSecret();
    await this.db.query("UPDATE users SET totp_pending_secret=$2 WHERE id=$1", [userId, encryptSecret(secret)]);
    const uri = otpauthUri(u.email, secret);
    const qrDataUrl = await QRCode.toDataURL(uri, { margin: 1, width: 240, errorCorrectionLevel: "M" });
    return { secret, otpauth: uri, qrDataUrl };
  }

  async enableTwoFactor(userId: string, shopId: string | null, password: string, code: string) {
    this.requireEncryption();
    const u = await this.requirePassword(userId, password);
    if (u.totp_enabled_at) throw new BadRequestException("two_factor_already_enabled");
    if (!u.totp_pending_secret) throw new BadRequestException("two_factor_setup_required");
    let secret: string;
    try { secret = decryptSecret(u.totp_pending_secret); } catch { throw new BadRequestException("two_factor_setup_required"); }
    const step = verifyTotp(code, secret);
    if (step === null) {
      await audit(this.db.pool, { shopId, actorId: userId, action: "auth.2fa.enroll.failed", entity: "user", entityId: userId });
      throw new BadRequestException("invalid_code");
    }

    const recoveryCodes = generateRecoveryCodes();
    await this.db.tx(async (c) => {
      await c.query(
        "UPDATE users SET totp_secret=$2, totp_pending_secret=NULL, totp_enabled_at=now(), totp_last_step=$3 WHERE id=$1",
        [userId, encryptSecret(secret), step],
      );
      await c.query("DELETE FROM totp_recovery_codes WHERE user_id=$1", [userId]);
      for (const rc of recoveryCodes) {
        await c.query("INSERT INTO totp_recovery_codes(user_id, code_hash) VALUES ($1,$2)", [userId, hashRecoveryCode(rc)]);
      }
    });
    await audit(this.db.pool, { shopId, actorId: userId, action: "auth.2fa.enabled", entity: "user", entityId: userId });
    await this.notifications.security(userId, shopId, "two_factor_enabled");
    return { recoveryCodes, enabled: true };
  }

  private async consumeRecoveryCode(userId: string, code: string): Promise<boolean> {
    if (!looksLikeRecoveryCode(code)) return false;
    const hash = hashRecoveryCode(code);
    const rows = await this.db.query("SELECT id, code_hash FROM totp_recovery_codes WHERE user_id=$1 AND used_at IS NULL", [userId]);
    const match = rows.find((r: any) => sameHash(r.code_hash, hash));
    if (!match) return false;
    const upd = await this.db.query(
      "UPDATE totp_recovery_codes SET used_at=now() WHERE id=$1 AND used_at IS NULL RETURNING id", [match.id]);
    return !!upd.length;
  }

  private async verifySecondFactor(u: any, code: string): Promise<"totp" | "recovery" | null> {
    if (await this.consumeRecoveryCode(u.id, code)) return "recovery";
    if (!u.totp_secret) return null;
    let secret: string;
    try { secret = decryptSecret(u.totp_secret); } catch { return null; }
    const step = verifyTotp(code, secret);
    if (step === null) return null;
    const last = u.totp_last_step === null || u.totp_last_step === undefined ? -1 : Number(u.totp_last_step);
    if (step <= last) return null; // replayed code from an accepted time-step
    await this.db.query("UPDATE users SET totp_last_step=$2 WHERE id=$1", [u.id, step]);
    return "totp";
  }

  async verifyTwoFactorLogin(challengeToken: string, code: string, meta: SessionMeta): Promise<SessionPayload> {
    const [challenge] = await this.db.query(
      "SELECT * FROM two_factor_challenges WHERE token_hash=$1", [hashToken(challengeToken)]);
    if (!challenge || challenge.consumed_at || new Date(challenge.expires_at).getTime() <= Date.now()) {
      throw new UnauthorizedException("two_factor_challenge_invalid");
    }
    const [u] = await this.db.query("SELECT * FROM users WHERE id=$1", [challenge.user_id]);
    if (!u || !u.active || !u.totp_enabled_at) throw new UnauthorizedException("two_factor_challenge_invalid");

    const used = await this.verifySecondFactor(u, code);
    if (!used) {
      const next = await this.db.query(
        "UPDATE two_factor_challenges SET attempts=attempts+1 WHERE id=$1 RETURNING attempts", [challenge.id]);
      const attempts = Number(next[0]?.attempts ?? 0);
      if (attempts >= 5) await this.db.query("DELETE FROM two_factor_challenges WHERE id=$1", [challenge.id]);
      await audit(this.db.pool, { shopId: u.shop_id, actorId: u.id, action: "auth.2fa.verify.failed", entity: "user", entityId: u.id, newValue: { attempts } });
      throw new UnauthorizedException(attempts >= 5 ? "two_factor_locked" : "invalid_code");
    }

    const consumed = await this.db.query(
      "UPDATE two_factor_challenges SET consumed_at=now() WHERE id=$1 AND consumed_at IS NULL RETURNING id", [challenge.id]);
    if (!consumed.length) throw new UnauthorizedException("two_factor_challenge_invalid"); // parallel replay of the challenge
    await this.db.query("DELETE FROM two_factor_challenges WHERE user_id=$1 AND id<>$2", [u.id, challenge.id]);

    const session = await this.createSession(u, meta, randomUUID());
    await audit(this.db.pool, {
      shopId: u.shop_id, actorId: u.id,
      action: used === "recovery" ? "auth.2fa.recovery.used" : "auth.2fa.verified", entity: "user", entityId: u.id,
    });
    if (used === "recovery") await this.notifications.security(u.id, u.shop_id, "recovery_code_used");
    else await this.notifications.security(u.id, u.shop_id, "two_factor_login");
    return session;
  }

  async disableTwoFactor(userId: string, shopId: string | null, password: string, code: string) {
    const u = await this.requirePassword(userId, password);
    if (!u.totp_enabled_at) throw new BadRequestException("two_factor_not_enabled");
    if (!(await this.verifySecondFactor(u, code))) {
      await audit(this.db.pool, { shopId, actorId: userId, action: "auth.2fa.disable.failed", entity: "user", entityId: userId });
      throw new BadRequestException("invalid_code");
    }
    await this.db.tx(async (c) => {
      await c.query(
        "UPDATE users SET totp_secret=NULL, totp_pending_secret=NULL, totp_enabled_at=NULL, totp_last_step=NULL WHERE id=$1", [userId]);
      await c.query("DELETE FROM totp_recovery_codes WHERE user_id=$1", [userId]);
    });
    await audit(this.db.pool, { shopId, actorId: userId, action: "auth.2fa.disabled", entity: "user", entityId: userId });
    await this.notifications.security(userId, shopId, "two_factor_disabled");
    return { enabled: false };
  }

  async regenerateRecoveryCodes(userId: string, shopId: string | null, password: string, code: string) {
    const u = await this.requirePassword(userId, password);
    if (!u.totp_enabled_at) throw new BadRequestException("two_factor_not_enabled");
    if (!(await this.verifySecondFactor(u, code))) throw new BadRequestException("invalid_code");
    const recoveryCodes = generateRecoveryCodes();
    await this.db.tx(async (c) => {
      await c.query("DELETE FROM totp_recovery_codes WHERE user_id=$1", [userId]);
      for (const rc of recoveryCodes) {
        await c.query("INSERT INTO totp_recovery_codes(user_id, code_hash) VALUES ($1,$2)", [userId, hashRecoveryCode(rc)]);
      }
    });
    await audit(this.db.pool, { shopId, actorId: userId, action: "auth.2fa.recovery.regenerated", entity: "user", entityId: userId });
    await this.notifications.security(userId, shopId, "recovery_codes_regenerated");
    return { recoveryCodes };
  }
}
