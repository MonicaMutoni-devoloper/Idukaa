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

const run = (records: LocalRecord[], products: LocalProduct[], range = DAY3, over: { financials?: boolean; role?: "owner" | "manager" } = {}) =>
  computeLocalDashboard({
    records, products, from: range.from, to: range.to,
    role: over.role ?? "owner", financials: over.financials ?? true,
    now: Date.parse("2026-11-03T12:00:00.000Z"),
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
