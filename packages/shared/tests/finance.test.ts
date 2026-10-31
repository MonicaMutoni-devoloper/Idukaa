import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQty, formatQty, lineAmount } from "../src/money.ts";
import { replayLedger, expectedStock, compareCount, type Movement } from "../src/valuation.ts";
import { allocateLineDiscounts, summarize } from "../src/finance.ts";

const u = (n: number) => n * 1000;

test("quantity parsing is exact", () => {
  assert.equal(parseQty("2.5"), 2500); assert.equal(formatQty(2500), "2.5"); assert.equal(formatQty(-35000), "-35");
  assert.throws(() => parseQty("1.2345"));
});
test("lineAmount rounds half up with no float error", () => {
  assert.equal(lineAmount(u(3), 1234), 3702); assert.equal(lineAmount(500, 1001), 501); assert.equal(lineAmount(333, 3), 1);
});
test("spec example: 50 + 30 - 45 = 35 expected, count 32 => 3 unit discrepancy", () => {
  const m: Movement[] = [
    { type: "opening", qty: u(50), unitCost: 1000, occurredAt: "2026-01-01T00:00:00Z" },
    { type: "receipt", qty: u(30), unitCost: 1000, occurredAt: "2026-01-02T00:00:00Z" },
    { type: "sale", qty: -u(45), occurredAt: "2026-01-03T00:00:00Z" },
  ];
  assert.equal(expectedStock(m), u(35));
  const d = compareCount(expectedStock(m), u(32));
  assert.equal(d.difference, -u(3)); assert.equal(d.requiresInvestigation, true);
});
test("moving average costing", () => {
  const m: Movement[] = [
    { type: "receipt", qty: u(10), unitCost: 100, occurredAt: "2026-01-01T00:00:00Z" },
    { type: "receipt", qty: u(10), unitCost: 200, occurredAt: "2026-01-02T00:00:00Z" },
    { type: "sale", qty: -u(5), occurredAt: "2026-01-03T00:00:00Z" },
  ];
  const r = replayLedger(m);
  assert.equal(r.cogs, 750);       // 5 x avg 150
  assert.equal(r.value, 2250);     // 15 x 150
  assert.equal(r.onHand, u(15));
});
test("sale return restores stock and reduces COGS; damage counted as loss not COGS", () => {
  const r = replayLedger([
    { type: "receipt", qty: u(10), unitCost: 100, occurredAt: "2026-01-01T00:00:00Z" },
    { type: "sale", qty: -u(4), occurredAt: "2026-01-02T00:00:00Z" },
    { type: "sale_return", qty: u(1), occurredAt: "2026-01-03T00:00:00Z" },
    { type: "damage", qty: -u(2), occurredAt: "2026-01-04T00:00:00Z" },
  ]);
  assert.equal(r.cogs, 300); assert.equal(r.lossValue, 200); assert.equal(r.onHand, u(5)); assert.equal(r.value, 500);
});
test("period summary: purchases are not expenses", () => {
  const s = summarize({ grossSales: 100000, discounts: 2000, salesReturns: 3000, cogs: 60000, operatingExpenses: 15000, expensesPaid: 10000, cashCollected: 90000, inventoryPurchases: 80000, receivables: 5000 });
  assert.equal(s.netSales, 95000); assert.equal(s.grossProfit, 35000); assert.equal(s.operatingProfit, 20000);
  assert.equal(s.outstandingExpenses, 5000); assert.equal(s.grossMarginBps, 3684);
});

import { periodCosts, valueAt } from "../src/valuation.ts";

test("stock losses reduce the result after operating profit and are never expensed twice", () => {
  const base = { grossSales: 100000, discounts: 0, salesReturns: 0, cogs: 60000, operatingExpenses: 15000, expensesPaid: 15000, cashCollected: 100000, inventoryPurchases: 40000, receivables: 0 };
  const s = summarize({ ...base, stockLosses: 4000 });
  assert.equal(s.operatingProfit, 25000, "stock losses are NOT part of operating expenses");
  assert.equal(s.operatingResultAfterStockLosses, 21000, "profit after recognized stock losses");
  const none = summarize(base);
  assert.equal(none.stockLosses, 0);
  assert.equal(none.operatingResultAfterStockLosses, none.operatingProfit);
});

test("gross margin is unavailable (null) instead of 0% when net sales are zero", () => {
  const s = summarize({ grossSales: 0, discounts: 0, salesReturns: 0, cogs: 0, operatingExpenses: 500, expensesPaid: 500, cashCollected: 0, inventoryPurchases: 0, receivables: 0 });
  assert.equal(s.grossMarginBps, null);
  assert.equal(s.operatingProfit, -500, "an operating loss is still reported");
});

test("sale-level discounts split across lines exactly, in whole RWF", () => {
  assert.deepEqual(allocateLineDiscounts([10000, 5000], 1500), [1000, 500]);
  const uneven = allocateLineDiscounts([3333, 3333, 3334], 100); // floors 33/33/33 + 1 leftover
  assert.equal(uneven.reduce((s, n) => s + n, 0), 100, "shares sum to the discount");
  assert.deepEqual(allocateLineDiscounts([5000], 0), [0], "no discount → no allocation");
  assert.deepEqual(allocateLineDiscounts([5000, 3000], 99999), [5000, 3000], "allocation never exceeds a line");
  // Precision: huge lines must not lose a franc to float rounding.
  const big = allocateLineDiscounts([9007199254740991, 1], 500);
  assert.equal(big.reduce((s, n) => s + n, 0), 500);
});

test("valueAt reports inventory value at a period boundary", () => {
  const m: Movement[] = [
    { type: "receipt", qty: 10000, unitCost: 100, occurredAt: "2026-01-01T00:00:00.000Z" },
    { type: "sale", qty: -4000, occurredAt: "2026-01-15T00:00:00.000Z" },
    { type: "receipt", qty: 10000, unitCost: 200, occurredAt: "2026-02-01T00:00:00.000Z" },
  ];
  const opening = valueAt(m, "2026-02-01T00:00:00.000Z");
  assert.equal(opening.onHand, 6000);            // 6 units left before February
  assert.equal(opening.value, 600);              // 6 × 100 (moving average unchanged)
  const closing = valueAt(m, "2026-03-01T00:00:00.000Z");
  assert.equal(closing.onHand, 16000);
  assert.equal(closing.value, 2600);             // 6 × 100 (before Feb) + 10 × 200 (Feb receipt)
});

test("periodCosts only counts movements inside the period but uses full-history average", () => {
  const m: Movement[] = [
    { type: "receipt", qty: 10000, unitCost: 100, occurredAt: "2026-01-01T00:00:00.000Z" },
    { type: "sale", qty: -2000, occurredAt: "2026-01-10T00:00:00.000Z" },
    { type: "receipt", qty: 10000, unitCost: 200, occurredAt: "2026-02-01T00:00:00.000Z" },
    { type: "sale", qty: -3000, occurredAt: "2026-02-05T00:00:00.000Z" },
  ];
  assert.equal(periodCosts(m, "2026-02-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z").cogs, 467);
  assert.equal(periodCosts(m, "2026-01-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z").cogs, 200);
});
