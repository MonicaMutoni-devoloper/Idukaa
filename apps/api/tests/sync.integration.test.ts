/**
 * REAL integration tests: real PostgreSQL, real SyncService, real SQL constraints. No mocks.
 * Run:  TEST_DATABASE_URL=postgres://... npm run test -w @sms/api   (uses a fresh schema per run)
 * Skipped automatically when TEST_DATABASE_URL is unset.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID as uuid } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import bcrypt from "bcryptjs";
import { costPerBaseUnit, toBaseQty } from "@sms/shared";

const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : "TEST_DATABASE_URL not set";
process.env.DATABASE_URL = url ?? "";

let db: any, svc: any, shopA: string, shopB: string, mgr: any, mgrB: any, owner: any, pid: string, pool: Pool;
const now = () => new Date().toISOString();
const op = (type: string, payload: any, opId = uuid()) => ({ opId, deviceId: "test-device", createdAt: now(), type, payload });

before(async () => {
  if (skip) return;
  pool = new Pool({ connectionString: url });
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  const dir = join(process.cwd(), "migrations");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) await pool.query(readFileSync(join(dir, f), "utf8"));
  const { Db } = await import("../src/db/db.service");
  const { SyncService } = await import("../src/sync/sync.service");
  db = new Db(); svc = new SyncService(db);
  shopA = (await pool.query("INSERT INTO shops(name) VALUES ('A (test fixture)') RETURNING id")).rows[0].id;
  shopB = (await pool.query("INSERT INTO shops(name) VALUES ('B (test fixture)') RETURNING id")).rows[0].id;
  const mk = async (shop: string, role: string, email: string) => ({ id: (await pool.query("INSERT INTO users(shop_id,email,full_name,password_hash,role) VALUES ($1,$2,'t','x',$3) RETURNING id", [shop, email, role])).rows[0].id, role, shopId: shop });
  mgr = await mk(shopA, "manager", "m@a.test"); owner = await mk(shopA, "owner", "o@a.test"); mgrB = await mk(shopB, "manager", "m@b.test");
  pid = uuid();
  const r = await svc.push(mgr, "d", [op("product.upsert", { productId: pid, code: "SUG", name: "Sugar 1kg", unit: "pcs", sellingPrice: 1500, lowStockThreshold: 5000, initialQty: 50_000, initialUnitCost: 1000 })]);
  assert.equal(r[0].status, "applied");
});
after(async () => { if (!skip) { await db.onModuleDestroy(); await pool.end(); } });
const onHand = async () => Number((await pool.query("SELECT COALESCE(SUM(qty),0) q FROM stock_movements WHERE product_id=$1", [pid])).rows[0].q);

test("sale reduces stock via ledger and is idempotent on replay", { skip }, async () => {
  const saleOp = op("sale.create", { saleId: uuid(), soldAt: now(), discount: 0, amountPaid: 3000, lines: [{ productId: pid, qty: 2000, unitPrice: 1500 }] });
  const before = await onHand();
  assert.equal((await svc.push(mgr, "d", [saleOp]))[0].status, "applied");
  assert.equal((await svc.push(mgr, "d", [saleOp]))[0].status, "duplicate"); // same opId replayed
  assert.equal(await onHand(), before - 2000);
  assert.equal(Number((await pool.query("SELECT count(*) FROM sales WHERE op_id=$1", [saleOp.opId])).rows[0].count), 1);
});

test("selling more than on-hand becomes a conflict, posts nothing, and is kept for owner review", { skip }, async () => {
  const before = await onHand();
  const o = op("sale.create", { saleId: uuid(), soldAt: now(), discount: 0, amountPaid: 0, lines: [{ productId: pid, qty: before + 1000, unitPrice: 1500 }] });
  const r = (await svc.push(mgr, "d", [o]))[0];
  assert.equal(r.status, "conflict"); assert.equal(await onHand(), before);
  assert.equal((await svc.push(mgr, "d", [o]))[0].status, "conflict"); // replay returns the ORIGINAL outcome
  const row = (await pool.query("SELECT status FROM operations WHERE op_id=$1", [o.opId])).rows[0]; assert.equal(row.status, "conflict");
});

test("partial deliveries: cumulative receipts cannot exceed ordered quantity", { skip }, async () => {
  const purchaseId = uuid(), before = await onHand();
  assert.equal((await svc.push(mgr, "d", [op("purchase.create", { purchaseId, supplierId: null, orderedAt: now(), amountPaid: 0, receiveNow: false, lines: [{ productId: pid, qty: 10_000, unitCost: 1100 }] })]))[0].status, "applied");
  const rc = (q: number) => op("receipt.create", { receiptId: uuid(), purchaseId, receivedAt: now(), lines: [{ productId: pid, qty: q }] });
  assert.equal((await svc.push(mgr, "d", [rc(6000)]))[0].status, "applied");
  assert.equal((await svc.push(mgr, "d", [rc(5000)]))[0].status, "conflict"); // 6+5 > 10
  assert.equal((await svc.push(mgr, "d", [rc(4000)]))[0].status, "applied");
  assert.equal(await onHand(), before + 10_000);
});

test("stock count with a 3-unit shortfall opens an investigation and does not change stock", { skip }, async () => {
  const have = await onHand(), countId = uuid();
  assert.equal((await svc.push(mgr, "d", [op("count.submit", { countId, countedAt: now(), lines: [{ productId: pid, counted: have - 3000 }] })]))[0].status, "applied");
  const inv = (await pool.query("SELECT difference, status FROM investigations WHERE count_id=$1", [countId])).rows[0];
  assert.equal(Number(inv.difference), -3000); assert.equal(inv.status, "open"); assert.equal(await onHand(), have);
});

test("adjustments need owner approval before stock moves", { skip }, async () => {
  const have = await onHand(), adjustmentId = uuid();
  assert.equal((await svc.push(mgr, "d", [op("adjustment.request", { adjustmentId, productId: pid, qty: -1000, reason: "damage", note: "dropped box" })]))[0].status, "pending_approval");
  assert.equal(await onHand(), have);
});

test("the owner inherits every manager operation, and another shop still cannot touch these records", { skip }, async () => {
  const saleLine = [{ productId: pid, qty: 1000, unitPrice: 1500 }];
  const sale = (saleId: string) => op("sale.create", { saleId, soldAt: now(), discount: 0, amountPaid: 1500, lines: saleLine });

  // The three operations the owner used to be refused by the sync table: selling, counting and
  // requesting a correction (all three were `["manager"]`).
  const before = await onHand();
  const ownerSaleId = uuid();
  assert.equal((await svc.push(owner, "d", [sale(ownerSaleId)]))[0].status, "applied", "an owner records a sale exactly like a manager");
  assert.equal(await onHand(), before - 1000, "and it moves the same ledger");

  assert.equal((await svc.push(owner, "d", [op("count.submit", { countId: uuid(), countedAt: now(), lines: [{ productId: pid, counted: await onHand() }] })]))[0].status,
    "applied", "an owner counts stock like a manager");

  const adj = await svc.push(owner, "d", [op("adjustment.request", { adjustmentId: uuid(), productId: pid, qty: -500, reason: "damage", note: "owner found a broken item" })]);
  assert.equal(adj[0].status, "pending_approval", "an owner's correction still needs approval, never straight to the ledger");

  // Shared shop data, not two copies: each role reads the same stored sale, whichever role recorded it.
  const { ReportsController } = await import("../src/reports/reports.controller");
  const { FinanceService } = await import("../src/reports/finance.service");
  const reports = new ReportsController(db, new FinanceService(db));
  const managerSaleId = uuid();
  assert.equal((await svc.push(mgr, "d", [sale(managerSaleId)]))[0].status, "applied");
  assert.equal((await reports.sale(owner, managerSaleId)).sale.id, managerSaleId, "the owner sees the manager's sale");
  assert.equal((await reports.sale(mgr, ownerSaleId)).sale.id, ownerSaleId, "the manager sees the owner's sale");
  assert.deepEqual(await reports.sale(owner, managerSaleId), await reports.sale(mgr, managerSaleId),
    "both roles read the one stored record, not per-role copies");

  // Owner-only controls stay closed to managers…
  const { SalesController } = await import("../src/sales/sales.controller");
  assert.deepEqual(Reflect.getMetadata("roles", SalesController), ["owner"], "voiding a sale stays owner-only");
  // …and a different shop still cannot reach this shop's records.
  assert.equal((await svc.push(mgrB, "d", [sale(uuid())]))[0].message, "unknown_product");
});

/* ------------------------------------------------------- add product: product + initial stock in ONE operation */

