/**
 * Analytics aggregation tests. These run on Node with built-in TypeScript type stripping, like the
 * existing report tests, because the aggregations are pure: no SQLite, no network, no React.
 *
 * What matters here is that the four report categories cannot disagree with each other or with the
 * accounting layer: revenue excludes voided sales, quantities never add kilograms to pieces, an
 * unknown cost stays null instead of becoming zero, Kigali day boundaries are respected, and a
 * pending operation is added to a product's totals exactly once.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dayRange } from "@sms/shared";
import {
  deltaOf, discountedSales, expenseBreakdown, expenseTotals, inventoryFromProducts, inventoryMetrics,
  mergePendingItems, movementGroup, movementMetrics, movementSeries, movementsFromRecords, pendingFinancials,
  salesByCashier, salesByCategory, salesSeries, salesTotals, seriesOf,
} from "../src/services/report-analytics.ts";
import { bucketKey, bucketKeys, bucketModeFor, previousRange } from "../src/services/report-period.ts";
import type { LocalProduct, LocalRecord } from "../src/database/local.ts";

const DAY = dayRange("2026-11-03")!;

const sale = (over: Record<string, unknown> = {}) => ({
  id: "s1", at: "2026-11-03T09:00:00.000Z", by: "Aline", payment_method: "cash",
  gross_amount: 2000, discount: 200, amount_paid: 1800, status: "posted", units: 2000,
  products: "Flour", ...over,
});

const item = (over: Record<string, unknown> = {}) => ({
  productId: "p1", name: "Flour", code: "P1", unit: "kg",
  units: 2000, gross: 2000, sales: 1, avgUnitPrice: 1000, ...over,
});

const product = (over: Partial<LocalProduct> = {}): LocalProduct => ({
  id: "p1", code: "P1", barcode: null, name: "Flour", unit: "kg", category: "Food",
  selling_price: 1000, low_threshold: 2000, on_hand: 8000, pending_delta: 0,
  purchase_unit: null, selling_unit: null, units_per_purchase: 1, units_per_selling: 1,
  ...over,
});

const rec = (op_id: string, type: string, at: string, data: unknown, status = "pending"): LocalRecord =>
  ({ op_id, type, at, data: JSON.stringify(data), actor: null, created_at: at, status });

/* ------------------------------------------------------------------ sales */

test("revenue excludes voided sales, keeps discounts explicit and computes the average sale", () => {
  const totals = salesTotals([
    sale(),
    sale({ id: "s2", gross_amount: 5000, discount: 0, units: 1000 }),
    sale({ id: "s3", gross_amount: 9000, discount: 0, status: "reversed" }),
  ] as any);
  assert.equal(totals.gross, 7000);
  assert.equal(totals.discounts, 200);
  assert.equal(totals.net, 6800);
  assert.equal(totals.transactions, 2);
  assert.equal(totals.units, 3000);
  assert.equal(totals.averageSale, 3400);
  assert.equal(totals.reversed, 1);
});

test("sales by cashier totals each person once, and never invents a name for a device sale", () => {
  const rows = salesByCashier([
    sale({ id: "a", by: "Aline" }),
    sale({ id: "b", by: "Aline", gross_amount: 1000, discount: 0 }),
    sale({ id: "c", by: null }),
    sale({ id: "d", by: "Aline", status: "reversed" }),
  ] as any);
  const aline = rows.find((r) => r.label === "Aline")!;
  assert.equal(aline.net, 2800);
  assert.equal(aline.transactions, 2);
  assert.equal(aline.units, 4000);
  const unknown = rows.find((r) => r.label === "—")!;
  assert.equal(unknown.transactions, 1, "offline rows carry no cashier name; the screen shows —");
});

test("sales by category groups products and labels an uncategorised product honestly", () => {
  const rows = salesByCategory([item(), item({ productId: "p2", name: "Sugar", gross: 3000 }), item({ productId: "p3", name: "Soap" })], (id) =>
    id === "p1" ? "Food" : id === "p2" ? "Food" : null);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.label, "Food");
  assert.equal(rows[0]!.gross, 5000);
  assert.equal(rows[0]!.products, 2);
  assert.equal(rows[1]!.label, "—");
});

