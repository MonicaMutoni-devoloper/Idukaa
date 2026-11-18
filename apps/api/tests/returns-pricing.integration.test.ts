/**
 * Cancelled sales, product returns and selling-price changes over REAL HTTP, REAL sync and REAL
 * PostgreSQL. No mocks. Skipped when TEST_DATABASE_URL is unset (wipes schema public).
 *
 * The assertions read the persisted records, the stock ledger and the finance report — a green
 * compile is not evidence that money or stock moved correctly.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import "reflect-metadata";
import { execSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { randomUUID as uuid } from "node:crypto";
import { Pool } from "pg";
import bcrypt from "bcryptjs";

process.env.JWT_SECRET = "returns-test-secret-".padEnd(48, "x");
process.env.JWT_EXPIRES_IN = "15m";
const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : "TEST_DATABASE_URL not set";
process.env.DATABASE_URL = url ?? "";
const PASSWORD = "returns-pass-123";

let pool: Pool, app: any, base = "";
let shopA = "", shopB = "", ownerA = "", managerA = "", ownerB = "";
const at = () => new Date().toISOString();

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
  const r = await call("POST", "/auth/login", { email, password: PASSWORD });
  assert.ok(r.status < 300, `login ${email}: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data as { token: string; user: any };
};

async function addUser(email: string, name: string, role: "owner" | "manager", shopId: string) {
  return (await pool.query(
    "INSERT INTO users(email_verified_at, shop_id,email,full_name,password_hash,role) VALUES (now(),$1,$2,$3,$4,$5) RETURNING id",
    [shopId, email, name, await bcrypt.hash(PASSWORD, 4), role])).rows[0].id as string;
}

const push = (token: string, type: string, payload: unknown, opId = uuid()) =>
  call("POST", "/sync/push", { operations: [{ opId, deviceId: "returns-device", createdAt: at(), type, payload }] }, token);

async function createProduct(token: string, opts: { qty?: number; cost?: number; price?: number; name?: string } = {}) {
  const productId = uuid();
  const qty = opts.qty ?? 100_000, cost = opts.cost ?? 1000, price = opts.price ?? 1500;
  const r = await push(token, "product.upsert", {
    productId, code: `P-${productId.slice(0, 6)}`, name: opts.name ?? `Product ${productId.slice(0, 4)}`,
    unit: "pcs", sellingPrice: price, lowStockThreshold: 0, initialQty: qty, initialUnitCost: cost,
  });
  assert.equal(r.data.results[0].status, "applied", JSON.stringify(r.data));
  return { productId, price, cost, qty };
}

async function createSale(token: string, lines: { productId: string; qty: number; unitPrice: number }[], discount = 0, amountPaid?: number) {
  const saleId = uuid();
  const gross = lines.reduce((s, l) => s + (l.qty * l.unitPrice) / 1000, 0);
  const r = await push(token, "sale.create", {
    saleId, soldAt: at(), discount, amountPaid: amountPaid ?? gross - discount,
    paymentMethod: "cash", lines,
  });
  assert.equal(r.data.results[0].status, "applied", JSON.stringify(r.data));
  return { saleId, gross, net: gross - discount };
}

const qtyOn = async (productId: string) =>
  Number((await pool.query("SELECT COALESCE(SUM(qty),0) q FROM stock_movements WHERE product_id=$1", [productId])).rows[0].q);

before(async () => {
  if (skip) return;
  const dbName = new URL(url!).pathname.replace(/^\//, "");
  if (!/test/i.test(dbName) && process.env.ALLOW_DESTRUCTIVE_TEST_DB !== "1") {
    throw new Error(`Refusing to wipe schema public in database "${dbName}"`);
  }
  pool = new Pool({ connectionString: url });
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  const dir = join(process.cwd(), "migrations");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) await pool.query(readFileSync(join(dir, f), "utf8"));

  shopA = (await pool.query("INSERT INTO shops(name) VALUES ('Returns shop A') RETURNING id")).rows[0].id;
  shopB = (await pool.query("INSERT INTO shops(name) VALUES ('Returns shop B') RETURNING id")).rows[0].id;
  ownerA = await addUser("owner@returns.test", "Owner A", "owner", shopA);
  managerA = await addUser("manager@returns.test", "Manager A", "manager", shopA);
  ownerB = await addUser("owner@returns-b.test", "Owner B", "owner", shopB);

  try { execSync("npx tsc -p tsconfig.json", { cwd: process.cwd(), stdio: "pipe" }); }
  catch (e: any) { throw new Error(`app build failed:\n${e?.stdout ?? ""}${e?.stderr ?? ""}`); }
  const { AppModule } = await import("../dist/app.module");
  const { NestFactory } = await import("@nestjs/core");
  app = await NestFactory.create(AppModule, { logger: ["error"] });
  await app.listen(0, "127.0.0.1");
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
});
after(async () => { if (skip) return; await app?.close(); await pool.end(); });

test("cancelling a sale reverses revenue and stock without deleting anything, idempotently", { skip }, async () => {
  const o = await auth("owner@returns.test");
  const m = await auth("manager@returns.test");
  const p = await createProduct(m.token, { qty: 20_000 });
  const { saleId, net } = await createSale(m.token, [{ productId: p.productId, qty: 5000, unitPrice: 1500 }]);
  assert.equal(await qtyOn(p.productId), 15_000);

  // Managers cannot cancel: the sales routes stay owner-only.
  assert.equal((await call("POST", `/sales/${saleId}/cancel`, { reason: "wrong role" }, m.token)).status, 403);

  const cancellationId = uuid();
  const cancel = await call("POST", `/sales/${saleId}/cancel`, { reason: "Customer changed their mind", cancellationId }, o.token);
  assert.equal(cancel.status, 201, JSON.stringify(cancel.data));
  assert.equal(cancel.data.status, "reversed");
  assert.equal(cancel.data.restocked, true);

  // The sale row is preserved, stamped and still carries its original lines.
  const sale = (await pool.query("SELECT status, cancellation_id, reversed_at, reversal_reason FROM sales WHERE id=$1", [saleId])).rows[0];
  assert.equal(sale.status, "reversed");
  assert.equal(sale.cancellation_id, cancellationId);
  assert.ok(sale.reversed_at);
  assert.equal(sale.reversal_reason, "Customer changed their mind");
  assert.equal(Number((await pool.query("SELECT count(*)::int n FROM sale_lines WHERE sale_id=$1", [saleId])).rows[0].n), 1);
  assert.equal(await qtyOn(p.productId), 20_000, "undispatched goods return to stock");
  const mv = (await pool.query("SELECT qty, unit_cost FROM stock_movements WHERE source_type='sale_void' AND source_id=$1", [saleId])).rows[0];
  assert.equal(Number(mv.qty), 5000);
  assert.equal(Number(mv.unit_cost), 1000, "restored at the original sale cost");
  assert.equal(Number((await pool.query("SELECT count(*)::int n FROM audit_log WHERE action='sale.void' AND entity_id=$1", [saleId])).rows[0].n), 1);

  // A retried request is the same cancellation, not a second reversal.
  const again = await call("POST", `/sales/${saleId}/cancel`, { reason: "Customer changed their mind", cancellationId }, o.token);
  assert.equal(again.status, 201);
  assert.equal(again.data.duplicate, true);
  assert.equal(await qtyOn(p.productId), 20_000);
  const other = await call("POST", `/sales/${saleId}/cancel`, { reason: "Again", cancellationId: uuid() }, o.token);
  assert.equal(other.status, 400);
  assert.equal(msg(other.data), "sale_already_reversed");

  // Revenue is gone from the finance report, and so is the COGS of restocked goods.
  const from = new Date(Date.now() - 3600_000).toISOString(), to = new Date(Date.now() + 3600_000).toISOString();
  const summary = await call("GET", `/reports/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, undefined, o.token);
  assert.equal(summary.status, 200, JSON.stringify(summary.data));
  assert.equal(Number(summary.data.current.grossSales), 0);
  assert.equal(Number(summary.data.current.salesReturns), 0);
  assert.equal(Number(summary.data.current.cogs), 0);
  assert.equal(Number(summary.data.current.netSales), 0);
  assert.ok(net > 0);
});

test("a dispatched cancellation needs owner approval and does not silently restock", { skip }, async () => {
  const o = await auth("owner@returns.test");
  const m = await auth("manager@returns.test");
  const p = await createProduct(m.token, { qty: 10_000 });
  const { saleId } = await createSale(m.token, [{ productId: p.productId, qty: 3000, unitPrice: 1500 }]);
  await pool.query("UPDATE sales SET dispatched_at=now() WHERE id=$1", [saleId]);

  const noApproval = await call("POST", `/sales/${saleId}/cancel`, { reason: "Goods already on the truck" }, o.token);
  assert.equal(noApproval.status, 400);
  assert.equal(msg(noApproval.data), "approval_ref_required_after_dispatch");
  assert.equal((await pool.query("SELECT status FROM sales WHERE id=$1", [saleId])).rows[0].status, "posted", "the refused request changed nothing");

  const cancelled = await call("POST", `/sales/${saleId}/cancel`, {
    reason: "Goods already on the truck, owner agreed", approvalRef: "OWNER-OK-1", restock: false,
  }, o.token);
  assert.equal(cancelled.status, 201, JSON.stringify(cancelled.data));
  assert.equal(cancelled.data.restocked, false);
  assert.equal(await qtyOn(p.productId), 7000, "dispatched goods are not restocked without confirmation");
  const row = (await pool.query("SELECT cancellation_approval_ref FROM sales WHERE id=$1", [saleId])).rows[0];
  assert.equal(row.cancellation_approval_ref, "OWNER-OK-1");
});

test("partial and full returns refund the discounted amount and restore only resalable goods", { skip }, async () => {
  const m = await auth("manager@returns.test");
  const p = await createProduct(m.token, { qty: 50_000 });
  const { saleId, net } = await createSale(m.token, [{ productId: p.productId, qty: 10_000, unitPrice: 1500 }], 1000);
  assert.equal(net, 14_000);

  const preview = await call("GET", `/returns/preview/${saleId}`, undefined, m.token);
  assert.equal(preview.status, 200);
  assert.equal(preview.data.lines[0].remainingQty, 10_000);
  assert.equal(preview.data.lines[0].net, 14_000);
  assert.equal(preview.data.lines[0].unitCost, 1000);

  const partial = { returnId: uuid(), saleId, returnedAt: at(), reason: "Two bags were torn", lines: [{ productId: p.productId, qty: 3000, condition: "resalable" }] };
  const first = await call("POST", "/returns", partial, m.token);
  assert.equal(first.status, 201, JSON.stringify(first.data));
  assert.equal(first.data.refund, 4200, "3/10 of the discounted 14,000");
  assert.equal(first.data.costReversed, 3000);
  assert.equal(await qtyOn(p.productId), 43_000);

  // Replaying the same document id is a duplicate: no second refund and no second restock.
  const replay = await call("POST", "/returns", partial, m.token);
  assert.equal(replay.status, 201);
  assert.equal(replay.data.status, "duplicate");
  assert.equal(await qtyOn(p.productId), 43_000);

  // Requesting more than the remaining 7 units is refused before anything is written.
  const over = await call("POST", "/returns", { returnId: uuid(), saleId, returnedAt: at(), reason: "Too many", lines: [{ productId: p.productId, qty: 8000, condition: "resalable" }] }, m.token);
  assert.equal(over.status, 400);
  assert.match(msg(over.data), /return_exceeds_sold/);
  assert.equal(await qtyOn(p.productId), 43_000);

  // Damaged goods are recorded and refunded but stay out of sellable stock.
  const damaged = await call("POST", "/returns", { returnId: uuid(), saleId, returnedAt: at(), reason: "Torn bags", approvalRef: "OWNER-RET-1", lines: [{ productId: p.productId, qty: 2000, condition: "damaged" }] }, m.token);
  assert.equal(damaged.status, 201, JSON.stringify(damaged.data));
  assert.equal(damaged.data.refund, 2800);
  assert.equal(damaged.data.costReversed, 0, "damaged goods are not restored, so no COGS is reversed");
  assert.equal(await qtyOn(p.productId), 43_000);
  const damagedLine = (await pool.query("SELECT condition, restocked FROM sale_return_lines WHERE return_id=$1", [damaged.data.returnId])).rows[0];
  assert.equal(damagedLine.condition, "damaged");
  assert.equal(damagedLine.restocked, false);

  // The remaining 5 units refund exactly the remaining net: the two returns reconcile to the sale.
  const rest = await call("POST", "/returns", { returnId: uuid(), saleId, returnedAt: at(), reason: "Final balance", lines: [{ productId: p.productId, qty: 5000, condition: "resalable" }] }, m.token);
  assert.equal(rest.status, 201, JSON.stringify(rest.data));
  assert.equal(rest.data.refund, 7000);
  assert.equal(first.data.refund + damaged.data.refund + rest.data.refund, net);
  assert.equal(await qtyOn(p.productId), 48_000);
  const view = await call("GET", `/returns/preview/${saleId}`, undefined, m.token);
  assert.equal(view.data.fullyReturned, true);
  const detail = await call("GET", `/reports/sales/${saleId}`, undefined, m.token);
  assert.equal(detail.status, 200);
  assert.equal(detail.data.returns.length, 3);
  const tx = await call("GET", `/reports/transactions?kind=sales&from=${encodeURIComponent(new Date(Date.now() - 3600_000).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 3600_000).toISOString())}`, undefined, m.token);
  const row = tx.data.find((s: any) => s.id === saleId);
  assert.equal(row.return_status, "full");
  assert.equal(Number(row.refunded), 14_000);
});

test("returns restore inventory at the historical sale cost, not today's average", { skip }, async () => {
  const o = await auth("owner@returns.test");
  const m = await auth("manager@returns.test");
  const p = await createProduct(m.token, { qty: 10_000, cost: 1000, price: 2000 });
  const { saleId } = await createSale(m.token, [{ productId: p.productId, qty: 4000, unitPrice: 2000 }]);
  assert.equal(await qtyOn(p.productId), 6000);
  const from = new Date(Date.now() - 3600_000).toISOString(), to = new Date(Date.now() + 3600_000).toISOString();
  const beforeReturn = (await call("GET", `/reports/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, undefined, o.token)).data.current;

  // A later receipt raises the moving average to 2,000; the sale's cost stays 1,000.
  const received = await push(m.token, "purchase.create", {
    purchaseId: uuid(), supplierId: null, orderedAt: at(), amountPaid: 0, receiveNow: true,
    lines: [{ productId: p.productId, qty: 4000, unitCost: 3000 }],
  });
  assert.equal(received.data.results[0].status, "applied", JSON.stringify(received.data));

  const ret = await call("POST", "/returns", { returnId: uuid(), saleId, returnedAt: at(), reason: "Customer returned one", lines: [{ productId: p.productId, qty: 1000, condition: "resalable" }] }, m.token);
  assert.equal(ret.status, 201, JSON.stringify(ret.data));
  assert.equal(ret.data.costReversed, 1000, "the original line cost");
  const movement = (await pool.query("SELECT unit_cost FROM stock_movements WHERE type='sale_return' AND source_id=$1", [ret.data.returnId])).rows[0];
  assert.equal(Number(movement.unit_cost), 1000);
  assert.equal(await qtyOn(p.productId), 11_000);

  const afterReturn = (await call("GET", `/reports/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, undefined, o.token)).data.current;
  // The return reverses exactly the cost the goods left at (1,000), not the new 3,000 average.
  assert.equal(Number(beforeReturn.cogs) - Number(afterReturn.cogs), 1000);
  assert.equal(Number(afterReturn.salesReturns) - Number(beforeReturn.salesReturns), 2000);
});

test("returns are shop-scoped, manager-allowed and need approval for damaged goods", { skip }, async () => {
  const m = await auth("manager@returns.test");
  const b = await auth("owner@returns-b.test");
  const p = await createProduct(m.token, { qty: 10_000 });
  const { saleId } = await createSale(m.token, [{ productId: p.productId, qty: 2000, unitPrice: 1500 }]);

  assert.equal((await call("GET", `/returns/preview/${saleId}`, undefined, b.token)).status, 404);
  assert.equal((await call("POST", "/returns", { returnId: uuid(), saleId, returnedAt: at(), reason: "Foreign shop", lines: [{ productId: p.productId, qty: 1000, condition: "resalable" }] }, b.token)).status, 404);

  const damagedNoRef = await call("POST", "/returns", { returnId: uuid(), saleId, returnedAt: at(), reason: "Damaged item", lines: [{ productId: p.productId, qty: 1000, condition: "damaged" }] }, m.token);
  assert.equal(damagedNoRef.status, 400);
  assert.equal(msg(damagedNoRef.data), "return_approval_required");
  assert.equal(await qtyOn(p.productId), 8000);
});

test("a selling-price change keeps history, never moves stock, and needs approval below cost", { skip }, async () => {
  const o = await auth("owner@returns.test");
  const m = await auth("manager@returns.test");
  const p = await createProduct(m.token, { qty: 100_000, cost: 1000, price: 1500 });
  const movementsBefore = Number((await pool.query("SELECT count(*)::int n FROM stock_movements WHERE product_id=$1", [p.productId])).rows[0].n);

  const preview = await call("GET", `/products/${p.productId}/price-preview?newPrice=2000`, undefined, m.token);
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  assert.equal(preview.data.product.avgCost, 1000);
  assert.equal(preview.data.product.costPerSellingUnit, 1000);
  assert.equal(preview.data.product.onHand, 100_000);
  assert.equal(preview.data.proposed.grossProfitPerUnit, 1000);
  assert.equal(preview.data.proposed.grossMarginBps, 5000);
  assert.equal(preview.data.proposed.potentialRevenue, 200_000);
  assert.equal(preview.data.proposed.expectedGrossProfit, 100_000);
  assert.equal(preview.data.warnings.length, 0);

  const raised = await call("POST", `/products/${p.productId}/price`, { priceId: uuid(), newPrice: 2000, reason: "Supplier increased prices", expectedPrice: 1500 }, m.token);
  assert.equal(raised.status, 201, JSON.stringify(raised.data));
  assert.equal((await pool.query("SELECT selling_price FROM products WHERE id=$1", [p.productId])).rows[0].selling_price, 2000);
  assert.equal(Number((await pool.query("SELECT count(*)::int n FROM stock_movements WHERE product_id=$1", [p.productId])).rows[0].n), movementsBefore, "no inventory movement");
  assert.equal(Number((await pool.query("SELECT count(*)::int n FROM audit_log WHERE action='product.price.change' AND entity_id=$1", [p.productId])).rows[0].n), 1);

  // Below cost: a manager needs an explicit owner reference; the owner may proceed.
  const below = await call("POST", `/products/${p.productId}/price`, { priceId: uuid(), newPrice: 900, reason: "Clear old stock", expectedPrice: 2000 }, m.token);
  assert.equal(below.status, 403);
  assert.equal(msg(below.data), "below_cost_approval_required");
  const belowApproved = await call("POST", `/products/${p.productId}/price`, { priceId: uuid(), newPrice: 900, reason: "Clear old stock", approvalRef: "OWNER-PRICE-1", expectedPrice: 2000 }, m.token);
  assert.equal(belowApproved.status, 201, JSON.stringify(belowApproved.data));
  const ownerBelow = await call("POST", `/products/${p.productId}/price`, { priceId: uuid(), newPrice: 800, reason: "Owner decision", expectedPrice: 900 }, o.token);
  assert.equal(ownerBelow.status, 201);

  // A stale expected price is a conflict and cannot overwrite the newer server price.
  const stale = await call("POST", `/products/${p.productId}/price`, { priceId: uuid(), newPrice: 1200, reason: "Old device", expectedPrice: 1500 }, m.token);
  assert.equal(stale.status, 409);
  assert.equal(msg(stale.data), "price_changed_on_server");
  assert.equal((await pool.query("SELECT selling_price FROM products WHERE id=$1", [p.productId])).rows[0].selling_price, 800);

  // Every change — including the purchase-carried one later — is in the price ledger.
  const history = await call("GET", `/products/${p.productId}/prices`, undefined, m.token);
  assert.equal(history.status, 200);
  assert.deepEqual(history.data.changes.map((c: any) => [c.oldPrice, c.newPrice]).slice(0, 3), [[900, 800], [2000, 900], [1500, 2000]]);
});

test("scheduled and offline price changes take effect without rewriting historical sale prices", { skip }, async () => {
  const o = await auth("owner@returns.test");
  const m = await auth("manager@returns.test");
  const p = await createProduct(m.token, { qty: 20_000, cost: 1000, price: 1500 });
  const { saleId } = await createSale(m.token, [{ productId: p.productId, qty: 2000, unitPrice: 1500 }]);

  const future = new Date(Date.now() + 3600_000).toISOString();
  const scheduled = await call("POST", `/products/${p.productId}/price`, { priceId: uuid(), newPrice: 1800, reason: "Next month price", effectiveAt: future, expectedPrice: 1500 }, o.token);
  assert.equal(scheduled.status, 201, JSON.stringify(scheduled.data));
  assert.equal(scheduled.data.scheduled, true);
  let prod = (await pool.query("SELECT selling_price, pending_selling_price FROM products WHERE id=$1", [p.productId])).rows[0];
  assert.equal(Number(prod.selling_price), 1500, "the current price is unchanged until the effective time");
  assert.equal(Number(prod.pending_selling_price), 1800);

  // The original sale keeps the price it charged; the price change did not touch it.
  assert.equal(Number((await pool.query("SELECT unit_price FROM sale_lines WHERE sale_id=$1", [saleId])).rows[0].unit_price), 1500);

  // Once due, the next pull promotes it (no stock movement).
  const movements = Number((await pool.query("SELECT count(*)::int n FROM stock_movements WHERE product_id=$1", [p.productId])).rows[0].n);
  await pool.query("UPDATE products SET pending_price_at=now() - interval '1 minute' WHERE id=$1", [p.productId]);
  const pulled = await call("GET", "/sync/pull", undefined, o.token);
  assert.equal(pulled.status, 200);
  prod = (await pool.query("SELECT selling_price, pending_selling_price FROM products WHERE id=$1", [p.productId])).rows[0];
  assert.equal(Number(prod.selling_price), 1800);
  assert.equal(prod.pending_selling_price, null);
  assert.equal(Number((await pool.query("SELECT count(*)::int n FROM stock_movements WHERE product_id=$1", [p.productId])).rows[0].n), movements);

  // Offline change with the price the device saw applies; a stale one is a conflict.
  const applied = await push(m.token, "product.price.set", { productId: p.productId, priceId: uuid(), newPrice: 1900, reason: "Phone price update", expectedPrice: 1800 });
  assert.equal(applied.data.results[0].status, "applied", JSON.stringify(applied.data));
  assert.equal(Number((await pool.query("SELECT selling_price FROM products WHERE id=$1", [p.productId])).rows[0].selling_price), 1900);
  const stale = await push(m.token, "product.price.set", { productId: p.productId, priceId: uuid(), newPrice: 1950, reason: "Stale phone", expectedPrice: 1800 });
  assert.equal(stale.data.results[0].status, "conflict");
  assert.equal(stale.data.results[0].message, "price_changed_on_server");
  assert.equal(Number((await pool.query("SELECT selling_price FROM products WHERE id=$1", [p.productId])).rows[0].selling_price), 1900);

  // A sale after the change still records the price the cashier charged, and that line keeps it.
  const after = await createSale(m.token, [{ productId: p.productId, qty: 1000, unitPrice: 1900 }]);
  assert.equal(Number((await pool.query("SELECT unit_price FROM sale_lines WHERE sale_id=$1", [after.saleId])).rows[0].unit_price), 1900);
  assert.equal(Number((await pool.query("SELECT unit_price FROM sale_lines WHERE sale_id=$1", [saleId])).rows[0].unit_price), 1500);
});

test("an offline return is validated on push, idempotent, and a rejected attempt writes nothing", { skip }, async () => {
  const m = await auth("manager@returns.test");
  const p = await createProduct(m.token, { qty: 10_000 });
  const { saleId } = await createSale(m.token, [{ productId: p.productId, qty: 3000, unitPrice: 1500 }]);
  const returnId = uuid();
  const payload = { returnId, saleId, returnedAt: at(), reason: "Offline return", lines: [{ productId: p.productId, qty: 1000, condition: "resalable" }] };
  const opId = uuid();

  const first = await push(m.token, "sale.return", payload, opId);
  assert.equal(first.data.results[0].status, "applied", JSON.stringify(first.data));
  assert.equal(await qtyOn(p.productId), 8000);
  const replay = await push(m.token, "sale.return", payload, opId);
  assert.equal(replay.data.results[0].status, "duplicate");
  assert.equal(await qtyOn(p.productId), 8000);

  const over = await push(m.token, "sale.return", { ...payload, returnId: uuid(), lines: [{ productId: p.productId, qty: 9000, condition: "resalable" }] });
  assert.equal(over.data.results[0].status, "rejected");
  assert.match(over.data.results[0].message, /return_exceeds_sold/);
  assert.equal(await qtyOn(p.productId), 8000);

  // Mixed valid/invalid lines roll the whole document back: no header, no line, no movement.
  const before = Number((await pool.query("SELECT count(*)::int n FROM sale_returns")).rows[0].n);
  const mixed = await call("POST", "/returns", { returnId: uuid(), saleId, returnedAt: at(), reason: "One bad line", lines: [
    { productId: p.productId, qty: 1000, condition: "resalable" },
    { productId: uuid(), qty: 1000, condition: "resalable" },
  ] }, m.token);
  assert.equal(mixed.status, 400);
  assert.equal(Number((await pool.query("SELECT count(*)::int n FROM sale_returns")).rows[0].n), before);
  assert.equal(await qtyOn(p.productId), 8000);
  assert.equal(Number((await pool.query("SELECT count(*)::int n FROM sale_return_lines WHERE product_id=$1", [p.productId])).rows[0].n), 1);
});

test("a cancelled sale with returns is refused instead of reversing the same revenue twice", { skip }, async () => {
  const o = await auth("owner@returns.test");
  const m = await auth("manager@returns.test");
  const p = await createProduct(m.token, { qty: 10_000 });
  const { saleId } = await createSale(m.token, [{ productId: p.productId, qty: 2000, unitPrice: 1500 }]);
  const ret = await call("POST", "/returns", { returnId: uuid(), saleId, returnedAt: at(), reason: "One came back", lines: [{ productId: p.productId, qty: 1000, condition: "resalable" }] }, m.token);
  assert.equal(ret.status, 201);
  const cancel = await call("POST", `/sales/${saleId}/cancel`, { reason: "Customer cancelled the rest" }, o.token);
  assert.equal(cancel.status, 400);
  assert.equal(msg(cancel.data), "sale_has_returns");
  assert.equal((await pool.query("SELECT status FROM sales WHERE id=$1", [saleId])).rows[0].status, "posted");
});

test("the database itself refuses to return more than was sold", { skip }, async () => {
  const m = await auth("manager@returns.test");
  const p = await createProduct(m.token, { qty: 10_000 });
  const { saleId } = await createSale(m.token, [{ productId: p.productId, qty: 1000, unitPrice: 1500 }]);
  const returnId = uuid();
  await pool.query("INSERT INTO sale_returns(id,shop_id,sale_id,user_id,returned_at,reason) VALUES ($1,$2,$3,$4,now(),'direct insert probe')", [returnId, shopA, saleId, managerA]);
  await assert.rejects(
    () => pool.query(`INSERT INTO sale_return_lines(return_id,product_id,qty,unit_price,refund_amount,unit_cost,condition,restocked)
                      VALUES ($1,$2,2000,1500,3000,1000,'resalable',true)`, [returnId, p.productId]),
    (e: any) => e?.code === "23514");
  // The failed insert left no line behind; the probe header is inert because it has no lines.
  assert.equal(Number((await pool.query("SELECT count(*)::int n FROM sale_return_lines WHERE return_id=$1", [returnId])).rows[0].n), 0);
});
