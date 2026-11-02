import { test } from "node:test";
import assert from "node:assert/strict";
import { costPerBaseUnit, fromBaseQty, priceBelowCost, profitPerBaseUnit, toBaseQty } from "../src/index.ts";

const u = (n: number) => n * 1000; // whole units -> milli-units

test("buying 1 bag of rice (25 kg) converts to base kilograms", () => {
  assert.equal(toBaseQty(u(1), 25), u(25));   // 1 bag -> 25 kg
  assert.equal(toBaseQty(u(2), 25), u(50));   // 2 bags -> 50 kg
  assert.equal(toBaseQty(500, 25), 12_500);   // 0.5 bag -> 12.5 kg (decimals allowed)
});

test("selling units convert the same way, and the inverse round-trips", () => {
  assert.equal(toBaseQty(u(5), 1), u(5));     // 1:1 products are the identity transform
  assert.equal(toBaseQty(u(12), 12), u(144)); // 1 carton of 12 bottles as a selling unit
  assert.equal(fromBaseQty(u(50), 25), u(2)); // 50 kg back to 2 bags
  assert.equal(fromBaseQty(12_500, 25), 500); // 12.5 kg back to 0.5 bag
});

test("conversion is integer-only: multiplication is exact, division rounds half-up, never float", () => {
  assert.equal(toBaseQty(1, 25), 25);         // 0.001 bag x 25 kg/bag = 0.025 kg = 25 milli-kg
  assert.equal(toBaseQty(1500, 7), 10_500);   // 1.5 x 7 = 10.5 kg, exact
  assert.equal(toBaseQty(1, 3), 3);           // 0.001 x 3 = 0.003, exact
  assert.equal(toBaseQty(2, 3), 6);           // 0.002 x 3 = 0.006, exact
  assert.equal(fromBaseQty(13, 2), 7);        // 6.5 milli -> 7, rounded half-up
  assert.equal(fromBaseQty(12, 2), 6);        // exact division stays exact
  assert.throws(() => toBaseQty(u(1), 0));
  assert.throws(() => toBaseQty(u(1), 2.5));
  assert.throws(() => fromBaseQty(u(1), 0));
});

test("cost per purchase unit becomes integer RWF per base unit", () => {
  assert.equal(costPerBaseUnit(30_000, 25), 1_200);  // 30,000 RWF per 25 kg bag -> 1,200/kg
  assert.equal(costPerBaseUnit(40_000, 12), 3_333);  // 3333.33 -> rounded half-up
  assert.equal(costPerBaseUnit(1_429, 1), 1_429);    // 1:1 identity
  assert.equal(costPerBaseUnit(0, 25), 0);
  assert.throws(() => costPerBaseUnit(100, 0));
});

test("below-cost checks compare on one basis across unit configurations", () => {
  // Rice: 1,400/kg selling vs 1,200/kg cost -> NOT below cost.
  assert.equal(priceBelowCost(1_400, 1, 1_200), false);
  // Same numbers quoted per bag must not flip the verdict (1,400 per 25 kg would be below cost).
  assert.equal(priceBelowCost(1_400, 25, 1_200), true);
  // Carton pricing: 5,000/carton of 12 vs 300/bottle -> 416.67 per bottle, above cost.
  assert.equal(priceBelowCost(5_000, 12, 300), false);
  assert.equal(priceBelowCost(3_000, 12, 300), true); // exactly 250/bottle, still below the 300 cost
  assert.equal(priceBelowCost(2_999, 12, 300), true);
  // Legacy 1:1 behaviour is unchanged.
  assert.equal(priceBelowCost(1_428, 1, 1_429), true);
  assert.equal(priceBelowCost(1_429, 1, 1_429), false);
});

test("profit per base unit matches the spec's rice example", () => {
  // 1,400/kg selling, 1,200/kg cost -> 200 RWF profit per kg.
  assert.equal(profitPerBaseUnit(1_400, 1, 1_200), 200);
  assert.equal(profitPerBaseUnit(5_000, 12, 300), 116); // 416 floor - 300
});