test("creating a product registers its initial stock exactly once and both are audited", { skip }, async () => {
  const id = uuid();
  const create = () => op("product.upsert", { productId: id, code: `N-${id.slice(0, 8)}`, name: "New Product", unit: "kg", sellingPrice: 2000, lowStockThreshold: 5000, initialQty: 12_000, initialUnitCost: 1400 });
  assert.equal((await svc.push(mgr, "d", [create()]))[0].status, "applied");

  const mv = (await pool.query("SELECT type, qty, unit_cost, reason FROM stock_movements WHERE product_id=$1", [id])).rows;
  assert.equal(mv.length, 1, "one initial-stock movement");
  assert.equal(mv[0].type, "opening");
  assert.equal(Number(mv[0].qty), 12_000);
  assert.equal(Number(mv[0].unit_cost), 1400, "the unit cost is stored on the movement, so the moving average starts correctly");
  assert.equal(await qtyOnHand(id), 12_000);

  const created = (await pool.query("SELECT action, new_value FROM audit_log WHERE entity='product' AND entity_id=$1", [id])).rows;
  assert.equal(created.length, 1, "product creation is audited");
  assert.equal(created[0].action, "product.create");
  const nv = typeof created[0].new_value === "string" ? JSON.parse(created[0].new_value) : created[0].new_value;
  assert.equal(nv.initialQty, 12_000);
  assert.equal(nv.initialUnitCost, 1400);
  assert.equal(nv.initialStockValue, 16_800, "12 units × 1,400 RWF recorded server-side");

  // A later operation carrying initial stock is an EDIT of an existing product: stock is never initialized again.
  const edit: any = { ...create(), opId: uuid() };
  edit.payload = { ...edit.payload, sellingPrice: 2100, initialQty: 99_000, initialUnitCost: 5 };
  assert.equal((await svc.push(mgr, "d", [edit]))[0].status, "applied");
  assert.equal(await qtyOnHand(id), 12_000, "an edit cannot add a second initial stock movement");
  assert.equal(Number((await pool.query("SELECT count(*) FROM stock_movements WHERE product_id=$1", [id])).rows[0].count), 1);
  assert.equal(Number((await pool.query("SELECT count(*) FROM audit_log WHERE action='product.create' AND entity_id=$1", [id])).rows[0].count), 1, "only one creation audit entry");
  assert.equal(Number((await pool.query("SELECT count(*) FROM audit_log WHERE action='product.update' AND entity_id=$1", [id])).rows[0].count), 1, "the edit is audited as an update");
});

test("initial stock is all-or-nothing: quantity and cost must travel together", { skip }, async () => {
  const id = uuid();
  const r = (await svc.push(mgr, "d", [op("product.upsert", { productId: id, code: `H-${id.slice(0, 8)}`, name: "Half entered", unit: "pcs", sellingPrice: 100, lowStockThreshold: 0, initialQty: 1000 })]))[0];
  assert.equal(r.status, "rejected");
  assert.match(String(r.message), /initial_stock_incomplete/);
  assert.equal(Number((await pool.query("SELECT count(*) FROM products WHERE id=$1", [id])).rows[0].count), 0, "no half-created product row");
  assert.equal(await qtyOnHand(id), 0);
});

test("two create operations for the same product cannot both initialize stock", { skip }, async () => {
  const id = uuid();
  const mk = () => op("product.upsert", { productId: id, code: `D-${id.slice(0, 8)}`, name: "Double submit", unit: "pcs", sellingPrice: 100, lowStockThreshold: 0, initialQty: 5000, initialUnitCost: 40 });
  const [a, b] = await Promise.all([svc.push(mgr, "d", [mk()]), svc.push(mgr, "d", [mk()])]);
  assert.ok([a[0].status, b[0].status].includes("applied"), "one of the two creates wins");
  assert.equal(await qtyOnHand(id), 5000, "stock initialized exactly once under concurrency");
  assert.equal(Number((await pool.query("SELECT count(*) FROM stock_movements WHERE product_id=$1", [id])).rows[0].count), 1);
});