test("discounts view lists only discounted, non-voided sales, largest first", () => {
  const rows = discountedSales([
    sale({ id: "a", discount: 100 }),
    sale({ id: "b", discount: 900 }),
    sale({ id: "c", discount: 0 }),
    sale({ id: "d", discount: 500, status: "reversed" }),
  ] as any);
  assert.deepEqual(rows.map((r) => r.id), ["b", "a"]);
});

/* ------------------------------------------------------------------ periods and buckets */

test("Kigali day boundaries and Monday weeks drive the buckets", () => {
  // 23:30 UTC on 3 Nov is already 01:30 on 4 Nov in Kigali (UTC+2).
  assert.equal(bucketKey("2026-11-03T23:30:00.000Z", "day"), "2026-11-04");
  assert.equal(bucketKey("2026-11-04T00:30:00.000Z", "week"), "2026-11-02"); // Monday
  assert.equal(bucketKey("2026-11-30T10:00:00.000Z", "month"), "2026-11-01");
  assert.equal(bucketModeFor(DAY.from, DAY.to), "day");
});

test("a trend includes every empty bucket in the range, in order", () => {
  assert.deepEqual(bucketKeys(DAY.from, DAY.to, "day"), ["2026-11-03"]);
  const week = { from: "2026-11-02T22:00:00.000Z", to: "2026-11-05T22:00:00.000Z" };
  assert.deepEqual(bucketKeys(week.from, week.to, "day"), ["2026-11-03", "2026-11-04", "2026-11-05"]);
  const series = salesSeries([sale()] as any, week.from, week.to, "day");
  assert.deepEqual(series.map((p) => p.netSales), [1800, 0, 0]);
  assert.equal(series[0]!.transactions, 1);
});

test("generic series sums the supplied value per bucket", () => {
  const points = seriesOf(
    [{ at: "2026-11-03T09:00:00.000Z", amount: 500 }, { at: "2026-11-03T12:00:00.000Z", amount: 250 }],
    DAY.from, DAY.to, "day", (r) => r.at, (r) => r.amount,
  );
  assert.deepEqual(points, [{ date: "2026-11-03", value: 750 }]);
});

test("the comparison period is the same length immediately before, half-open", () => {
  const prev = previousRange("2026-11-03T22:00:00.000Z", "2026-11-04T22:00:00.000Z");
  assert.equal(prev.from, "2026-11-02T22:00:00.000Z");
  assert.equal(prev.to, "2026-11-03T22:00:00.000Z");
  assert.equal(deltaOf(120, 100).pct, 20);
  assert.equal(deltaOf(120, 0).pct, null, "no prior value means no percentage, not an infinite one");
});

/* ------------------------------------------------------------------ expenses */

test("expense totals split paid from unpaid and the breakdown ranks categories", () => {
  const rows: any[] = [
    { id: "e1", at: "2026-11-03T08:00:00.000Z", category: "rent", amount: 500, paid: true, note: null, by: null },
    { id: "e2", at: "2026-11-03T09:00:00.000Z", category: "transport", amount: 300, paid: false, note: null, by: null },
    { id: "e3", at: "2026-11-03T10:00:00.000Z", category: "rent", amount: 250, paid: false, note: null, by: null },
  ];
  assert.deepEqual(expenseTotals(rows), { total: 1050, paid: 500, unpaid: 550, count: 3 });
  const cats = expenseBreakdown(rows);
  assert.equal(cats[0]!.label, "rent");
  assert.equal(cats[0]!.amount, 750);
  assert.equal(cats[0]!.unpaid, 250);
  assert.equal(cats[0]!.count, 2);
});

/* ------------------------------------------------------------------ inventory */

