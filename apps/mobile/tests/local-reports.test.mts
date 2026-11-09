/**
 * Offline reporting tests. Runs on Node 24 with built-in TypeScript type stripping:
 *   npm run test:mobile
 *
 * These cover the acceptance criteria for offline reports: a cached report survives a failed
 * request, an operation saved in airplane mode appears in the report immediately, the financial
 * figures follow the shared rules (discounts, COGS from received cost, expenses deducted, stock
 * received never counted as sales), a pending operation is not counted twice once it synchronizes,
 * and a cached report can never be shown for another shop or period.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dayRange } from "@sms/shared";
import {
  computeLocalReport, computeLocalSummary, mergePendingRows, readReportCache, reportCacheKey,
  type ReportExpenseRow, type ReportSaleRow,
} from "../src/services/local-reports.ts";
import type { LocalProduct, LocalRecord } from "../src/database/local.ts";

const rec = (op_id: string, type: string, at: string, data: unknown, status = "pending"): LocalRecord =>
  ({ op_id, type, at, data: JSON.stringify(data), actor: null, created_at: at, status });

const product = (over: Partial<LocalProduct> = {}): LocalProduct => ({
  id: "p1", code: "P1", barcode: null, name: "Flour", unit: "kg", category: null,
  selling_price: 1000, low_threshold: 2000, on_hand: 8000, pending_delta: 0,
  purchase_unit: null, selling_unit: null, units_per_purchase: 1, units_per_selling: 1,
  ...over,
});

const DAY3 = dayRange("2026-11-03")!;
const DAY2 = dayRange("2026-11-02")!;

const sale = (opId: string, at: string, over: Record<string, unknown> = {}, status = "pending") => rec(opId, "sale.create", at, {
  saleId: `sale-${opId}`, soldAt: at, discount: 200, amountPaid: 1800, paymentMethod: "cash",
  lines: [{ productId: "p1", qty: 2000, unitPrice: 1000, sellingQty: 2000 }], ...over,
}, status);

const expense = (opId: string, at: string, over: Record<string, unknown> = {}, status = "pending") => rec(opId, "expense.create", at, {
  expenseId: `exp-${opId}`, category: "rent", amount: 500, paid: true, incurredAt: at, ...over,
}, status);

const purchase = (opId: string, at: string, over: Record<string, unknown> = {}, status = "sync" + "ed") => rec(opId, "purchase.create", at, {
  purchaseId: `pur-${opId}`, orderedAt: at, amountPaid: 5000, receiveNow: true,
  lines: [{ productId: "p1", qty: 10000, unitCost: 500 }], ...over,
}, status);

const report = (records: LocalRecord[], view: Parameters<typeof computeLocalReport>[0]["view"], products = [product()], range = DAY3) =>
  computeLocalReport({ records, products, view, from: range.from, to: range.to });

const summary = (records: LocalRecord[], products = [product()], range = DAY3) =>
  computeLocalSummary({ records, products, from: range.from, to: range.to });

/* 1-3: a cached report survives a failed request and is never replaced by empty data ---------- */

test("a cached report is returned unchanged for the same shop, view and period", () => {
  const key = reportCacheKey("shop-1", "sales", DAY3.from, DAY3.to);
  const raw = JSON.stringify({ savedAt: "2026-11-03T12:00:00.000Z", shopId: "shop-1", view: "sales", from: DAY3.from, to: DAY3.to, rows: [{ id: "s1", at: "2026-11-03T09:00:00.000Z" }], totals: null });
  const entry = readReportCache(raw, { shopId: "shop-1", view: "sales", from: DAY3.from, to: DAY3.to });
  assert.ok(entry, "the saved copy is usable offline");
  assert.equal(entry.rows.length, 1);
  assert.equal(key, reportCacheKey("shop-1", "sales", DAY3.from, DAY3.to));
});

test("a cached report is rejected for another shop, another period, another view, or corruption", () => {
  const raw = JSON.stringify({ savedAt: "2026-11-03T09:00:00.000Z", shopId: "shop-1", view: "sales", from: DAY3.from, to: DAY3.to, rows: [{ id: "s1" }], totals: null });
  const expect = { shopId: "shop-1", view: "sales", from: DAY3.from, to: DAY3.to };
  assert.equal(readReportCache(raw, { ...expect, shopId: "shop-2" }), null, "another shop's report must never render");
  assert.equal(readReportCache(raw, { ...expect, view: "expenses" }), null);
  assert.equal(readReportCache(raw, { ...expect, from: DAY2.from }), null);
  assert.equal(readReportCache("{not json", expect), null);
  assert.equal(readReportCache(null, expect), null, "no cache is not an error, just no saved copy");
});

