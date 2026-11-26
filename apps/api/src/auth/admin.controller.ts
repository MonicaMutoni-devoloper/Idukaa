import { Body, Controller, Get, HttpCode, NotFoundException, Param, Patch, Post, Query } from "@nestjs/common";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { Db } from "../db/db.service";
import { Me, Roles, type AuthUser } from "../common/auth";
import { audit } from "../audits/audit";
import { EmailVerificationService } from "./email-verification.service";
import { ImpersonationService } from "./impersonation.service";

const NewUser = z.object({ email: z.string().email(), fullName: z.string().min(1).max(120), role: z.enum(["owner", "manager"]), shopId: z.string().uuid(), password: z.string().min(10).max(200) });
/** Every admin list is bounded and searchable: no endpoint ever returns an unbounded table. */
const Page = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
  q: z.string().trim().max(80).optional(),
});
const Reason = z.object({ reason: z.string().trim().min(3).max(500) });

/** Impersonation session creation payload */
const ImpersonateUser = z.object({
  targetUserId: z.string().uuid(),
  reason: z.string().trim().min(3).max(500),
});
const ImpersonateShop = z.object({
  targetShopId: z.string().uuid(),
  reason: z.string().trim().min(3).max(500),
});

/** End an impersonation session */
const EndSession = z.object({
  sessionId: z.string().uuid(),
});

/** Revoke a target user (bumps token_version) */
const RevokeUser = z.object({
  userId: z.string().uuid(),
});

/** Every admin list is bounded and searchable: no endpoint ever returns an unbounded table. */
@Controller("admin") @Roles("system_admin")
export class AdminController {
  constructor(private db: Db, private verification: EmailVerificationService, private impersonation: ImpersonationService) {}

  /* ------------------------------------------------------------------ impersonation */

  /** Create an impersonation session for a target user.
   *  Admin specifies the user and a mandatory reason. The session is short-lived.
   */
  @Post("impersonate/user") @HttpCode(201)   async impersonateUser(@Me() u: AuthUser, @Body() b: unknown) {
    const n = ImpersonateUser.parse(b);
    const { sessionId, expiresAt } = await this.impersonation.createSession(u.id, n.targetUserId, null, n.reason);
    const [target] = await this.db.query(
      `SELECT u.id, u.full_name, u.email, u.shop_id, s.name AS shop_name,
              COALESCE((SELECT m.role FROM shop_memberships m
                         WHERE m.user_id=u.id AND m.shop_id=u.shop_id AND m.status='active'), u.role) AS role
         FROM users u LEFT JOIN shops s ON s.id=u.shop_id WHERE u.id=$1`, [n.targetUserId]);
    await audit(this.db.pool, { shopId: target.shop_id, actorId: u.id, action: "admin.impersonate.user", entity: "impersonation_session", entityId: sessionId, newValue: { targetUserId: n.targetUserId, reason: n.reason } });
    return { sessionId, expiresAt, targetType: "user",
      target: { id: target.id, name: target.full_name, email: target.email, role: target.role, shopId: target.shop_id, shopName: target.shop_name } };
  }

  /** Create an impersonation session for a target shop.
   *  Admin specifies the shop and a mandatory reason. The session is short-lived.
   */
  @Post("impersonate/shop") @HttpCode(201)   async impersonateShop(@Me() u: AuthUser, @Body() b: unknown) {
    const n = ImpersonateShop.parse(b);
    const { sessionId, expiresAt } = await this.impersonation.createSession(u.id, null, n.targetShopId, n.reason);
    const [shop] = await this.db.query("SELECT id, name FROM shops WHERE id=$1", [n.targetShopId]);
    await audit(this.db.pool, { shopId: n.targetShopId, actorId: u.id, action: "admin.impersonate.shop", entity: "impersonation_session", entityId: sessionId, newValue: { targetShopId: n.targetShopId, reason: n.reason } });
    return { sessionId, expiresAt, targetType: "shop", target: { shopId: shop.id, shopName: shop.name } };
  }