test("inventory quantities are summed per unit and value is null when cost is unavailable", () => {
  const items = inventoryFromProducts([
    product({ id: "p1", unit: "kg", on_hand: 8000, pending_delta: -2000 }),
    product({ id: "p2", name: "Soap", unit: "pcs", on_hand: 0, low_threshold: 5 }),
    product({ id: "p3", name: "Sugar", unit: "kg", on_hand: 500 }),
  ]);
  const flour = items.find((i) => i.id === "p1")!;
  assert.equal(flour.onHand, 6000, "queued operations are part of this device's current quantity");
  assert.equal(flour.local, true);
  assert.equal(flour.value, null, "the device holds no cost, so it claims no value");

  const m = inventoryMetrics(items);
  assert.equal(m.products, 3);
  assert.equal(m.out, 1);
  assert.equal(m.low, 1, "low stock excludes out-of-stock, which has its own count");
  assert.equal(m.value, null);
  assert.equal(m.priced, 0);
  assert.equal(m.unpriced, 3);
  assert.deepEqual(m.byUnit, [{ unit: "kg", qty: 6500 }, { unit: "pcs", qty: 0 }]);
});

test("inventory value is only reported when every product has a cost", () => {
  const priced = [
    { ...inventoryFromProducts([product()])[0]!, value: 4000 },
    { ...inventoryFromProducts([product({ id: "p2", name: "Soap" })])[0]!, value: 1000 },
  ];
  assert.equal(inventoryMetrics(priced).value, 5000);
  const mixed = [priced[0]!, { ...priced[1]!, value: null }];
  assert.equal(inventoryMetrics(mixed).value, null, "a partial sum would understate the shop");
});

/* ------------------------------------------------------------------ movements */

test("movement types map to the report groups the workspace offers", () => {
  assert.equal(movementGroup("receipt"), "in");
  assert.equal(movementGroup("opening"), "in");
  assert.equal(movementGroup("sale"), "sold");
  assert.equal(movementGroup("damage"), "loss");
  assert.equal(movementGroup("adjustment"), "adjust");
  assert.equal(movementGroup("supplier_return"), "other");
});

test("movement totals keep quantities exact and refuse to guess a loss cost", () => {
  const rows: any[] = [
    { id: "1", at: DAY.from, type: "receipt", qty: 10000, unitCost: 500 },
    { id: "2", at: DAY.from, type: "sale", qty: -2000, unitCost: null },
    { id: "3", at: DAY.from, type: "damage", qty: -500, unitCost: 500 },
    { id: "4", at: DAY.from, type: "expiry", qty: -500, unitCost: null },
  ];
  const m = movementMetrics(rows);
  assert.equal(m.inQty, 10000);
  assert.equal(m.soldQty, 2000);
  assert.equal(m.lossQty, 1000);
  assert.equal(m.lossValue, null, "one uncosted loss hides the total instead of understating it");
  assert.equal(m.missingCost, 1);

  const priced = movementMetrics(rows.filter((r) => r.id !== "4"));
  assert.equal(priced.lossValue, 250, "500 milli-units at 500 RWF per unit");
});

test("movements derived from device records carry quantities, references and no invented balance", () => {
  const records = [
    rec("op1", "purchase.create", "2026-11-03T07:00:00.000Z", {
      purchaseId: "pur-1", orderedAt: "2026-11-03T07:00:00.000Z", receiveNow: true, amountPaid: 5000,
      lines: [{ productId: "p1", qty: 10000, unitCost: 500 }],
    }),
    rec("op2", "sale.create", "2026-11-03T09:00:00.000Z", {
      saleId: "sale-1", soldAt: "2026-11-03T09:00:00.000Z", discount: 0, amountPaid: 2000,
      lines: [{ productId: "p1", qty: 2000, unitPrice: 1000, sellingQty: 2000 }],
    }),
    rec("op3", "adjustment.request", "2026-11-03T10:00:00.000Z", {
      adjustmentId: "adj-1", productId: "p1", qty: -500, reason: "damage",
    }, "pending_approval"),
  ];
  const rows = movementsFromRecords({ records, products: [product()], from: DAY.from, to: DAY.to });
  assert.equal(rows.length, 3);
  const sold = rows.find((r) => r.type === "sale")!;
  assert.equal(sold.qty, -2000);
  assert.equal(sold.product, "Flour");
  assert.equal(sold.unitCost, null, "sale cost is not stored on the device");
  assert.equal(sold.balanceBefore, null, "a device-only running balance would be wrong");
  assert.equal(sold.balanceAfter, null);
  const received = rows.find((r) => r.type === "receipt")!;
  assert.equal(received.qty, 10000);
  assert.equal(received.unitCost, 500);
  assert.equal(received.reference, "RC-PUR1", "short human reference, not a UUID");
  const loss = rows.find((r) => r.type === "damage")!;
  assert.equal(loss.syncStatus, "pending_approval");
  assert.equal(rows.find((r) => r.type === "adjustment"), undefined, "damage stays damage, not a generic adjustment");
});

