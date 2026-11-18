/**
 * Perpetual weighted average cost through the REAL sync pipeline and report services: PostgreSQL,
 * no mocks. Skipped automatically when TEST_DATABASE_URL is unset (the schema is wiped per run).
 *
 * Business scenario:
 *   12 @ 800 opening  -> inventory value 9,600
 *   8 @ 1,000 receipt -> 20 units, 17,600 -> average 880
 *   sell 5 @ 1,400    -> revenue 7,000, COGS 4,400, gross profit 2,600
 * A backdated delivery is then inserted BEFORE the sale; the sale's cost must not move.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID as uuid } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";

process.env.JWT_EXPIRES_IN = "15m";
const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : "TEST_DATABASE_URL not set";
process.env.DATABASE_URL = url ?? "";

let pool: Pool, db: any, svc: any, finance: any, sales: any;
let shop: string, owner: any;
const product = uuid();
const saleId = uuid();
const sale2 = uuid();
const product2 = uuid();
const sale3 = uuid();
const now = () => new Date().toISOString();
const op = (type: string, payload: object, createdAt = now()) => ({ opId: uuid(), deviceId: "costing-test", createdAt, type, payload });
const WIDE = { from: "2000-01-01T00:00:00.000Z", to: "2100-01-01T00:00:00.000Z" };

before(async () => {
  if (skip) return;
  pool = new Pool({ connectionString: url });
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  const dir = join(process.cwd(), "migrations");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) await pool.query(readFileSync(join(dir, f), "utf8"));

  const { Db } = await import("../src/db/db.service");
  const { SyncService } = await import("../src/sync/sync.service");
  const { FinanceService } = await import("../src/reports/finance.service");
  const { SalesController } = await import("../src/sales/sales.controller");
  db = new Db(); svc = new SyncService(db); finance = new FinanceService(db); sales = new SalesController(db);

  shop = (await pool.query("INSERT INTO shops(name) VALUES ('Costing shop') RETURNING id")).rows[0].id;
  const u = await pool.query(
    "INSERT INTO users(email_verified_at, shop_id,email,full_name,password_hash,role) VALUES (now(),$1,$2,$3,$4,'owner') RETURNING id",
    [shop, "owner@costing.test", "Costing Owner", "$2a$04$" + "0".repeat(53)]);
  owner = { id: u.rows[0].id, role: "owner", shopId: shop };

  const push = async (ops: any[]) => {
    const res = await svc.push(owner, "costing-dev", ops);
    for (const r of res) assert.equal(r.status, "applied", `op failed: ${r.status} ${r.message ?? ""}`);
    return res;
  };

  await push([
    // Initial stock: 12 units at 800. The opening movement is dated by the operation's createdAt.
    op("product.upsert", {
      productId: product, code: "COST-1", name: "Costed item", unit: "pcs",
      sellingPrice: 1200, lowStockThreshold: 0, initialQty: 12000, initialUnitCost: 800,
    }, "2026-01-01T06:00:00.000Z"),
    // 8 more at 1,000; the new selling price arrives with the delivery.
    op("purchase.create", {
      purchaseId: uuid(), supplierId: null, orderedAt: "2026-01-05T09:00:00.000Z", amountPaid: 8000,
      receiveNow: true, lines: [{ productId: product, qty: 8000, unitCost: 1000, sellingPrice: 1400 }],
    }),
    // Sell 5 at 1,400, then 3 more at the same price on the next day.
    op("sale.create", {
      saleId, soldAt: "2026-01-10T10:00:00.000Z", discount: 0, amountPaid: 7000, paymentMethod: "cash",
      lines: [{ productId: product, qty: 5000, unitPrice: 1400 }],
    }),
    op("sale.create", {
      saleId: sale2, soldAt: "2026-01-11T10:00:00.000Z", discount: 0, amountPaid: 4200, paymentMethod: "cash",
      lines: [{ productId: product, qty: 3000, unitPrice: 1400 }],
    }),
  ]);
});
after(async () => { if (skip) return; await db.onModuleDestroy(); await pool.end(); });

const saleLines = async () =>
  (await pool.query("SELECT sl.qty, sl.unit_price, sl.unit_cost FROM sale_lines sl WHERE sl.sale_id=$1", [saleId])).rows;
const saleMovements = async () =>
  (await pool.query("SELECT qty, unit_cost FROM stock_movements WHERE product_id=$1 AND type='sale' ORDER BY occurred_at, id", [product])).rows;

test("a sale is posted at the weighted average of the stock it came from", { skip }, async () => {
  const lines = await saleLines();
  assert.equal(Number(lines[0].unit_price), 1400);
  assert.equal(Number(lines[0].unit_cost), 880, "12 x 800 + 8 x 1000 = 17,600 / 20 = 880");

  const mv = await saleMovements();
  assert.deepEqual(mv.map((m: any) => Number(m.unit_cost)), [880, 880], "each sale movement records the cost it moved at");

  const p = await finance.period(shop, WIDE.from, WIDE.to);
  assert.equal(p.cogs, 7040, "5 x 880 + 3 x 880");
  assert.equal(p.netSales, 11200);
  assert.equal(p.grossProfit, 4160);
  assert.equal(p.closingInventoryValue, 10560, "12 units x 880 left");
  assert.equal(p.closingInventoryUnits, 12000);

  const rows = await finance.productProfitability(shop, WIDE.from, WIDE.to);
  const row = rows.find((r: any) => r.productId === product);
  assert.equal(row.avgCost, 880);
  assert.equal(row.cogs, 7040);
  assert.equal(row.revenue, 11200);
  assert.equal(row.grossProfit, 4160);
});

test("a later purchase changes the average going forward, never the sales already posted", { skip }, async () => {
  const received = await svc.push(owner, "costing-dev", [
    // Backdated BEFORE both sales: without a recorded cost this would restate their COGS.
    op("purchase.create", {
      purchaseId: uuid(), supplierId: null, orderedAt: "2026-01-03T09:00:00.000Z", amountPaid: 0,
      receiveNow: true, lines: [{ productId: product, qty: 2000, unitCost: 1200 }],
    }),
  ]);
  assert.equal(received[0].status, "applied");

  const p = await finance.period(shop, WIDE.from, WIDE.to);
  assert.equal(p.cogs, 7040, "the posted sales keep the 880 they recorded");
  assert.equal(p.closingInventoryUnits, 14000);
  // 17,600 + 2,400 - 7,040 = 12,960 for 14 units -> 925.71 -> 926
  assert.equal(p.closingInventoryValue, 12960);
  const rows = await finance.productProfitability(shop, WIDE.from, WIDE.to);
  assert.equal(rows.find((r: any) => r.productId === product).avgCost, 926);
});

test("voiding a sale returns the goods at the cost that sale recorded", { skip }, async () => {
  await sales.voidSale(owner, saleId, { reason: "customer changed their mind" });
  const ret = (await pool.query(
    "SELECT qty, unit_cost FROM stock_movements WHERE product_id=$1 AND type='sale_return'", [product])).rows;
  assert.equal(Number(ret[0].qty), 5000);
  assert.equal(Number(ret[0].unit_cost), 880, "restored at the original sale cost, not today's 926");

  const p = await finance.period(shop, WIDE.from, WIDE.to);
  assert.equal(p.cogs, 2640, "only the surviving 3-unit sale costs 3 x 880");
  assert.equal(p.closingInventoryUnits, 19000);
  assert.equal(p.closingInventoryValue, 17360);  // 12,960 + 5 x 880
});

test("a receipt entered before a sale counts even when its document timestamp is later (posting order)", { skip }, async () => {
  const push = async (ops: any[]) => {
    const res = await svc.push(owner, "costing-dev", ops);
    for (const r of res) assert.equal(r.status, "applied", `op failed: ${r.status} ${r.message ?? ""}`);
  };
  const purchaseId = uuid();
  await push([
    op("product.upsert", {
      productId: product2, code: "COST-2", name: "Posted-order item", unit: "pcs",
      sellingPrice: 1500, lowStockThreshold: 0, initialQty: 10000, initialUnitCost: 1000,
    }, "2026-01-01T06:00:00.000Z"),
    // Entered at 09:22 but stored with the mobile form's noon document date.
    op("purchase.create", {
      purchaseId, supplierId: null, orderedAt: "2026-01-02T12:00:00.000Z", amountPaid: 20000,
      receiveNow: true, lines: [{ productId: product2, qty: 10000, unitCost: 2000 }],
    }),
    // Posted after the receipt, at a time before the receipt's document date.
    op("sale.create", {
      saleId: sale3, soldAt: "2026-01-02T09:00:00.000Z", discount: 0, amountPaid: 7500, paymentMethod: "cash",
      lines: [{ productId: product2, qty: 5000, unitPrice: 1500 }],
    }),
  ]);

  const line = (await pool.query("SELECT unit_price, unit_cost FROM sale_lines WHERE sale_id=$1", [sale3])).rows[0];
  assert.equal(Number(line.unit_price), 1500);
  assert.equal(Number(line.unit_cost), 1500, "10 @ 1,000 + 10 @ 2,000 -> 1,500, not the old 1,000");
  const mv = (await pool.query("SELECT unit_cost FROM stock_movements WHERE source_type='sale' AND source_id=$1", [sale3])).rows[0];
  assert.equal(Number(mv.unit_cost), 1500);

  const rows = await finance.productProfitability(shop, WIDE.from, WIDE.to);
  const row = rows.find((r: any) => r.productId === product2);
  assert.equal(row.revenue, 7500);
  assert.equal(row.cogs, 7500);
  assert.equal(row.grossProfit, 0, "5 x 1,500 revenue against 5 x 1,500 cost");
});

test("posting order is applied to every later purchase and sale, and the snapshots stay historical", { skip }, async () => {
  const push = async (ops: any[]) => {
    const res = await svc.push(owner, "costing-dev", ops);
    for (const r of res) assert.equal(r.status, "applied", `op failed: ${r.status} ${r.message ?? ""}`);
  };
  const product3 = uuid();
  const first = uuid(), second = uuid();
  await push([
    op("product.upsert", {
      productId: product3, code: "COST-3", name: "Multi-purchase item", unit: "pcs",
      sellingPrice: 1200, lowStockThreshold: 0, initialQty: 10000, initialUnitCost: 1000,
    }, "2026-02-01T06:00:00.000Z"),
    // Test C: only the selling price changes; cost stays the 1,000 purchase cost.
    op("product.upsert", { productId: product3, code: "COST-3", name: "Multi-purchase item", unit: "pcs", sellingPrice: 1200, lowStockThreshold: 0 }, "2026-02-02T06:00:00.000Z"),
    op("sale.create", {
      saleId: first, soldAt: "2026-02-02T09:00:00.000Z", discount: 0, amountPaid: 6000, paymentMethod: "cash",
      lines: [{ productId: product3, qty: 5000, unitPrice: 1200 }],
    }),
    op("purchase.create", {
      purchaseId: uuid(), supplierId: null, orderedAt: "2026-02-03T12:00:00.000Z", amountPaid: 7000,
      receiveNow: true, lines: [{ productId: product3, qty: 5000, unitCost: 1400 }],
    }),
    op("sale.create", {
      saleId: second, soldAt: "2026-02-04T09:00:00.000Z", discount: 0, amountPaid: 6400, paymentMethod: "cash",
      lines: [{ productId: product3, qty: 4000, unitPrice: 1600 }],
    }),
  ]);

  const lines = (await pool.query("SELECT sale_id, unit_price, unit_cost FROM sale_lines WHERE sale_id = ANY($1::uuid[]) ORDER BY sale_id", [[first, second]])).rows;
  const bySale = new Map(lines.map((l: any) => [l.sale_id, l]));
  assert.equal(Number(bySale.get(first).unit_cost), 1000, "selling price 1,200 does not change the 1,000 cost");
  assert.equal(Number(bySale.get(second).unit_cost), 1200, "10 @ 1,000 then 5 @ 1,400, after selling 5 -> 1,200");
  const rows = await finance.productProfitability(shop, "2026-02-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z");
  const row = rows.find((r: any) => r.productId === product3);
  assert.equal(row.revenue, 6000 + 6400);
  assert.equal(row.cogs, 5000 + 4800);
  assert.equal(row.grossProfit, 2600);

  // A backdated receipt entered AFTER these sales must not rewrite either snapshot.
  await push([
    op("purchase.create", {
      purchaseId: uuid(), supplierId: null, orderedAt: "2026-02-01T12:00:00.000Z", amountPaid: 3000,
      receiveNow: true, lines: [{ productId: product3, qty: 1000, unitCost: 3000 }],
    }),
  ]);
  const after = (await pool.query("SELECT sale_id, unit_cost FROM sale_lines WHERE sale_id = ANY($1::uuid[]) ORDER BY sale_id", [[first, second]])).rows;
  assert.deepEqual(Object.fromEntries(after.map((l: any) => [l.sale_id, Number(l.unit_cost)])), { [first]: 1000, [second]: 1200 }, "posted sale costs are immutable");
  const rowAfter = (await finance.productProfitability(shop, "2026-02-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z"))
    .find((r: any) => r.productId === product3);
  assert.equal(rowAfter.cogs, row.cogs, "historical COGS does not move when a later receipt is backdated");
  assert.notEqual(rowAfter.avgCost, row.avgCost, "the receipt changes today's average and inventory value going forward");
});

test("changing only the selling price leaves the cost basis and inventory value untouched", { skip }, async () => {
  const before = await finance.period(shop, WIDE.from, WIDE.to);
  const res = await svc.push(owner, "costing-dev", [
    op("product.upsert", { productId: product, code: "COST-1", name: "Costed item", unit: "pcs", sellingPrice: 1200, lowStockThreshold: 0 }),
  ]);
  assert.equal(res[0].status, "applied");
  const after = await finance.period(shop, WIDE.from, WIDE.to);
  assert.equal(after.cogs, before.cogs);
  assert.equal(after.closingInventoryValue, before.closingInventoryValue);
  assert.equal(Number((await pool.query("SELECT selling_price FROM products WHERE id=$1", [product])).rows[0].selling_price), 1200);
});