test("operations queued offline by an older build (openingQty) still register their stock", { skip }, async () => {
  const id = uuid();
  const legacy = op("product.upsert", { productId: id, code: `L-${id.slice(0, 8)}`, name: "Legacy queued op", unit: "pcs", sellingPrice: 500, lowStockThreshold: 0 });
  (legacy as any).payload.openingQty = 7000;
  (legacy as any).payload.openingUnitCost = 250;
  assert.equal((await svc.push(mgr, "d", [legacy]))[0].status, "applied");
  assert.equal(await qtyOnHand(id), 7000);
});

test("ledger and audit log are immutable at the database level", { skip }, async () => {
  await assert.rejects(pool.query("UPDATE stock_movements SET qty=qty+1"), /append-only/);
  await assert.rejects(pool.query("DELETE FROM audit_log"), /append-only/);
});

/* --------------------------------------------- flexible purchase / base / selling units */
/**
 * The spec's worked example: Rice bought in 25 kg bags at 30,000/bag, sold per kg at 1,400.
 * The ledger, stock checks and valuation all stay in BASE kg; the natural bag/kg entries are
 * carried alongside and re-verified server-side (toBaseQty is the same shared function the
 * offline client uses, so both sides convert identically without connectivity).
 */
const specRice = (initialMilli = 12_500) => {
  const id = uuid();
  return {
    id,
    create: op("product.upsert", {
      productId: id, code: `RICE-${id.slice(0, 6)}`, name: "Rice", unit: "kg", sellingPrice: 1_400, lowStockThreshold: 5_000,
      purchaseUnit: "bag", unitsPerPurchase: 25, sellingUnit: "kg", unitsPerSelling: 1,
      initialQty: initialMilli,
      initialUnitCost: 1_200,
    }),
    buy: (bags: number, costPerBag: number, opId = uuid()) => op("purchase.create", {
      purchaseId: uuid(), supplierId: null, orderedAt: now(), amountPaid: 0, receiveNow: true,
      lines: [{ productId: id, qty: toBaseQty(bags * 1000, 25), purchaseQty: bags * 1000, unitFactor: 25, unitCost: costPerBaseUnit(costPerBag, 25), sellingPrice: 1_400 }],
    }, opId),
    sell: (kg: number, price: number, opId = uuid()) => op("sale.create", {
      saleId: uuid(), soldAt: now(), discount: 0, amountPaid: kg * price, paymentMethod: "cash",
      lines: [{ productId: id, qty: kg * 1000, sellingQty: kg * 1000, unitPrice: price }],
    }, opId),
  };
};

test("rice: buying 1 bag adds 25 kg, selling 5 kg deducts 5 kg and leaves 20 kg", { skip }, async () => {
  const r = specRice();
  assert.equal((await svc.push(mgr, "d", [r.create]))[0].status, "applied");
  assert.equal(await qtyOnHand(r.id), 12_500, "opening 0.5 bag registered in base kg");
  assert.equal((await svc.push(mgr, "d", [r.buy(1, 30_000)]))[0].status, "applied");
  assert.equal(await qtyOnHand(r.id), 37_500, "1 bag = +25 kg, never +1");

  const sale = r.sell(5, 1_400);
  assert.equal((await svc.push(mgr, "d", [sale]))[0].status, "applied");
  assert.equal(await qtyOnHand(r.id), 32_500, "5 kg sold -> -5 kg, not -5 bags");
  const line = (await pool.query("SELECT qty, qty_entered, unit_price, line_amount FROM sale_lines WHERE sale_id=(SELECT id FROM sales WHERE op_id=$1)", [sale.opId])).rows[0];
  assert.equal(Number(line.qty), 5_000);                                  // base ledger quantity
  assert.equal(Number(line.qty_entered), 5_000, "original entered quantity preserved");
  assert.equal(Number(line.line_amount), 7_000, "revenue = 5 kg x 1,400");
});

test("rice: weighted average cost stays in base units (1,200 then 1,300 -> 1,250/kg)", { skip }, async () => {
  const r = specRice(25_000); // 1 bag opening = 25 kg @ 1,200
  assert.equal((await svc.push(mgr, "d", [r.create]))[0].status, "applied");
  assert.equal((await svc.push(mgr, "d", [r.buy(1, 30_000)]))[0].status, "applied");   // +25 kg @ 1,200
  assert.equal((await svc.push(mgr, "d", [r.buy(2, 32_500)]))[0].status, "applied");   // +50 kg @ 1,300 (65,000 for 2 bags)
  const { replayLedger } = await import("@sms/shared");
  const mv = (await pool.query("SELECT type, qty, unit_cost, occurred_at FROM stock_movements WHERE product_id=$1 ORDER BY occurred_at, id", [r.id])).rows;
  const led = replayLedger(mv.map((m: any) => ({ type: m.type, qty: Number(m.qty), unitCost: m.unit_cost === null ? undefined : Number(m.unit_cost), occurredAt: new Date(m.occurred_at).toISOString() })));
  assert.equal(led.onHand, 100_000, "100 kg on hand (25 + 25 + 50)");
  assert.equal(led.value, 125_000, "25x1200 + 25x1200 + 50x1300 = 125,000 RWF valued at base-unit cost");
  assert.equal(led.avgCost, 1_250, "moving average: 125,000 / 100 kg = 1,250/kg");
});

test("rice: selling all remaining stock hits exactly zero, decimal kg allowed", { skip }, async () => {
  const r = specRice();
  assert.equal((await svc.push(mgr, "d", [r.create]))[0].status, "applied");
  assert.equal((await svc.push(mgr, "d", [r.buy(1, 30_000)]))[0].status, "applied"); // 37.5 kg
  assert.equal((await svc.push(mgr, "d", [r.sell(0.5, 1_400)]))[0].status, "applied"); // 0.5 kg = 500 milli
  assert.equal(await qtyOnHand(r.id), 37_000);
  assert.equal((await svc.push(mgr, "d", [r.sell(37, 1_400)]))[0].status, "applied");
  assert.equal(await qtyOnHand(r.id), 0, "stock lands exactly on zero");
  const over = (await svc.push(mgr, "d", [r.sell(1, 1_400)]))[0];
  assert.equal(over.status, "conflict", "one more kg is insufficient stock");
});

