/**
 * Offline credit repayments in the device ledger.
 *
 * A repayment saved in airplane mode must be visible immediately as money received on its own day,
 * must reduce the customer's outstanding credit, and must never add revenue or profit. It must also
 * stay out of the figures once the server has rejected it. This mirrors the API integration test
 * (apps/api/tests/credit-daily-reporting.integration.test.ts) so the two bases cannot drift.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dayRange } from "@sms/shared";
import { computeLocalReport, computeLocalSummary, type ReportRepaymentRow } from "../src/services/local-reports.ts";
import { computeLocalDashboard } from "../src/services/local-dashboard.ts";
import type { LocalProduct, LocalRecord } from "../src/database/local.ts";

const rec = (op_id: string, type: string, at: string, data: unknown, status = "pending"): LocalRecord =>
  ({ op_id, type, at, data: JSON.stringify(data), actor: null, created_at: at, status });

const product = (over: Partial<LocalProduct> = {}): LocalProduct => ({
  id: "p1", code: "LOAF", barcode: null, name: "Loaf", unit: "kg", category: null,
  selling_price: 35000, low_threshold: 0, on_hand: 0, pending_delta: 0,
  purchase_unit: null, selling_unit: null, units_per_purchase: 1, units_per_selling: 1,
  ...over,
});

const MON = dayRange("2026-01-05")!;
const WED = dayRange("2026-01-07")!;
const THU = dayRange("2026-01-08")!;
const JAN = { from: dayRange("2026-01-01")!.from, to: dayRange("2026-02-01")!.from };

/** 1 unit received for 25,000 on 1 January, so a 35,000 sale has exactly 10,000 of gross profit. */
const opening = rec("op0", "purchase.create", "2026-01-01T08:00:00.000Z", {
  purchaseId: "pur1", orderedAt: "2026-01-01T08:00:00.000Z", amountPaid: 25000, receiveNow: true,
  lines: [{ productId: "p1", qty: 1000, unitCost: 25000 }],
}, "synced");

const sale = rec("op1", "sale.create", "2026-01-05T08:00:00.000Z", {
  saleId: "sale1", soldAt: "2026-01-05T08:00:00.000Z", discount: 0, amountPaid: 0,
  paymentMethod: "credit", customerId: "c1",
  lines: [{ productId: "p1", qty: 1000, unitPrice: 35000 }],
}, "synced");

const repay = (opId: string, paymentId: string, at: string, amount: number, method: string, status = "pending") =>
  rec(opId, "credit.payment.create", at, {
    paymentId, customerId: "c1", amount, paidAt: at, method, reference: `PAY-${paymentId}`,
  }, status);

const sum = (records: LocalRecord[], range: { from: string; to: string }) =>
  computeLocalSummary({ records, products: [product()], from: range.from, to: range.to });

test("a repayment is money received on its own day, never revenue and never profit", () => {
  const wed = repay("op2", "pay-wed", "2026-01-07T09:00:00.000Z", 20_000, "cash");
  const mon = sum([opening, sale, wed], MON).current;
  assert.equal(mon.netSales, 35_000);
  assert.equal(mon.cogs, 25_000);
  assert.equal(mon.grossProfit, 10_000);
  assert.equal(mon.cashCollected, 0, "the credit sale collected nothing");
  assert.equal(mon.creditRepayments, 0, "Wednesday's repayment is not counted on Monday");
  assert.equal(mon.outstandingCredit, 35_000);

  const wedFigures = sum([opening, sale, wed], WED).current;
  assert.equal(wedFigures.netSales, 0, "a repayment creates no sale");
  assert.equal(wedFigures.cogs, 0);
  assert.equal(wedFigures.grossProfit, 0, "a repayment creates no profit");
  assert.equal(wedFigures.creditRepayments, 20_000);
  assert.equal(wedFigures.totalReceived, 20_000, "money received today");
  assert.deepEqual(wedFigures.repaymentsByMethod, { cash: 20_000, momo: 0, bank: 0, other: 0 });
  assert.equal(wedFigures.outstandingCredit, 15_000);

  // Yesterday's repayment never lands in today's collections.
  assert.equal(sum([opening, sale, wed], THU).current.creditRepayments, 0);
});

