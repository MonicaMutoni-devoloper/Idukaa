import { Injectable, UnauthorizedException, ForbiddenException } from "@nestjs/common";
import { Db } from "../db/db.service";
import { audit } from "../audits/audit";
import { randomUUID } from "node:crypto";

/**
 * Impersonation session management for system_admins.
 *
 * Rules:
 * - Sessions are short-lived (configurable TTL, default 8 hours).
 * - A new session is created when an admin explicitly "accesses" a user account or shop.
 * - The admin's JWT identity is preserved; target user/shop are added to the session metadata.
 * - Every protected request re-validates an active, non-expired impersonation session.
 * - Ending or revoking a session never touches the target's own credentials or devices.
 * - Expired sessions are automatically rejected on each request.
 * - The administrator can exit (end) their own impersonation session at any time.
 */

const DEFAULT_IMPERSONATION_TTL_MINUTES = Number(
  process.env.IMPERSONATION_TTL_MINUTES ?? 480, // 8 hours
);

const MAX_IMPERSONATION_TTL_MINUTES = Number(
  process.env.IMPERSONATION_MAX_TTL_MINUTES ?? 1440, // 24 hours max
);

@Injectable()
export class ImpersonationService {
  constructor(private db: Db) {}

  /** Validate that the impersonation session in the request is active and not expired. */
  async validateImpersonationSession(
    adminId: string,
    sessionId?: string,
  ): Promise<{ type: "user" | "shop"; targetId: string; targetType: "user" | "shop"; reason: string } | null> {
    if (!sessionId) return null;

    const [s] = await this.db.query<any>(
      `SELECT * FROM impersonation_sessions WHERE id=$1`,
      [sessionId]
    );

    if (!s) return null;
    if (s.status !== "active") return null;
    if (new Date(s.expires_at).getTime() <= Date.now()) {
      // Mark expired without deleting so the history shows how the session ended.
      await this.db.query(
        "UPDATE impersonation_sessions SET status='expired', ended_at=now() WHERE id=$1 AND status='active'",
        [s.id]
      ).catch(() => undefined);
      return null;
    }
    if (s.admin_user_id !== adminId) return null;

    // Validate target exists and is active
    let targetType: "user" | "shop" = "user";

    if (s.target_user_id) {
      const [u] = await this.db.query(
        `SELECT u.id, u.active, u.account_status, u.role, u.shop_id, sh.status AS shop_status
           FROM users u LEFT JOIN shops sh ON sh.id=u.shop_id WHERE u.id=$1`, [s.target_user_id]);
      if (!u || !u.active || u.account_status !== "active" || u.role === "system_admin"
          || !u.shop_id || u.shop_status !== "active") return null;
      targetType = "user";
    } else if (s.target_shop_id) {
      const [shop] = await this.db.query(`SELECT id, status FROM shops WHERE id=$1`, [s.target_shop_id]);
      if (!shop || shop.status !== "active") return null;
      targetType = "shop";
    } else {
      return null;
    }

    return { type: targetType, targetId: s.target_user_id ?? s.target_shop_id!, targetType, reason: s.reason };
  }

