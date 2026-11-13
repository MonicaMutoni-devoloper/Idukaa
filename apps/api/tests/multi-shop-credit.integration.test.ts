/**
 * Multi-shop, per-shop subscription, customer-credit and anomaly integration checks over real HTTP
 * and real PostgreSQL. Each file owns a throwaway schema; TEST_DATABASE_URL is required.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import "reflect-metadata";
import { execSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import bcrypt from "bcryptjs";

process.env.JWT_SECRET = "multi-shop-test-secret-".padEnd(48, "x");
process.env.JWT_EXPIRES_IN = "15m";
const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : "TEST_DATABASE_URL not set";
process.env.DATABASE_URL = url ?? "";
const PASSWORD = "multi-shop-pass-123";
const ADMIN = "admin@multishop.test";

let pool: Pool, app: any, base = "";
const ids: Record<string, string> = {};
const sessions = new Map<string, { token: string; user: any }>();

const call = async (method: string, path: string, body?: unknown, token?: string) => {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data: any = null;
  try { data = await res.json(); } catch { /* empty */ }
  return { status: res.status, data };
};
const msg = (d: any) => String(d?.message ?? d?.error ?? "");
const auth = async (email: string) => {
  const hit = sessions.get(email); if (hit) return hit;
  const r = await call("POST", "/auth/login", { email, password: PASSWORD });
  assert.ok(r.status < 300, `login ${email}: ${r.status} ${JSON.stringify(r.data)}`);
  sessions.set(email, r.data); return r.data;
};
const push = (token: string, op: unknown) => call("POST", "/sync/push", { operations: [op] }, token);
const op = (type: string, payload: unknown) => ({ opId: randomUUID(), deviceId: "integration", createdAt: new Date().toISOString(), type, payload });

