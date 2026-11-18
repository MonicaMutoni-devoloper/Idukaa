import { test } from "node:test";
import assert from "node:assert/strict";
import { averageCostAt, periodCosts, replayLedger, type Movement } from "../src/valuation.ts";
import { lineAmount } from "../src/money.ts";

/**
 * Perpetual weighted average cost, end to end.
 *
 * Every expected number below is the arithmetic from the business scenario, written out so a change
 * in rounding or ordering cannot pass unnoticed. Revenue minus the COGS the ledger relieved is the
 * gross profit the reports show.
 */
const u = (n: number) => n * 1000;
const t = (day: number) => `2026-01-${String(day).padStart(2, "0")}T08:00:00.000Z`;

/** What the sale posting code does: cost is read inside the transaction, then written on the movement. */
function sell(movements: Movement[], qty: number, at: string): Movement {
  return { type: "sale", qty: -u(qty), unitCost: averageCostAt(movements, at), occurredAt: at };
}

const profit = (revenue: number, cogs: number) => revenue - cogs;

test("the reported case: 12 @ 800 + 8 @ 1000, sell 5 @ 1400", () => {
  const m: Movement[] = [
    { type: "opening", qty: u(12), unitCost: 800, occurredAt: t(1) },
    { type: "receipt", qty: u(8), unitCost: 1000, occurredAt: t(2) },
  ];
  assert.equal(averageCostAt(m, t(2)), 880);
  const sale = sell(m, 5, t(3));
  const r = replayLedger([...m, sale]);
  assert.equal(sale.unitCost, 880);
  assert.equal(r.cogs, 4400);                       // 5 × 880, not 5 × 800
  assert.equal(profit(lineAmount(u(5), 1400), r.cogs), 2600);
  assert.equal(r.value, 13200);                     // 15 × 880
  assert.equal(r.avgCost, 880);
});

test("scenario A: purchase cost increases (10 @ 1000 then 10 @ 1400)", () => {
  const m: Movement[] = [
    { type: "opening", qty: u(10), unitCost: 1000, occurredAt: t(1) },
    { type: "receipt", qty: u(10), unitCost: 1400, occurredAt: t(2) },
  ];
  assert.equal(averageCostAt(m, t(2)), 1200);       // 24 000 / 20
  const r = replayLedger([...m, sell(m, 5, t(3))]);
  assert.equal(r.cogs, 6000);
  assert.equal(profit(lineAmount(u(5), 1800), r.cogs), 3000);
});

test("scenario B: purchase cost decreases (10 @ 1400 then 10 @ 1000)", () => {
  const m: Movement[] = [
    { type: "opening", qty: u(10), unitCost: 1400, occurredAt: t(1) },
    { type: "receipt", qty: u(10), unitCost: 1000, occurredAt: t(2) },
  ];
  assert.equal(averageCostAt(m, t(2)), 1200);
  const r = replayLedger([...m, sell(m, 5, t(3))]);
  assert.equal(r.cogs, 6000, "cheaper stock must lower the average, not keep the old 1400");
  assert.equal(profit(lineAmount(u(5), 1600), r.cogs), 2000);
});

test("scenario C: only the selling price changes — the cost basis does not move", () => {
  const m: Movement[] = [{ type: "opening", qty: u(10), unitCost: 1000, occurredAt: t(1) }];
  assert.equal(averageCostAt(m, t(2)), 1000, "a price edit posts no movement and no new cost");
  const r = replayLedger([...m, sell(m, 5, t(2))]);
  assert.equal(r.cogs, 5000);
  assert.equal(profit(lineAmount(u(5), 1200), r.cogs), 1000, "revenue uses the sale's own price");
});

test("scenario D: purchase cost and selling price both decrease", () => {
  const m: Movement[] = [
    { type: "opening", qty: u(10), unitCost: 1400, occurredAt: t(1) },
    { type: "receipt", qty: u(10), unitCost: 1000, occurredAt: t(2) },
  ];
  assert.equal(averageCostAt(m, t(2)), 1200);
  const r = replayLedger([...m, sell(m, 5, t(3))]);
  assert.equal(r.cogs, 6000);
  assert.equal(profit(lineAmount(u(5), 1400), r.cogs), 1000);
});

