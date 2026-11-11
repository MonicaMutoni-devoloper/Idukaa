import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cartSellingQty, maxSellingMilli, mergeCartQty, stepSellingQty, validateQuickAddQty,
} from "../src/services/sell-quick-add.ts";

test("simple products cap the popup at the available base quantity", () => {
  assert.equal(maxSellingMilli(25000, 1), 25000); // 25 kg
  assert.equal(maxSellingMilli(0, 1), 0);
  assert.equal(maxSellingMilli(-100, 1), 0);
  assert.deepEqual(validateQuickAddQty("3", 25000, 1), { ok: true, qty: 3000, base: 3000 });
  assert.deepEqual(validateQuickAddQty("2.5", 25000, 1), { ok: true, qty: 2500, base: 2500 });
});

test("zero, negative and malformed quantities are refused", () => {
  for (const bad of ["0", "-2", "", "abc", "1.2345"]) {
    const result = validateQuickAddQty(bad, 25000, 1);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "positive");
  }
});

test("a quantity above available stock is refused with the real limit", () => {
  const result = validateQuickAddQty("26", 25000, 1);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "stock");
  assert.equal(result.ok === false && result.max, 25000);
});

test("packaged products convert through units_per_selling, never one-for-one", () => {
  // 30 bottles in stock, one carton is 12 bottles.
  assert.equal(maxSellingMilli(30000, 12), 2500); // 2.5 cartons
  assert.deepEqual(validateQuickAddQty("2", 30000, 12), { ok: true, qty: 2000, base: 24000 });
  const tooMany = validateQuickAddQty("3", 30000, 12);
  assert.equal(tooMany.ok, false);
  assert.equal(tooMany.ok === false && tooMany.reason, "stock");
});

test("plus and minus step by one selling unit and never cross the stock limit", () => {
  assert.equal(stepSellingQty("1", 1, 25000, 1), "2");
  assert.equal(stepSellingQty("2.5", 1, 2500, 1), "2.5");
  assert.equal(stepSellingQty("1", -1, 25000, 1), "1");
  assert.equal(stepSellingQty("0.5", 1, 25000, 1), "1.5");
});

test("adding an existing line merges quantity and refuses to exceed stock", () => {
  assert.equal(mergeCartQty("1", 3000, 25000, 1), "4");
  assert.equal(mergeCartQty("24", 1000, 25000, 1), "25");
  assert.equal(mergeCartQty("25", 1000, 25000, 1), null);
  assert.equal(mergeCartQty("1", 1000, 30000, 12), "2"); // two cartons = 24 bottles
  assert.equal(mergeCartQty("2", 1000, 30000, 12), null); // three cartons = 36 bottles
});

test("the compact summary sums selling quantities without inventing money", () => {
  assert.equal(cartSellingQty([{ qty: "3" }, { qty: "5" }, { qty: "2" }]), 10000);
  assert.equal(cartSellingQty([{ qty: "2.5" }]), 2500);
});
