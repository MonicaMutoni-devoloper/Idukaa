import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Patch, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { Db } from "../db/db.service";
import { Me, Roles, type AuthUser } from "../common/auth";
import { audit } from "../audits/audit";

const CustomerBody = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(2).max(120),
  phone: z.string().trim().max(30).optional(),
  address: z.string().trim().max(240).optional(),
  notes: z.string().trim().max(500).optional(),
  creditLimit: z.number().int().nonnegative().optional(),
});
const CustomerPatch = CustomerBody.partial().extend({ status: z.enum(["active", "blocked"]).optional() });
const Reminder = z.object({ message: z.string().trim().min(3).max(400).optional() });

const shape = (r: any) => ({
  id: r.id, name: r.name, phone: r.phone, address: r.address, notes: r.notes,
  creditLimit: Number(r.credit_limit), status: r.status, createdAt: r.created_at,
  balance: r.balance == null ? undefined : Number(r.balance),
  overdue: r.overdue == null ? undefined : Number(r.overdue),
  lastPaymentAt: r.last_payment_at ?? null,
});

const balanceSql = `
  COALESCE((SELECT SUM(s.gross_amount-s.discount-s.amount_paid) FROM sales s
             WHERE s.shop_id=c.shop_id AND s.customer_id=c.id AND s.status='posted'),0)
  - COALESCE((SELECT SUM(p.amount) FROM credit_payments p WHERE p.shop_id=c.shop_id AND p.customer_id=c.id),0)
  + COALESCE((SELECT SUM(a.amount) FROM credit_adjustments a WHERE a.shop_id=c.shop_id AND a.customer_id=c.id),0)`;

/** Customer credit is shop-scoped at every query; a customer id from another shop is a 404. */
@Controller("customers") @Roles("owner", "manager")
export class CustomersController {
  constructor(private db: Db) {}

  @Get()
  async list(@Me() u: AuthUser, @Query() q: any) {
    if (!u.shopId) throw new BadRequestException("shop_required");
    const search = typeof q.search === "string" ? q.search.trim() : "";
    const rows = await this.db.query(
      `SELECT c.*, ${balanceSql} AS balance,
              (SELECT COALESCE(SUM(s.gross_amount-s.discount-s.amount_paid),0) FROM sales s
                WHERE s.shop_id=c.shop_id AND s.customer_id=c.id AND s.status='posted'
                  AND s.due_at IS NOT NULL AND s.due_at < now()) AS overdue,
              (SELECT max(p.paid_at) FROM credit_payments p WHERE p.shop_id=c.shop_id AND p.customer_id=c.id) AS last_payment_at
         FROM customers c WHERE c.shop_id=$1
           AND ($2='' OR c.name ILIKE '%'||$2||'%' OR COALESCE(c.phone,'') ILIKE '%'||$2||'%')
         ORDER BY balance DESC, c.name LIMIT 500`, [u.shopId, search]);
    return rows.map(shape);
  }

  @Get("summary")
  async summary(@Me() u: AuthUser) {
    if (!u.shopId) throw new BadRequestException("shop_required");
    const [totals] = await this.db.query(
      `SELECT COALESCE(SUM(x.balance),0)::bigint outstanding,
              COALESCE(SUM(x.overdue),0)::bigint overdue,
              COUNT(*) FILTER (WHERE x.balance > 0)::int with_balance,
              COUNT(*) FILTER (WHERE x.limit_used >= 0.8 AND x.balance > 0)::int near_limit
         FROM (SELECT ${balanceSql} AS balance,
                      (SELECT COALESCE(SUM(s.gross_amount-s.discount-s.amount_paid),0) FROM sales s
                        WHERE s.shop_id=c.shop_id AND s.customer_id=c.id AND s.status='posted'
                          AND s.due_at IS NOT NULL AND s.due_at < now()) AS overdue,
                      CASE WHEN c.credit_limit > 0 THEN (${balanceSql})::numeric / c.credit_limit ELSE 0 END AS limit_used
                 FROM customers c WHERE c.shop_id=$1) x`, [u.shopId]);
    const [today] = await this.db.query(
      "SELECT COALESCE(SUM(amount),0)::bigint amount FROM credit_payments WHERE shop_id=$1 AND paid_at >= date_trunc('day', now() AT TIME ZONE 'Africa/Kigali') AT TIME ZONE 'Africa/Kigali'", [u.shopId]);
    const [month] = await this.db.query(
      "SELECT COALESCE(SUM(amount),0)::bigint amount FROM credit_payments WHERE shop_id=$1 AND paid_at >= date_trunc('month', now() AT TIME ZONE 'Africa/Kigali') AT TIME ZONE 'Africa/Kigali'", [u.shopId]);
    return {
      outstanding: Number(totals.outstanding), overdue: Number(totals.overdue),
      customersWithBalance: Number(totals.with_balance), nearLimit: Number(totals.near_limit),
      collectedToday: Number(today.amount), collectedThisMonth: Number(month.amount),
    };
  }