test("several purchases and several sales in a row keep one moving average", () => {
  const m: Movement[] = [
    { type: "opening", qty: u(10), unitCost: 1000, occurredAt: t(1) },
    { type: "receipt", qty: u(10), unitCost: 1400, occurredAt: t(2) },   // avg 1200
  ];
  const s1 = sell(m, 5, t(3)); m.push(s1);                             // cost 1200
  m.push({ type: "receipt", qty: u(5), unitCost: 1200, occurredAt: t(4) }); // avg unchanged, 1200
  const s2 = sell(m, 4, t(5));
  assert.equal(s2.unitCost, 1200);
  const r = replayLedger([...m, s2]);
  assert.equal(r.cogs, 5 * 1200 + 4 * 1200);
  assert.equal(r.onHand, u(16));
  assert.equal(r.value, 16 * 1200);
  assert.equal(r.avgCost, 1200);
});

test("a later purchase never rewrites the cost of a sale already posted", () => {
  const m: Movement[] = [
    { type: "opening", qty: u(12), unitCost: 800, occurredAt: t(1) },
    { type: "receipt", qty: u(8), unitCost: 1000, occurredAt: t(2) },
  ];
  const sale = sell(m, 5, t(3));
  assert.equal(sale.unitCost, 880);
  // A backdated delivery arrives afterwards: dated BEFORE the sale, so without the recorded cost
  // the replay would place it ahead of the sale and restate that sale's COGS.
  const full: Movement[] = [...m, sale, { type: "receipt", qty: u(20), unitCost: 1200, occurredAt: "2026-01-02T12:00:00.000Z" }];
  const r = replayLedger(full);
  assert.equal(r.cogs, 4400, "historical COGS is fixed by the recorded cost");
  assert.equal(periodCosts(full, t(3), t(4)).cogs, 4400);
  assert.equal(r.onHand, u(35));
  assert.equal(r.value, 37200);   // 17 600 + 24 000 − 4 400
});

test("a voided sale returns at its original cost, not today's average", () => {
  const m: Movement[] = [
    { type: "opening", qty: u(10), unitCost: 1000, occurredAt: t(1) },
    { type: "sale", qty: -u(5), unitCost: 1000, occurredAt: t(2) },
    { type: "receipt", qty: u(10), unitCost: 2000, occurredAt: t(3) },  // avg rises to 1667
  ];
  assert.equal(replayLedger(m).avgCost, 1667);
  const returned = replayLedger([...m, { type: "sale_return", qty: u(2), unitCost: 1000, occurredAt: t(4) }]);
  assert.equal(returned.cogs, 3000, "5 × 1000 sold, 2 × 1000 returned");
  assert.equal(returned.onHand, u(17));
  assert.equal(returned.value, 27000);  // 25 000 + 2 × 1000
});

test("legacy rows without a recorded cost keep the running-average behaviour", () => {
  const r = replayLedger([
    { type: "receipt", qty: u(10), unitCost: 100, occurredAt: t(1) },
    { type: "sale", qty: -u(5), occurredAt: t(2) },
    { type: "sale_return", qty: u(1), occurredAt: t(3) },
  ]);
  assert.equal(r.cogs, 400);      // 5 × 100 − 1 × 100
  assert.equal(r.value, 600);
});

test("damaged and lost stock are relieved at the average but never counted as COGS", () => {
  const r = replayLedger([
    { type: "opening", qty: u(10), unitCost: 1000, occurredAt: t(1) },
    { type: "damage", qty: -u(2), unitCost: 1000, occurredAt: t(2) },
    { type: "sale", qty: -u(3), unitCost: 1000, occurredAt: t(3) },
  ]);
  assert.equal(r.cogs, 3000);
  assert.equal(r.lossValue, 2000);
  assert.equal(r.value, 5000);
});

test("a sale is never relieved for more value than the stock holds", () => {
  // Recorded cost higher than the remaining value (a legacy/backdated ledger): value floors at 0
  // rather than turning the inventory into a negative asset.
  const r = replayLedger([
    { type: "opening", qty: u(1), unitCost: 500, occurredAt: t(1) },
    { type: "sale", qty: -u(1), unitCost: 900, occurredAt: t(2) },
  ]);
  assert.equal(r.cogs, 500);
  assert.equal(r.value, 0);
  assert.equal(r.onHand, 0);
});