test("a failed request falls back to the cached rows, not to an empty list", () => {
  const cached = { savedAt: "2026-11-03T09:00:00.000Z", shopId: "shop-1", view: "sales", from: DAY3.from, to: DAY3.to, rows: [{ id: "s1", at: "2026-11-03T08:00:00.000Z" }], totals: null };
  const entry = readReportCache(JSON.stringify(cached), { shopId: "shop-1", view: "sales", from: DAY3.from, to: DAY3.to })!;
  // The screen renders mergePendingRows(entry.rows, pending) when the API throws.
  const rendered = mergePendingRows(entry.rows as ReportSaleRow[], []);
  assert.deepEqual(rendered, entry.rows, "the previous report stays visible");
  assert.ok(rendered.length > 0);
});

/* 4-6: offline operations appear immediately -------------------------------------------------- */

test("a sale saved offline appears in the sales report at once, net of its discount", () => {
  const r = report([sale("op1", "2026-11-03T09:00:00.000Z")], "sales");
  assert.equal(r.rows.length, 1);
  const row = r.rows[0] as ReportSaleRow;
  assert.equal(row.id, "sale-op1", "the operation id the server will also store");
  assert.equal(row.gross_amount, 2000);
  assert.equal(row.discount, 200);
  assert.equal(row.amount_paid, 1800);
  assert.equal(row.units, 2000);
  assert.equal(row.local, true, "flagged as saved on this device");
  assert.equal(r.counts.pending, 1);
});

test("an expense saved offline appears in the expenses report and reduces profit immediately", () => {
  const records = [expense("op2", "2026-11-03T08:00:00.000Z"), sale("op1", "2026-11-03T09:00:00.000Z")];
  const rows = report(records, "expenses").rows as ReportExpenseRow[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.amount, 500);
  assert.equal(rows[0]!.paid, true);

  const s = summary(records);
  assert.equal(s.current.operatingExpenses, 500);
  assert.equal(s.current.netSales, 1800);
  assert.equal(s.current.operatingProfit, 1800 - s.current.cogs - 500);
});

test("stock received offline shows in the purchases report and never as sales", () => {
  const records = [purchase("op3", "2026-11-03T07:00:00.000Z")];
  const rows = report(records, "purchases").rows as any[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].total_amount, 5000);
  assert.equal(rows[0].balance, 0);

  const s = summary(records);
  assert.equal(s.current.grossSales, 0, "a delivery is inventory, not revenue");
  assert.equal(s.current.netSales, 0);
  assert.equal(s.current.inventoryPurchases, 5000);
  assert.deepEqual(s.current.purchasesReceived, { deliveries: 1, products: 1, units: 10000, value: 5000 });
  assert.equal(s.current.closingInventoryUnits, 10000);
  assert.equal(s.current.closingInventoryValue, 5000);
});

/* 7-9: financial correctness ---------------------------------------------------------------- */

test("COGS uses the cost actually received, and expenses are deducted from operating profit", () => {
  const records = [purchase("op1", "2026-11-02T08:00:00.000Z"), sale("op2", "2026-11-03T09:00:00.000Z", {}, "sync" + "ed"), expense("op3", "2026-11-03T10:00:00.000Z")];
  const s = summary(records);
  assert.equal(s.current.netSales, 1800, "2000 gross minus the 200 discount");
  assert.equal(s.current.cogs, 1000, "2 units at the 500 that was received");
  assert.equal(s.current.grossProfit, 800);
  assert.equal(s.current.operatingExpenses, 500);
  assert.equal(s.current.operatingProfit, 300);
  assert.equal(s.current.operatingResultAfterStockLosses, 300);
  assert.equal(s.current.costBasisIncomplete, false);
  assert.equal(s.current.openingInventoryUnits, 10000, "the delivery was the day before, so it opens the period");
  assert.equal(s.current.closingInventoryUnits, 8000);
  assert.equal(s.current.closingInventoryValue, 4000);
});

test("one operation is counted exactly once, before and after it synchronizes", () => {
  const pending = summary([sale("op1", "2026-11-03T09:00:00.000Z")]);
  const synced = summary([sale("op1", "2026-11-03T09:00:00.000Z", {}, "sync" + "ed")]);
  assert.equal(synced.current.netSales, pending.current.netSales);
  assert.equal(synced.current.transactions, 1);
  assert.equal(pending.current.transactions, 1);
});

