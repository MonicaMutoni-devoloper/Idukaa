/**
 * Owner-authorised transaction corrections against real PostgreSQL.
 *
 * Run with a dedicated database:
 *   TEST_DATABASE_URL=postgres://... npm run test -w @sms/api
 *
 * The suite is skipped (not passed) when TEST_DATABASE_URL is unset. It exercises the real sync
 * outbox path for requests, the real correction service for owner decisions, and the real sale
 * posting/reversal services for stock, cost and money effects.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID as uuid } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";

const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : "TEST_DATABASE_URL not set";
process.env.DATABASE_URL = url ?? "";

let db: any, svc: any, corrections: any, pool: Pool;
let shopA: string, shopB: string, owner: any, manager: any, ownerB: any, customer: string;
let p1: string;

const now = () => new Date().toISOString();
const op = (type: string, payload: any, opId = uuid()) => ({ opId, deviceId: "correction-test", createdAt: now(), type, payload });

async function onHand(productId: string): Promise<number> {
  const r = await pool.query("SELECT COALESCE(SUM(qty),0)::bigint q FROM stock_movements WHERE product_id=$1", [productId]);
  return Number(r.rows[0].q);
}
async function seedProduct(code: string, price = 1500, cost = 1000, qty = 200_000): Promise<string> {
  const id = uuid();
  const r = await svc.push(owner, "d", [op("product.upsert", {
    productId: id, code, name: code, unit: "pcs", sellingPrice: price, lowStockThreshold: 0,
    initialQty: qty, initialUnitCost: cost,
  })]);
  assert.equal(r[0].status, "applied", `product ${code}: ${r[0].message ?? ""}`);
  return id;
}
async function seedSale(input: {
  productId?: string; qty?: number; price?: number; discount?: number; paid?: number;
  customerId?: string | null; paymentMethod?: string; dispatched?: boolean;
  lines?: { productId: string; qty: number; unitPrice: number; sellingQty?: number }[];
}): Promise<string> {
  const saleId = uuid();
  const lines = input.lines ?? [{
    productId: input.productId ?? p1, qty: input.qty ?? 3000, unitPrice: input.price ?? 1500,
    sellingQty: input.qty ?? 3000,
  }];
  const gross = lines.reduce((s, l) => s + (l.sellingQty ?? l.qty) * l.unitPrice / 1000, 0);
  const r = await svc.push(owner, "d", [op("sale.create", {
    saleId, soldAt: now(), discount: input.discount ?? 0,
    amountPaid: input.paid ?? gross - (input.discount ?? 0),
    paymentMethod: input.paymentMethod ?? "cash", customerId: input.customerId ?? null,
    lines,
  })]);
  assert.equal(r[0].status, "applied", `sale: ${r[0].message ?? ""}`);
  if (input.dispatched) await pool.query("UPDATE sales SET dispatched_at=now() WHERE id=$1", [saleId]);
  return saleId;
}
async function requestCorrection(input: {
  saleId: string; discount?: number; lines?: { productId: string; qty: number; unitPrice: number; sellingQty?: number }[];
  fulfillment?: "not_handed_over" | "handed_over"; actor?: any; alertId?: string | null; reason?: string;
  customerId?: string | null;
}) {
  const correctionId = uuid();
  const sale = (await pool.query("SELECT s.*, (SELECT json_agg(json_build_object('productId',sl.product_id,'qty',sl.qty,'unitPrice',sl.unit_price,'sellingQty',sl.qty_entered) ORDER BY sl.id) FROM sale_lines sl WHERE sl.sale_id=s.id) lines FROM sales s WHERE s.id=$1", [input.saleId])).rows[0];
  const lines = input.lines ?? (sale.lines as any[]).map((l) => ({ productId: l.productId, qty: Number(l.qty), unitPrice: Number(l.unitPrice), sellingQty: Number(l.sellingQty ?? l.qty) }));
  const r = await svc.push(input.actor ?? manager, "d", [op("correction.request", {
    correctionId, saleId: input.saleId, reason: input.reason ?? "Incorrect entry confirmed by the investigation",
    evidence: "test evidence", fulfillment: input.fulfillment ?? "not_handed_over",
    discount: input.discount ?? 0, amountPaid: 0, lines, alertId: input.alertId ?? null,
    customerId: input.customerId ?? null,
  })]);
  return { correctionId, result: r[0], lines };
}
async function approve(correctionId: string, note = "Owner reviewed the evidence") {
  return corrections.approve(owner, correctionId, note);
}
async function salesFor(saleId: string) {
  return (await pool.query("SELECT * FROM sales WHERE id=$1", [saleId])).rows[0];
}

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

  const { Db } = await import("../src/db/db.service");
  const { SyncService } = await import("../src/sync/sync.service");
  const { CorrectionsService } = await import("../src/corrections/corrections.service");
  const { SalePostingService } = await import("../src/sales/sale-posting.service");
  const { SalesReversalService } = await import("../src/sales/reversal.service");
  const { PricingService } = await import("../src/returns/pricing.service");
  db = new Db();
  svc = new SyncService(db);
  corrections = new CorrectionsService(db, new SalePostingService(new PricingService(db)), new SalesReversalService());

  const mkShop = async (name: string) => (await pool.query("INSERT INTO shops(name) VALUES ($1) RETURNING id", [name])).rows[0].id;
  shopA = await mkShop("Correction shop A (test fixture)");
  shopB = await mkShop("Correction shop B (test fixture)");
  const mkUser = async (shop: string, role: string, email: string) => ({
    id: (await pool.query("INSERT INTO users(email_verified_at,shop_id,email,full_name,password_hash,role) VALUES (now(),$1,$2,$3,'x',$4) RETURNING id",
      [shop, email, role === "owner" ? "Owner" : "Manager", role])).rows[0].id,
    role, shopId: shop,
  });
  owner = await mkUser(shopA, "owner", "owner@corrections.test");
  manager = await mkUser(shopA, "manager", "manager@corrections.test");
  ownerB = await mkUser(shopB, "owner", "owner-b@corrections.test");

  p1 = await seedProduct("CORR-P1");

  customer = uuid();
  assert.equal((await svc.push(owner, "d", [op("customer.upsert", {
    customerId: customer, name: "Correction Customer", phone: "0788000111", creditLimit: 10_000_000,
  })]))[0].status, "applied");
});
after(async () => { if (!skip) { await db.onModuleDestroy(); await pool.end(); } });

test("discount correction preserves the original, reverses once, posts one corrected sale and restocks correctly", { skip }, async () => {
  const product = await seedProduct("DISC-1");
  const saleId = await seedSale({
    productId: product, qty: 3000, price: 1500, discount: 4300, paid: 200,
    customerId: customer, paymentMethod: "credit",
  });
  const before = await onHand(product);
  const originalBefore = await salesFor(saleId);

  const { correctionId, result } = await requestCorrection({ saleId, discount: 0 });
  assert.equal(result.status, "applied", result.message);

  const approved = await approve(correctionId);
  assert.ok(["completed", "reconciliation_required"].includes(approved.status));
  const originalAfter = await salesFor(saleId);
  assert.equal(originalAfter.status, "reversed");
  assert.equal(Number(originalAfter.gross_amount), 4500, "original gross is preserved");
  assert.equal(Number(originalAfter.discount), 4300, "original discount is preserved");
  assert.equal(Number(originalAfter.amount_paid), 200, "original cashier/collection facts are preserved");
  assert.equal(originalAfter.user_id, originalBefore.user_id);
  assert.equal(originalAfter.reversal_id, approved.reversalId);

  const corrected = await salesFor(approved.correctedSaleId);
  assert.equal(corrected.status, "posted");
  assert.equal(Number(corrected.gross_amount), 4500);
  assert.equal(Number(corrected.discount), 0);
  assert.equal(Number(corrected.amount_paid), 200, "only the recorded collection is applied");
  assert.equal(corrected.corrects_sale_id, saleId);
  assert.equal(corrected.correction_id, correctionId);
  assert.equal(corrected.reversal_id, approved.reversalId);
  assert.equal(await onHand(product), before, "reversal and corrected sale net to zero physical change");

  const lines = (await pool.query("SELECT qty, unit_price, unit_cost, line_amount FROM sale_lines WHERE sale_id=$1", [saleId])).rows;
  assert.equal(lines.length, 1);
  assert.equal(Number(lines[0].qty), 3000);
  assert.equal(Number(lines[0].unit_price), 1500, "original selling price is not rewritten");
  assert.equal(Number(lines[0].unit_cost), 1000, "original cost snapshot is not rewritten");

  const owing = Number((await pool.query(
    "SELECT COALESCE(SUM(gross_amount-discount-amount_paid),0)::bigint v FROM sales WHERE shop_id=$1 AND customer_id=$2 AND status='posted'",
    [shopA, customer])).rows[0].v);
  assert.equal(owing, 4300, "the additional amount is a customer receivable, not a new cash receipt");
  assert.equal(await pool.query("SELECT count(*)::int n FROM sales WHERE corrects_sale_id=$1", [saleId]).then((r) => r.rows[0].n), 1);
});

test("a walk-in correction that creates a balance requires and records the customer who owes it", { skip }, async () => {
  const product = await seedProduct("WALKIN-1");
  const saleId = await seedSale({ productId: product, qty: 3000, price: 1500, discount: 4300, paid: 200 });

  const withoutCustomer = await requestCorrection({ saleId, discount: 200 });
  assert.equal(withoutCustomer.result.status, "rejected", "an unnamed walk-in cannot carry a new receivable");
  assert.match(String(withoutCustomer.result.message), /customer_required_for_additional_payment/);

  const withCustomer = await requestCorrection({ saleId, discount: 200, customerId: customer });
  assert.equal(withCustomer.result.status, "applied", withCustomer.result.message);
  const approved = await approve(withCustomer.correctionId);
  assert.equal(approved.customer.id, customer, "the owner reviews the named debtor");
  assert.equal(approved.expectedAdditional, 4100);
  assert.equal(approved.moneyStatus, "balance_due");

  const corrected = await salesFor(approved.correctedSaleId);
  assert.equal(corrected.customer_id, customer, "the corrected sale carries the named receivable");
  assert.equal(Number(corrected.amount_paid), 200, "only the original collection is applied");
  assert.equal(Number(corrected.gross_amount) - Number(corrected.discount), 4300);
  const frozen = (await pool.query("SELECT proposed->>'customerId' AS c FROM sale_corrections WHERE id=$1", [withCustomer.correctionId])).rows[0].c;
  assert.equal(frozen, customer, "the reviewed debtor is frozen with the rest of the proposal");
});

test("price correction records a refund, caps the corrected sale's applied payment and completes after settlement", { skip }, async () => {
  const product = await seedProduct("PRICE-1");
  const saleId = await seedSale({ productId: product, qty: 2000, price: 1500, paid: 3000 });
  const before = await onHand(product);
  const { correctionId } = await requestCorrection({
    saleId, lines: [{ productId: product, qty: 2000, unitPrice: 1200, sellingQty: 2000 }],
  });
  const approved = await approve(correctionId);
  assert.equal(approved.status, "reconciliation_required");
  assert.equal(approved.expectedRefund, 600);
  assert.equal(approved.moneyStatus, "refund_due");
  const corrected = await salesFor(approved.correctedSaleId);
  assert.equal(Number(corrected.amount_paid), 2400, "the corrected sale applies at most its net");
  assert.equal(await onHand(product), before);
  const negative = Number((await pool.query(
    "SELECT COALESCE(SUM(gross_amount-discount-amount_paid),0)::bigint v FROM sales WHERE id=$1", [approved.correctedSaleId])).rows[0].v);
  assert.equal(negative, 0, "an excess collection is not a negative receivable");

  const partial = await corrections.settleRefund(owner, correctionId, 200, "Cash refund part one");
  assert.equal(partial.status, "reconciliation_required");
  assert.equal(partial.amountRefunded, 200);
  const done = await corrections.settleRefund(owner, correctionId, 400, "Cash refund completed");
  assert.equal(done.status, "completed");
  assert.equal(done.amountRefunded, 600);
  assert.equal(done.moneyStatus, "reconciled");
});

test("quantity and product corrections restock the original and deduct the corrected selection exactly once", { skip }, async () => {
  const qtyProduct = await seedProduct("QTY-1");
  const qtySale = await seedSale({ productId: qtyProduct, qty: 3000, price: 1500, paid: 4500 });
  const qtyBefore = await onHand(qtyProduct);
  const qtyCorrection = await requestCorrection({
    saleId: qtySale, lines: [{ productId: qtyProduct, qty: 2000, unitPrice: 1500, sellingQty: 2000 }],
  });
  const qtyApproved = await approve(qtyCorrection.correctionId);
  assert.equal(await onHand(qtyProduct), qtyBefore + 1000, "the smaller corrected quantity leaves one more unit in stock");
  assert.equal(Number((await salesFor(qtyApproved.correctedSaleId)).gross_amount), 3000);

  const productA = await seedProduct("PROD-A");
  const productB = await seedProduct("PROD-B", 1800, 1200);
  const productSale = await seedSale({ productId: productA, qty: 1000, price: 1500, paid: 1500, customerId: customer, paymentMethod: "credit" });
  const aBefore = await onHand(productA), bBefore = await onHand(productB);
  const productCorrection = await requestCorrection({
    saleId: productSale, lines: [{ productId: productB, qty: 1000, unitPrice: 1800, sellingQty: 1000 }],
  });
  const productApproved = await approve(productCorrection.correctionId);
  assert.equal(await onHand(productA), aBefore + 1000, "the original product is restored");
  assert.equal(await onHand(productB), bBefore - 1000, "the corrected product is deducted once");
  const correctedLines = (await pool.query("SELECT product_id, qty, unit_cost FROM sale_lines WHERE sale_id=$1", [productApproved.correctedSaleId])).rows;
  assert.equal(correctedLines.length, 1);
  assert.equal(correctedLines[0].product_id, productB);
  assert.equal(Number(correctedLines[0].qty), 1000);
  assert.equal(Number(correctedLines[0].unit_cost), 1200, "the corrected sale gets a fresh moving-average cost snapshot");
});

test("a manager may request but cannot approve, and the owner can reject without touching the sale", { skip }, async () => {
  const product = await seedProduct("ROLE-1", 1000, 500);
  const saleId = await seedSale({ productId: product, qty: 1000, price: 1000, paid: 1000 });
  const { correctionId } = await requestCorrection({ saleId, discount: 0 });
  await assert.rejects(() => corrections.approve(manager, correctionId, "self approval"), /role_not_allowed/);
  const rejected = await corrections.reject(owner, correctionId, "Evidence did not match the receipt");
  assert.equal(rejected.status, "rejected");
  assert.equal((await salesFor(saleId)).status, "posted", "a rejected request never reverses the sale");
  assert.equal(await onHand(product), 199_000, "a request/rejection never moves stock");
});

test("handed-over goods allow a price correction with zero net stock change but refuse quantity changes", { skip }, async () => {
  const product = await seedProduct("HAND-1");
  const saleId = await seedSale({ productId: product, qty: 1000, price: 1500, paid: 1500, dispatched: true });
  // A later purchase changes today's average. The handed-over correction must still use the
  // original sale's cost snapshot, not revalue the goods that never came back.
  const purchase = await svc.push(owner, "d", [op("purchase.create", {
    purchaseId: uuid(), supplierId: null, orderedAt: now(), amountPaid: 2000, receiveNow: true,
    lines: [{ productId: product, qty: 1000, unitCost: 2000 }],
  })]);
  assert.equal(purchase[0].status, "applied", purchase[0].message);
  const before = await onHand(product);

  const relabel = await requestCorrection({
    saleId, fulfillment: "not_handed_over", lines: [{ productId: product, qty: 2000, unitPrice: 1500, sellingQty: 2000 }],
  });
  assert.equal(relabel.result.status, "rejected");
  assert.match(String(relabel.result.message), /dispatched_sale_must_be_handed_over/);

  const bad = await requestCorrection({
    saleId, fulfillment: "handed_over", lines: [{ productId: product, qty: 2000, unitPrice: 1500, sellingQty: 2000 }],
  });
  assert.equal(bad.result.status, "rejected");
  assert.match(String(bad.result.message), /physical_stock_change_requires_return/);
  assert.equal((await salesFor(saleId)).status, "posted");
  assert.equal(await onHand(product), before);

  const good = await requestCorrection({
    saleId, fulfillment: "handed_over", lines: [{ productId: product, qty: 1000, unitPrice: 1200, sellingQty: 1000 }],
  });
  assert.equal(good.result.status, "applied", good.result.message);
  const approved = await approve(good.correctionId);
  assert.equal(approved.fulfillment, "handed_over");
  assert.equal(await onHand(product), before, "a handed-over price correction does not restock the goods");
  assert.equal(Number((await salesFor(approved.correctedSaleId)).amount_paid), 1200);
  assert.equal(approved.expectedRefund, 300);
  const correctedCost = Number((await pool.query(
    "SELECT unit_cost FROM sale_lines WHERE sale_id=$1", [approved.correctedSaleId])).rows[0].unit_cost);
  assert.equal(correctedCost, 1000, "the corrected line keeps the original historical cost basis");
});

test("a partial line correction on handed-over goods is refused instead of reversing an untouched line", { skip }, async () => {
  const a = await seedProduct("PART-A");
  const b = await seedProduct("PART-B", 1200, 600);
  const saleId = await seedSale({
    paid: 2700, dispatched: true,
    lines: [
      { productId: a, qty: 1000, unitPrice: 1500, sellingQty: 1000 },
      { productId: b, qty: 1000, unitPrice: 1200, sellingQty: 1000 },
    ],
  });
  const beforeA = await onHand(a), beforeB = await onHand(b);
  const partial = await requestCorrection({
    saleId, fulfillment: "handed_over",
    lines: [{ productId: a, qty: 1000, unitPrice: 1500, sellingQty: 1000 }],
  });
  assert.equal(partial.result.status, "rejected");
  assert.match(String(partial.result.message), /physical_stock_change_requires_return/);
  assert.equal((await salesFor(saleId)).status, "posted");
  assert.equal(await onHand(a), beforeA);
  assert.equal(await onHand(b), beforeB);
});

test("a sale with a return refuses correction, and a corrected sale cannot be corrected again", { skip }, async () => {
  const product = await seedProduct("RET-1");
  const saleId = await seedSale({ productId: product, qty: 2000, price: 1000, paid: 2000 });
  const returned = await svc.push(owner, "d", [op("sale.return", {
    returnId: uuid(), saleId, returnedAt: now(), reason: "Customer changed their mind",
    lines: [{ productId: product, qty: 1000, condition: "resalable" }],
  })]);
  assert.equal(returned[0].status, "applied", returned[0].message);

  const blocked = await requestCorrection({ saleId });
  assert.equal(blocked.result.status, "rejected");
  assert.match(String(blocked.result.message), /sale_has_returns/);

  // A corrected sale has its own correction link and must not be corrected again.
  const clean = await seedSale({ productId: product, qty: 1000, price: 1000, paid: 1000 });
  const first = await requestCorrection({ saleId: clean });
  const approved = await approve(first.correctionId);
  const second = await requestCorrection({ saleId: approved.correctedSaleId });
  assert.equal(second.result.status, "rejected");
  assert.match(String(second.result.message), /sale_is_corrected_sale/);
});

test("stale original evidence, missing customers, cross-shop access and duplicate approvals are refused or idempotent", { skip }, async () => {
  const product = await seedProduct("SAFE-1");
  const saleId = await seedSale({ productId: product, qty: 1000, price: 1000, paid: 1000 });
  const stale = await requestCorrection({ saleId, discount: 0 });
  await pool.query("UPDATE sales SET discount=1 WHERE id=$1", [saleId]);
  await assert.rejects(() => approve(stale.correctionId), /original_sale_changed/);

  const noCustomerSale = await seedSale({ productId: product, qty: 1000, price: 1000, discount: 200, paid: 800 });
  const needsCustomer = await requestCorrection({ saleId: noCustomerSale, discount: 0 });
  assert.equal(needsCustomer.result.status, "rejected", "a new receivable needs a named customer");

  const crossShopSale = await seedSale({ productId: product, qty: 1000, price: 1000, paid: 1000 });
  const crossShop = await requestCorrection({
    saleId: crossShopSale, lines: [{ productId: product, qty: 1000, unitPrice: 900, sellingQty: 1000 }],
  });
  assert.equal(crossShop.result.status, "applied", crossShop.result.message);
  await assert.rejects(() => corrections.get(shopB, crossShop.correctionId), /correction_not_found/);
  await assert.rejects(() => corrections.approve(ownerB, crossShop.correctionId, "cross shop"), /correction_not_found/);

  const duplicateSale = await seedSale({ productId: product, qty: 1000, price: 1000, paid: 1000 });
  const req = await requestCorrection({ saleId: duplicateSale });
  const first = await approve(req.correctionId);
  assert.equal(first.status, "completed");
  const again = await approve(req.correctionId);
  assert.equal(again.correctedSaleId, first.correctedSaleId);
  const correctedCount = Number((await pool.query("SELECT count(*)::int n FROM sales WHERE corrects_sale_id=$1", [duplicateSale])).rows[0].n);
  assert.equal(correctedCount, 1);
  const reversalMovements = Number((await pool.query(
    "SELECT count(*)::int n FROM stock_movements WHERE source_type='sale_correction' AND source_id=$1", [first.reversalId])).rows[0].n);
  assert.equal(reversalMovements, 1);
});

test("duplicate sync and concurrent approvals do not create duplicate reversals or corrected sales", { skip }, async () => {
  const product = await seedProduct("SYNC-1");
  const saleId = await seedSale({ productId: product, qty: 1000, price: 1500, paid: 1500 });
  const correctionId = uuid();
  const payload = {
    correctionId, saleId, reason: "Duplicate sync protection", evidence: "offline retry",
    fulfillment: "not_handed_over", discount: 0, amountPaid: 1500,
    lines: [{ productId: product, qty: 1000, unitPrice: 1500, sellingQty: 1000 }],
  };
  const first = await svc.push(manager, "d", [op("correction.request", payload)]);
  const replay = await svc.push(manager, "d", [op("correction.request", payload)]);
  assert.equal(first[0].status, "applied");
  assert.equal(replay[0].status, "duplicate");
  assert.equal(Number((await pool.query("SELECT count(*)::int n FROM sale_corrections WHERE id=$1", [correctionId])).rows[0].n), 1);

  const results = await Promise.allSettled([approve(correctionId), approve(correctionId)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
  assert.equal(Number((await pool.query("SELECT count(*)::int n FROM sales WHERE corrects_sale_id=$1", [saleId])).rows[0].n), 1);
  assert.equal(Number((await pool.query("SELECT count(*)::int n FROM sales WHERE id=$1 AND status='reversed'", [saleId])).rows[0].n), 1);
});

test("approval links an alert without deleting its history, and resolved alerts remain resolved for unchanged evidence", { skip }, async () => {
  const product = await seedProduct("ALERT-1");
  const saleId = await seedSale({ productId: product, qty: 3000, price: 1500, discount: 4300, paid: 200, customerId: customer, paymentMethod: "credit" });
  const alertId = uuid();
  await pool.query(
    `INSERT INTO business_alerts(shop_id,dedupe_key,category,severity,severity_level,title,explanation,entity_type,entity_id,evidence,evidence_signature,status)
     VALUES ($1,$2,'discount','warning','high','Large discount','Review this discount','sale',$3,$4,'sig-original','resolved')`,
    [shopA, `sale:${saleId}`, saleId, JSON.stringify({ saleId, discount: 4300, percent: 95.6 })],
  );
  await pool.query("INSERT INTO alert_events(alert_id,shop_id,actor_id,action,note) VALUES ($1,$2,$3,'resolved','Legitimate promotion checked')", [alertId, shopA, owner.id]);

  const request = await requestCorrection({ saleId, discount: 0, alertId });
  assert.equal(request.result.status, "applied", request.result.message);
  const approved = await approve(request.correctionId);
  assert.equal(approved.alertId, alertId);
  const alert = (await pool.query("SELECT status, resolution_category FROM business_alerts WHERE id=$1", [alertId])).rows[0];
  assert.equal(alert.status, "resolved");
  assert.equal(alert.resolution_category, "human_error");
  const events = Number((await pool.query("SELECT count(*)::int n FROM alert_events WHERE alert_id=$1", [alertId])).rows[0].n);
  assert.ok(events >= 2, "the original resolution and the correction event are both retained");
  const detections = Number((await pool.query("SELECT occurrences FROM business_alerts WHERE id=$1", [alertId])).rows[0].occurrences);
  assert.ok(detections >= 1);
});

test("posted reports count the corrected sale once and keep the reversed original in history", { skip }, async () => {
  const product = await seedProduct("REPORT-1");
  const saleId = await seedSale({ productId: product, qty: 2000, price: 1000, paid: 2000 });
  const request = await requestCorrection({
    saleId, lines: [{ productId: product, qty: 2000, unitPrice: 1000, sellingQty: 2000 }], discount: 500,
  });
  const approved = await approve(request.correctionId);
  const totals = (await pool.query(
    "SELECT COALESCE(SUM(gross_amount-discount),0)::bigint net, COUNT(*)::int n FROM sales WHERE shop_id=$1 AND status='posted' AND id IN ($2,$3)",
    [shopA, saleId, approved.correctedSaleId])).rows[0];
  assert.equal(Number(totals.n), 1, "the reversed original is not a positive posted sale");
  assert.equal(Number(totals.net), 1500, "the corrected net is counted once");
  const history = await salesFor(saleId);
  assert.equal(history.status, "reversed");
  assert.equal(Number(history.gross_amount), 2000);
});