  /** End the current impersonation session. The target's own login sessions are never touched. */
  @Post("impersonate/end") @HttpCode(200) async endImpersonation(@Me() u: AuthUser, @Body() b: unknown) {
    const n = EndSession.parse(b);
    const result = await this.impersonation.endSession(n.sessionId, u.id);
    await audit(this.db.pool, { shopId: result.targetShopId, actorId: u.id, action: "admin.impersonation_end", entity: "impersonation_session", entityId: n.sessionId, newValue: { targetUserId: result.targetUserId, targetShopId: result.targetShopId } });
    return { ended: result.ended };
  }

  /* ------------------------------------------------------------------ users (existing) */

  @Get("users") async users(@Query() q: unknown) {
    const p = Page.parse(q);
    const like = p.q ? `%${p.q.toLowerCase()}%` : null;
    return this.db.query(
      `SELECT users.id, users.shop_id, users.email, users.full_name, users.role, users.active,
              users.account_status, users.created_at, sh.name AS shop_name, app.phone,
              (SELECT max(created_at) FROM refresh_sessions s WHERE s.user_id = users.id) AS last_seen_at
         FROM users
         LEFT JOIN shops sh ON sh.id = users.shop_id
         LEFT JOIN LATERAL (
           SELECT phone FROM owner_applications a
            WHERE lower(a.email) = lower(users.email) ORDER BY a.created_at DESC LIMIT 1
         ) app ON true
        WHERE ($1::text IS NULL OR lower(users.email) LIKE $1 OR lower(users.full_name) LIKE $1
               OR COALESCE(app.phone,'') LIKE $1 OR lower(COALESCE(sh.name,'')) LIKE $1)
        ORDER BY users.created_at DESC LIMIT $2 OFFSET $3`,
      [like, p.limit, p.offset]);
  }

  @Post("users") async create(@Me() u: AuthUser, @Body() b: unknown) {
    const n = NewUser.parse(b); const hash = await bcrypt.hash(n.password, 12);
    const [r] = await this.db.query("INSERT INTO users(shop_id,email,full_name,password_hash,role) VALUES ($1,$2,$3,$4,$5) RETURNING id", [n.shopId, n.email, n.fullName, hash, n.role]);
    await audit(this.db.pool, { shopId: n.shopId, actorId: u.id, action: "admin.user.create", entity: "user", entityId: r.id, newValue: { email: n.email, role: n.role } });
    void this.verification.issue(r.id, n.email, n.fullName).catch(() => undefined);
    return r;
  }

  @Post("users/:id/revoke") @HttpCode(200) async revoke(@Me() u: AuthUser, @Param("id") id: string) {
    const r = await this.db.query("UPDATE users SET active=false, account_status='suspended', token_version=token_version+1 WHERE id=$1 AND role<>'system_admin' RETURNING shop_id", [id]);
    if (!r.length) throw new NotFoundException();
    await audit(this.db.pool, { shopId: r[0].shop_id, actorId: u.id, action: "admin.user.revoke", entity: "user", entityId: id });
    return { ok: true };
  }

  @Post("users/:id/activate") @HttpCode(200) async activate(@Me() u: AuthUser, @Param("id") id: string) {
    const r = await this.db.query("UPDATE users SET active=true, account_status='active' WHERE id=$1 AND account_status='suspended' AND role<>'system_admin' RETURNING shop_id", [id]);
    if (!r.length) throw new NotFoundException("not_suspended");
    await audit(this.db.pool, { shopId: r[0].shop_id, actorId: u.id, action: "admin.user.activate", entity: "user", entityId: id });
    return { ok: true };
  }

  /* ------------------------------------------------------------------ shops (existing) */