test("conversion mismatches are rejected server-side, never silently applied", { skip }, async () => {
  const r = specRice();
  assert.equal((await svc.push(mgr, "d", [r.create]))[0].status, "applied");
  // Claiming 1 bag while deducting only 1 kg: natural quantity and base quantity disagree.
  const badBuy = op("purchase.create", { purchaseId: uuid(), supplierId: null, orderedAt: now(), amountPaid: 0, receiveNow: true,
    lines: [{ productId: r.id, qty: 1_000, purchaseQty: 1_000, unitFactor: 25, unitCost: 1_200 }] });
  const rb = (await svc.push(mgr, "d", [badBuy]))[0];
  assert.equal(rb.status, "rejected"); assert.match(String(rb.message), /unit_conversion_mismatch/);
  assert.equal(await qtyOnHand(r.id), 12_500, "nothing was posted");
  // A factor that is not the product's configured one is refused outright.
  const badFactor = op("purchase.create", { purchaseId: uuid(), supplierId: null, orderedAt: now(), amountPaid: 0, receiveNow: true,
    lines: [{ productId: r.id, qty: 50_000, purchaseQty: 1_000, unitFactor: 50, unitCost: 1_200 }] });
  const rf = (await svc.push(mgr, "d", [badFactor]))[0];
  assert.equal(rf.status, "rejected"); assert.match(String(rf.message), /unit_factor_mismatch/);
  // A converted product cannot be received from a build that does not send the conversion at all.
  const oldBuild = op("purchase.create", { purchaseId: uuid(), supplierId: null, orderedAt: now(), amountPaid: 0, receiveNow: true,
    lines: [{ productId: r.id, qty: 25_000, unitCost: 1_200 }] });
  const ro = (await svc.push(mgr, "d", [oldBuild]))[0];
  assert.equal(ro.status, "rejected"); assert.match(String(ro.message), /unit_factor_required/);
  // Sales follow the same rule for the selling unit.
  const badSell = op("sale.create", { saleId: uuid(), soldAt: now(), discount: 0, amountPaid: 0,
    lines: [{ productId: r.id, qty: 1_000, sellingQty: 5_000, unitPrice: 1_400 }] });
  const rs = (await svc.push(mgr, "d", [badSell]))[0];
  assert.equal(rs.status, "rejected"); assert.match(String(rs.message), /unit_conversion_mismatch/);
  assert.equal(await qtyOnHand(r.id), 12_500, "stock untouched by every rejected attempt");
});

test("a product sold in packs cannot be sold by a build that omits the natural quantity", { skip }, async () => {
  const id = uuid();
  assert.equal((await svc.push(mgr, "d", [op("product.upsert", {
    productId: id, code: `PACK-${id.slice(0, 6)}`, name: "Soap pack", unit: "bar", sellingPrice: 4_000, lowStockThreshold: 0,
    sellingUnit: "pack", unitsPerSelling: 4, initialQty: 4_000, initialUnitCost: 500 })]))[0].status, "applied");
  const oldBuild = op("sale.create", { saleId: uuid(), soldAt: now(), discount: 0, amountPaid: 0,
    lines: [{ productId: id, qty: 1_000, unitPrice: 4_000 }] });
  const res = (await svc.push(mgr, "d", [oldBuild]))[0];
  assert.equal(res.status, "rejected"); assert.match(String(res.message), /selling_qty_required/);
  assert.equal(await qtyOnHand(id), 4_000, "nothing moved");
});

test("carton-style selling units price lines from the natural quantity", { skip }, async () => {
  const id = uuid();
  assert.equal((await svc.push(mgr, "d", [op("product.upsert", {
    productId: id, code: `SODA-${id.slice(0, 6)}`, name: "Soda", unit: "bottle", sellingPrice: 6_000, lowStockThreshold: 0,
    purchaseUnit: "carton", unitsPerPurchase: 12, sellingUnit: "carton", unitsPerSelling: 12,
    initialQty: 12_000, initialUnitCost: 300, // 12 bottles @ 300
  })]))[0].status, "applied");
  // Receive 2 cartons: qty in base bottles, natural carton entry + factor verified by the server.
  assert.equal((await svc.push(mgr, "d", [op("purchase.create", { purchaseId: uuid(), supplierId: null, orderedAt: now(), amountPaid: 0, receiveNow: true,
    lines: [{ productId: id, qty: 24_000, purchaseQty: 2_000, unitFactor: 12, unitCost: 300, sellingPrice: 6_000 }] })]))[0].status, "applied");
  assert.equal(await qtyOnHand(id), 36_000, "36 bottles on hand (3 cartons)");
  // Sell 1 carton: deducts 12 bottles, revenue = 1 carton x 6,000 (NOT 12 x 6,000).
  const sale = op("sale.create", { saleId: uuid(), soldAt: now(), discount: 0, amountPaid: 6_000,
    lines: [{ productId: id, qty: 12_000, sellingQty: 1_000, unitPrice: 6_000 }] });
  assert.equal((await svc.push(mgr, "d", [sale]))[0].status, "applied");
  assert.equal(await qtyOnHand(id), 24_000);
  const line = (await pool.query("SELECT qty, qty_entered, line_amount FROM sale_lines WHERE sale_id=(SELECT id FROM sales WHERE op_id=$1)", [sale.opId])).rows[0];
  assert.equal(Number(line.qty), 12_000, "base bottles deducted");
  assert.equal(Number(line.qty_entered), 1_000, "original carton quantity preserved");
  assert.equal(Number(line.line_amount), 6_000, "priced per carton");
});

test("below-cost detection compares one basis across unit configurations", { skip }, async () => {
  const r = specRice();
  assert.equal((await svc.push(mgr, "d", [r.create]))[0].status, "applied");
  // 1,200/kg cost, selling 1,100/kg -> below cost: must require the auditable acknowledgement.
  const noAck = op("purchase.create", { purchaseId: uuid(), supplierId: null, orderedAt: now(), amountPaid: 0, receiveNow: true, belowCostAcknowledged: false,
    lines: [{ productId: r.id, qty: 25_000, purchaseQty: 1_000, unitFactor: 25, unitCost: 1_200, sellingPrice: 1_100 }] });
  assert.equal((await svc.push(mgr, "d", [noAck]))[0].status, "rejected");
  const ack = op("purchase.create", { purchaseId: uuid(), supplierId: null, orderedAt: now(), amountPaid: 0, receiveNow: true,
    belowCostAcknowledged: true, belowCostReason: "clearing old stock",
    lines: [{ productId: r.id, qty: 25_000, purchaseQty: 1_000, unitFactor: 25, unitCost: 1_200, sellingPrice: 1_100 }] });
  assert.equal((await svc.push(mgr, "d", [ack]))[0].status, "applied");
  // 1,400/kg against a 1,200/kg cost is NOT below cost — and neither is the same price
  // expressed per 25 kg bag against a per-bag cost of 30,000 (cross-multiplied comparison).
  const fine = op("purchase.create", { purchaseId: uuid(), supplierId: null, orderedAt: now(), amountPaid: 0, receiveNow: true, belowCostAcknowledged: false,
    lines: [{ productId: r.id, qty: 25_000, purchaseQty: 1_000, unitFactor: 25, unitCost: 1_200, sellingPrice: 1_400 }] });
  assert.equal((await svc.push(mgr, "d", [fine]))[0].status, "applied");
});

