/**
 * Local dashboard calculation tests. Runs on Node 24 with built-in TypeScript type stripping:
 *   npm run test:dashboard -w @sms/mobile
 *
 * These cover the rules that a network response used to hide: figures derived from saved records,
 * Africa/Kigali day boundaries, an operation counted exactly once across pending -> synced, and a
 * manager never receiving cost or profit data.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dayRange } from "@sms/shared";
import { computeLocalDashboard } from "../src/services/local-dashboard.ts";
import type { LocalProduct, LocalRecord } from "../src/database/local.ts";

const rec = (op_id: string, type: string, at: string, data: unknown, status = "pending"): LocalRecord =>
  ({ op_id, type, at, data: JSON.stringify(data), actor: null, created_at: at, status });

const product = (over: Partial<LocalProduct> = {}): LocalProduct => ({
  id: "p1", code: "P1", barcode: null, name: "Flour", unit: "kg", category: null,
  selling_price: 1000, low_threshold: 2000, on_hand: 0, pending_delta: 0,
  purchase_unit: null, selling_unit: null, units_per_purchase: 1, units_per_selling: 1,
  ...over,
});

const DAY3 = dayRange("2026-11-03")!;
const DAY2 = dayRange("2026-11-02")!;
const DAY4 = dayRange("2026-11-04")!;

const sale = (opId: string, at: string, over: Record<string, unknown> = {}, status = "pending") => rec(opId, "sale.create", at, {
  saleId: `sale-${opId}`, soldAt: at, discount: 200, amountPaid: 1800, paymentMethod: "cash",
  lines: [{ productId: "p1", qty: 2000, unitPrice: 1000, sellingQty: 2000 }], ...over,
}, status);

const purchase = (opId: string, at: string, over: Record<string, unknown> = {}, status = "synced") => rec(opId, "purchase.create", at, {
  purchaseId: `pur-${opId}`, orderedAt: at, amountPaid: 5000, receiveNow: true,
  lines: [{ productId: "p1", qty: 10000, unitCost: 500 }], ...over,
}, status);

const run = (records: LocalRecord[], products: LocalProduct[], range = DAY3, over: { financials?: boolean; role?: "owner" | "manager" } = {}) =>
  computeLocalDashboard({
    records, products, from: range.from, to: range.to,
    role: over.role ?? "owner", financials: over.financials ?? true,
    now: Date.parse("2026-11-03T12:00:00.000Z"),
  });

test("offline costing uses the order operations were saved, not the receipt's noon date", () => {
  const opening: LocalRecord = { op_id: "open-1", type: "product.upsert", at: "2026-11-03T08:00:00.000Z",
    data: JSON.stringify({ productId: "p1", name: "Flour", unit: "kg", sellingPrice: 1500, lowStockThreshold: 0, initialQty: 10000, initialUnitCost: 1000 }),
    actor: null, created_at: "2026-11-03T08:00:00.000Z", status: "synced" };
  // Entered at 09:20 but stored with the receive form's noon document date.
  const receipt: LocalRecord = { op_id: "pur-1", type: "purchase.create", at: "2026-11-03T12:00:00.000Z",
    data: JSON.stringify({ purchaseId: "pur-1", orderedAt: "2026-11-03T12:00:00.000Z", receiveNow: true, amountPaid: 20000,
      lines: [{ productId: "p1", qty: 10000, unitCost: 2000 }] }),
    actor: null, created_at: "2026-11-03T09:20:00.000Z", status: "synced" };
  const saleAt: LocalRecord = { op_id: "sale-1", type: "sale.create", at: "2026-11-03T09:30:00.000Z",
    data: JSON.stringify({ saleId: "sale-1", soldAt: "2026-11-03T09:30:00.000Z", discount: 0, amountPaid: 7500,
      paymentMethod: "cash", lines: [{ productId: "p1", qty: 5000, unitPrice: 1500, sellingQty: 5000 }] }),
    actor: null, created_at: "2026-11-03T09:30:00.000Z", status: "synced" };

  const d = run([opening, receipt, saleAt], [product({ on_hand: 15000 })], DAY3, { financials: true });
  assert.equal(d.data.financials!.cogs, 7500, "5 x 1,500; the 2,000 receipt entered before the sale counts");
  assert.equal(d.data.financials!.grossProfit, 0);
  assert.equal(d.data.financials!.costBasisIncomplete, false);
});

test("the owner and an authorised manager compute the same figures from the same stored records", () => {
  const records = [purchase("op1", "2026-11-02T08:00:00.000Z"), sale("op2", "2026-11-03T09:00:00.000Z", {}, "synced")];
  const products = [product({ on_hand: 8000 })];
  const asOwner = run(records, products, DAY3, { role: "owner" });
  const asManager = run(records, products, DAY3, { role: "manager", financials: true });

  assert.deepEqual(asManager.data.operations, asOwner.data.operations, "one shop, one set of records");
  assert.deepEqual(asManager.data.financials, asOwner.data.financials, "with access granted, the manager sees the same cost and profit");
  assert.equal(asOwner.data.role, "owner");
  assert.equal(asManager.data.role, "manager");
});

test("a manager without financial access sees the shared operations but no cost or profit", () => {
  const records = [sale("op1", "2026-11-03T09:00:00.000Z")];
  const products = [product({ on_hand: 8000 })];
  const hiddenView = run(records, products, DAY3, { role: "manager", financials: false });
  const ownerView = run(records, products, DAY3, { role: "owner" });

  assert.equal(hiddenView.data.financials, null, "cost and profit stay owner-only until the owner grants access");
  assert.deepEqual(hiddenView.data.operations, ownerView.data.operations, "operational figures are shared, not per-role copies");
  assert.ok(!("grossProfit" in (hiddenView.data.topProducts[0] ?? {})), "no profit leaks through the product ranking");
});

test("recomputing from stored records is stable across a relaunch and never double counts", () => {
  const records = [purchase("op1", "2026-11-02T08:00:00.000Z"), sale("op2", "2026-11-03T09:00:00.000Z", {}, "synced")];
  const products = [product({ on_hand: 8000 })];
  const first = run(records, products);
  const afterRelaunch = run(records, products); // same persisted rows, fresh process

  assert.deepEqual(afterRelaunch.data.operations, first.data.operations, "the same records give the same figures");
  assert.deepEqual(afterRelaunch.data.financials, first.data.financials);

  // The record is stored once per operation id, so moving it from pending to synced is not a new sale.
  const pending = run([purchase("op1", "2026-11-02T08:00:00.000Z"), sale("op2", "2026-11-03T09:00:00.000Z")], products);
  assert.deepEqual(pending.data.operations, first.data.operations, "pending -> synced does not count the sale twice");
});

test("an offline sale appears in the dashboard immediately", () => {
  const r = run([sale("op1", "2026-11-03T09:00:00.000Z")], [product({ on_hand: 8000 })]);
  assert.equal(r.data.operations.netSales, 1800, "gross 2000 minus the 200 discount");
  assert.equal(r.data.operations.transactions, 1);
  assert.equal(r.data.operations.unitsSold, 2000);
  assert.equal(r.data.operations.cashCollected, 1800);
  assert.equal(r.data.operations.receivables, 0);
  assert.equal(r.data.financials?.netSales, 1800);
  assert.equal(r.source, "local");
  assert.equal(r.status, "pending_sync", "saved on the device but not yet confirmed");
});

test("an expense moves profit immediately", () => {
  const records = [
    rec("op1", "expense.create", "2026-11-03T08:00:00.000Z", { expenseId: "e1", category: "rent", amount: 500, paid: true, incurredAt: "2026-11-03T08:00:00.000Z" }),
    sale("op2", "2026-11-03T09:00:00.000Z"),
  ];
  const r = run(records, [product({ on_hand: 8000 })]);
  assert.equal(r.data.financials?.operatingExpenses, 500);
  assert.equal(r.data.financials?.operatingProfit, (r.data.financials?.netSales ?? 0) - (r.data.financials?.cogs ?? 0) - 500);
  assert.deepEqual(r.data.expensesByCategory, [{ category: "rent", amount: 500, unpaid: 0 }]);
});

test("a received delivery raises stock and gives the sale a real cost basis", () => {
  const records = [
    rec("op1", "purchase.create", "2026-11-02T08:00:00.000Z", {
      purchaseId: "pur1", orderedAt: "2026-11-02T08:00:00.000Z", amountPaid: 5000, receiveNow: true,
      lines: [{ productId: "p1", qty: 10000, unitCost: 500 }],
    }, "synced"),
    sale("op2", "2026-11-03T09:00:00.000Z", {}, "synced"),
  ];
  const r = run(records, [product({ on_hand: 8000 })]);
  assert.equal(r.data.financials?.cogs, 1000, "2 units at the 500 cost that was actually received");
  assert.equal(r.data.financials?.grossProfit, 800);
  assert.equal(r.data.financials?.costBasisIncomplete, false);
  assert.equal(r.data.operations.inventoryValue, 4000, "8 units left at 500");
  assert.equal(r.data.operations.unitsReceived, 0, "the delivery was yesterday, not in today's range");
});

test("a sale whose stock history is not on this device is flagged provisional, never invented", () => {
  const r = run([sale("op1", "2026-11-03T09:00:00.000Z")], [product({ on_hand: 8000 })]);
  assert.equal(r.data.financials?.costBasisIncomplete, true);
  assert.equal(r.data.operations.inventoryValue, null, "no cost basis means no RWF valuation");
});

test("pending -> synchronized counts the sale exactly once", () => {
  const pending = run([sale("op1", "2026-11-03T09:00:00.000Z", {}, "pending")], [product({ on_hand: 8000 })]);
  const synced = run([sale("op1", "2026-11-03T09:00:00.000Z", {}, "synced")], [product({ on_hand: 8000 })]);
  assert.equal(synced.data.operations.netSales, pending.data.operations.netSales);
  assert.equal(synced.data.operations.transactions, 1);
  assert.equal(synced.data.financials?.netSales, pending.data.financials?.netSales);
  assert.equal(synced.status, "calculated_local");
  assert.equal(pending.status, "pending_sync");
  assert.equal(synced.counts.total, 1);
});

test("a failed or conflicting record is reported as such", () => {
  assert.equal(run([sale("op1", "2026-11-03T09:00:00.000Z", {}, "rejected")], []).status, "sync_failed");
  assert.equal(run([sale("op1", "2026-11-03T09:00:00.000Z", {}, "conflict")], []).status, "conflict");
});

test("a rejected or conflicting operation is never counted as revenue, cost or stock", () => {
  const products = [product({ on_hand: 8000 })];
  for (const status of ["rejected", "conflict"] as const) {
    const r = run([sale("op1", "2026-11-03T09:00:00.000Z", {}, status)], products);
    assert.equal(r.data.operations.netSales, 0, `${status}: no revenue the server refused`);
    assert.equal(r.data.operations.transactions, 0);
    assert.equal(r.data.financials?.netSales, 0);
    assert.equal(r.data.financials?.cogs, 0);
    assert.equal(r.data.expensesByCategory.length, 0);
    assert.equal(r.counts.total, 1, "the operation is still held on the device for recovery");
    assert.equal(r.status, status === "rejected" ? "sync_failed" : "conflict");
  }
});

test("empty records return valid zeros with an unavailable margin, not an error", () => {
  const r = run([], []);
  assert.equal(r.data.operations.netSales, 0);
  assert.equal(r.data.operations.transactions, 0);
  assert.equal(r.data.financials?.grossMarginBps, null, "zero sales means margin is unavailable, not 0%");
  assert.equal(r.data.financials?.operatingResultAfterStockLosses, 0);
  assert.equal(r.coverageFrom, null);
  assert.equal(r.covered, false);
});

test("Kigali business days: 00:30 Kigali belongs to the new day, not the UTC one", () => {
  // 22:30Z on 2 November is 00:30 on 3 November in Africa/Kigali (UTC+2, no daylight saving).
  const records = [sale("op1", "2026-11-02T22:30:00.000Z")];
  assert.equal(run(records, [], DAY3).data.operations.transactions, 1);
  assert.equal(run(records, [], DAY2).data.operations.transactions, 0);
  assert.equal(run(records, [], DAY4).data.operations.transactions, 0, "a later day is not included");
});

test("a manager without financial access gets operational figures but no cost or profit", () => {
  const r = run([sale("op1", "2026-11-03T09:00:00.000Z")], [product({ on_hand: 8000 })], DAY3, { role: "manager", financials: false });
  assert.equal(r.data.financials, null);
  assert.equal(r.data.financialComparison, null);
  assert.equal(r.data.permissions.financials, false);
  assert.equal(r.data.operations.netSales, 1800, "sales data stays visible");
});

test("discounts are split across lines exactly, so product revenue adds up to net sales", () => {
  const records = [rec("op1", "sale.create", "2026-11-03T09:00:00.000Z", {
    saleId: "s1", soldAt: "2026-11-03T09:00:00.000Z", discount: 300, amountPaid: 2700,
    lines: [
      { productId: "p1", qty: 1000, unitPrice: 1000 },
      { productId: "p2", qty: 2000, unitPrice: 1000 },
    ],
  }, "synced")];
  const r = run(records, [product({ id: "p1" }), product({ id: "p2", name: "Sugar" })]);
  const total = r.data.topProducts.reduce((s, p) => s + p.netSales, 0);
  assert.equal(r.data.operations.netSales, 2700);
  assert.equal(total, 2700, "no franc lost or duplicated by the discount split");
});

test("an offline sale return reduces net sales and COGS in its period", () => {
  const records = [
    purchase("op1", "2026-11-02T08:00:00.000Z"),
    sale("op2", "2026-11-03T09:00:00.000Z", { discount: 0, amountPaid: 2000 }, "synced"),
    rec("op3", "adjustment.request", "2026-11-03T10:00:00.000Z", {
      adjustmentId: "adj1", productId: "p1", qty: 1000, reason: "sale_return", refundAmount: 1000,
    }, "pending_approval"),
  ];
  const r = run(records, [product({ on_hand: 9000 })]);
  assert.equal(r.data.operations.netSales, 1000, "2,000 sold less the 1,000 refunded");
  assert.equal(r.data.financials?.cogs, 500, "the returned unit reverses its 500 cost");
  assert.equal(r.data.financials?.grossProfit, 500);
  assert.equal(r.data.operations.inventoryValue, 4500, "9 units back on hand at 500");
});

test("an offline damage adjustment quarantines stock as a loss, not as cost of sales", () => {
  const records = [
    purchase("op1", "2026-11-02T08:00:00.000Z"),
    rec("op2", "adjustment.request", "2026-11-03T09:00:00.000Z", {
      adjustmentId: "adj1", productId: "p1", qty: -1000, reason: "damage",
    }, "pending_approval"),
  ];
  const r = run(records, [product({ on_hand: 9000 })]);
  assert.equal(r.data.operations.netSales, 0);
  assert.equal(r.data.financials?.cogs, 0);
  assert.equal(r.data.financials?.stockLosses, 500, "one damaged unit at the 500 moving average");
  assert.equal(r.data.operations.inventoryValue, 4500);
});