test("a synchronized sale that also arrives from the server is not added twice on reconnect", () => {
  const local = report([sale("op1", "2026-11-03T09:00:00.000Z", {}, "sync" + "ed")], "sales").rows as ReportSaleRow[];
  const server = [{ id: "sale-op1", at: "2026-11-03T09:00:00.000Z", gross_amount: 2000 }];
  const merged = mergePendingRows(server as any[], local.filter((r) => r.syncStatus !== "synced" && r.syncStatus !== "rejected"));
  assert.equal(merged.length, 1, "matched by operation id, so revenue cannot double");

  // A sale still waiting for the queue IS merged, because the server answer cannot contain it yet.
  const pendingRows = report([sale("op2", "2026-11-03T10:00:00.000Z")], "sales").rows as ReportSaleRow[];
  const withPending = mergePendingRows(server as any[], pendingRows);
  assert.equal(withPending.length, 2);
  assert.ok(withPending.some((r: any) => r.id === "sale-op2" && r.local === true));
});

/* 10: restart and empty states --------------------------------------------------------------- */

test("recomputing after a restart returns identical rows and figures", () => {
  const records = [purchase("op1", "2026-11-02T08:00:00.000Z"), sale("op2", "2026-11-03T09:00:00.000Z"), expense("op3", "2026-11-03T10:00:00.000Z")];
  assert.deepEqual(report(records, "sales").rows, report(records, "sales").rows);
  assert.deepEqual(summary(records).current, summary(records).current);
});

test("an empty period reports zeros and an unavailable margin, never a fake 0%", () => {
  const s = summary([]);
  assert.equal(s.current.netSales, 0);
  assert.equal(s.current.transactions, 0);
  assert.equal(s.current.grossMarginBps, null);
  assert.equal(s.current.operatingResultAfterStockLosses, 0);
  assert.equal(s.current.closingInventoryValue, 0);
  assert.equal(report([], "sales").rows.length, 0);
  assert.equal(report([], "items").totals?.products, 0);
});

test("adjustments requested offline are shown as pending, without an invented cost", () => {
  const rows = report([rec("op9", "adjustment.request", "2026-11-03T09:00:00.000Z", {
    adjustmentId: "adj1", productId: "p1", qty: -300, reason: "damage", countedAt: "2026-11-03T09:00:00.000Z",
  }, "pending_approval")], "adjustments").rows as any[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "pending", "approval is the server's decision, not the device's");
  assert.equal(rows[0].unit_cost, null, "no ledger cost is available offline, so it is left unknown");
  assert.equal(rows[0].product, "Flour");
});

test("a period before the device's first record is still computed, and comparison handles no prior sales", () => {
  const s = summary([sale("op1", "2026-11-03T09:00:00.000Z")]);
  assert.equal(s.previous.netSales, 0);
  assert.equal(s.comparison.netSales.pct, null, "no prior sales means a change with no percentage");
  assert.equal(s.comparison.netSales.change, 1800);
  const empty = report([], "sales", [product()], DAY2);
  assert.equal(empty.coverageFrom, null);
  assert.equal(empty.counts.inRange, 0);
});

test("the items report groups per product with the server's average-price formula", () => {
  const records = [
    sale("op1", "2026-11-03T09:00:00.000Z"),
    rec("op2", "sale.create", "2026-11-03T11:00:00.000Z", {
      saleId: "s2", soldAt: "2026-11-03T11:00:00.000Z", discount: 0, amountPaid: 2000, paymentMethod: "mobile",
      lines: [{ productId: "p1", qty: 2000, unitPrice: 1000, sellingQty: 2000 }, { productId: "p2", qty: 1000, unitPrice: 1500, sellingQty: 1000 }],
    }),
  ];
  const products = [product(), product({ id: "p2", name: "Sugar", code: "P2" })];
  const r = report(records, "items", products);
  // Per-product sale counts, summed like the API's items totals: the sale holding two products
  // counts once for each of them.
  assert.equal(r.totals?.sales, 3);
  assert.equal(r.totals?.units, 5000);
  assert.equal(r.totals?.products, 2);
  assert.equal(r.totals?.discounts, 200);
  assert.equal(r.totals?.gross, 5500, "every line amount, before discounts");
  assert.equal(r.totals?.net, 5300, "the second sale has no discount, so its lines stay whole");
  const flour = (r.rows as any[]).find((x) => x.productId === "p1");
  assert.equal(flour.units, 4000);
  assert.equal(flour.avgUnitPrice, 1000);
  assert.equal(flour.sales, 2);
});