  @Get(":id")
  async get(@Me() u: AuthUser, @Param("id") id: string) {
    if (!z.string().uuid().safeParse(id).success) throw new NotFoundException("customer_not_found");
    const [row] = await this.db.query(`SELECT c.*, ${balanceSql} AS balance FROM customers c WHERE c.id=$1 AND c.shop_id=$2`, [id, u.shopId]);
    if (!row) throw new NotFoundException("customer_not_found");
    return shape(row);
  }

  @Get(":id/statement")
  async statement(@Me() u: AuthUser, @Param("id") id: string) {
    if (!z.string().uuid().safeParse(id).success) throw new NotFoundException("customer_not_found");
    const [customer] = await this.db.query(`SELECT c.*, ${balanceSql} AS balance FROM customers c WHERE c.id=$1 AND c.shop_id=$2`, [id, u.shopId]);
    if (!customer) throw new NotFoundException("customer_not_found");
    const sales = await this.db.query(
      `SELECT s.id, s.sold_at AS at, (s.gross_amount-s.discount) AS total, s.amount_paid,
              (s.gross_amount-s.discount-s.amount_paid) AS credit, s.due_at, s.status, u.full_name AS by
         FROM sales s JOIN users u ON u.id=s.user_id
        WHERE s.shop_id=$1 AND s.customer_id=$2 ORDER BY s.sold_at, s.id`, [u.shopId, id]);
    const payments = await this.db.query(
      "SELECT id, paid_at AS at, amount, method, reference, user_id FROM credit_payments WHERE shop_id=$1 AND customer_id=$2 ORDER BY paid_at, id", [u.shopId, id]);
    const adjustments = await this.db.query(
      "SELECT id, created_at AS at, amount, reason, user_id FROM credit_adjustments WHERE shop_id=$1 AND customer_id=$2 ORDER BY created_at, id", [u.shopId, id]);
    return { customer: shape(customer), sales: sales.map((r: any) => ({ ...r, total: Number(r.total), amountPaid: Number(r.amount_paid), credit: Number(r.credit) })),
      payments: payments.map((r: any) => ({ ...r, amount: Number(r.amount) })),
      adjustments: adjustments.map((r: any) => ({ ...r, amount: Number(r.amount) })) };
  }

  @Post()
  async create(@Me() u: AuthUser, @Body() body: unknown) {
    if (!u.shopId) throw new BadRequestException("shop_required");
    const b = CustomerBody.safeParse(body);
    if (!b.success) throw new BadRequestException(b.error.issues[0]?.message);
    const v = b.data;
    // Only an owner controls a credit line. A manager may register a customer with zero credit.
    const limit = u.role === "owner" ? v.creditLimit ?? 0 : 0;
    try {
      const [row] = await this.db.query(
        `INSERT INTO customers(id,shop_id,name,phone,address,notes,credit_limit)
         VALUES (COALESCE($1::uuid, gen_random_uuid()),$2,$3,$4,$5,$6,$7)
         RETURNING *`, [v.id ?? null, u.shopId, v.name, v.phone || null, v.address || null, v.notes || null, limit]);
      await audit(this.db.pool, { shopId: u.shopId, actorId: u.id, action: "customer.create", entity: "customer", entityId: row.id,
        newValue: { name: row.name, phone: row.phone, creditLimit: Number(row.credit_limit) } });
      return shape({ ...row, balance: 0 });
    } catch (e: any) {
      if (e?.code === "23505") throw new BadRequestException("customer_phone_in_use");
      throw e;
    }
  }