async function addUser(email: string, name: string, role: "owner" | "manager" | "system_admin", shopId: string | null) {
  const r = await pool.query(
    "INSERT INTO users(shop_id,email,full_name,password_hash,role) VALUES ($1,$2,$3,$4,$5) RETURNING id",
    [shopId, email, name, await bcrypt.hash(PASSWORD, 4), role]);
  return r.rows[0].id as string;
}
async function addShop(name: string, status = "active") {
  const r = await pool.query("INSERT INTO shops(name,status) VALUES ($1,$2) RETURNING id", [name, status]);
  return r.rows[0].id as string;
}
async function addProduct(shopId: string, name: string, onHand = 0, cost = 1000) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO products(id,shop_id,code,name,category,unit,selling_price,low_stock_threshold,units_per_purchase,units_per_selling)
     VALUES ($1,$2,$3,$4,'test','unit',5000,10,1,1)`, [id, shopId, name.toUpperCase().replace(/\W/g, ""), name]);
  if (onHand) {
    await pool.query(
      `INSERT INTO stock_movements(shop_id,product_id,type,qty,unit_cost,source_type,source_id,user_id,occurred_at)
       VALUES ($1,$2,'opening',$3,$4,'opening',$2,$5,now()-interval '40 days')`, [shopId, id, onHand, cost, ids.ownerA]);
  }
  return id;
}
async function addCustomer(shopId: string, name: string, limit: number) {
  const id = randomUUID();
  await pool.query("INSERT INTO customers(id,shop_id,name,credit_limit) VALUES ($1,$2,$3,$4)", [id, shopId, name, limit]);
  return id;
}
async function insertSale(shopId: string, userId: string, at: string, gross: number, discount: number, paid: number, customerId?: string, productId?: string, lineQty = 1000, linePrice = gross) {
  const opId = randomUUID(), saleId = randomUUID();
  await pool.query(
    "INSERT INTO operations(op_id,shop_id,user_id,device_id,type,payload,status,client_created_at) VALUES ($1,$2,$3,'seed','sale.create','{}','applied',$4)",
    [opId, shopId, userId, at]);
  await pool.query(
    "INSERT INTO sales(id,shop_id,op_id,user_id,sold_at,gross_amount,discount,amount_paid,customer_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [saleId, shopId, opId, userId, at, gross, discount, paid, customerId ?? null]);
  if (productId) await pool.query(
    "INSERT INTO sale_lines(sale_id,product_id,qty,unit_price,line_amount) VALUES ($1,$2,$3,$4,$5)",
    [saleId, productId, lineQty, linePrice, Math.round((lineQty * linePrice) / 1000)]);
  return saleId;
}

before(async () => {
  if (skip) return;
  pool = new Pool({ connectionString: url });
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  const dir = join(process.cwd(), "migrations");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) await pool.query(readFileSync(join(dir, f), "utf8"));

  ids.admin = await addUser(ADMIN, "Platform Admin", "system_admin", null);
  ids.shopA = await addShop("Shop A");
  ids.shopB = await addShop("Shop B");
  ids.shopC = await addShop("Shop C");
  ids.shopD = await addShop("Pending Shop D");
  ids.shopE = await addShop("Empty Shop E");
  ids.ownerA = await addUser("owner-a@multishop.test", "Owner A", "owner", ids.shopA);
  ids.managerA = await addUser("manager-a@multishop.test", "Manager A", "manager", ids.shopA);
  ids.managerB = await addUser("manager-b@multishop.test", "Manager B", "manager", ids.shopB);
  ids.ownerB = await addUser("owner-b@multishop.test", "Owner B", "owner", ids.shopC);
  ids.ownerD = await addUser("owner-d@multishop.test", "Owner D", "owner", ids.shopD);
  ids.ownerE = await addUser("owner-e@multishop.test", "Owner E", "owner", ids.shopE);
  ids.shared = await addUser("shared@multishop.test", "Shared Employee", "manager", ids.shopA);
  // Owner A also owns B. The shared employee belongs to A and B.
  await pool.query("INSERT INTO shop_memberships(user_id,shop_id,role) VALUES ($1,$2,'owner') ON CONFLICT DO NOTHING", [ids.ownerA, ids.shopB]);
  await pool.query("INSERT INTO shop_memberships(user_id,shop_id,role) VALUES ($1,$2,'manager') ON CONFLICT DO NOTHING", [ids.shared, ids.shopB]);

  // D starts unpaid; E starts empty for false-positive checks.
  await pool.query("UPDATE shops SET subscription_required=true WHERE id=$1", [ids.shopD]);
  await pool.query("UPDATE shop_subscriptions SET status='expired' WHERE shop_id=$1", [ids.shopD]);
  await pool.query("INSERT INTO shop_subscriptions(shop_id,plan_id,status) SELECT $1,id,'pending_payment' FROM subscription_plans WHERE code='starter'", [ids.shopD]);

  ids.productA = await addProduct(ids.shopA, "Bread", 100_000, 1000);

  try { execSync("npx tsc -p tsconfig.json", { cwd: process.cwd(), stdio: "pipe" }); }
  catch (e: any) { throw new Error(`app build failed:\n${e?.stdout ?? ""}${e?.stderr ?? ""}`); }
  const { AppModule } = await import("../dist/app.module");
  const { NestFactory } = await import("@nestjs/core");
  app = await NestFactory.create(AppModule, { logger: ["error"] });
  await app.listen(0, "127.0.0.1");
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
});

after(async () => {
  if (skip) return;
  await app?.close();
  await pool.end();
});

test("membership: only authorized shops are reachable, and switching is server-side", { skip }, async () => {
  const a = await auth("owner-a@multishop.test");
  const ma = await auth("manager-a@multishop.test");
  const mb = await auth("manager-b@multishop.test");
  const b = await auth("owner-b@multishop.test");
  const shared = await auth("shared@multishop.test");

  const listA = await call("GET", "/shop/memberships", undefined, a.token);
  assert.equal(listA.status, 200);
  assert.deepEqual(listA.data.map((s: any) => s.id).sort(), [ids.shopA, ids.shopB].sort());

  for (const [token, target, label] of [
    [b.token, ids.shopA, "Owner B -> A"], [b.token, ids.shopB, "Owner B -> B"],
    [ma.token, ids.shopB, "Manager A -> B"], [mb.token, ids.shopA, "Manager B -> A"],
  ] as const) {
    const r = await call("POST", "/shop/switch", { shopId: target }, token);
    assert.equal(r.status, 403, label);
    assert.equal(msg(r.data), "shop_access_denied");
  }

  // A manager may not take the owner-only combined view.
  assert.equal((await call("GET", "/shop/command-centre", undefined, ma.token)).status, 403);

  const switched = await call("POST", "/shop/switch", { shopId: ids.shopB }, a.token);
  assert.equal(switched.status, 201, JSON.stringify(switched.data));
  assert.equal(switched.data.shopName, "Shop B");
  const me = await call("GET", "/auth/me", undefined, a.token);
  assert.equal(me.data.shopName, "Shop B");
  assert.equal((await call("GET", "/shop/profile", undefined, a.token)).data.name, "Shop B");
  assert.equal((await call("POST", "/shop/switch", { shopId: ids.shopA }, a.token)).status, 201);

  // The shared employee can work in both shops; no per-employee subscription exists.
  assert.equal((await call("GET", "/shop/profile", undefined, shared.token)).data.name, "Shop A");
  assert.equal((await call("POST", "/shop/switch", { shopId: ids.shopB }, shared.token)).status, 201);
  assert.equal((await call("GET", "/shop/profile", undefined, shared.token)).data.name, "Shop B");
  assert.equal((await call("POST", "/shop/switch", { shopId: ids.shopA }, shared.token)).status, 201);

  // Revocation is immediate: the same session loses the shop without waiting for a new token.
  await pool.query("UPDATE shop_memberships SET status='revoked' WHERE user_id=$1 AND shop_id=$2", [ids.shared, ids.shopB]);
  const revoked = await call("POST", "/shop/switch", { shopId: ids.shopB }, shared.token);
  assert.equal(revoked.status, 403);
  await pool.query("UPDATE shop_memberships SET status='active' WHERE user_id=$1 AND shop_id=$2", [ids.shared, ids.shopB]);

  // A foreign customer id is a 404, not a leak of its name or balance.
  const customer = await call("POST", "/customers", { name: "Shop A Customer", creditLimit: 100000 }, a.token);
  assert.equal(customer.status, 201, JSON.stringify(customer.data));
  ids.customerA = customer.data.id;
  assert.equal((await call("GET", `/customers/${ids.customerA}`, undefined, b.token)).status, 404);
});

test("subscription: pending, expired and cancelled shops are blocked; admin verification opens them", { skip }, async () => {
  const d = await auth("owner-d@multishop.test");
  const admin = await auth(ADMIN);

  const blocked = await call("GET", "/shop/staff", undefined, d.token);
  assert.equal(blocked.status, 403);
  assert.equal(msg(blocked.data), "subscription_inactive");
  const subView = await call("GET", "/subscriptions", undefined, d.token);
  assert.equal(subView.status, 200);
  assert.equal(subView.data.current.status, "pending_payment");

  const pending = await call("GET", "/subscriptions/admin/pending", undefined, admin.token);
  const sub = pending.data.find((s: any) => s.shopId === ids.shopD);
  assert.ok(sub);
  assert.equal((await call("POST", `/subscriptions/${sub.id}/verify`, {}, d.token)).status, 403, "owner cannot verify their own payment");
  const verified = await call("POST", `/subscriptions/${sub.id}/verify`, { paymentReference: "TEST-D" }, admin.token);
  assert.equal(verified.status, 201);
  assert.equal((await call("GET", "/shop/staff", undefined, d.token)).status, 200);

  // Expiry is derived from ends_at, not left active forever.
  await pool.query("UPDATE shop_subscriptions SET ends_at=now()-interval '1 minute' WHERE id=$1", [sub.id]);
  const expired = await call("GET", "/shop/staff", undefined, d.token);
  assert.equal(expired.status, 403);
  assert.equal((await call("GET", "/subscriptions", undefined, d.token)).data.current.status, "expired");

  // Renewal is another pending payment and another administrator decision.
  const checkout = await call("POST", "/subscriptions/checkout", { planCode: "starter" }, d.token);
  assert.equal(checkout.status, 201, JSON.stringify(checkout.data));
  const renew = (await call("GET", "/subscriptions/admin/pending", undefined, admin.token)).data.find((s: any) => s.shopId === ids.shopD);
  assert.ok(renew);
  assert.equal((await call("POST", `/subscriptions/${renew.id}/verify`, {}, admin.token)).status, 201);
  assert.equal((await call("GET", "/shop/staff", undefined, d.token)).status, 200);

  // A suspended shop stays suspended even if a payment is verified.
  await pool.query("UPDATE shops SET status='suspended' WHERE id=$1", [ids.shopD]);
  await pool.query("UPDATE shop_subscriptions SET status='cancelled' WHERE shop_id=$1", [ids.shopD]);
  await pool.query("INSERT INTO shop_subscriptions(shop_id,plan_id,status) SELECT $1,id,'pending_payment' FROM subscription_plans WHERE code='starter'", [ids.shopD]);
  const suspendedSub = (await call("GET", "/subscriptions/admin/pending", undefined, admin.token)).data.find((s: any) => s.shopId === ids.shopD);
  assert.equal((await call("POST", `/subscriptions/${suspendedSub.id}/verify`, {}, admin.token)).status, 201);
  assert.equal((await pool.query("SELECT status FROM shops WHERE id=$1", [ids.shopD])).rows[0].status, "suspended");
  assert.equal((await call("GET", "/shop/staff", undefined, d.token)).status, 200, "reads remain available while suspended");
  assert.equal((await call("PATCH", "/shop/profile", { name: "Nope" }, d.token)).status, 403, "writes stay closed");
  await pool.query("UPDATE shops SET status='active' WHERE id=$1", [ids.shopD]);

  // Cancelled status blocks access immediately.
  await pool.query("UPDATE shop_subscriptions SET status='cancelled' WHERE shop_id=$1", [ids.shopD]);
  assert.equal((await call("GET", "/shop/staff", undefined, d.token)).status, 403);
  await pool.query("UPDATE shop_subscriptions SET status='active', ends_at=now()+interval '30 days' WHERE id=$1", [suspendedSub.id]);

  // Pricing is system-admin only and audited.
  const plans = await call("GET", "/subscriptions/plans", undefined, admin.token);
  const plan = plans.data.find((p: any) => p.code === "starter");
  assert.equal((await call("POST", `/subscriptions/plans/${plan.id}`, { priceRwf: 11000 }, d.token)).status, 403);
  const changed = await call("POST", `/subscriptions/plans/${plan.id}`, { priceRwf: 11000 }, admin.token);
  assert.equal(changed.status, 201);
  assert.equal(changed.data.priceRwf, 11000);
  assert.ok(Number((await pool.query("SELECT count(*)::int n FROM audit_log WHERE action='subscription.plan.update' AND entity_id=$1", [plan.id])).rows[0].n) >= 1);
});

test("credit ledger: 50,000 sale, partial payments, duplicate and concurrent repayment safety", { skip }, async () => {
  const a = await auth("owner-a@multishop.test");
  const saleOp = op("sale.create", {
    saleId: randomUUID(), soldAt: new Date().toISOString(), discount: 0, amountPaid: 20000,
    paymentMethod: "cash", customerId: ids.customerA, dueAt: new Date(Date.now() + 86_400_000).toISOString(),
    lines: [{ productId: ids.productA, qty: 10000, unitPrice: 5000 }],
  });
  const applied = await push(a.token, saleOp);
  assert.equal(applied.status, 201, JSON.stringify(applied.data));
  assert.equal(applied.data.results[0].status, "applied", JSON.stringify(applied.data));

  let customer = await call("GET", `/customers/${ids.customerA}`, undefined, a.token);
  assert.equal(customer.data.balance, 30000);
  assert.equal(customer.data.overdue, 0);

  const pay1 = op("credit.payment.create", {
    paymentId: randomUUID(), customerId: ids.customerA, amount: 10000, paidAt: new Date().toISOString(),
    method: "momo", reference: `PAY-${randomUUID().slice(0, 8)}`,
  });
  assert.equal((await push(a.token, pay1)).data.results[0].status, "applied");
  customer = await call("GET", `/customers/${ids.customerA}`, undefined, a.token);
  assert.equal(customer.data.balance, 20000);

  const pay2 = op("credit.payment.create", {
    paymentId: randomUUID(), customerId: ids.customerA, amount: 20000, paidAt: new Date().toISOString(),
    method: "bank", reference: `PAY-${randomUUID().slice(0, 8)}`,
  });
  assert.equal((await push(a.token, pay2)).data.results[0].status, "applied");
  customer = await call("GET", `/customers/${ids.customerA}`, undefined, a.token);
  assert.equal(customer.data.balance, 0);

  // Replaying the exact operation is idempotent; a new operation for the same money is refused.
  assert.equal((await push(a.token, pay2)).data.results[0].status, "duplicate");
  const again = await push(a.token, op("credit.payment.create", {
    paymentId: randomUUID(), customerId: ids.customerA, amount: 1, paidAt: new Date().toISOString(),
    method: "cash", reference: `PAY-${randomUUID().slice(0, 8)}`,
  }));
  assert.equal(again.data.results[0].status, "rejected");
  assert.match(again.data.results[0].message, /payment_exceeds_balance/);
  assert.equal((await call("GET", `/customers/${ids.customerA}`, undefined, a.token)).data.balance, 0);

  // Concurrent repayments serialize on the customer row: two 6,000 claims cannot both consume 10,000.
  const c2 = await addCustomer(ids.shopA, "Concurrent Customer", 20000);
  const debt = await push(a.token, op("sale.create", {
    saleId: randomUUID(), soldAt: new Date().toISOString(), discount: 0, amountPaid: 0,
    paymentMethod: "credit", customerId: c2, dueAt: new Date(Date.now() - 86_400_000).toISOString(),
    lines: [{ productId: ids.productA, qty: 2000, unitPrice: 5000 }],
  }));
  assert.equal(debt.data.results[0].status, "applied");
  const paymentOps = [0, 1].map(() => op("credit.payment.create", {
    paymentId: randomUUID(), customerId: c2, amount: 6000, paidAt: new Date().toISOString(),
    method: "cash", reference: `PAY-${randomUUID().slice(0, 8)}`,
  }));
  const concurrent = await Promise.all(paymentOps.map((p) => push(a.token, p)));
  const statuses = concurrent.map((r) => r.data.results[0].status).sort();
  assert.deepEqual(statuses, ["applied", "rejected"]);
  const after = await call("GET", `/customers/${c2}`, undefined, a.token);
  assert.equal(after.data.balance, 4000);
  assert.equal(after.data.overdue, 4000, "payments cap the overdue figure instead of leaving it inflated");

  const statement = await call("GET", `/customers/${ids.customerA}/statement`, undefined, a.token);
  assert.equal(statement.status, 200);
  assert.equal(statement.data.sales[0].credit, 30000);
  assert.equal(statement.data.payments.reduce((n: number, p: any) => n + p.amount, 0), 30000);

  // A signed owner adjustment is audited and cannot take the account below zero.
  const adjusted = await call("POST", `/customers/${c2}/adjustments`, { amount: -1000, reason: "Goodwill correction" }, a.token);
  assert.equal(adjusted.status, 201);
  assert.equal((await call("GET", `/customers/${c2}`, undefined, a.token)).data.balance, 3000);
  assert.equal((await call("POST", `/customers/${c2}/adjustments`, { amount: -5000, reason: "Too much" }, a.token)).status, 400);
});

test("credit limits: zero means none, approvals hold stock, rejection moves nothing", { skip }, async () => {
  const a = await auth("owner-a@multishop.test");
  const ma = await auth("manager-a@multishop.test");
  await call("PATCH", "/shop/settings", { creditLimitPolicy: "owner_approval" }, a.token);

  const zero = await addCustomer(ids.shopA, "No Credit", 0);
  const denied = await push(ma.token, op("sale.create", {
    saleId: randomUUID(), soldAt: new Date().toISOString(), discount: 0, amountPaid: 0, paymentMethod: "credit",
    customerId: zero, dueAt: new Date(Date.now() + 86_400_000).toISOString(),
    lines: [{ productId: ids.productA, qty: 1000, unitPrice: 5000 }],
  }));
  assert.equal(denied.data.results[0].status, "rejected");
  assert.match(denied.data.results[0].message, /credit_limit_exceeded:0/);

  const limited = await addCustomer(ids.shopA, "Limited Customer", 10000);
  const pendingOp = op("sale.create", {
    saleId: randomUUID(), soldAt: new Date().toISOString(), discount: 0, amountPaid: 0, paymentMethod: "credit",
    customerId: limited, dueAt: new Date(Date.now() + 86_400_000).toISOString(),
    lines: [{ productId: ids.productA, qty: 3000, unitPrice: 5000 }],
  });
  const pending = await push(ma.token, pendingOp);
  assert.equal(pending.data.results[0].status, "pending_approval");
  const pendingRows = await call("GET", "/sales/pending-credit", undefined, a.token);
  assert.equal(pendingRows.status, 200);
  assert.equal(pendingRows.data.length, 1);
  const beforeStock = Number((await pool.query("SELECT COALESCE(SUM(qty),0)::bigint q FROM stock_movements WHERE product_id=$1", [ids.productA])).rows[0].q);

  const rejected = await call("POST", `/sales/${pendingRows.data[0].id}/reject-credit`, { reason: "Limit not approved" }, a.token);
  assert.equal(rejected.status, 201);
  const afterReject = Number((await pool.query("SELECT COALESCE(SUM(qty),0)::bigint q FROM stock_movements WHERE product_id=$1", [ids.productA])).rows[0].q);
  assert.equal(afterReject, beforeStock, "a rejected credit sale never touches stock");
  const replay = await push(ma.token, pendingOp);
  assert.equal(replay.data.results[0].status, "rejected");
  assert.equal(replay.data.results[0].message, "credit_rejected");

  const pending2 = await push(ma.token, op("sale.create", {
    saleId: randomUUID(), soldAt: new Date().toISOString(), discount: 0, amountPaid: 0, paymentMethod: "credit",
    customerId: limited, dueAt: new Date(Date.now() + 86_400_000).toISOString(),
    lines: [{ productId: ids.productA, qty: 3000, unitPrice: 5000 }],
  }));
  assert.equal(pending2.data.results[0].status, "pending_approval");
  const rows2 = await call("GET", "/sales/pending-credit", undefined, a.token);
  const approved = await call("POST", `/sales/${rows2.data[0].id}/approve-credit`, { reason: "Owner checked the customer" }, a.token);
  assert.equal(approved.status, 201);
  assert.equal(approved.data.status, "posted");
  const afterApprove = Number((await pool.query("SELECT COALESCE(SUM(qty),0)::bigint q FROM stock_movements WHERE product_id=$1", [ids.productA])).rows[0].q);
  assert.equal(afterApprove, beforeStock - 3000, "stock moves exactly once on approval");
  assert.equal((await call("GET", `/customers/${limited}`, undefined, a.token)).data.balance, 15000);

  // Reason override is audited, and a missing reason is refused.
  await call("PATCH", "/shop/settings", { creditLimitPolicy: "reason_override" }, a.token);
  const overrideCustomer = await addCustomer(ids.shopA, "Override Customer", 1000);
  const noReason = await push(ma.token, op("sale.create", {
    saleId: randomUUID(), soldAt: new Date().toISOString(), discount: 0, amountPaid: 0, paymentMethod: "credit",
    customerId: overrideCustomer, dueAt: new Date(Date.now() + 86_400_000).toISOString(),
    lines: [{ productId: ids.productA, qty: 1000, unitPrice: 5000 }],
  }));
  assert.equal(noReason.data.results[0].status, "rejected");
  assert.match(noReason.data.results[0].message, /credit_override_reason_required/);
  const withReason = await push(ma.token, op("sale.create", {
    saleId: randomUUID(), soldAt: new Date().toISOString(), discount: 0, amountPaid: 0, paymentMethod: "credit",
    customerId: overrideCustomer, creditOverrideReason: "Owner approved by phone",
    dueAt: new Date(Date.now() + 86_400_000).toISOString(),
    lines: [{ productId: ids.productA, qty: 1000, unitPrice: 5000 }],
  }));
  assert.equal(withReason.data.results[0].status, "applied");
  assert.ok(Number((await pool.query("SELECT count(*)::int n FROM audit_log WHERE action='sale.credit.override' AND new_value->>'customerId'=$1", [overrideCustomer])).rows[0].n) >= 1);
});

test("anomaly rules detect all six categories, deduplicate, reopen and stay shop-scoped", { skip }, async () => {
  const a = await auth("owner-a@multishop.test");
  const b = await auth("owner-b@multishop.test");
  const e = await auth("owner-e@multishop.test");

  // A new shop with almost no history must not manufacture comparison alerts.
  await insertSale(ids.shopE, ids.ownerE, new Date(Date.now() - 8 * 86_400_000).toISOString(), 10000, 5000, 10000);
  const empty = await call("POST", "/alerts/detect", {}, e.token);
  assert.equal(empty.status, 201);
  assert.equal(empty.data.sufficientHistory, false);

  const stockProduct = await addProduct(ids.shopA, "Stock Watch", 200_000);
  const marginProduct = await addProduct(ids.shopA, "Margin Watch", 100_000, 20000);
  // Baseline daily sales, then a 10x day.
  for (let d = 10; d >= 2; d--) {
    const at = new Date(Date.now() - d * 86_400_000).toISOString();
    await insertSale(ids.shopA, ids.ownerA, at, 5000, 0, 5000, undefined, stockProduct);
    await pool.query(
      `INSERT INTO stock_movements(shop_id,product_id,type,qty,source_type,source_id,user_id,occurred_at)
       VALUES ($1,$2,'sale',-1000,'sale',$3,$4,$5)`, [ids.shopA, stockProduct, randomUUID(), ids.ownerA, at]);
  }
  await insertSale(ids.shopA, ids.ownerA, new Date().toISOString(), 50000, 0, 50000, undefined, stockProduct);
  await pool.query(
    `INSERT INTO stock_movements(shop_id,product_id,type,qty,source_type,source_id,user_id,occurred_at)
     VALUES ($1,$2,'sale',-10000,'sale',$3,$4,now())`, [ids.shopA, stockProduct, randomUUID(), ids.ownerA]);

  // Discount: prior no-discount sale, recent 50% discount.
  await insertSale(ids.shopA, ids.ownerA, new Date(Date.now() - 9 * 86_400_000).toISOString(), 20000, 0, 20000);
  await insertSale(ids.shopA, ids.ownerA, new Date().toISOString(), 20000, 10000, 10000);

  // Margin: 10 units sold for 10,000 each against a 20,000 average receipt cost.
  await pool.query("UPDATE products SET selling_price=10000 WHERE id=$1", [marginProduct]);
  await pool.query(
    `INSERT INTO stock_movements(shop_id,product_id,type,qty,unit_cost,source_type,source_id,user_id,occurred_at)
     VALUES ($1,$2,'receipt',100000,20000,'purchase',$3,$4,now()-interval '20 days')`,
    [ids.shopA, marginProduct, randomUUID(), ids.ownerA]);
  await insertSale(ids.shopA, ids.ownerA, new Date(Date.now() - 2 * 86_400_000).toISOString(), 100000, 0, 100000, undefined, marginProduct, 10000, 10000);

  // Adjustments: three approved corrections in seven days.
  for (let i = 0; i < 3; i++) {
    const adjId = randomUUID(), opId = randomUUID();
    await pool.query("INSERT INTO operations(op_id,shop_id,user_id,device_id,type,payload,status,client_created_at) VALUES ($1,$2,$3,'seed','adjustment.request','{}','applied',now())", [opId, ids.shopA, ids.ownerA]);
    await pool.query(
      `INSERT INTO adjustments(id,shop_id,op_id,product_id,qty,reason,note,requested_by,status,decided_by,decided_at)
       VALUES ($1,$2,$3,$4,-1000,'correction','seed',$5,'approved',$5,now())`, [adjId, ids.shopA, opId, stockProduct, ids.ownerA]);
  }

  // Expense baseline then a spike. Every expense needs its idempotency operation row (FK).
  const addExpense = async (at: string, amount: number) => {
    const opId = randomUUID();
    await pool.query("INSERT INTO operations(op_id,shop_id,user_id,device_id,type,payload,status,client_created_at) VALUES ($1,$2,$3,'seed','expense.create','{}','applied',$4)", [opId, ids.shopA, ids.ownerA, at]);
    await pool.query("INSERT INTO expenses(id,shop_id,op_id,user_id,category,amount,paid,incurred_at) VALUES ($1,$2,$3,$4,'test',$5,true,$6)", [randomUUID(), ids.shopA, opId, ids.ownerA, amount, at]);
  };
  for (let d = 10; d >= 2; d--) await addExpense(new Date(Date.now() - d * 86_400_000).toISOString(), 1000);
  await addExpense(new Date().toISOString(), 50000);

  const risk = await addCustomer(ids.shopA, "Risk Customer", 1000);
  await insertSale(ids.shopA, ids.ownerA, new Date(Date.now() - 5 * 86_400_000).toISOString(), 900, 0, 0, risk);

  const first = await call("POST", "/alerts/detect", {}, a.token);
  assert.equal(first.status, 201, JSON.stringify(first.data));
  const categories = new Set((await call("GET", "/alerts?status=open", undefined, a.token)).data.map((x: any) => x.category));
  for (const c of ["stock_reduction", "discount", "margin", "adjustments", "expense", "credit_risk"]) assert.ok(categories.has(c), `missing ${c}`);
  assert.ok(!(await call("GET", "/alerts", undefined, a.token)).data.some((x: any) => /theft|fraud|stole/i.test(`${x.title} ${x.explanation}`)), "wording must not accuse");

  const count = Number((await pool.query("SELECT count(*)::int n FROM business_alerts WHERE shop_id=$1", [ids.shopA])).rows[0].n);
  const second = await call("POST", "/alerts/detect", {}, a.token);
  assert.equal(second.status, 201);
  assert.equal(Number((await pool.query("SELECT count(*)::int n FROM business_alerts WHERE shop_id=$1", [ids.shopA])).rows[0].n), count, "detect is idempotent per dedupe key");

  const alert = (await call("GET", "/alerts", undefined, a.token)).data[0];
  assert.equal((await call("GET", `/alerts/${alert.id}`, undefined, b.token)).status, 404, "another shop cannot read the alert");
  const investigating = await call("POST", `/alerts/${alert.id}/status`, { status: "investigating", note: "Checking the records" }, a.token);
  assert.equal(investigating.status, 201);
  const resolved = await call("POST", `/alerts/${alert.id}/status`, { status: "resolved", note: "Counted and explained" }, a.token);
  assert.equal(resolved.status, 201);
  assert.equal(resolved.data.status, "resolved");
  const after = await call("POST", "/alerts/detect", {}, a.token);
  assert.equal(after.status, 201);
  assert.ok(after.data.updated >= 1);
  const reopened = await call("GET", `/alerts/${alert.id}`, undefined, a.token);
  assert.equal(reopened.data.status, "open");
  assert.ok(reopened.data.events.some((ev: any) => ev.action === "reopened"));
  assert.ok(reopened.data.events.some((ev: any) => ev.action === "resolved" && ev.note === "Counted and explained"));
});
