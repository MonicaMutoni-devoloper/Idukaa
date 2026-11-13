import { BadRequestException, Body, Controller, ForbiddenException, Get, NotFoundException, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { Db } from "../db/db.service";
import { Me, Roles, type AuthUser } from "../common/auth";
import { audit } from "../audits/audit";

const Checkout = z.object({ shopId: z.string().uuid().optional(), planCode: z.string().trim().min(1).max(40) });
const Verify = z.object({ paymentReference: z.string().trim().max(120).optional() });

const shape = (r: any) => r ? ({
  id: r.id, shopId: r.shop_id, planCode: r.plan_code, planName: r.plan_name,
  priceRwf: Number(r.price_rwf), durationDays: Number(r.duration_days),
  status: r.effective_status ?? r.status, startsAt: r.starts_at, endsAt: r.ends_at,
  paymentReference: r.payment_reference, activatedAt: r.activated_at, createdAt: r.created_at,
}) : null;

/**
 * Subscription lifecycle. Payment verification is deliberately administrator-controlled until a
 * real payment provider is connected: a frontend "paid" message never activates a shop.
 */
@Controller("subscriptions")
export class SubscriptionsController {
  constructor(private db: Db) {}

  @Get("plans") @Roles("owner", "manager", "system_admin")
  async plans() {
    const rows = await this.db.query(
      "SELECT id, code, name, price_rwf, duration_days FROM subscription_plans WHERE active=true ORDER BY price_rwf, duration_days");
    return rows.map((r: any) => ({ id: r.id, code: r.code, name: r.name, priceRwf: Number(r.price_rwf), durationDays: Number(r.duration_days) }));
  }

  @Get() @Roles("owner")
  async current(@Me() u: AuthUser) {
    if (!u.shopId) throw new BadRequestException("shop_required");
    const [row] = await this.db.query(
      `SELECT ss.*, p.code AS plan_code, p.name AS plan_name, p.price_rwf, p.duration_days,
              CASE WHEN ss.status='active' AND ss.ends_at IS NOT NULL AND ss.ends_at <= now() THEN 'expired' ELSE ss.status END AS effective_status
         FROM shop_subscriptions ss JOIN subscription_plans p ON p.id=ss.plan_id
        WHERE ss.shop_id=$1 ORDER BY ss.created_at DESC LIMIT 1`, [u.shopId]);
    const history = await this.db.query(
      `SELECT ss.*, p.code AS plan_code, p.name AS plan_name, p.price_rwf, p.duration_days,
              CASE WHEN ss.status='active' AND ss.ends_at IS NOT NULL AND ss.ends_at <= now() THEN 'expired' ELSE ss.status END AS effective_status
         FROM shop_subscriptions ss JOIN subscription_plans p ON p.id=ss.plan_id
        WHERE ss.shop_id=$1 ORDER BY ss.created_at DESC LIMIT 50`, [u.shopId]);
    const [shop] = await this.db.query("SELECT subscription_required FROM shops WHERE id=$1", [u.shopId]);
    return { required: !!shop?.subscription_required, current: shape(row), history: history.map(shape) };
  }

  /** Create or replace a pending subscription. No paid feature is enabled until an admin verifies it. */
  @Post("checkout") @Roles("owner")
  async checkout(@Me() u: AuthUser, @Body() body: unknown) {
    const b = Checkout.safeParse(body);
    if (!b.success) throw new BadRequestException(b.error.issues[0]?.message);
    const shopId = b.data.shopId ?? u.shopId;
    if (!shopId) throw new BadRequestException("shop_required");
    const [member] = await this.db.query(
      "SELECT role FROM shop_memberships WHERE user_id=$1 AND shop_id=$2 AND status='active'", [u.id, shopId]);
    if (!member || member.role !== "owner") throw new ForbiddenException("subscription_owner_only");
    const [plan] = await this.db.query("SELECT id, price_rwf, duration_days FROM subscription_plans WHERE code=$1 AND active=true", [b.data.planCode]);
    if (!plan) throw new NotFoundException("plan_not_found");
    return this.db.tx(async (c) => {
      const { rows: [active] } = await c.query(
        `SELECT ss.*, p.code AS plan_code, p.name AS plan_name, p.price_rwf, p.duration_days
           FROM shop_subscriptions ss JOIN subscription_plans p ON p.id=ss.plan_id
          WHERE ss.shop_id=$1 ORDER BY ss.created_at DESC LIMIT 1 FOR UPDATE OF ss`, [shopId]);
      if (active?.status === "active" && (!active.ends_at || new Date(active.ends_at).getTime() > Date.now())) {
        return { ok: true, alreadyActive: true, subscription: shape(active) };
      }
      // Clear every non-current row before inserting the renewal. An `active` row whose ends_at
      // has passed is no longer current, but still occupies the partial unique index until it is
      // explicitly marked expired here.
      await c.query(
        `UPDATE shop_subscriptions SET status='expired', updated_at=now()
          WHERE shop_id=$1 AND (status IN ('pending_payment','verification_required')
             OR (status='active' AND ends_at IS NOT NULL AND ends_at <= now()))`, [shopId]);
      const { rows: [row] } = await c.query(
        `INSERT INTO shop_subscriptions(shop_id, plan_id, status) VALUES ($1,$2,'pending_payment')
         RETURNING id, shop_id, status, starts_at, ends_at, created_at`, [shopId, plan.id]);
      await c.query("UPDATE shops SET subscription_required=true WHERE id=$1", [shopId]);
      await audit(c, { shopId, actorId: u.id, action: "subscription.checkout", entity: "shop_subscription", entityId: row.id,
        newValue: { planCode: b.data.planCode, priceRwf: Number(plan.price_rwf), status: "pending_payment" } });
      return { ok: true, alreadyActive: false, subscription: { ...shape({ ...row, plan_code: b.data.planCode, plan_name: "", price_rwf: plan.price_rwf, duration_days: plan.duration_days }), status: "pending_payment" } };
    });
  }

  /** System administrator controls pricing and plan availability; prices are never hardcoded in the app. */
  @Post("plans/:id") @Roles("system_admin")
  async updatePlan(@Me() u: AuthUser, @Param("id") id: string, @Body() body: unknown) {
    if (!z.string().uuid().safeParse(id).success) throw new NotFoundException("plan_not_found");
    const b = z.object({
      name: z.string().trim().min(2).max(80).optional(),
      priceRwf: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
      durationDays: z.number().int().min(1).max(3660).optional(),
      active: z.boolean().optional(),
    }).refine((v) => Object.keys(v).length > 0, "no_changes").safeParse(body);
    if (!b.success) throw new BadRequestException(b.error.issues[0]?.message);
    const v = b.data;
    return this.db.tx(async (c) => {
      const { rows: [old] } = await c.query("SELECT id, code, name, price_rwf, duration_days, active FROM subscription_plans WHERE id=$1 FOR UPDATE", [id]);
      if (!old) throw new NotFoundException("plan_not_found");
      const { rows: [row] } = await c.query(
        `UPDATE subscription_plans SET name=COALESCE($2,name), price_rwf=COALESCE($3,price_rwf),
                duration_days=COALESCE($4,duration_days), active=COALESCE($5,active)
          WHERE id=$1 RETURNING id, code, name, price_rwf, duration_days, active`,
        [id, v.name ?? null, v.priceRwf ?? null, v.durationDays ?? null, v.active ?? null]);
      await audit(c, { shopId: null, actorId: u.id, action: "subscription.plan.update", entity: "subscription_plan", entityId: id,
        oldValue: { name: old.name, priceRwf: Number(old.price_rwf), durationDays: Number(old.duration_days), active: old.active },
        newValue: { name: row.name, priceRwf: Number(row.price_rwf), durationDays: Number(row.duration_days), active: row.active } });
      return { id: row.id, code: row.code, name: row.name, priceRwf: Number(row.price_rwf), durationDays: Number(row.duration_days), active: row.active };
    });
  }

  @Get("admin/pending") @Roles("system_admin")
  async pending() {
    const rows = await this.db.query(
      `SELECT ss.*, p.code AS plan_code, p.name AS plan_name, p.price_rwf, p.duration_days, s.name AS shop_name
         FROM shop_subscriptions ss JOIN subscription_plans p ON p.id=ss.plan_id JOIN shops s ON s.id=ss.shop_id
        WHERE ss.status IN ('pending_payment','verification_required') ORDER BY ss.created_at`);
    return rows.map((r: any) => ({ ...shape(r), shopName: r.shop_name }));
  }

  /** Administrator confirms payment. This is the only path that activates paid functionality. */
  @Post(":id/verify") @Roles("system_admin")
  async verify(@Me() u: AuthUser, @Param("id") id: string, @Body() body: unknown) {
    if (!z.string().uuid().safeParse(id).success) throw new NotFoundException("subscription_not_found");
    const b = Verify.safeParse(body ?? {});
    if (!b.success) throw new BadRequestException(b.error.issues[0]?.message);
    return this.db.tx(async (c) => {
      const { rows: [sub] } = await c.query(
        `SELECT ss.*, p.duration_days, p.price_rwf FROM shop_subscriptions ss
           JOIN subscription_plans p ON p.id=ss.plan_id WHERE ss.id=$1 FOR UPDATE`, [id]);
      if (!sub) throw new NotFoundException("subscription_not_found");
      if (sub.status === "active") return { ok: true, alreadyActive: true, subscription: shape(sub) };
      if (!["pending_payment", "verification_required", "expired", "cancelled"].includes(sub.status)) {
        throw new BadRequestException("subscription_not_activatable");
      }
      await c.query("UPDATE shop_subscriptions SET status='expired', updated_at=now() WHERE shop_id=$1 AND status='active'", [sub.shop_id]);
      const startsAt = new Date();
      const endsAt = new Date(startsAt.getTime() + Number(sub.duration_days) * 86_400_000);
      const { rows: [row] } = await c.query(
        `UPDATE shop_subscriptions SET status='active', starts_at=$2, ends_at=$3, payment_reference=$4,
                activated_by=$5, activated_at=now(), updated_at=now() WHERE id=$1
         RETURNING id, shop_id, status, starts_at, ends_at, payment_reference, activated_at, created_at`,
        [id, startsAt, endsAt, b.data.paymentReference ?? null, u.id]);
      // Activation never overrides an administrator's suspension: it only turns on paid access.
      await c.query("UPDATE shops SET subscription_required=true WHERE id=$1", [sub.shop_id]);
      await audit(c, { shopId: sub.shop_id, actorId: u.id, action: "subscription.verify", entity: "shop_subscription", entityId: id,
        oldValue: { status: sub.status }, newValue: { status: "active", startsAt, endsAt, paymentReference: b.data.paymentReference ?? null } });
      return { ok: true, alreadyActive: false, subscription: shape({ ...row, duration_days: sub.duration_days, price_rwf: sub.price_rwf }) };
    });
  }
}