test("movements outside the period are excluded, and the series compares received with sold", () => {
  const records = [
    rec("op1", "sale.create", "2026-11-01T09:00:00.000Z", {
      saleId: "s0", soldAt: "2026-11-01T09:00:00.000Z", discount: 0, amountPaid: 1000,
      lines: [{ productId: "p1", qty: 1000, unitPrice: 1000, sellingQty: 1000 }],
    }),
    rec("op2", "sale.create", "2026-11-03T09:00:00.000Z", {
      saleId: "s1", soldAt: "2026-11-03T09:00:00.000Z", discount: 0, amountPaid: 2000,
      lines: [{ productId: "p1", qty: 2000, unitPrice: 1000, sellingQty: 2000 }],
    }),
  ];
  const rows = movementsFromRecords({ records, products: [product()], from: DAY.from, to: DAY.to });
  assert.equal(rows.length, 1);
  const series = movementSeries(rows, DAY.from, DAY.to, "day");
  assert.deepEqual(series, [{ date: "2026-11-03", received: 0, sold: 2000 }]);
});

/* ------------------------------------------------------------------ pending financials */

test("pending financials sum only the queued rows, net of discounts, and expose their counts", () => {
  const p = pendingFinancials({
    sales: [sale(), sale({ id: "s2", gross_amount: 5000, discount: 0, units: 1000 }), sale({ id: "s3", status: "reversed" })] as any,
    expenses: [{ id: "e1", category: "rent", amount: 500, paid: true }, { id: "e2", category: "transport", amount: 300, paid: false }] as any,
    purchases: [{ id: "pu1", total_amount: 5000 }, { id: "pu2", total_amount: 2500 }] as any,
  });
  assert.equal(p.salesGross, 7000);
  assert.equal(p.salesDiscounts, 200);
  assert.equal(p.salesNet, 6800);
  assert.equal(p.salesCount, 2, "a reversed sale is not pending revenue");
  assert.equal(p.expenses, 800);
  assert.equal(p.expenseCount, 2);
  assert.equal(p.purchases, 7500);
  assert.equal(p.purchaseCount, 2);
});

test("pending financials are zero only when there are no queued rows, never because cost is unknown", () => {
  const p = pendingFinancials({ sales: [], expenses: [], purchases: [] });
  assert.deepEqual(p, {
    salesNet: 0, salesGross: 0, salesDiscounts: 0, salesCount: 0,
    expenses: 0, expenseCount: 0, purchases: 0, purchaseCount: 0,
  });
});

/* ------------------------------------------------------------------ reconciliation */

test("a pending sale is added to the same product instead of becoming a second row", () => {
  const merged = mergePendingItems([item({ units: 2000, gross: 2000, sales: 1 })], [item({ units: 1000, gross: 1000, sales: 1 })]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.units, 3000);
  assert.equal(merged[0]!.gross, 3000);
  assert.equal(merged[0]!.sales, 2);
  assert.equal(merged[0]!.avgUnitPrice, 1000);
  assert.equal(merged[0]!.local, true);
});

test("a pending sale for a product the server has not sold yet still appears", () => {
  const merged = mergePendingItems([item()], [item({ productId: "p2", name: "Sugar", units: 500, gross: 750 })]);
  assert.deepEqual(merged.map((r) => r.productId).sort(), ["p1", "p2"]);
  assert.equal(merged.find((r) => r.productId === "p2")!.local, true);
});

test("merging nothing returns the server rows untouched", () => {
  const server = [item()];
  assert.equal(mergePendingItems(server, []), server);
});