test("unit configuration is set at creation and locked afterwards", { skip }, async () => {
  const r = specRice();
  assert.equal((await svc.push(mgr, "d", [r.create]))[0].status, "applied");
  // A plain edit (price change, no unit fields) must keep the conversion untouched.
  const edit = op("product.upsert", { productId: r.id, code: `RICE-${r.id.slice(0, 6)}`, name: "Rice", unit: "kg", sellingPrice: 1_500, lowStockThreshold: 5_000 });
  assert.equal((await svc.push(mgr, "d", [edit]))[0].status, "applied");
  const row = (await pool.query("SELECT selling_price, purchase_unit, units_per_purchase, units_per_selling FROM products WHERE id=$1", [r.id])).rows[0];
  assert.equal(Number(row.selling_price), 1_500);
  assert.equal(row.purchase_unit, "bag");
  assert.equal(Number(row.units_per_purchase), 25, "conversion survives an unrelated edit");
  // An edit that tries to CHANGE the conversion is refused: historical kg would be reinterpreted.
  const change = op("product.upsert", { productId: r.id, code: `RICE-${r.id.slice(0, 6)}`, name: "Rice", unit: "kg", sellingPrice: 1_500, lowStockThreshold: 5_000,
    purchaseUnit: "sack", unitsPerPurchase: 50 });
  const rc = (await svc.push(mgr, "d", [change]))[0];
  assert.equal(rc.status, "rejected"); assert.match(String(rc.message), /unit_config_locked/);
  // Missing unit labels with a non-1 factor fail schema validation with a clear message.
  const noLabel = op("product.upsert", { productId: uuid(), code: "X1", name: "No label", unit: "kg", sellingPrice: 100, lowStockThreshold: 0, unitsPerPurchase: 10 });
  const rl = (await svc.push(mgr, "d", [noLabel]))[0];
  assert.equal(rl.status, "rejected"); assert.match(String(rl.message), /purchase_unit_required/);
});

test("different shops configure units independently and stay isolated", { skip }, async () => {
  const idA = uuid(), idB = uuid();
  assert.equal((await svc.push(mgr, "d", [op("product.upsert", { productId: idA, code: "ISO-A", name: "Rice A", unit: "kg", sellingPrice: 1_400, lowStockThreshold: 0,
    purchaseUnit: "bag", unitsPerPurchase: 25, initialQty: 25_000, initialUnitCost: 1_200 })]))[0].status, "applied");
  assert.equal((await svc.push(mgrB, "d", [op("product.upsert", { productId: idB, code: "ISO-B", name: "Soap B", unit: "bar", sellingPrice: 2_000, lowStockThreshold: 0,
    sellingUnit: "packet", unitsPerSelling: 4, initialQty: 4_000, initialUnitCost: 800 })]))[0].status, "applied");
  const rows = (await pool.query("SELECT id, shop_id, units_per_purchase, units_per_selling FROM products WHERE id = ANY($1::uuid[])", [[idA, idB]])).rows;
  assert.equal(rows.length, 2, "each shop keeps its own product row");
  const a = rows.find((r: any) => r.id === idA)!, b = rows.find((r: any) => r.id === idB)!;
  assert.equal(a.shop_id, shopA); assert.equal(b.shop_id, shopB);
  assert.equal(Number(a.units_per_purchase), 25, "shop A buys in bags");
  assert.equal(Number(b.units_per_selling), 4, "shop B sells in packets of 4");
  // Shop B cannot touch shop A's product: the row lock is shop-scoped, conversion or not.
  const res = (await svc.push(mgrB, "d", [op("sale.create", { saleId: uuid(), soldAt: now(), discount: 0, amountPaid: 0,
    lines: [{ productId: idA, qty: 1_000, sellingQty: 1_000, unitPrice: 1_400 }] })]))[0];
  assert.equal(res.status, "rejected"); assert.match(String(res.message), /unknown_product/);
});

test("offline purchase and sale: replay after reconnect is applied exactly once", { skip }, async () => {
  const r = specRice();
  assert.equal((await svc.push(mgr, "d", [r.create]))[0].status, "applied");
  const buy = r.buy(1, 30_000); const sell = r.sell(5, 1_400);
  // The device queues both while offline, then pushes them; a flaky network replays the batch.
  assert.deepEqual((await svc.push(mgr, "offline-device", [buy, sell])).map((x: any) => x.status), ["applied", "applied"]);
  assert.deepEqual((await svc.push(mgr, "offline-device", [buy, sell])).map((x: any) => x.status), ["duplicate", "duplicate"]);
  assert.equal(await qtyOnHand(r.id), 32_500, "12.5 + 25 - 5 kg: no duplicate movement");
  assert.equal(Number((await pool.query("SELECT count(*) FROM stock_movements WHERE product_id=$1", [r.id])).rows[0].count), 3, "opening + receipt + sale, once each");
});

