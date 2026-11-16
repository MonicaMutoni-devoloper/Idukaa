/**
 * Queued work folded onto a dashboard snapshot. Runs on Node's test runner:
 *   npm run test:dashboard -w @sms/mobile
 *
 * The rule under test is the one the shop reported twice: an offline phone must not show only its
 * own sales as the whole period (the snapshot stays the basis), and it must not freeze until the
 * phone finds a network either (queued sales are folded on top). Cost is only claimed when this
 * device's stock history can price it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dayRange } from "@sms/shared";
import { computeLocalDashboard } from "../src/services/local-dashboard.ts";
import { applyPendingDashboard, pendingFigures } from "../src/services/pending-dashboard.ts";
import type { LocalProduct, LocalRecord } from "../src/database/local.ts";

const rec = (op_id: string, type: string, at: string, data: unknown, status = "pending"): LocalRecord =>
  ({ op_id, type, at, data: JSON.stringify(data), actor: null, created_at: at, status });

const product = (over: Partial<LocalProduct> = {}): LocalProduct => ({
  id: "p1", code: "P1", barcode: null, name: "Flour", unit: "kg", category: null,
  selling_price: 1000, low_threshold: 2000, on_hand: 0, pending_delta: 0,
  purchase_unit: null, selling_unit: null, units_per_purchase: 1, units_per_selling: 1,
  ...over,
});

const DAY = dayRange("2026-11-03")!;
const sale = (opId: string, at: string, over: Record<string, unknown> = {}, status = "pending") => rec(opId, "sale.create", at, {
  saleId: `sale-${opId}`, soldAt: at, discount: 200, amountPaid: 1800, paymentMethod: "cash",
  lines: [{ productId: "p1", qty: 2000, unitPrice: 1000, sellingQty: 2000 }], ...over,
}, status);
const purchase = (opId: string, at: string, over: Record<string, unknown> = {}, status = "synced") => rec(opId, "purchase.create", at, {
  purchaseId: `pur-${opId}`, orderedAt: at, amountPaid: 5000, receiveNow: true,
  lines: [{ productId: "p1", qty: 10000, unitCost: 500 }], ...over,
}, status);

/** A dashboard as the server would have answered it, computed from already-synchronized records. */
const snapshot = (records: LocalRecord[]) =>
  computeLocalDashboard({
    records, products: [product({ on_hand: 8000 })], from: DAY.from, to: DAY.to,
    role: "owner", financials: true, now: Date.parse("2026-11-03T12:00:00.000Z"),
  }).data;

const base = () => snapshot([purchase("op1", "2026-11-02T08:00:00.000Z"), sale("op2", "2026-11-03T09:00:00.000Z", {}, "synced")]);

test("a queued sale moves today's figures without touching the rest of the shop's history", () => {
  const records = [purchase("op1", "2026-11-02T08:00:00.000Z"), sale("op2", "2026-11-03T09:00:00.000Z", {}, "synced"),
    sale("op3", "2026-11-03T10:00:00.000Z", { discount: 0, amountPaid: 1000, lines: [{ productId: "p1", qty: 1000, unitPrice: 1000, sellingQty: 1000 }] })];
  const before = base();
  const figures = pendingFigures({ records, from: DAY.from, to: DAY.to, withCosts: true });
  const after = applyPendingDashboard(before, figures);

  assert.equal(figures.count, 1);
  assert.equal(figures.netSales, 1000);
  assert.equal(figures.costComplete, true, "the device's own receipt explains the cost");
  assert.equal(figures.cogs, 500, "cost is the moving average this device recorded");

  // The basis is the shop's snapshot (1800 net from the synchronized sale), not the device's rows.
  assert.equal(before.operations.netSales, 1800);
  assert.equal(after.operations.netSales, 2800);
  assert.equal(after.operations.transactions, 2);
  assert.equal(after.financials?.netSales, 2800);
  assert.equal(after.financials?.cogs, before.financials!.cogs + 500);
  assert.equal(after.financials?.grossProfit, (after.financials!.netSales) - (after.financials!.cogs));
  assert.equal(after.financials?.grossMarginBps, Math.round((after.financials!.grossProfit * 10_000) / 2800));
  assert.equal(after.financials?.operatingProfit, after.financials!.grossProfit - after.financials!.operatingExpenses);
  // The chart gains the sale on the same Kigali day, and the canned comparison panels are untouched.
  const dayRow = after.trend.find((p) => p.date === "2026-11-03");
  assert.equal(dayRow?.netSales, 2800, "the day's bar keeps the shop's sale and gains the queued one");
  assert.equal(dayRow?.transactions, 2);
  assert.deepEqual(after.salesComparison, before.salesComparison);
});

