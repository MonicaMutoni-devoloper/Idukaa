import { test } from "node:test";
import assert from "node:assert/strict";
import { breakEven, grossMarginPct, markupPct, recommendedPrice } from "../src/pricing.ts";

test("markup and gross margin are different percentages", () => {
  // cost 800, price 1000: markup = 25%, margin = 20%
  assert.equal(markupPct(800, 1000), 25);
  assert.equal(grossMarginPct(800, 1000), 20);
  // Below-cost selling shows a negative margin and a negative markup.
  assert.equal(markupPct(1000, 800), -20);
  assert.equal(grossMarginPct(1000, 800), -25);
  // Unknown cost or zero price is unavailable, never a fake 0%.
  assert.equal(markupPct(0, 1000), null);
  assert.equal(grossMarginPct(800, 0), null);
});

test("recommended price = cost / (1 - target margin), rounded up", () => {
  assert.equal(recommendedPrice(800, 20), 1000); // spec example
  assert.equal(recommendedPrice(800, 0), 800);   // zero margin = sell at cost
  // 1/3 margin: 900 / 0.6667… = 1350.0… exact case + a rounding-up case
  assert.equal(recommendedPrice(900, 66.67), 2701); // 900 / 0.3333 = 2700.27 → rounded up
  assert.equal(recommendedPrice(333, 75), 1332);   // 333/0.25 = 1332 exactly
  const up = recommendedPrice(1000, 33.33)!;       // 1000/0.6667 = 1499.92… → 1500
  assert.equal(up, 1500);
  // The rounded-up price never undercuts the target margin.
  for (const [cost, target] of [[800, 20], [1000, 33.33], [333, 75], [999, 12.5]] as const) {
    const price = recommendedPrice(cost, target)!;
    const actualMargin = ((price - cost) / price) * 100; // unrounded: grossMarginPct rounds to 0.1
    assert.ok(actualMargin >= target - 0.01, `${price} must meet ${target}%, got ${actualMargin}`);
  }
});

test("recommended price refuses out-of-range targets and unknown costs", () => {
  assert.equal(recommendedPrice(800, 100), null, "100% margin is impossible");
  assert.equal(recommendedPrice(800, 120), null);
  assert.equal(recommendedPrice(800, -5), null);
  assert.equal(recommendedPrice(0, 20), null, "no cost basis → no recommendation");
});

test("break-even is only reported when the data supports it", () => {
  const be = breakEven(100000, 70000, 12000)!; // contribution margin 30% → 12000/0.3
  assert.equal(be.variableCosts, 70000);
  assert.equal(be.fixedCosts, 12000);
  assert.equal(be.contributionMarginRatioBps, 3000);
  assert.equal(be.breakEvenRevenue, 40000);
  // Unavailable cases: no sales, no contribution, nonsense inputs.
  assert.equal(breakEven(0, 0, 12000), null, "zero revenue cannot yield a break-even");
  assert.equal(breakEven(100000, 120000, 12000), null, "negative contribution is not break-evenable");
  assert.equal(breakEven(100000, 70000, -1), null);
  // Free goods (cogs 0): ratio is 100%, break-even equals fixed costs.
  assert.equal(breakEven(50000, 0, 9000)!.breakEvenRevenue, 9000);
});