test("open purchases endpoint lists only outstanding lines and clears them when fully received", { skip }, async () => {
  const { PurchasesController } = await import("../src/purchases/purchases.controller");
  const ctrl = new PurchasesController(db);
  const purchaseId = uuid();
  assert.equal((await svc.push(mgr, "d", [op("purchase.create", { purchaseId, supplierId: null, orderedAt: now(), amountPaid: 0, receiveNow: false, lines: [{ productId: pid, qty: 5000, unitCost: 1200 }] })]))[0].status, "applied");

  let open = (await ctrl.open(mgr)).purchases.find((p: any) => p.id === purchaseId);
  assert.ok(open, "open purchase is listed");
  assert.equal(open.lines[0].outstanding, 5000);
  assert.equal(open.lines[0].qtyReceived, 0);

  await svc.push(mgr, "d", [op("receipt.create", { receiptId: uuid(), purchaseId, receivedAt: now(), lines: [{ productId: pid, qty: 2000 }] })]);
  open = (await ctrl.open(mgr)).purchases.find((p: any) => p.id === purchaseId);
  assert.equal(open.lines[0].outstanding, 3000);

  await svc.push(mgr, "d", [op("receipt.create", { receiptId: uuid(), purchaseId, receivedAt: now(), lines: [{ productId: pid, qty: 3000 }] })]);
  open = (await ctrl.open(mgr)).purchases.find((p: any) => p.id === purchaseId);
  assert.equal(open, undefined, "fully received purchase leaves the open list");
});

test("pull is incremental and returns on-hand with products", { skip }, async () => {
  const first = await svc.pull(mgr); assert.ok(first.changes.some((c: any) => c.id === pid));
  const second = await svc.pull(mgr, first.checkpoint); assert.equal(second.changes.length, 0);
});

/* ------------------------------------------------------------------ purchasing, POS and reporting rules */

async function newProduct(price = 1500, initialQty = 20_000, initialUnitCost = 1000) {
  const id = uuid();
  const r = await svc.push(mgr, "d", [op("product.upsert", { productId: id, code: `P-${id.slice(0, 8)}`, name: `Product ${id.slice(0, 6)}`, unit: "pcs", sellingPrice: price, lowStockThreshold: 2000, initialQty, initialUnitCost })]);
  assert.equal(r[0].status, "applied");
  return id;
}
const qtyOnHand = async (productId: string) => Number((await pool.query("SELECT COALESCE(SUM(qty),0) q FROM stock_movements WHERE product_id=$1", [productId])).rows[0].q);

const WIDE = { from: "2000-01-01T00:00:00.000Z", to: "2100-01-01T00:00:00.000Z" };

test("a sale records its payment method and the manager discount ceiling is enforced by the server", { skip }, async () => {
  const p = await newProduct();
  const saleId = uuid();
  assert.equal((await svc.push(mgr, "d", [op("sale.create", { saleId, soldAt: now(), discount: 0, amountPaid: 1500, paymentMethod: "momo", lines: [{ productId: p, qty: 1000, unitPrice: 1500 }] })]))[0].status, "applied");
  assert.equal((await pool.query("SELECT payment_method FROM sales WHERE id=$1", [saleId])).rows[0].payment_method, "momo");

  await pool.query("UPDATE shops SET max_discount_percent=10 WHERE id=$1", [shopA]);
  const over = (await svc.push(mgr, "d", [op("sale.create", { saleId: uuid(), soldAt: now(), discount: 300, amountPaid: 1200, lines: [{ productId: p, qty: 1000, unitPrice: 1500 }] })]))[0];
  assert.equal(over.status, "rejected");
  assert.match(String(over.message), /discount_above_limit:10%/);
  await pool.query("UPDATE shops SET max_discount_percent=100 WHERE id=$1", [shopA]);
});

test("below-cost stock entry needs an audited reason, and policy can block managers entirely", { skip }, async () => {
  const p = await newProduct(1200, 0, 0);
  const line = { productId: p, qty: 28_000, unitCost: 1429, sellingPrice: 1200 };
  const refusedId = uuid();
  const refused = (await svc.push(mgr, "d", [op("purchase.create", { purchaseId: refusedId, supplierId: null, orderedAt: now(), amountPaid: 0, receiveNow: true, lines: [line] })]))[0];
  assert.equal(refused.status, "rejected");
  assert.match(String(refused.message), /below_cost_acknowledgement_required/);
  assert.equal(Number((await pool.query("SELECT count(*) FROM purchases WHERE id=$1", [refusedId])).rows[0].count), 0);

  const purchaseId = uuid();
  const accepted = (await svc.push(mgr, "d", [op("purchase.create", {
    purchaseId, supplierId: null, orderedAt: now(), amountPaid: 0, receiveNow: true, notes: "clear slow stock",
    belowCostAcknowledged: true, belowCostReason: "clearance of slow stock", lines: [line],
  })]))[0];
  assert.equal(accepted.status, "applied");
  assert.equal(await qtyOnHand(p), 28_000);
  assert.equal((await pool.query("SELECT notes FROM purchases WHERE id=$1", [purchaseId])).rows[0].notes, "clear slow stock");
  assert.equal(Number((await pool.query("SELECT count(*) FROM audit_log WHERE action='purchase.below_cost' AND entity_id=$1", [purchaseId])).rows[0].count), 1);
  // The price entered on the received line becomes the product's current price.
  assert.equal(Number((await pool.query("SELECT selling_price FROM products WHERE id=$1", [p])).rows[0].selling_price), 1200);

  await pool.query("UPDATE shops SET below_cost_policy='block' WHERE id=$1", [shopA]);
  const blocked = (await svc.push(mgr, "d", [op("purchase.create", { purchaseId: uuid(), supplierId: null, orderedAt: now(), amountPaid: 0, receiveNow: false, belowCostAcknowledged: true, belowCostReason: "clearance again", lines: [line] })]))[0];
  assert.equal(blocked.status, "rejected");
  assert.match(String(blocked.message), /below_cost_blocked_by_shop_policy/);
  await pool.query("UPDATE shops SET below_cost_policy='acknowledge' WHERE id=$1", [shopA]);
});

test("a void returns every item to stock exactly once and keeps the sale for audit", { skip }, async () => {
  const p = await newProduct(1500, 10_000, 1000);
  const saleId = uuid();
  assert.equal((await svc.push(mgr, "d", [op("sale.create", { saleId, soldAt: now(), discount: 0, amountPaid: 6000, paymentMethod: "cash", lines: [{ productId: p, qty: 4000, unitPrice: 1500 }] })]))[0].status, "applied");
  assert.equal(await qtyOnHand(p), 6000);

  const { SalesController } = await import("../src/sales/sales.controller");
  const sales = new SalesController(db);
  await sales.voidSale(owner, saleId, { reason: "duplicated sale" });
  assert.equal(await qtyOnHand(p), 10_000);
  assert.equal((await pool.query("SELECT status, reversal_reason FROM sales WHERE id=$1", [saleId])).rows[0].status, "reversed");
  assert.equal((await pool.query("SELECT reversal_reason FROM sales WHERE id=$1", [saleId])).rows[0].reversal_reason, "duplicated sale");
  assert.equal(Number((await pool.query("SELECT count(*) FROM stock_movements WHERE source_type='sale_void' AND source_id=$1", [saleId])).rows[0].count), 1);

  await assert.rejects(() => sales.voidSale(owner, saleId, { reason: "again" }), /sale_already_reversed/);
  assert.equal(await qtyOnHand(p), 10_000);
  assert.equal(Number((await pool.query("SELECT count(*) FROM audit_log WHERE action='sale.void' AND entity_id=$1", [saleId])).rows[0].count), 1);
  assert.equal((await pool.query("SELECT status FROM sales WHERE id=$1", [saleId])).rows[0].status, "reversed");
});

