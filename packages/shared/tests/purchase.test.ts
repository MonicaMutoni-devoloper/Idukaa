import { test } from "node:test";
import assert from "node:assert/strict";
import { unitCostFromTotal, projectLine, isBelowCost, formatQty } from "../src/index.ts";

const u = (n: number) => n * 1000;

test("spec example: 28 bottles for 40,000 at 1,200 each is projected as a loss", () => {
  const p = projectLine({ qty: u(28), totalCost: 40_000, sellingPrice: 1_200 });
  assert.equal(p.unitCost, 1_429);          // 40,000 / 28 = 1,428.57, rounded half up
  assert.equal(p.recordedCost, 40_012);     // what the ledger records at an integer unit cost
  assert.equal(p.rounding, 12);             // the rounding is shown, not hidden
  assert.equal(p.revenue, 33_600);          // 28 x 1,200
  assert.equal(p.profit, -6_412);
  assert.equal(p.belowCost, true);
  assert.equal(p.marginBps, -1908);         // about -19.1%
});

test("whole-number division is exact and above-cost lines are not flagged", () => {
  const p = projectLine({ qty: u(28), totalCost: 28_000, sellingPrice: 1_200 });
  assert.equal(p.unitCost, 1_000); assert.equal(p.recordedCost, 28_000); assert.equal(p.rounding, 0);
  assert.equal(p.profit, 5_600); assert.equal(p.belowCost, false);
  assert.equal(p.marginBps, 1667); // 16.67%
});

test("unit cost derivation never uses floating point", () => {
  assert.equal(unitCostFromTotal(100_000, u(3)), 33_333);   // 33,333.33 -> 33,333
  assert.equal(unitCostFromTotal(1, u(3)), 0);              // 0.33 -> 0
  assert.equal(unitCostFromTotal(0, u(12)), 0);
  assert.throws(() => unitCostFromTotal(1000, 0));
});

test("crate conversion: 3 crates of 12 bottles at 36,000 total", () => {
  const qty = 3 * 12 * 1000; // 36 sellable units
  const p = projectLine({ qty, totalCost: 36_000, sellingPrice: 1_200 });
  assert.equal(formatQty(qty), "36");
  assert.equal(p.unitCost, 1_000);
  assert.equal(p.recordedCost, 36_000);
  assert.equal(p.revenue, 43_200);
  assert.equal(p.profit, 7_200);
});

test("below-cost comparison is strictly per sellable unit", () => {
  assert.equal(isBelowCost(1_429, 1_428), true);
  assert.equal(isBelowCost(1_429, 1_429), false);
  assert.equal(isBelowCost(0, 0), false);
});
