/**
 * Daily credit reporting over real HTTP and real PostgreSQL.
 *
 * The scenario is the one a shop owner reasons about: a credit sale on Monday, a cash repayment on
 * Wednesday, the balance by mobile money on Thursday. A repayment collects an existing receivable,
 * so it must appear in money received on its own day, must never raise sales revenue or profit, and
 * must reduce outstanding credit exactly once — including when its operation is replayed.
 *
 * TEST_DATABASE_URL is required and must name a test database (this file wipes schema public).
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
import { dayRange } from "@sms/shared";

process.env.JWT_SECRET = "credit-daily-test-secret-".padEnd(48, "x");
process.env.JWT_EXPIRES_IN = "15m";
const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : "TEST_DATABASE_URL not set";
process.env.DATABASE_URL = url ?? "";
const PASSWORD = "credit-daily-pass-123";
const OWNER = "owner@daily-credit.test";

let pool: Pool, app: any, base = "";
let token = "", shopId = "", ownerId = "", productId = "", customerId = "";

const call = async (method: string, path: string, body?: unknown, auth?: string) => {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data: any = null;
  try { data = await res.json(); } catch { /* empty body */ }
  return { status: res.status, data };
};
const push = async (op: unknown) => {
  const r = await call("POST", "/sync/push", { operations: [op] }, token);
  assert.ok(r.status < 300, `push failed: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data.results[0];
};
const op = (type: string, payload: unknown, createdAt: string) =>
  ({ opId: randomUUID(), deviceId: "daily-reporting", createdAt, type, payload });

// Kigali business days used by every assertion. Half-open [from, to) like the API itself.
const MON = dayRange("2026-01-05")!;
const TUE = dayRange("2026-01-06")!;
const WED = dayRange("2026-01-07")!;
const THU = dayRange("2026-01-08")!;
const FRI = dayRange("2026-01-09")!;
const JAN = { from: dayRange("2026-01-01")!.from, to: dayRange("2026-02-01")!.from };

const summary = async (range: { from: string; to: string }) => {
  const r = await call("GET", `/reports/summary?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`, undefined, token);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.current;
};
const dashboard = async (range: { from: string; to: string }) => {
  const r = await call("GET", `/reports/dashboard?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`, undefined, token);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
};
const repaymentsBetween = async (range: { from: string; to: string }) => {
  const r = await call("GET", `/reports/transactions?kind=repayments&from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`, undefined, token);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data as any[];
};

before(async () => {
  if (skip) return;
  const dbName = new URL(url!).pathname.replace(/^\//, "");
  if (!/test/i.test(dbName) && process.env.ALLOW_DESTRUCTIVE_TEST_DB !== "1") {
    throw new Error(`Refusing to wipe schema public in database "${dbName}": point TEST_DATABASE_URL at a dedicated test database`);
  }
  pool = new Pool({ connectionString: url });
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  const dir = join(process.cwd(), "migrations");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) await pool.query(readFileSync(join(dir, f), "utf8"));

  shopId = (await pool.query("INSERT INTO shops(name,status) VALUES ('Daily Credit Shop','active') RETURNING id")).rows[0].id;
  ownerId = (await pool.query(
    "INSERT INTO users(shop_id,email,full_name,password_hash,role) VALUES ($1,$2,'Owner',$3,'owner') RETURNING id",
    [shopId, OWNER, await bcrypt.hash(PASSWORD, 4)])).rows[0].id;

  // 1 kg loaf bought for 25,000 and sold for 35,000: gross profit must be exactly 10,000.
  productId = randomUUID();
  await pool.query(
    `INSERT INTO products(id,shop_id,code,name,category,unit,selling_price,low_stock_threshold,units_per_purchase,units_per_selling)
     VALUES ($1,$2,'LOAF','Loaf','test','kg',35000,1,1,1)`, [productId, shopId]);
  await pool.query(
    `INSERT INTO stock_movements(shop_id,product_id,type,qty,unit_cost,source_type,source_id,user_id,occurred_at)
     VALUES ($1,$2,'opening',1000,25000,'opening',$2,$3,'2026-01-01T08:00:00.000Z')`, [shopId, productId, ownerId]);

  customerId = randomUUID();
  await pool.query(
    "INSERT INTO customers(id,shop_id,name,phone,credit_limit) VALUES ($1,$2,'Mukamana Alice','0788123456',100000)",
    [customerId, shopId]);

  try { execSync("npx tsc -p tsconfig.json", { cwd: process.cwd(), stdio: "pipe" }); }
  catch (e: any) { throw new Error(`app build failed:\n${e?.stdout ?? ""}${e?.stderr ?? ""}`); }
  const { AppModule } = await import("../dist/app.module");
  const { NestFactory } = await import("@nestjs/core");
  app = await NestFactory.create(AppModule, { logger: ["error"] });
  await app.listen(0, "127.0.0.1");
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

  const login = await call("POST", "/auth/login", { email: OWNER, password: PASSWORD });
  assert.ok(login.status < 300, `login: ${login.status} ${JSON.stringify(login.data)}`);
  token = login.data.token;
});

after(async () => {
  if (skip) return;
  await app?.close();
  await pool.end();
});

test("a credit sale, then a cash and a mobile-money repayment, across three days", { skip }, async () => {
  /* ---------------------------------------------------------------- Monday: credit sale */
  const sale = await push(op("sale.create", {
    saleId: randomUUID(), soldAt: "2026-01-05T08:00:00.000Z", discount: 0, amountPaid: 0,
    paymentMethod: "credit", customerId, dueAt: "2026-01-20T08:00:00.000Z",
    lines: [{ productId, qty: 1000, unitPrice: 35000 }],
  }, "2026-01-05T08:00:00.000Z"));
  assert.equal(sale.status, "applied");

  const mon = await summary(MON);
  assert.equal(mon.netSales, 35_000, "Monday sales revenue");
  assert.equal(mon.cogs, 25_000, "Monday cost of goods sold");
  assert.equal(mon.grossProfit, 10_000, "Monday profit");
  assert.equal(mon.cashCollected, 0, "nothing collected on a full-credit sale");
  assert.equal(mon.creditRepayments, 0, "no repayment on Monday");
  assert.equal(mon.totalReceived, 0, "no money received on Monday");
  assert.equal(mon.outstandingCredit, 35_000, "Monday outstanding credit");
  assert.equal(mon.receivables, 35_000, "Monday credit issued");

  const monDash = await dashboard(MON);
  assert.equal(monDash.operations.cashCollected, 0);
  assert.equal(monDash.operations.creditRepayments, 0);
  assert.equal(monDash.operations.totalReceived, 0);
  assert.equal(monDash.operations.outstandingCredit, 35_000, "dashboard outstanding credit on Monday");
  assert.equal(monDash.financials.grossProfit, 10_000, "dashboard profit is unaffected by later repayments");

  /* ------------------------------------------- Wednesday: 20,000 in cash from the customer */
  const payWed = op("credit.payment.create", {
    paymentId: randomUUID(), customerId, amount: 20_000, paidAt: "2026-01-07T09:00:00.000Z",
    method: "cash", reference: "PAY-WED-0001",
  }, "2026-01-07T09:00:00.000Z");
  assert.equal((await push(payWed)).status, "applied");

  const wed = await summary(WED);
  assert.equal(wed.netSales, 0, "a repayment creates no sale");
  assert.equal(wed.cogs, 0);
  assert.equal(wed.grossProfit, 0, "a repayment creates no profit");
  assert.equal(wed.cashCollected, 0, "Wednesday has no new sale collection");
  assert.equal(wed.creditRepayments, 20_000, "Wednesday credit repayments");
  assert.equal(wed.totalReceived, 20_000, "Wednesday money received from this repayment");
  assert.deepEqual(wed.repaymentsByMethod, { cash: 20_000, momo: 0, bank: 0, other: 0 },
    "the repayment is counted under the method actually used, once");
  assert.equal(wed.outstandingCredit, 15_000, "outstanding credit after the cash repayment");

  const wedDash = await dashboard(WED);
  assert.equal(wedDash.operations.creditRepayments, 20_000);
  assert.equal(wedDash.operations.totalReceived, 20_000);
  assert.equal(wedDash.operations.cashCollected, 0);
  assert.equal(wedDash.operations.outstandingCredit, 15_000);
  assert.equal(wedDash.financials.netSales, 0);
  assert.equal(wedDash.financials.grossProfit, 0);

  const wedRows = await repaymentsBetween(WED);
  assert.equal(wedRows.length, 1, "one repayment transaction on Wednesday");
  assert.equal(Number(wedRows[0].amount), 20_000);
  assert.equal(wedRows[0].method, "cash");
  assert.equal(wedRows[0].customer, "Mukamana Alice");

  // Monday's own day still shows nothing collected: the repayment never moves to the sale date.
  assert.equal((await summary(MON)).creditRepayments, 0, "Monday still has no repayment");
  assert.equal((await summary(MON)).totalReceived, 0);
  // Yesterday's repayment never appears in today's totals.
  assert.equal((await summary(TUE)).creditRepayments, 0, "Tuesday has no repayment");
  assert.equal((await summary(THU)).creditRepayments, 0, "Thursday is still empty");

  /* --------------------------------- replaying the same repayment must not count it twice */
  const replay = await call("POST", "/sync/push", { operations: [payWed] }, token);
  assert.ok(replay.status < 300, `replay: ${replay.status} ${JSON.stringify(replay.data)}`);
  assert.equal(replay.data.results[0].status, "duplicate");
  assert.equal((await summary(WED)).creditRepayments, 20_000, "replay does not add a second repayment");
  assert.equal((await summary(WED)).outstandingCredit, 15_000, "replay does not reduce the balance twice");
  const count = Number((await pool.query("SELECT count(*)::int n FROM credit_payments WHERE shop_id=$1", [shopId])).rows[0].n);
  assert.equal(count, 1, "one repayment row on the server");

  /* -------------------------------------- Thursday: the remaining 15,000 by mobile money */
  assert.equal((await push(op("credit.payment.create", {
    paymentId: randomUUID(), customerId, amount: 15_000, paidAt: "2026-01-08T11:00:00.000Z",
    method: "momo", reference: "PAY-THU-0001",
  }, "2026-01-08T11:00:00.000Z"))).status, "applied");

  const thu = await summary(THU);
  assert.equal(thu.netSales, 0);
  assert.equal(thu.grossProfit, 0);
  assert.equal(thu.creditRepayments, 15_000);
  assert.equal(thu.totalReceived, 15_000);
  assert.equal(thu.repaymentsByMethod.momo, 15_000);
  assert.equal(thu.repaymentsByMethod.cash, 0, "Thursday's money is not also counted as cash");
  assert.equal(thu.outstandingCredit, 0, "the debt is fully settled");

  const thuRows = await repaymentsBetween(THU);
  assert.equal(thuRows.length, 1);
  assert.equal(thuRows[0].method, "momo");

  /* ------------------------------------------------- the month must not double-count anything */
  const month = await summary(JAN);
  assert.equal(month.netSales, 35_000, "one sale, once");
  assert.equal(month.cogs, 25_000);
  assert.equal(month.grossProfit, 10_000, "the original profit is recorded once and not repeated");
  assert.equal(month.cashCollected, 0, "the credit sale collected nothing at the counter");
  assert.equal(month.creditRepayments, 35_000, "cash 20,000 + mobile money 15,000");
  assert.equal(month.totalReceived, 35_000, "money received is collections + repayments, never both added twice");
  assert.deepEqual(month.repaymentsByMethod, { cash: 20_000, momo: 15_000, bank: 0, other: 0 });
  assert.equal(month.repaymentCount, 2);
  assert.equal(month.outstandingCredit, 0);
  assert.equal(month.transactions, 1, "repayments are not sales transactions");

  const monthRows = await repaymentsBetween(JAN);
  assert.deepEqual(monthRows.map((r) => Number(r.amount)).sort((a, b) => a - b), [15_000, 20_000]);
  assert.deepEqual(monthRows.map((r) => r.method).sort(), ["cash", "momo"]);

  const monthDash = await dashboard(JAN);
  assert.equal(monthDash.operations.totalReceived, 35_000);
  assert.equal(monthDash.operations.outstandingCredit, 0);
  assert.equal(monthDash.financials.grossProfit, 10_000);
  // The trend keeps repayments on their own series; they never inflate the revenue series.
  const repTrend = monthDash.trend.reduce((s: number, t: any) => s + (t.repayments ?? 0), 0);
  assert.equal(repTrend, 35_000, "trend repayments total the two payments");
  assert.equal(monthDash.trend.reduce((s: number, t: any) => s + t.netSales, 0), 35_000, "trend revenue is the sale only");

  /* ------------------------------------------------------- tomorrow must be empty, not stale */
  const fri = await summary(FRI);
  assert.equal(fri.creditRepayments, 0);
  assert.equal(fri.totalReceived, 0);
  assert.equal(fri.outstandingCredit, 0, "a settled balance stays settled");
});