test("CSV export escapes commas and carries the payment method", { skip }, async () => {
  assert.equal((await svc.push(mgr, "d", [op("expense.create", { expenseId: uuid(), category: "transport", amount: 2500, paid: true, incurredAt: now(), note: "supplier, urgent" })]))[0].status, "applied");
  const { ReportsController } = await import("../src/reports/reports.controller");
  const { FinanceService } = await import("../src/reports/finance.service");
  const reports = new ReportsController(db, new FinanceService(db));
  const res: any = { headers: {} as Record<string, string>, setHeader(k: string, v: string) { this.headers[k] = v; }, send(b: string) { this.body = b; } };
  await reports.exportCsv(owner, { kind: "expenses", ...WIDE }, res);
  assert.match(res.headers["Content-Type"], /text\/csv/);
  assert.match(res.headers["Content-Disposition"], /expenses/);
  assert.match(res.body, /incurred_at_utc/);
  assert.ok(res.body.includes('"supplier, urgent"'), "a comma in a note stays inside one quoted CSV field");

  await reports.exportCsv(owner, { kind: "sales", ...WIDE }, res);
  assert.match(res.body, /payment_method/);
  assert.match(res.body, /momo/);
  await assert.rejects(() => reports.exportCsv(owner, { kind: "nope", ...WIDE }, res), /kind must be/);
});