test("merging twice from the same snapshot never counts a sale twice", () => {
  const records = [purchase("op1", "2026-11-02T08:00:00.000Z"), sale("op2", "2026-11-03T09:00:00.000Z", {}, "synced"),
    sale("op3", "2026-11-03T10:00:00.000Z")];
  const figures = pendingFigures({ records, from: DAY.from, to: DAY.to, withCosts: true });
  const before = base();
  const once = applyPendingDashboard(before, figures);
  const twice = applyPendingDashboard(before, figures);
  assert.equal(once.operations.netSales, twice.operations.netSales);
  assert.equal(once.operations.transactions, 2);
  assert.equal(before.operations.transactions, 1, "the snapshot itself is never mutated");
});

test("once the sale synchronizes the snapshot already contains it, so nothing is added", () => {
  const records = [purchase("op1", "2026-11-02T08:00:00.000Z"), sale("op2", "2026-11-03T09:00:00.000Z", {}, "synced"),
    sale("op3", "2026-11-03T10:00:00.000Z", {}, "synced")];
  const figures = pendingFigures({ records, from: DAY.from, to: DAY.to, withCosts: true });
  assert.equal(figures.count, 0);
  const before = base();
  assert.equal(applyPendingDashboard(before, figures), before);
});

test("a rejected or conflicting sale never reaches the figures", () => {
  for (const status of ["rejected", "conflict"]) {
    const records = [purchase("op1", "2026-11-02T08:00:00.000Z"), sale("op3", "2026-11-03T10:00:00.000Z", {}, status)];
    const figures = pendingFigures({ records, from: DAY.from, to: DAY.to, withCosts: true });
    assert.equal(figures.count, 0, `${status} must not add revenue`);
    assert.equal(figures.netSales, 0);
  }
});

test("a sale dated outside the range does not move this period", () => {
  const records = [purchase("op1", "2026-11-01T08:00:00.000Z"), sale("op3", "2026-11-02T10:00:00.000Z")];
  const figures = pendingFigures({ records, from: DAY.from, to: DAY.to, withCosts: true });
  assert.equal(figures.count, 0);
  assert.equal(figures.netSales, 0);
});

test("a cost this device cannot explain is marked provisional instead of guessed", () => {
  // Stock arrived before this phone had any history: the cost basis is not on the device.
  const records = [sale("op3", "2026-11-03T10:00:00.000Z", { discount: 0, amountPaid: 1000, lines: [{ productId: "p1", qty: 1000, unitPrice: 1000, sellingQty: 1000 }] })];
  const figures = pendingFigures({ records, from: DAY.from, to: DAY.to, withCosts: true });
  assert.equal(figures.count, 1);
  assert.equal(figures.netSales, 1000, "the sale itself is still real money");
  assert.equal(figures.costComplete, false);
  const after = applyPendingDashboard(base(), figures);
  assert.equal(after.financials?.costBasisIncomplete, true, "profit is flagged, not presented as exact");
});

test("a queued credit sale raises what customers owe, and a queued repayment lowers it", () => {
  const records = [
    purchase("op1", "2026-11-02T08:00:00.000Z"),
    sale("op3", "2026-11-03T10:00:00.000Z", {
      customerId: "c1", discount: 0, amountPaid: 300,
      lines: [{ productId: "p1", qty: 1000, unitPrice: 1000, sellingQty: 1000 }],
    }),
    rec("op4", "credit.payment.create", "2026-11-03T11:00:00.000Z", {
      paymentId: "pay-1", customerId: "c1", amount: 200, method: "momo", paidAt: "2026-11-03T11:00:00.000Z",
    }),
  ];
  const figures = pendingFigures({ records, from: DAY.from, to: DAY.to, withCosts: true });
  assert.equal(figures.creditDelta, 700 - 200);
  const after = applyPendingDashboard(base(), figures);
  assert.equal(after.operations.outstandingCredit, 500);
  assert.equal(after.operations.creditRepayments, 200, "a repayment is never revenue");
  assert.equal(after.operations.repaymentsByMethod?.momo, 200);
  assert.equal(after.operations.totalReceived, after.operations.cashCollected + 200);
});