  @Get("shops") async shops(@Query() q: unknown) {
    const p = Page.parse(q);
    const like = p.q ? `%${p.q.toLowerCase()}%` : null;
    return this.db.query(
      `SELECT s.id, s.name, s.currency, s.status, s.suspended_at, s.suspended_reason, s.created_at,
              s.location, s.category, u.full_name AS owner, u.email AS owner_email, u.id AS owner_id,
              (SELECT count(*)::int FROM users x WHERE x.shop_id = s.id) AS users,
              (SELECT count(*)::int FROM users x WHERE x.shop_id = s.id AND x.role='manager') AS managers,
              (SELECT string_agg(x.full_name, ', ' ORDER BY x.full_name) FROM users x WHERE x.shop_id = s.id AND x.role='manager') AS manager_names,
              (SELECT count(*)::int FROM owner_applications a WHERE a.shop_id = s.id) AS applications
         FROM shops s LEFT JOIN users u ON u.role = 'owner' AND u.shop_id = s.id
        WHERE ($1::text IS NULL OR lower(s.name) LIKE $1 OR lower(COALESCE(u.full_name,'')) LIKE $1)
        ORDER BY s.created_at DESC LIMIT $2 OFFSET $3`,
      [like, p.limit, p.offset]);
  }

  @Post("shops") async createShop(@Me() u: AuthUser, @Body() b: unknown) {
    const { name } = z.object({ name: z.string().min(1).max(120) }).parse(b);
    const [s] = await this.db.query("INSERT INTO shops(name) VALUES ($1) RETURNING id", [name]);
    await audit(this.db.pool, { shopId: null, actorId: u.id, action: "admin.shop.create", entity: "shop", entityId: s.id });
    return s;
  }

  @Post("shops/:id/suspend") @HttpCode(200) async suspendShop(@Me() u: AuthUser, @Param("id") id: string, @Body() b: unknown) {
    const { reason } = Reason.parse(b);
    return this.db.tx(async (c) => {
      const r = await c.query("UPDATE shops SET status='suspended', suspended_at=now(), suspended_reason=$2 WHERE id=$1 AND status='active' RETURNING id", [id, reason]);
      if (!r.rowCount) throw new NotFoundException("shop_not_found_or_already_suspended");
      await audit(c, { shopId: null, actorId: u.id, action: "admin.shop.suspend", entity: "shop", entityId: id, reason, newValue: { status: "suspended" } });
      return { ok: true, status: "suspended" };
    });
  }

  @Post("shops/:id/reactivate") @HttpCode(200) async reactivateShop(@Me() u: AuthUser, @Param("id") id: string, @Body() b: unknown) {
    const { reason } = Reason.parse(b);
    return this.db.tx(async (c) => {
      const r = await c.query("UPDATE shops SET status='active', suspended_at=NULL, suspended_reason=NULL WHERE id=$1 AND status='suspended' RETURNING id", [id]);
      if (!r.rowCount) throw new NotFoundException("shop_not_found_or_not_suspended");
      await audit(c, { shopId: null, actorId: u.id, action: "admin.shop.reactivate", entity: "shop", entityId: id, reason, newValue: { status: "active" } });
      return { ok: true, status: "active" };
    });
  }

  /* ------------------------------------------------------------------ security & audit */

  @Get("audit") async auditLog(@Query() q: unknown) {
    const p = Page.parse(q);
    const prefix = p.q ? `${p.q.trim()}%` : null;
    return this.db.query(
      `SELECT a.id, a.action, a.entity, a.entity_id, a.reason, a.at AS created_at,
              a.impersonated, a.impersonation_session_id, a.on_behalf_of_user_id, a.sensitive,
              us.full_name AS actor, us.email AS actor_email,
              ob.full_name AS on_behalf_of
       FROM audit_log a
       LEFT JOIN users us ON us.id = a.actor_id
       LEFT JOIN users ob ON ob.id = a.on_behalf_of_user_id
       WHERE (a.action LIKE 'auth.%' OR a.action LIKE 'admin.%' OR a.action LIKE 'shop.%'
              OR a.action LIKE 'staff.%' OR a.action LIKE 'application.%' OR a.impersonated)
         AND ($1::text IS NULL OR a.action LIKE $1)
       ORDER BY a.id DESC LIMIT $2 OFFSET $3`,
      [prefix, p.limit, p.offset]);
  }

