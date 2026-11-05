/**
 * Dashboard section isolation — no database required.
 *
 * The production complaint was `GET /reports/dashboard → 500` and `GET /reports/profitability → 500`
 * with no way to tell which part failed. These tests pin the contract that makes that failure mode
 * survivable and diagnosable:
 *   - one optional panel failing does NOT take the report down, and is named in `degraded`;
 *   - the headline figures still come from the finance service (nothing is replaced by zeros);
 *   - a failure of the CORE calculation is not swallowed — it still fails loudly;
 *   - a stale schema (PostgreSQL 42703, e.g. a migration that never reached production) is reported
 *     as 503 `schema_out_of_date` with a request id, not an opaque 500.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { summarize } from "@sms/shared";

const RANGE = { from: "2026-11-01T00:00:00.000Z", to: "2026-11-08T00:00:00.000Z" };
const owner = { id: "u1", role: "owner", shopId: "11111111-1111-4111-8111-111111111111" } as any;
const manager = { id: "u2", role: "manager", shopId: owner.shopId } as any;
/** A fresh fake request per test: the degraded list is stored on the request object. */
const mkReq = (path = "/reports/dashboard", requestId = "test-request-1") => ({ method: "GET", path, requestId } as any);

/** A complete PeriodResult built from the real shared summarizer, so no field is invented. */
const periodResult = (netSales = 12345) => ({
  ...summarize({
    grossSales: netSales, discounts: 0, salesReturns: 0, cogs: 0, operatingExpenses: 0,
    expensesPaid: 0, cashCollected: netSales, inventoryPurchases: 0, receivables: 0, stockLosses: 0,
  }),
  stockLossValue: 0, transactions: 3, unitsSold: 12000,
  purchasesReceived: { deliveries: 0, products: 0, units: 0, value: 0 },
  openingInventoryValue: 0, closingInventoryValue: 0, openingInventoryUnits: 0,
  closingInventoryUnits: 0, costBasisIncomplete: false,
});

const schemaError = (column: string) =>
  Object.assign(new Error(`column "${column}" does not exist`), { code: "42703", column });

/** Every SQL statement answers an empty result set, so each panel maps to its documented default. */
const emptyDb = { query: async () => [] } as any;

const makeController = async (over: Record<string, unknown> = {}) => {
  const { ReportsController } = await import("../src/reports/reports.controller");
  const finance = {
    canSeeFinancials: async () => true,
    movements: async () => new Map(),
    period: async () => periodResult(),
    productProfitability: async () => [],
    ...over,
  } as any;
  return { controller: new ReportsController(emptyDb, finance), finance };
};

test("one failing panel is named in `degraded`, and the headline figures survive", async () => {
  const { controller } = await makeController({
    productProfitability: async () => { throw schemaError("selling_unit"); },
  });
  const d = await controller.dashboard(owner, RANGE, mkReq());

  assert.deepEqual(d.degraded, ["product_profitability"], "the broken panel is reported, not hidden");
  assert.equal(d.financials.netSales, 12345, "core figures come from the finance service");
  assert.equal(d.operations.netSales, 12345);
  assert.deepEqual(d.financials.topProductsByProfit, [], "the failed panel is empty, not fabricated");
  assert.deepEqual(d.financials.lowMarginProducts, []);
  assert.equal(d.financials.costBasisIncomplete, false, "unknown cost basis is not assumed");
  assert.equal(d.financials.monthly.length, 12, "the monthly series is still built");
});

test("a healthy dashboard reports no degradation", async () => {
  const { controller } = await makeController();
  const d = await controller.dashboard(owner, RANGE, mkReq());
  assert.deepEqual(d.degraded, []);
});

test("a manager without financial access never receives cost, profit or a financial panel", async () => {
  const { controller } = await makeController({
    canSeeFinancials: async () => false,
    productProfitability: async () => { throw schemaError("selling_unit"); },
  });
  const d = await controller.dashboard(manager, RANGE, mkReq());
  assert.equal(d.financials, null);
  assert.equal(d.financialComparison, null);
  assert.deepEqual(d.degraded, [], "a panel the role never sees cannot be degraded");
  assert.equal(d.operations.netSales, 12345, "operational figures remain visible");
});

test("a failure in the core calculation is NOT swallowed", async () => {
  const { controller } = await makeController({
    period: async () => { throw schemaError("gross_amount"); },
  });
  await assert.rejects(() => controller.dashboard(owner, RANGE, mkReq()), (e: any) => e.code === "42703");
});

test("profitability reports a stale schema as 503 with a request id, and logs the cause", async () => {
  const { ProfitabilityController } = await import("../src/reports/profitability.controller");
  const finance = {
    canSeeFinancials: async () => true,
    movements: async () => new Map(),
    productProfitability: async () => { throw schemaError("units_per_selling"); },
    period: async () => periodResult(),
    expenseChanges: async () => [],
  } as any;
  const prof = new ProfitabilityController(finance);
  const req2 = mkReq("/reports/profitability", "test-request-2");

  await assert.rejects(
    () => prof.profitability(owner, RANGE, req2),
    (e: any) => e.getStatus?.() === 503
      && e.getResponse()?.error === "schema_out_of_date"
      && e.getResponse()?.requestId === "test-request-2",
  );
});

test("profitability still refuses a manager without financial access", async () => {
  const { ProfitabilityController } = await import("../src/reports/profitability.controller");
  const finance = { canSeeFinancials: async () => false } as any;
  const prof = new ProfitabilityController(finance);
  await assert.rejects(() => prof.profitability(manager, RANGE, mkReq("/reports/profitability")), (e: any) => e.getStatus?.() === 403);
});