test("manager financial data is hidden until the owner enables it, and totals match their transactions", { skip }, async () => {
  const { ReportsController } = await import("../src/reports/reports.controller");
  const { FinanceService } = await import("../src/reports/finance.service");
  const reports = new ReportsController(db, new FinanceService(db));
  const raw = (await pool.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(gross_amount - discount),0)::bigint AS net
    FROM sales WHERE shop_id=$1 AND status='posted' AND sold_at>=$2 AND sold_at<$3`, [shopA, WIDE.from, WIDE.to])).rows[0];

  const managerView = await reports.dashboard(mgr, WIDE);
  assert.equal(managerView.permissions.financials, false);
  assert.equal(managerView.financials, null);
  assert.equal(managerView.operations.transactions, raw.n);
  assert.equal(managerView.operations.netSales, Number(raw.net));
  assert.equal(managerView.operations.inventoryValue, null);
  assert.equal((await reports.inventory(mgr)).totalValue, null, "cost-based inventory value is withheld from managers");
  assert.equal(managerView.trend.every((t: any) => t.grossProfit === null), true);
  await assert.rejects(() => reports.summary(mgr, WIDE), /financials_not_permitted/);

  await pool.query("UPDATE shops SET manager_financial_access=true WHERE id=$1", [shopA]);
  const shared = await reports.dashboard(mgr, WIDE);
  assert.equal(shared.permissions.financials, true);
  assert.equal(shared.financials.netSales, managerView.operations.netSales);
  assert.equal(typeof shared.operations.inventoryValue, "number");
  assert.ok((await reports.summary(mgr, WIDE)).current.netSales === shared.financials.netSales);
  const topIds = shared.topProducts.map((p: any) => p.id);
  assert.equal(shared.worstProducts.some((p: any) => topIds.includes(p.id)), false,
    "a product is never listed as both a top and a worst seller");
  await pool.query("UPDATE shops SET manager_financial_access=false WHERE id=$1", [shopA]);
});

/* ------------------------------------------------------------------ stock receiving, sales visibility, account settings */

test("an owner can receive stock into an existing product, and a replayed operation never receives it twice", { skip }, async () => {
  const p = await newProduct(1500, 12_000, 1000);
  const before = await qtyOnHand(p);
  const productsBefore = Number((await pool.query("SELECT count(*) FROM products WHERE shop_id=$1", [shopA])).rows[0].count);
  const purchaseId = uuid();
  const stockOp = op("purchase.create", {
    purchaseId, supplierId: null, orderedAt: now(), amountPaid: 20_000, receiveNow: true, reference: "INV-20", notes: "extra bottles",
    lines: [{ productId: p, qty: 20_000, unitCost: 1000, sellingPrice: 1500 }],
  });

  const res = (await svc.push(owner, "d", [stockOp]))[0];
  assert.equal(res.status, "applied", res.message);
  assert.equal(await qtyOnHand(p), before + 20_000, "stock is added to the existing product");
  assert.equal(Number((await pool.query("SELECT count(*) FROM products WHERE shop_id=$1", [shopA])).rows[0].count), productsBefore,
    "receiving stock never creates a second product");

  const purchase = (await pool.query("SELECT user_id, reference, notes, total_amount FROM purchases WHERE id=$1", [purchaseId])).rows[0];
  assert.equal(purchase.user_id, owner.id, "the person who received the stock is recorded");
  assert.equal(purchase.reference, "INV-20");
  assert.equal(purchase.notes, "extra bottles");
  assert.equal(Number(purchase.total_amount), 20_000);
  assert.equal(Number((await pool.query("SELECT count(*) FROM stock_movements WHERE source_type='purchase' AND source_id=$1 AND type='receipt'", [purchaseId])).rows[0].count), 1);

  assert.equal((await svc.push(owner, "d", [stockOp]))[0].status, "duplicate");
  assert.equal(await qtyOnHand(p), before + 20_000, "a retried request does not add the stock again");
});

test("a sale can be opened with its line items, and other shops cannot read it", { skip }, async () => {
  const { ReportsController } = await import("../src/reports/reports.controller");
  const { FinanceService } = await import("../src/reports/finance.service");
  const reports = new ReportsController(db, new FinanceService(db));
  const p = await newProduct(2000, 10_000, 1000);
  const saleId = uuid();
  assert.equal((await svc.push(mgr, "d", [op("sale.create", { saleId, soldAt: now(), discount: 500, amountPaid: 3500, paymentMethod: "bank", lines: [{ productId: p, qty: 2000, unitPrice: 2000 }] })]))[0].status, "applied");

  const detail = await reports.sale(mgr, saleId);
  assert.equal(detail.sale.net, 3500);
  assert.equal(detail.sale.paymentMethod, "bank");
  assert.equal(detail.lines.length, 1);
  assert.equal(detail.lines[0].qty, 2000);
  assert.equal(detail.lines[0].unitPrice, 2000);
  assert.equal(detail.lines[0].lineAmount, 4000);
  assert.equal((await reports.sale(owner, saleId)).sale.id, saleId, "the owner sees the same sale");
  await assert.rejects(() => reports.sale(mgrB, saleId), /sale_not_found/);
  await assert.rejects(() => reports.sale(mgr, "not-a-uuid"), /sale_not_found/);

  const items = await reports.items(mgr, WIDE);
  const row = items.items.find((i: any) => i.productId === p);
  assert.ok(row, "the product appears in the products-sold view");
  assert.equal(row.units, 2000);
  assert.equal(row.gross, 4000);
  assert.equal(row.sales, 1);
  assert.equal(row.avgUnitPrice, 2000);
  assert.ok(items.totals.discounts >= 500, "period discounts are reported with the items view");

  // The sales report itself must name the goods sold (row + CSV), like the stock-losses report does.
  const salesRows = (await reports.tx(mgr, { kind: "sales", ...WIDE })) as any[];
  const saleRow = salesRows.find((r) => r.id === saleId);
  assert.ok(saleRow, "the sale is listed in the sales report");
  assert.equal(saleRow.products, `Product ${p.slice(0, 6)}`, "the sales report row names the product sold");

  let csv = "";
  await reports.exportCsv(mgr, { kind: "sales", ...WIDE }, {
    setHeader() {},
    send(body: string) { csv = body; },
  } as any);
  assert.ok(csv.split("\r\n")[0].includes("products"), "the sales CSV carries a products column");
  assert.ok(csv.includes(`Product ${p.slice(0, 6)}`), "the sales CSV names the product sold");
});

test("a user can rename themselves and change their password; the old password stops working", { skip }, async () => {
  const { AuthController } = await import("../src/auth/auth.controller");
  const { AuthService } = await import("../src/auth/auth.service");
  const { NotificationService } = await import("../src/notifications/notifications.service");
  const { JwtService } = await import("@nestjs/jwt");
  const jwt = new JwtService({ secret: "test-secret-".padEnd(48, "x") });
  const auth = new AuthController(new AuthService(db, jwt, new NotificationService(db)));
  const email = `pw-${Date.now()}@a.test`;
  const userId = (await pool.query(
    "INSERT INTO users(shop_id,email,full_name,password_hash,role) VALUES ($1,$2,'Old Name',$3,'manager') RETURNING id",
    [shopA, email, await bcrypt.hash("old-password-123", 4)])).rows[0].id;
  const u = { id: userId, role: "manager" as const, shopId: shopA };

  const me = await auth.me(u);
  assert.equal(me.email, email);
  assert.equal(me.name, "Old Name");
  assert.equal(me.shopName, (await pool.query("SELECT name FROM shops WHERE id=$1", [shopA])).rows[0].name);
  assert.equal((await auth.updateMe(u, { fullName: "  New Name  " })).name, "New Name", "the name is trimmed and stored");
  assert.equal((await auth.me(u)).name, "New Name");
  await assert.rejects(() => auth.updateMe(u, { fullName: "" }), /at least 2/);

  const req: any = { headers: {}, ip: "127.0.0.1", secure: false };
  const res: any = { cookie() {}, clearCookie() {} };
  await assert.rejects(() => auth.changePassword(u, { currentPassword: "wrong-password", newPassword: "new-password-123" }, req, res), /current_password_incorrect/);
  await assert.rejects(() => auth.changePassword(u, { currentPassword: "old-password-123", newPassword: "short" }, req, res), /at least 10/);
  await assert.rejects(() => auth.changePassword(u, { currentPassword: "old-password-123", newPassword: "old-password-123" }, req, res), /password_unchanged/);

  const { token } = await auth.changePassword(u, { currentPassword: "old-password-123", newPassword: "new-password-123" }, req, res);
  const payload: any = await jwt.verifyAsync(token);
  const row = (await pool.query("SELECT token_version, password_hash FROM users WHERE id=$1", [userId])).rows[0];
  assert.equal(row.token_version, 1, "changing the password revokes the old sessions");
  assert.equal(payload.tv, row.token_version, "the returned token matches the new version");
  assert.ok(await bcrypt.compare("new-password-123", row.password_hash));
  assert.equal(Number((await pool.query("SELECT count(*) FROM audit_log WHERE action='user.password.change' AND entity_id=$1", [userId])).rows[0].count), 1);
  assert.equal(Number((await pool.query("SELECT count(*) FROM audit_log WHERE action='user.profile.update' AND entity_id=$1", [userId])).rows[0].count), 1);
});

test("the shop can be renamed by its owner and the role metadata protects the restricted endpoints", { skip }, async () => {
  const { ShopController } = await import("../src/shop/shop.controller");
  const { ReportsController } = await import("../src/reports/reports.controller");
  const shop = new ShopController(db);

  assert.deepEqual(Reflect.getMetadata("roles", ShopController), ["owner", "manager"], "both shop roles may read the shop profile");
  assert.deepEqual(Reflect.getMetadata("roles", ShopController.prototype.updateProfile), ["owner"], "only the owner renames the shop");
  assert.deepEqual(Reflect.getMetadata("roles", ReportsController.prototype.items), ["owner", "manager"]);
  assert.deepEqual(Reflect.getMetadata("roles", ReportsController.prototype.sale), ["owner", "manager"]);

  const created = await shop.updateProfile(owner, { name: "A test shop" });
  assert.equal(created.name, "A test shop");
  assert.equal((await shop.profile(mgr)).name, "A test shop", "a manager sees the new name");
  assert.equal(Number((await pool.query("SELECT count(*) FROM audit_log WHERE action='shop.profile.update' AND entity_id=$1", [shopA])).rows[0].count), 1);
  await assert.rejects(() => shop.updateProfile(owner, { name: "x" }), /at least 2/);
});