  @Get("overview") async overview() {
    const q = async <T = any>(sql: string, params: unknown[] = []): Promise<T> => (await this.db.query<T>(sql, params))[0] as T;
    const shops = await q(`SELECT count(*)::int AS total, count(*) FILTER (WHERE status='active')::int AS active, count(*) FILTER (WHERE status='suspended')::int AS suspended FROM shops`);
    const apps = await q(`SELECT count(*)::int AS total, count(*) FILTER (WHERE status='PENDING_REVIEW')::int AS pending, count(*) FILTER (WHERE status='ADDITIONAL_INFORMATION_REQUIRED')::int AS info, count(*) FILTER (WHERE status='APPROVED')::int AS approved, count(*) FILTER (WHERE status='REJECTED')::int AS rejected FROM owner_applications`);
    const users = await q(`SELECT count(*)::int AS total, count(*) FILTER (WHERE role='owner')::int AS owners, count(*) FILTER (WHERE role='manager')::int AS managers, count(*) FILTER (WHERE role='system_admin')::int AS admins, count(*) FILTER (WHERE active)::int AS active, count(*) FILTER (WHERE account_status='suspended')::int AS suspended FROM users`);
    const recentApps = await this.db.query(`SELECT id, status, email, full_name, created_at FROM owner_applications ORDER BY created_at DESC LIMIT 5`);
    return { shops, apps, users, recentApps };
  }

  /* ------------------------------------------------------------------ impersonation management */

  /** Get all active impersonation sessions for the admin. */
  @Get("impersonation/sessions") async getImpersonationSessions(@Me() u: AuthUser) {
    return this.impersonation.getAdminSessions(u.id);
  }

  /** Check if the admin has an active impersonation session. */
  @Get("impersonation/active") async hasActiveImpersonation(@Me() u: AuthUser) {
    return this.impersonation.hasActiveImpersonation(u.id);
  }

  /**
   * Historical administrative access sessions with their targets, newest first. This is the
   * accountability view: who entered which account or shop, why, when, and how it ended.
   */
  @Get("impersonation/history") async impersonationHistory(@Query() q: unknown) {
    const p = Page.parse(q);
    return this.db.query(
      `SELECT s.id, s.reason, s.started_at, s.expires_at, s.ended_at, s.revoked_at, s.status,
              s.admin_user_id, a.full_name AS admin_name, a.email AS admin_email,
              tu.full_name AS target_user, tu.email AS target_user_email,
              ts.name AS target_shop
         FROM impersonation_sessions s
         JOIN users a ON a.id = s.admin_user_id
         LEFT JOIN users tu ON tu.id = s.target_user_id
         LEFT JOIN shops ts ON ts.id = s.target_shop_id
        ORDER BY s.started_at DESC LIMIT $1 OFFSET $2`, [p.limit, p.offset]);
  }

  /** Every audited operation performed inside one administrative access session. */
  @Get("impersonation/:id/actions") async impersonationActions(@Param("id") id: string) {
    return this.db.query(
      `SELECT a.id, a.action, a.entity, a.entity_id, a.reason, a.at AS created_at,
              a.sensitive, a.old_value, a.new_value,
              ob.full_name AS on_behalf_of
         FROM audit_log a LEFT JOIN users ob ON ob.id = a.on_behalf_of_user_id
        WHERE a.impersonation_session_id = $1
        ORDER BY a.id DESC LIMIT 500`, [id]);
  }

  /** Revoke an administrative access session owned by the calling administrator. */
  @Post("impersonation/:id/revoke") @HttpCode(200) async revokeImpersonation(@Me() u: AuthUser, @Param("id") id: string) {
    const result = await this.impersonation.endSession(id, u.id);
    await audit(this.db.pool, { shopId: result.targetShopId, actorId: u.id, action: "admin.impersonation_revoke", entity: "impersonation_session", entityId: id, reason: "revoked by administrator" });
    return result;
  }
}