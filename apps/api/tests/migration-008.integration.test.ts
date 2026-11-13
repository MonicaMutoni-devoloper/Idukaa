/**
 * Migration 008 against a realistic pre-008 schema, not just a fresh database.
 *
 * Applies every earlier migration, inserts existing shops/users/sales, then applies 008 and checks
 * the backfill, constraints, generated columns, indexes and preserved rows. It also applies 008 a
 * second time to prove the SQL itself is re-runnable (the migration runner still records it once).
 * 009's composite shop/customer foreign keys are exercised against the same data.
 *
 * Runs only when TEST_DATABASE_URL points at a throwaway database; this file wipes its public schema.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";

const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : "TEST_DATABASE_URL not set";
let pool: Pool;
let shopA = "";
let shopB = "";
let ownerA = "";
let managerA = "";
let customerA = "";
let existingSale = "";

const migration = (name: string) => readFileSync(join(process.cwd(), "migrations", name), "utf8");

before(async () => {
  if (skip) return;
  pool = new Pool({ connectionString: url });
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  const dir = join(process.cwd(), "migrations");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
    if (f >= "008") continue; // hold 008/009 back for the pre-migration fixture
    await pool.query(readFileSync(join(dir, f), "utf8"));
  }

  const a = (await pool.query("INSERT INTO shops(name) VALUES ('Existing A') RETURNING id")).rows[0];
  const b = (await pool.query("INSERT INTO shops(name) VALUES ('Existing B') RETURNING id")).rows[0];
  shopA = a.id; shopB = b.id;
  const owner = (await pool.query(
    "INSERT INTO users(shop_id,email,full_name,password_hash,role) VALUES ($1,'owner-a@migration.test','Owner A','x','owner') RETURNING id",
    [shopA])).rows[0];
  ownerA = owner.id;
  const mgr = (await pool.query(
    "INSERT INTO users(shop_id,email,full_name,password_hash,role) VALUES ($1,'manager-a@migration.test','Manager A','x','manager') RETURNING id",
    [shopA])).rows[0];
  managerA = mgr.id;
  // Platform administrators have no shop and must never receive a membership row.
  await pool.query(
    "INSERT INTO users(shop_id,email,full_name,password_hash,role) VALUES (NULL,'admin@migration.test','Admin','x','system_admin')");

  const opId = "11111111-1111-4111-8111-111111111111";
  existingSale = "22222222-2222-4222-8222-222222222222";
  await pool.query(
    "INSERT INTO operations(op_id,shop_id,user_id,device_id,type,payload,status,client_created_at) VALUES ($1,$2,$3,'dev','sale.create','{}','applied',now())",
    [opId, shopA, ownerA]);
  await pool.query(
    "INSERT INTO sales(id,shop_id,op_id,user_id,sold_at,gross_amount,discount,amount_paid) VALUES ($1,$2,$3,$4,now(),10000,1000,4000)",
    [existingSale, shopA, opId, ownerA]);

  await pool.query(migration("008_multi_shop_credit_anomalies.sql"));
});

after(async () => {
  if (skip) return;
  await pool.end();
});

test("008 preserves pre-existing shops, users and sales", { skip }, async () => {
  assert.equal(Number((await pool.query("SELECT count(*)::int n FROM shops")).rows[0].n), 2);
  assert.equal(Number((await pool.query("SELECT count(*)::int n FROM users")).rows[0].n), 3);
  assert.equal(Number((await pool.query("SELECT count(*)::int n FROM sales")).rows[0].n), 1);
  const sale = (await pool.query("SELECT gross_amount, discount, amount_paid, credit_amount FROM sales WHERE id=$1", [existingSale])).rows[0];
  assert.equal(Number(sale.gross_amount), 10000);
  assert.equal(Number(sale.credit_amount), 5000, "the generated credit column reflects the existing row");
});

test("008 backfills memberships without inventing platform access", { skip }, async () => {
  const rows = await pool.query("SELECT user_id, shop_id, role, status FROM shop_memberships ORDER BY role");
  assert.equal(rows.rowCount, 2);
  assert.deepEqual(rows.rows.map((r) => r.role), ["manager", "owner"]);
  assert.ok(rows.rows.every((r) => r.shop_id === shopA && r.status === "active"));
  assert.equal((await pool.query("SELECT 1 FROM shop_memberships WHERE user_id=(SELECT id FROM users WHERE email='admin@migration.test')")).rowCount, 0);
  assert.equal(Number((await pool.query("SELECT count(*)::int n FROM shop_memberships WHERE user_id=$1", [managerA])).rows[0].n), 1);

  // The trigger keeps the membership table in step with a newly created shop account.
  const newUser = (await pool.query(
    "INSERT INTO users(shop_id,email,full_name,password_hash,role) VALUES ($1,'new@migration.test','New Manager','x','manager') RETURNING id",
    [shopB])).rows[0];
  const created = await pool.query("SELECT shop_id, role, status FROM shop_memberships WHERE user_id=$1", [newUser.id]);
  assert.equal(created.rowCount, 1);
  assert.equal(created.rows[0].shop_id, shopB);
  assert.equal(created.rows[0].status, "active");
});

test("008 grandfathers existing shops and creates no pending payment", { skip }, async () => {
  const shops = await pool.query("SELECT id, subscription_required, credit_limit_policy FROM shops ORDER BY name");
  assert.ok(shops.rows.every((s: any) => s.subscription_required === false));
  assert.ok(shops.rows.every((s: any) => s.credit_limit_policy === "block"));
  const subs = await pool.query("SELECT shop_id, status, starts_at, ends_at FROM shop_subscriptions ORDER BY shop_id");
  assert.equal(subs.rowCount, 2);
  assert.ok(subs.rows.every((s: any) => s.status === "active" && s.starts_at && s.ends_at === null));
});

test("008 creates the expected schema and indexes", { skip }, async () => {
  const tables = (await pool.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1::text[])",
    [["shop_memberships","subscription_plans","shop_subscriptions","customers","credit_payments","credit_reminders","credit_adjustments","business_alerts","alert_events"]],
  )).rows.map((r: any) => r.table_name).sort();
  assert.deepEqual(tables, ["alert_events","business_alerts","credit_adjustments","credit_payments","credit_reminders","customers","shop_memberships","shop_subscriptions","subscription_plans"].sort());

  const cols = (await pool.query(
    `SELECT table_name, column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema='public' AND (table_name,column_name) IN
        (('shops','subscription_required'),('shops','credit_limit_policy'),('customers','credit_limit'),
         ('sales','customer_id'),('sales','due_at'),('sales','credit_amount'),('credit_payments','amount'))`,
  )).rows;
  const get = (t: string, c: string) => cols.find((r: any) => r.table_name === t && r.column_name === c);
  assert.equal(get("shops", "subscription_required")?.data_type, "boolean");
  assert.equal(get("shops", "subscription_required")?.is_nullable, "NO");
  assert.match(String(get("shops", "subscription_required")?.column_default), /false/);
  assert.equal(get("customers", "credit_limit")?.data_type, "bigint");
  assert.equal(get("sales", "credit_amount")?.is_nullable, "YES");
  assert.equal(get("credit_payments", "amount")?.data_type, "bigint");

  const indexes = (await pool.query("SELECT indexname FROM pg_indexes WHERE schemaname='public'")).rows.map((r: any) => r.indexname);
  for (const name of [
    "shop_memberships_shop_idx", "shop_memberships_user_idx", "shop_subscriptions_current_idx",
    "customers_shop_phone_idx", "sales_customer_idx", "credit_payments_reference_idx",
    "credit_payments_customer_idx", "business_alerts_shop_idx", "alert_events_alert_idx",
  ]) assert.ok(indexes.includes(name), `missing index ${name}`);
});

test("008 constraints reject duplicate memberships, duplicate phones and invalid statuses", { skip }, async () => {
  await assert.rejects(
    pool.query("INSERT INTO shop_memberships(user_id,shop_id,role) VALUES ($1,$2,'manager')", [ownerA, shopA]),
    (e: any) => e.code === "23505",
  );

  customerA = "33333333-3333-4333-8333-333333333333";
  await pool.query("INSERT INTO customers(id,shop_id,name,phone) VALUES ($1,$2,'Alice','+250788000001')", [customerA, shopA]);
  await assert.rejects(
    pool.query("INSERT INTO customers(id,shop_id,name,phone) VALUES (gen_random_uuid(),$1,'Duplicate','+250788000001')", [shopA]),
    (e: any) => e.code === "23505",
  );
  // The same phone in another shop is a different customer.
  await pool.query("INSERT INTO customers(id,shop_id,name,phone) VALUES (gen_random_uuid(),$1,'Alice B','+250788000001')", [shopB]);

  const opId = "44444444-4444-4444-8444-444444444444";
  await pool.query(
    "INSERT INTO operations(op_id,shop_id,user_id,device_id,type,payload,status,client_created_at) VALUES ($1,$2,$3,'dev','sale.create','{}','applied',now())",
    [opId, shopA, ownerA]);
  await assert.rejects(
    pool.query("INSERT INTO sales(id,shop_id,op_id,user_id,sold_at,gross_amount,discount,amount_paid,status) VALUES (gen_random_uuid(),$1,$2,$3,now(),1,0,0,'not_a_status')", [shopA, opId, ownerA]),
    (e: any) => e.code === "23514",
  );
  await pool.query(
    "INSERT INTO sales(id,shop_id,op_id,user_id,sold_at,gross_amount,discount,amount_paid,status) VALUES (gen_random_uuid(),$1,$2,$3,now(),1,0,0,'pending_approval')",
    [shopA, opId, ownerA]);
});

test("008 is re-runnable and 009 enforces shop-scoped customer references", { skip }, async () => {
  await pool.query(migration("008_multi_shop_credit_anomalies.sql"));
  await pool.query(migration("009_credit_shop_isolation.sql"));

  assert.equal(Number((await pool.query("SELECT count(*)::int n FROM shop_memberships WHERE user_id=$1", [ownerA])).rows[0].n), 1);
  assert.equal(Number((await pool.query("SELECT count(*)::int n FROM shop_subscriptions WHERE shop_id=$1", [shopA])).rows[0].n), 1);

  // A sale in Shop B cannot point at Shop A's customer, even if application code forgets a check.
  const opId = "55555555-5555-4555-8555-555555555555";
  await pool.query(
    "INSERT INTO operations(op_id,shop_id,user_id,device_id,type,payload,status,client_created_at) VALUES ($1,$2,$3,'dev','sale.create','{}','applied',now())",
    [opId, shopB, ownerA]);
  await assert.rejects(
    pool.query("INSERT INTO sales(id,shop_id,op_id,user_id,sold_at,gross_amount,discount,amount_paid,customer_id) VALUES (gen_random_uuid(),$1,$2,$3,now(),1,0,0,$4)", [shopB, opId, ownerA, customerA]),
    (e: any) => e.code === "23503",
  );

  const fks = (await pool.query(
    `SELECT conname FROM pg_constraint WHERE conname = ANY($1::text[])`,
    [["sales_customer_shop_fk","credit_payments_customer_shop_fk","credit_reminders_customer_shop_fk","credit_adjustments_customer_shop_fk"]],
  )).rows.map((r: any) => r.conname).sort();
  assert.deepEqual(fks, ["credit_adjustments_customer_shop_fk","credit_payments_customer_shop_fk","credit_reminders_customer_shop_fk","sales_customer_shop_fk"]);
});
