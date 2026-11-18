import { test } from "node:test";
import assert from "node:assert/strict";
import { averageCostAt, currentAverageCost, periodCosts, replayLedger, type Movement } from "../src/valuation.ts";
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

test("scenario A: 12 @ 800 + 8 @ 1,000, sell 5 @ 1,400", () => {
  const m: Movement[] = [
    { type: "opening", qty: u(12), unitCost: 800, occurredAt: t(1) },
    { type: "receipt", qty: u(8), unitCost: 1000, occurredAt: t(2) },
  ];
  assert.equal(averageCostAt(m, t(2)), 880);
  const sale = sell(m, 5, t(3));
  const r = replayLedger([...m, sale]);
  const revenue = lineAmount(u(5), 1400);
  assert.equal(revenue, 7000);
  assert.equal(sale.unitCost, 880);
  assert.equal(r.cogs, 4400);                       // 5 × 880, not 5 × 800
  assert.equal(profit(revenue, r.cogs), 2600);
  assert.equal(r.onHand, u(15), "20 bought − 5 sold");
  assert.equal(r.value, 13200);                     // 15 × 880
  assert.equal(r.avgCost, 880);
});

test("purchase cost increases (10 @ 1,000 then 10 @ 1,400)", () => {
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

test("purchase cost and selling price both decrease", () => {
  const m: Movement[] = [
    { type: "opening", qty: u(10), unitCost: 1400, occurredAt: t(1) },
    { type: "receipt", qty: u(10), unitCost: 1000, occurredAt: t(2) },
  ];
  assert.equal(averageCostAt(m, t(2)), 1200);
  const r = replayLedger([...m, sell(m, 5, t(3))]);
  assert.equal(r.cogs, 6000);
  assert.equal(profit(lineAmount(u(5), 1400), r.cogs), 1000);
});

test("scenario D: several purchases and several sales keep one moving average", () => {
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

test("posting order beats a receipt's noon document timestamp (the live old-cost defect)", () => {
  // Entered at 09:22, stored with the mobile form's noon date; the sale follows at 09:30.
  const opening: Movement = { type: "opening", qty: u(10), unitCost: 1000, occurredAt: t(1), seq: 1 };
  const receipt: Movement = { type: "receipt", qty: u(10), unitCost: 2000, occurredAt: `${t(1).slice(0, 8)}02T12:00:00.000Z`, seq: 2 };
  const sale: Movement = { type: "sale", qty: -u(5), unitCost: currentAverageCost([opening, receipt]), occurredAt: `${t(1).slice(0, 8)}02T09:30:00.000Z`, seq: 3 };

  assert.equal(sale.unitCost, 1500, "both postings are in the average, so 15,000 / 10");
  const r = replayLedger([opening, receipt, sale]);
  assert.equal(r.cogs, 7500, "5 x 1,500, not 5 x the old 1,000");
  assert.equal(r.value, 22500, "15 units at 1,500");
  assert.equal(r.avgCost, 1500);

  // The date-based helper is intentionally left with the old behaviour for historical queries;
  // sale posting must not use it.
  assert.equal(averageCostAt([opening, receipt], "2026-01-02T09:30:00.000Z"), 1000);
  assert.equal(periodCosts([opening, receipt, sale], "2026-01-02T00:00:00.000Z", "2026-01-03T00:00:00.000Z").cogs, 7500,
    "period COGS uses the same posting order");
});

test("scenario E: a later purchase never rewrites the cost of a sale already posted", () => {
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
