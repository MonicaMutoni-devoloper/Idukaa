/**
 * Dashboard presentation rules. Runs on Node 24:
 *   npm run test:dashboard -w @sms/mobile
 *
 * These lock the choices that a screenshot cannot prove: a repayment shows up in money received
 * but never in sales or profit, no comparison arrow appears without a real baseline, a manager
 * without the cost grant never receives a profit figure, and the attention panel lists only work
 * that actually exists.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  attentionItems, greetingKey, primaryFigures, trendMetricKeys, trendSeries,
} from "../src/services/dashboard-view.ts";
import type { Operations } from "../src/services/local-dashboard.ts";

const ops = (over: Partial<Operations> = {}): Operations => ({
  netSales: 100_000, transactions: 4, unitsSold: 12, averageTransaction: 25_000,
  cashCollected: 80_000, receivables: 20_000, grossSales: 100_000, discounts: 0,
  creditRepayments: 30_000, totalReceived: 110_000, outstandingCredit: 45_000,
  repaymentsByMethod: { cash: 30_000, momo: 0, bank: 0, other: 0 },
  deliveries: 1, productsReceived: 2, unitsReceived: 10, pendingReceipts: 0,
  inventoryValue: 200_000, lowStockCount: 3, outOfStockCount: 2, productCount: 20,
  supplierPayables: 0, pendingApprovals: 1, openInvestigations: 0, openConflicts: 0,
  ...over,
});

const fin = (over: { netSales?: number; grossProfit?: number; grossMarginBps?: number | null } = {}) => ({
  netSales: 100_000, grossProfit: 35_000, grossMarginBps: 3500, ...over,
});

test("money received counts sales collections and credit repayments once, and repayments add no revenue", () => {
  const tiles = primaryFigures({
    operations: ops({ netSales: 100_000, cashCollected: 80_000, creditRepayments: 30_000, totalReceived: 110_000 }),
    financials: fin(), financialsAllowed: true,
  });
  const byKey = Object.fromEntries(tiles.map((t) => [t.key, t]));
  assert.equal(byKey.moneyReceived.value, 110_000, "collections + repayments");
  assert.equal(byKey.netSales.value, 100_000, "a repayment is not sales revenue");
  assert.equal(byKey.grossProfit.value, 35_000, "a repayment is not profit");
});

test("outstanding credit is a balance that survives a quiet period", () => {
  const tiles = primaryFigures({
    operations: ops({ netSales: 0, transactions: 0, cashCollected: 0, creditRepayments: 0, totalReceived: 0, outstandingCredit: 45_000 }),
    financials: fin({ netSales: 0, grossProfit: 0 }), financialsAllowed: true,
  });
  const credit = tiles.find((t) => t.key === "outstandingCredit");
  assert.equal(credit?.value, 45_000, "no sales today does not mean customers owe nothing");
  assert.equal(credit?.tone, "accent", "a balance that needs chasing is not painted as good news");
});

test("no comparison arrow is invented without a baseline", () => {
  const tiles = primaryFigures({ operations: ops(), financials: fin(), financialsAllowed: true });
  assert.ok(tiles.every((t) => t.delta === null), "the payload supplied no comparison");

  const withPrior = primaryFigures({
    operations: ops(), financials: fin(), financialsAllowed: true,
    comparison: { netSales: { change: 5_000, pct: 5 }, grossProfit: { change: -1_000, pct: -3 } },
  });
  assert.equal(withPrior.find((t) => t.key === "netSales")?.delta?.pct, 5);
  assert.equal(withPrior.find((t) => t.key === "grossProfit")?.delta?.pct, -3);
  assert.equal(withPrior.find((t) => t.key === "moneyReceived")?.delta, null, "no per-period collection baseline exists");
});

test("a manager without the cost grant gets no profit figure at all", () => {
  const tiles = primaryFigures({
    operations: ops({ netSales: 100_000, transactions: 4 }), financials: null, financialsAllowed: false,
    salesComparison: { netSales: { change: 0, pct: 0 } },
  });
  assert.equal(tiles.length, 4);
  assert.deepEqual(tiles.map((t) => t.key), ["netSales", "moneyReceived", "outstandingCredit", "transactions"]);
  assert.ok(!tiles.some((t) => t.key === "grossProfit"), "no zero stand-in that reads as a real loss");
});

test("gross profit goes red only when it is actually negative", () => {
  const loss = primaryFigures({ operations: ops(), financials: fin({ grossProfit: -2_000, grossMarginBps: -200 }), financialsAllowed: true });
  assert.equal(loss.find((t) => t.key === "grossProfit")?.tone, "danger");
  const gain = primaryFigures({ operations: ops(), financials: fin(), financialsAllowed: true });
  assert.equal(gain.find((t) => t.key === "grossProfit")?.tone, "default");
});

test("attention lists only real work, worst first, and never double-counts out-of-stock shelves", () => {
  const items = attentionItems({
    operations: ops({ openConflicts: 1, pendingApprovals: 2, openInvestigations: 0, lowStockCount: 5, outOfStockCount: 2 }),
    counts: { pending: 3, failed: 1, conflicts: 0 }, isOwner: true,
  });
  assert.deepEqual(items.map((i) => i.key), ["conflicts", "failed", "approvals", "outOfStock", "lowStock", "pendingSync"]);
  assert.equal(items.find((i) => i.key === "lowStock")?.count, 3, "5 low includes the 2 that are out");
  assert.equal(items.find((i) => i.key === "investigations"), undefined, "zero is not an item");
  assert.equal(items.find((i) => i.key === "pendingSync")?.tone, "neutral", "an offline queue is not a fault");
});

test("a quiet shop has nothing to show, and a manager is not sent to approvals", () => {
  assert.deepEqual(attentionItems({
    operations: ops({ lowStockCount: 0, outOfStockCount: 0, pendingApprovals: 0, openInvestigations: 0, openConflicts: 0 }),
    counts: { pending: 0, failed: 0, conflicts: 0 }, isOwner: true,
  }), []);
  assert.deepEqual(attentionItems({ operations: null, counts: null, isOwner: false }), []);

  const manager = attentionItems({ operations: ops({ pendingApprovals: 4 }), counts: { pending: 0 }, isOwner: false });
  assert.ok(!manager.some((i) => i.key === "approvals"), "a manager cannot approve, so it is not their task");
});

test("the chart plots the metric it names, and offers profit only when permitted", () => {
  const rows = [{ date: "2026-11-16", netSales: 90_000, transactions: 3, grossProfit: 30_000, repayments: 7_000 }];
  assert.equal(trendSeries(rows, "sales")[0]!.netSales, 90_000);
  assert.equal(trendSeries(rows, "profit")[0]!.netSales, 30_000);
  assert.equal(trendSeries(rows, "repayments")[0]!.netSales, 7_000);
  assert.deepEqual(trendMetricKeys(true), ["sales", "profit", "repayments"]);
  assert.deepEqual(trendMetricKeys(false), ["sales", "repayments"]);
});

test("the greeting follows the shop's clock, not the device's", () => {
  // 03:00 UTC is 05:00 in Kigali; 09:59 UTC is 11:59; 16:00 UTC is 18:00.
  assert.equal(greetingKey(Date.UTC(2026, 10, 17, 3, 0)), "home.greeting.morning");
  assert.equal(greetingKey(Date.UTC(2026, 10, 17, 9, 59)), "home.greeting.morning");
  assert.equal(greetingKey(Date.UTC(2026, 10, 17, 10, 0)), "home.greeting.afternoon");
  assert.equal(greetingKey(Date.UTC(2026, 10, 17, 16, 0)), "home.greeting.evening");
  assert.equal(greetingKey(Date.UTC(2026, 10, 17, 22, 0)), "home.greeting.evening");
});