  /** Create a new impersonation session.
   *  Admin must provide: target user id or target shop id. The reason is optional (the console no
   *  longer asks for one) but a standard reason is always stored, because the column is NOT NULL
   *  and the accountability view must never show a blank entry.
   *  The session expires DEFAULT_IMPERSONATION_TTL_MINUTES from now,
   *  but may not exceed MAX_IMPERSONATION_TTL_MINUTES.
   */
  async createSession(
    adminId: string,
    targetUserId: string | null,
    targetShopId: string | null,
    reason?: string,
    customTtlMinutes?: number,
  ): Promise<{ sessionId: string; expiresAt: Date; reason: string }> {
    if (!targetUserId && !targetShopId) {
      throw new ForbiddenException("must_specify_target_user_or_shop");
    }
    // Access is one click from the admin console. A reason is still stored (the column is NOT
    // NULL and the accountability view shows it), but it no longer has to be typed in first.
    const trimmedReason = (reason ?? "").trim() || "Administrative access";

    // Targets are validated here, not only at request time: an administrator can never open an
    // inactive account, a suspended shop, or another platform administrator.
    if (targetUserId) {
      const [target] = await this.db.query(
        `SELECT u.id, u.active, u.account_status, u.role, u.shop_id, s.status AS shop_status
           FROM users u LEFT JOIN shops s ON s.id=u.shop_id WHERE u.id=$1`, [targetUserId]);
      if (!target || !target.active || target.account_status !== "active"
          || target.role === "system_admin" || !target.shop_id || target.shop_status !== "active") {
        throw new ForbiddenException("impersonation_target_unavailable");
      }
    }
    if (targetShopId) {
      const [shop] = await this.db.query("SELECT id, status FROM shops WHERE id=$1", [targetShopId]);
      if (!shop || shop.status !== "active") throw new ForbiddenException("impersonation_target_unavailable");
    }

    // One active administrative access session per administrator. Re-entering replaces the old
    // session instead of leaving an orphaned one behind (for example after a browser reload).
    await this.db.query(
      `UPDATE impersonation_sessions SET status='revoked', revoked_at=now()
        WHERE admin_user_id=$1 AND status='active'`, [adminId],
    );

    // TTL: respect a custom TTL if provided, otherwise defaults
    let ttlMinutes = DEFAULT_IMPERSONATION_TTL_MINUTES;
    if (customTtlMinutes !== undefined) {
      ttlMinutes = Math.min(
        Math.max(customTtlMinutes, 1),
        MAX_IMPERSONATION_TTL_MINUTES,
      );
    }

    const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);
    const sessionId = randomUUID();

    await this.db.query(
      `INSERT INTO impersonation_sessions(id, admin_user_id, target_user_id, target_shop_id, reason, expires_at, status) VALUES ($1,$2,$3,$4,$5,$6,'active')`,
      [sessionId, adminId, targetUserId, targetShopId, trimmedReason, expiresAt]
    );

    return { sessionId, expiresAt, reason: trimmedReason };
  }

  /**
   * End/revoke one administrative access session. The target's own login sessions and devices are
   * deliberately left untouched: an administrator leaving must be invisible to the account owner.
   */
  async endSession(sessionId: string, adminId: string): Promise<{ ended: boolean; targetShopId: string | null; targetUserId: string | null }> {
    const [s] = await this.db.query<any>(`SELECT * FROM impersonation_sessions WHERE id=$1`, [sessionId]);

    if (!s) return { ended: false, targetShopId: null, targetUserId: null };
    if (s.admin_user_id !== adminId) {
      throw new ForbiddenException("not_session_admin");
    }
    if (s.status !== "active") {
      return { ended: false, targetShopId: s.target_shop_id ?? null, targetUserId: s.target_user_id ?? null };
    }

    await this.db.query(`UPDATE impersonation_sessions SET status='revoked', revoked_at=now() WHERE id=$1`, [s.id]);

    return { ended: true, targetShopId: s.target_shop_id ?? null, targetUserId: s.target_user_id ?? null };
  }

  /** Get all active impersonation sessions for the admin. */
  async getAdminSessions(adminId: string) {
    return this.db.query<any[]>(`
      SELECT id, target_user_id, target_shop_id, reason, started_at, expires_at, status
      FROM impersonation_sessions
      WHERE admin_user_id=$1 AND status='active'
      ORDER BY started_at DESC
    `, [adminId]);
  }

  /** Check if the admin has any active impersonation session. */
  async hasActiveImpersonation(adminId: string): Promise<boolean> {
    const [row] = await this.db.query<any>(`
      SELECT count(*)::int AS n FROM impersonation_sessions
       WHERE admin_user_id=$1 AND status='active' AND expires_at > now()
    `, [adminId]);
    return (row?.n ?? 0) > 0;
  }
}