test("the month adds the two repayments once each and keeps the sale's profit single", () => {
  const records = [
    opening, sale,
    repay("op2", "pay-wed", "2026-01-07T09:00:00.000Z", 20_000, "cash"),
    repay("op3", "pay-thu", "2026-01-08T11:00:00.000Z", 15_000, "momo"),
  ];
  const month = sum(records, JAN).current;
  assert.equal(month.netSales, 35_000, "one sale, once");
  assert.equal(month.grossProfit, 10_000, "the original profit is not repeated");
  assert.equal(month.creditRepayments, 35_000);
  assert.equal(month.totalReceived, 35_000, "collections + repayments, never counted twice");
  assert.deepEqual(month.repaymentsByMethod, { cash: 20_000, momo: 15_000, bank: 0, other: 0 });
  assert.equal(month.outstandingCredit, 0);
  assert.equal(month.transactions, 1, "repayments are not sales transactions");
});

test("a rejected repayment never reaches the figures, while a pending one does", () => {
  const rejected = repay("op4", "pay-bad", "2026-01-07T09:00:00.000Z", 20_000, "cash", "rejected");
  const pending = repay("op5", "pay-ok", "2026-01-07T10:00:00.000Z", 5_000, "momo", "pending");
  const wed = sum([opening, sale, rejected, pending], WED).current;
  assert.equal(wed.creditRepayments, 5_000, "only the repayment the shop actually made");
  assert.equal(wed.outstandingCredit, 30_000);
});

test("the repayments tab lists each payment once, dated by the day it was paid", () => {
  const rows = (records: LocalRecord[], range: { from: string; to: string }) =>
    computeLocalReport({ records, products: [product()], view: "repayments", from: range.from, to: range.to })
      .rows as ReportRepaymentRow[];

  const wed = repay("op2", "pay-wed", "2026-01-07T09:00:00.000Z", 20_000, "cash");
  const thu = repay("op3", "pay-thu", "2026-01-08T11:00:00.000Z", 15_000, "momo");
  const rejected = repay("op4", "pay-bad", "2026-01-07T12:00:00.000Z", 9_000, "cash", "rejected");
  const all = [opening, sale, wed, thu, rejected];

  const wedRows = rows(all, WED);
  assert.equal(wedRows.length, 1, "one payment on Wednesday; a rejected one never appears");
  assert.equal(wedRows[0].id, "pay-wed");
  assert.equal(wedRows[0].amount, 20_000);
  assert.equal(wedRows[0].method, "cash");
  assert.equal(wedRows[0].reference, "PAY-pay-wed");
  assert.equal(wedRows[0].customer, null, "a customer name is never invented offline");
  assert.equal(
    wedRows.reduce((s, r) => s + r.amount, 0),
    sum(all, WED).current.creditRepayments,
    "the listed rows add up to the money the summary reports",
  );

  assert.deepEqual(rows(all, THU).map((r) => r.id), ["pay-thu"], "yesterday's payment is not listed today");
  assert.deepEqual(rows(all, JAN).map((r) => r.id), ["pay-thu", "pay-wed"], "newest first, each payment once");
});

test("the offline dashboard shows collections, repayments, total received and the balance", () => {
  const dash = computeLocalDashboard({
    records: [
      opening, sale,
      repay("op2", "pay-wed", "2026-01-07T09:00:00.000Z", 20_000, "cash"),
    ],
    products: [product()],
    from: MON.from, to: MON.to,
    role: "owner", financials: true, now: Date.parse("2026-01-05T12:00:00.000Z"),
  }).data;
  assert.equal(dash.operations.cashCollected, 0);
  assert.equal(dash.operations.creditRepayments, 0);
  assert.equal(dash.operations.totalReceived, 0);
  assert.equal(dash.operations.outstandingCredit, 35_000);

  const wed = computeLocalDashboard({
    records: [
      opening, sale,
      repay("op2", "pay-wed", "2026-01-07T09:00:00.000Z", 20_000, "cash"),
    ],
    products: [product()],
    from: WED.from, to: WED.to,
    role: "owner", financials: true, now: Date.parse("2026-01-07T12:00:00.000Z"),
  }).data;
  assert.equal(wed.operations.cashCollected, 0, "no new sale was collected on Wednesday");
  assert.equal(wed.operations.creditRepayments, 20_000);
  assert.equal(wed.operations.totalReceived, 20_000);
  assert.equal(wed.operations.outstandingCredit, 15_000);
  assert.deepEqual(wed.operations.repaymentsByMethod, { cash: 20_000, momo: 0, bank: 0, other: 0 });
  assert.equal(wed.financials?.grossProfit, 0, "the repayment adds no profit");
  assert.equal(wed.trend.reduce((s, t) => s + t.repayments, 0), 20_000, "the chart keeps repayments on their own series");
  assert.equal(wed.trend.reduce((s, t) => s + t.netSales, 0), 0, "and never adds them to revenue");
});