  @Patch(":id") @Roles("owner")
  async update(@Me() u: AuthUser, @Param("id") id: string, @Body() body: unknown) {
    if (!z.string().uuid().safeParse(id).success) throw new NotFoundException("customer_not_found");
    const b = CustomerPatch.safeParse(body);
    if (!b.success) throw new BadRequestException(b.error.issues[0]?.message);
    const v = b.data;
    return this.db.tx(async (c) => {
      const { rows: [old] } = await c.query("SELECT * FROM customers WHERE id=$1 AND shop_id=$2 FOR UPDATE", [id, u.shopId]);
      if (!old) throw new NotFoundException("customer_not_found");
      const { rows: [row] } = await c.query(
        `UPDATE customers SET name=COALESCE($2,name), phone=COALESCE($3,phone), address=COALESCE($4,address),
                notes=COALESCE($5,notes), credit_limit=COALESCE($6,credit_limit), status=COALESCE($7,status), updated_at=now()
          WHERE id=$1 RETURNING *`,
        [id, v.name ?? null, v.phone ?? null, v.address ?? null, v.notes ?? null, v.creditLimit ?? null, v.status ?? null]);
      await audit(c, { shopId: u.shopId, actorId: u.id, action: "customer.update", entity: "customer", entityId: id,
        oldValue: { name: old.name, phone: old.phone, creditLimit: Number(old.credit_limit), status: old.status },
        newValue: { name: row.name, phone: row.phone, creditLimit: Number(row.credit_limit), status: row.status } });
      return shape(row);
    });
  }

  /** Owner-only signed correction. Negative amounts may never push the account below zero. */
  @Post(":id/adjustments") @Roles("owner")
  async adjust(@Me() u: AuthUser, @Param("id") id: string, @Body() body: unknown) {
    if (!z.string().uuid().safeParse(id).success) throw new NotFoundException("customer_not_found");
    const b = z.object({ amount: z.number().int().refine((v) => v !== 0), reason: z.string().trim().min(3).max(500) }).safeParse(body);
    if (!b.success) throw new BadRequestException(b.error.issues[0]?.message);
    return this.db.tx(async (c) => {
      const { rows: [customer] } = await c.query(`SELECT c.*, ${balanceSql} AS balance FROM customers c WHERE c.id=$1 AND c.shop_id=$2 FOR UPDATE`, [id, u.shopId]);
      if (!customer) throw new NotFoundException("customer_not_found");
      if (Number(customer.balance) + b.data.amount < 0) throw new BadRequestException("adjustment_exceeds_balance");
      const { rows: [row] } = await c.query(
        "INSERT INTO credit_adjustments(shop_id,customer_id,user_id,amount,reason) VALUES ($1,$2,$3,$4,$5) RETURNING id, amount, reason, created_at",
        [u.shopId, id, u.id, b.data.amount, b.data.reason]);
      await audit(c, { shopId: u.shopId, actorId: u.id, action: "credit.adjustment", entity: "customer", entityId: id,
        oldValue: { balance: Number(customer.balance) }, newValue: { balance: Number(customer.balance) + b.data.amount, amount: b.data.amount }, reason: b.data.reason });
      return { ...row, amount: Number(row.amount) };
    });
  }

  /** Records a reminder as prepared. No SMS/WhatsApp provider is connected, so nothing is sent. */
  @Post(":id/reminders") @Roles("owner", "manager")
  async reminder(@Me() u: AuthUser, @Param("id") id: string, @Body() body: unknown) {
    if (!z.string().uuid().safeParse(id).success) throw new NotFoundException("customer_not_found");
    const b = Reminder.safeParse(body ?? {});
    if (!b.success) throw new BadRequestException(b.error.issues[0]?.message);
    const [customer] = await this.db.query(`SELECT c.*, ${balanceSql} AS balance FROM customers c WHERE c.id=$1 AND c.shop_id=$2`, [id, u.shopId]);
    if (!customer) throw new NotFoundException("customer_not_found");
    const message = b.data.message ?? `Reminder: your outstanding balance is ${Number(customer.balance)} RWF. Please arrange payment.`;
    const [row] = await this.db.query(
      `INSERT INTO credit_reminders(shop_id,customer_id,user_id,message) VALUES ($1,$2,$3,$4)
       RETURNING id, status, created_at`, [u.shopId, id, u.id, message]);
    await audit(this.db.pool, { shopId: u.shopId, actorId: u.id, action: "credit.reminder.prepared", entity: "customer", entityId: id,
      newValue: { reminderId: row.id, message, delivery: "not_sent" } });
    return { ...row, deliveryStatus: "not_sent", message };
  }
}
