import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Query } from "@nestjs/common";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { Db } from "../db/db.service";
import { Me, Roles, type AuthUser } from "../common/auth";
import { audit } from "../audits/audit";

const NewUser = z.object({ email: z.string().email(), fullName: z.string().min(1).max(120), role: z.enum(["owner", "manager"]), shopId: z.string().uuid(), password: z.string().min(10).max(200) });
/** Every admin list is bounded and searchable: no endpoint ever returns an unbounded table. */
const Page = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
  q: z.string().trim().max(80).optional(),
});
const Reason = z.object({ reason: z.string().trim().min(3).max(500) });

/**
 * System administrator: accounts, shop lifecycle and platform health ONLY.
 * No route here (or anywhere) exposes a shop's sales, purchases, expenses or stock to this role —
 * platform administration stays separate from day-to-day shop operations.
 */
@Controller("admin") @Roles("system_admin")
export class AdminController {
  constructor(private db: Db) {}

  /* ------------------------------------------------------------------ accounts */

  @Get("users")
  async users(@Query() q: unknown) {
    const p = Page.parse(q);
    const like = p.q ? `%${p.q.toLowerCase()}%` : null;
    return this.db.query(
      `SELECT id, shop_id, email, full_name, role, active, account_status, created_at,
              (SELECT max(created_at) FROM refresh_sessions s WHERE s.user_id = users.id) AS last_seen_at
       FROM users
       WHERE ($1::text IS NULL OR lower(email) LIKE $1 OR lower(full_name) LIKE $1)
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [like, p.limit, p.offset]);
  }

  @Post("users") async create(@Me() u: AuthUser, @Body() b: unknown) {
    const n = NewUser.parse(b); const hash = await bcrypt.hash(n.password, 12);
    const [r] = await this.db.query("INSERT INTO users(shop_id,email,full_name,password_hash,role) VALUES ($1,$2,$3,$4,$5) RETURNING id", [n.shopId, n.email, n.fullName, hash, n.role]);
    await audit(this.db.pool, { shopId: n.shopId, actorId: u.id, action: "admin.user.create", entity: "user", entityId: r.id, newValue: { email: n.email, role: n.role } }); return r;
  }

  /** Revocation (lost/stolen device or leaver): bumps token_version so every issued token dies on its next request. */
  @Post("users/:id/revoke") @HttpCode(200) async revoke(@Me() u: AuthUser, @Param("id") id: string) {
    const r = await this.db.query("UPDATE users SET active=false, account_status='suspended', token_version=token_version+1 WHERE id=$1 AND role<>'system_admin' RETURNING shop_id", [id]);
    if (!r.length) throw new NotFoundException();
    await audit(this.db.pool, { shopId: r[0].shop_id, actorId: u.id, action: "admin.user.revoke", entity: "user", entityId: id }); return { ok: true };
  }

  /**
   * Reactivates a REVOKED account. Only `suspended` is eligible: `pending_activation` accounts must
   * still complete the single-use activation link, so this route can never bypass onboarding.
   */
  @Post("users/:id/activate") @HttpCode(200) async activate(@Me() u: AuthUser, @Param("id") id: string) {
    const r = await this.db.query("UPDATE users SET active=true, account_status='active' WHERE id=$1 AND account_status='suspended' AND role<>'system_admin' RETURNING shop_id", [id]);
    if (!r.length) throw new NotFoundException("not_suspended");
    await audit(this.db.pool, { shopId: r[0].shop_id, actorId: u.id, action: "admin.user.activate", entity: "user", entityId: id }); return { ok: true };
  }

  /* ------------------------------------------------------------------ shops */

  @Get("shops")
  async shops(@Query() q: unknown) {
    const p = Page.parse(q);
    const like = p.q ? `%${p.q.toLowerCase()}%` : null;
    return this.db.query(
      `SELECT s.id, s.name, s.currency, s.status, s.suspended_at, s.suspended_reason, s.created_at,
              s.location, s.category, u.full_name AS owner,
              (SELECT count(*)::int FROM users x WHERE x.shop_id = s.id) AS users,
              (SELECT count(*)::int FROM owner_applications a WHERE a.shop_id = s.id) AS applications
       FROM shops s LEFT JOIN users u ON u.role = 'owner' AND u.shop_id = s.id
       WHERE ($1::text IS NULL OR lower(s.name) LIKE $1)
       ORDER BY s.created_at DESC LIMIT $2 OFFSET $3`,
      [like, p.limit, p.offset]);
  }

  @Post("shops") async createShop(@Me() u: AuthUser, @Body() b: unknown) {
    const { name } = z.object({ name: z.string().min(1).max(120) }).parse(b);
    const [s] = await this.db.query("INSERT INTO shops(name) VALUES ($1) RETURNING id", [name]);
    await audit(this.db.pool, { shopId: null, actorId: u.id, action: "admin.shop.create", entity: "shop", entityId: s.id }); return s;
  }

  /**
   * Suspension is metadata, never a delete: sales, inventory, financial records and audit history
   * stay untouched, the reason is required and written to the audit log, and the change is one
   * atomic statement (nobody can act on a half-suspended shop).
   */
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

  /**
   * Platform audit trail: account, session and administrative events only (auth.*, admin.*, shop.*).
   * A shop's sales/purchase/expense activity is deliberately NOT readable here — the platform
   * administrator has no default access to a shop's daily financial records.
   */
  @Get("audit")
  async auditLog(@Query() q: unknown) {
    const p = Page.parse(q);
    const prefix = p.q ? `${p.q.trim()}%` : null;
    return this.db.query(
      `SELECT a.id, a.action, a.entity, a.entity_id, a.reason, a.at AS created_at,
              us.full_name AS actor, us.email AS actor_email
       FROM audit_log a LEFT JOIN users us ON us.id = a.actor_id
       WHERE (a.action LIKE 'auth.%' OR a.action LIKE 'admin.%' OR a.action LIKE 'shop.%' OR a.action LIKE 'staff.%' OR a.action LIKE 'application.%')
         AND ($1::text IS NULL OR a.action LIKE $1)
       ORDER BY a.id DESC LIMIT $2 OFFSET $3`,
      [prefix, p.limit, p.offset]);
  }

  /** Overview metrics — every number is a real count from the database, never a placeholder. */
  @Get("overview")
  async overview() {
    const q = async <T = any>(sql: string, params: unknown[] = []): Promise<T> => (await this.db.query<T>(sql, params))[0] as T;
    const shops = await q(`SELECT count(*)::int AS total,
        count(*) FILTER (WHERE status='active')::int AS active,
        count(*) FILTER (WHERE status='suspended')::int AS suspended FROM shops`);
    const apps = await q(`SELECT count(*)::int AS total,
        count(*) FILTER (WHERE status='PENDING_REVIEW')::int AS pending,
        count(*) FILTER (WHERE status='ADDITIONAL_INFORMATION_REQUIRED')::int AS info,
        count(*) FILTER (WHERE status='APPROVED')::int AS approved,
        count(*) FILTER (WHERE status='REJECTED')::int AS rejected FROM owner_applications`);
    const users = await q(`SELECT count(*)::int AS total,
        count(*) FILTER (WHERE role='owner')::int AS owners,
        count(*) FILTER (WHERE role='manager')::int AS managers,
        count(*) FILTER (WHERE role='system_admin')::int AS admins,
        count(*) FILTER (WHERE active)::int AS active,
        count(*) FILTER (WHERE account_status='suspended')::int AS suspended FROM users`);
    const recentApps = await this.db.query(
      `SELECT id, shop_name, contact_name, status, submitted_at FROM owner_applications ORDER BY submitted_at DESC LIMIT 5`);
    const recentActions = await this.db.query(
      `SELECT a.id, a.action, a.entity, a.reason, a.at AS created_at, us.full_name AS actor
       FROM audit_log a LEFT JOIN users us ON us.id = a.actor_id
       WHERE a.action LIKE 'admin.%' OR a.action LIKE 'shop.%' OR a.action LIKE 'staff.%' OR a.action LIKE 'application.%'
       ORDER BY a.id DESC LIMIT 8`);
    // Recorded security-relevant events (evidence), not a claim that anything was breached.
    const events = await q(
      `SELECT count(*)::int AS n FROM audit_log
       WHERE (action LIKE 'auth.%' OR action = 'admin.user.revoke' OR action = 'admin.shop.suspend')
         AND at > now() - interval '30 days'`);
    const health = await this.health();
    return {
      shops, applications: apps, users, recentApplications: recentApps, recentActions,
      securityEvents30d: events.n,
      openConflicts: health.open_conflicts,
      database: { status: health.status, time: health.db_time },
      generatedAt: new Date().toISOString(),
    };
  }

  @Get("health") async health() { const [r] = await this.db.query("SELECT now() AS db_time, (SELECT count(*) FROM operations WHERE status='conflict' AND resolved_at IS NULL)::int AS open_conflicts"); return { status: "ok", ...r }; }
}
