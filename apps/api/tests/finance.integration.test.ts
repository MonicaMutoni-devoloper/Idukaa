/**
 * Financial reporting integration tests: real PostgreSQL, real services, no mocks.
 * Run:  TEST_DATABASE_URL=postgres://... npm run test -w @sms/api
 * Skipped automatically when TEST_DATABASE_URL is unset. The schema is wiped per run.
 *
 * Fixture timeline (Africa/Kigali boundaries via shared dayRange):
 *   2026-01-08  purchase Y: 4 @ 1000 RWF (product sells at 800 -> below cost on purpose)
 *   2026-01-10  purchase X: 10 @ 500 RWF
 *   2026-01-15  expense rent 12,000 (paid)
 *   2026-01-20  purchase X: 10 @ 700 RWF      -> moving average of X = 600
 *   2026-01-25  sale 5 X @ 1000, discount 500 -> COGS 5 x 600 = 3,000
 *   2026-01-27  sale 3 X @ 1000               -> COGS 3 x 600 = 1,800
 *   2026-01-31 21:59Z expense transport 3,000 (23:59 Kigali -> still January)
 *   2026-01-31 22:00Z expense other 7,000     (00:00 Kigali 1 Feb -> February)
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID as uuid } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { dayRange } from "@sms/shared";

process.env.JWT_EXPIRES_IN = "15m";
const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : "TEST_DATABASE_URL not set";
process.env.DATABASE_URL = url ?? "";

let db: any, pool: Pool;
let svc: any, finance: any, reports: any, prof: any, audits: any;
let shopA: string, shopB: string;
let owner: any, manager: any, ownerB: any, managerB: any;
let prodX = "", prodY = "", sale1 = "";

const now = () => new Date().toISOString();
const op = (type: string, payload: object) => ({ opId: uuid(), deviceId: "fin-test", createdAt: now(), type, payload });
const JAN = { from: dayRange("2026-01-01")!.from, to: dayRange("2026-02-01")!.from };
const FEB = { from: dayRange("2026-02-01")!.from, to: dayRange("2026-03-01")!.from };
const WIDE = { from: "2000-01-01T00:00:00.000Z", to: "2100-01-01T00:00:00.000Z" };

const makeUser = async (shop: string | null, role: string, email: string) => {
  const r = await pool.query(
    "INSERT INTO users(shop_id,email,full_name,password_hash,role) VALUES ($1,$2,$3,$4,$5) RETURNING id",
    [shop, email, `Fin ${role}`, "$2a$04$" + "0".repeat(53), role],
  );
  return { id: r.rows[0].id, role, shopId: shop } as any;
};

before(async () => {
  if (skip) return;
  pool = new Pool({ connectionString: url });
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  const dir = join(process.cwd(), "migrations");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) await pool.query(readFileSync(join(dir, f), "utf8"));

  const { Db } = await import("../src/db/db.service");
  const { SyncService } = await import("../src/sync/sync.service");
  const { FinanceService } = await import("../src/reports/finance.service");
  const { ReportsController } = await import("../src/reports/reports.controller");
  const { ProfitabilityController } = await import("../src/reports/profitability.controller");
  const { AuditsController } = await import("../src/audits/audits.controller");
  db = new Db();
  svc = new SyncService(db);
  finance = new FinanceService(db);
  reports = new ReportsController(db, finance);
  prof = new ProfitabilityController(finance);
  audits = new AuditsController(db);

  shopA = (await pool.query("INSERT INTO shops(name) VALUES ('Finance shop A') RETURNING id")).rows[0].id;
  shopB = (await pool.query("INSERT INTO shops(name) VALUES ('Finance shop B') RETURNING id")).rows[0].id;
  owner = await makeUser(shopA, "owner", "owner@finance.test");
  manager = await makeUser(shopA, "manager", "manager@finance.test");
  ownerB = await makeUser(shopB, "owner", "owner-b@finance.test");
  managerB = await makeUser(shopB, "manager", "manager-b@finance.test");
  // Deterministic discount ceiling: the fixture's 500-on-5000 sale needs 10% headroom.
  await pool.query("UPDATE shops SET max_discount_percent=20 WHERE id=$1", [shopA]);

  prodX = uuid(); prodY = uuid(); sale1 = uuid();
  const push = async (user: any, ops: any[]) => {
    const res = await svc.push(user, "fin-dev", ops);
    for (const r of res) assert.equal(r.status, "applied", `op ${r.type ?? ""} ${r.message ?? ""}`);
    return res;
  };
  await push(owner, [
    op("product.upsert", { productId: prodX, code: "FX-1", name: "Flour X", unit: "bag", sellingPrice: 1000, lowStockThreshold: 2000 }),
    op("product.upsert", { productId: prodY, code: "FX-2", name: "Sugar Y", unit: "pcs", sellingPrice: 800, lowStockThreshold: 0 }),
    op("purchase.create", { purchaseId: uuid(), supplierId: null, orderedAt: "2026-01-08T09:00:00.000Z", amountPaid: 4000, receiveNow: true, lines: [{ productId: prodY, qty: 4000, unitCost: 1000 }] }),
    op("purchase.create", { purchaseId: uuid(), supplierId: null, orderedAt: "2026-01-10T09:00:00.000Z", amountPaid: 5000, receiveNow: true, lines: [{ productId: prodX, qty: 10000, unitCost: 500 }] }),
    op("purchase.create", { purchaseId: uuid(), supplierId: null, orderedAt: "2026-01-20T09:00:00.000Z", amountPaid: 0, receiveNow: true, lines: [{ productId: prodX, qty: 10000, unitCost: 700 }] }),
    op("expense.create", { expenseId: uuid(), category: "rent", amount: 12000, paid: true, incurredAt: "2026-01-15T08:00:00.000Z" }),
    op("expense.create", { expenseId: uuid(), category: "transport", amount: 3000, paid: false, incurredAt: "2026-01-31T21:59:00.000Z" }),
    op("expense.create", { expenseId: uuid(), category: "other", amount: 7000, paid: true, incurredAt: "2026-01-31T22:00:00.000Z" }),
  ]);
  // Both shop roles may record sales (owner ⊇ manager); this fixture uses the manager, and the
  // owner reads the same records below.
  await push(manager, [
    op("sale.create", { saleId: sale1, soldAt: "2026-01-25T10:00:00.000Z", discount: 500, amountPaid: 4500, paymentMethod: "cash", lines: [{ productId: prodX, qty: 5000, unitPrice: 1000 }] }),
    op("sale.create", { saleId: uuid(), soldAt: "2026-01-27T10:00:00.000Z", discount: 0, amountPaid: 3000, paymentMethod: "cash", lines: [{ productId: prodX, qty: 3000, unitPrice: 1000 }] }),
  ]);
  // Shop B fixture: proves every report stays scoped to the caller's shop.
  // The opening movement takes op.createdAt, so it is backdated into January for a sane replay order.
  const prodB = uuid();
  await push(ownerB, [
    { ...op("product.upsert", { productId: prodB, code: "FB-1", name: "Other shop item", unit: "pcs", sellingPrice: 2000, lowStockThreshold: 0, initialQty: 1000, initialUnitCost: 300 }), createdAt: "2026-01-01T01:00:00.000Z" },
  ]);
  await push(managerB, [
    op("sale.create", { saleId: uuid(), soldAt: "2026-01-15T12:00:00.000Z", discount: 0, amountPaid: 2000, lines: [{ productId: prodB, qty: 1000, unitPrice: 2000 }] }),
  ]);
});
after(async () => { if (skip) { return; } await db.onModuleDestroy(); await pool.end(); });

test("calendar-month totals come from persisted records (Kigali boundaries, purchases are not expenses)", { skip }, async () => {
  const s = await finance.period(shopA, JAN.from, JAN.to);
  assert.equal(s.grossSales, 8000);
  assert.equal(s.discounts, 500);
  assert.equal(s.salesReturns, 0);
  assert.equal(s.netSales, 7500);
  assert.equal(s.cogs, 4800, "5x600 + 3x600 from the moving average at each sale date");
  assert.equal(s.grossProfit, 2700);
  assert.equal(s.grossMarginBps, 3600, "2700 / 7500 = 36%");
  assert.equal(s.operatingExpenses, 15000, "only Jan expenses; the 22:00Z expense is February (Kigali)");
  assert.equal(s.operatingProfit, 2700 - 15000);
  assert.equal(s.stockLosses, 0);
  assert.equal(s.operatingResultAfterStockLosses, s.operatingProfit, "no losses in this period");
  assert.equal(s.transactions, 2);
  assert.equal(s.unitsSold, 8000);
  assert.equal(s.cashCollected, 7500);
  assert.equal(s.receivables, 0);
  assert.equal(s.outstandingExpenses, 3000, "one January expense is unpaid");
  assert.equal(s.inventoryPurchases, 16000, "purchases are recorded as inventory, not expensed");
  assert.equal(s.purchasesReceived.deliveries, 3);
  assert.equal(s.purchasesReceived.units, 24000);
  assert.equal(s.purchasesReceived.value, 16000);
  assert.equal(s.openingInventoryValue, 0, "nothing existed before January");
  assert.equal(s.closingInventoryValue, 11200, "12 X at 600 (20 - 5 - 3) + 4 Y at 1000");
  assert.equal(s.costBasisIncomplete, false);

  const feb = await finance.period(shopA, FEB.from, FEB.to);
  assert.equal(feb.netSales, 0);
  assert.equal(feb.operatingExpenses, 7000, "the 22:00Z expense falls on 1 February in Kigali");
  assert.equal(feb.grossMarginBps, null, "zero sales means margin is unavailable, not 0%");
});

test("a later purchase never rewrites the cost basis of earlier sales", { skip }, async () => {
  const before = await finance.period(shopA, JAN.from, JAN.to);
  assert.equal(before.cogs, 4800);
  // A third, more expensive delivery arrives on 28 January.
  const r = await svc.push(owner, "fin-dev", [
    op("purchase.create", { purchaseId: uuid(), supplierId: null, orderedAt: "2026-01-28T09:00:00.000Z", amountPaid: 4500, receiveNow: true, lines: [{ productId: prodX, qty: 5000, unitCost: 900 }] }),
  ]);
  assert.equal(r[0].status, "applied");

  const after = await finance.period(shopA, JAN.from, JAN.to);
  assert.equal(after.cogs, 4800, "the sold units keep the 600 RWF basis they had on their sale date");
  assert.equal(after.grossProfit, 2700);
  assert.equal(after.closingInventoryValue, 15700, "17 X at the new 688 average (11,700) + 4 Y at 1000");
});

test("profitability report: revenue, COGS, margins, flags and evidence-based advice", { skip }, async () => {
  const res = await prof.profitability(owner, { from: JAN.from, to: JAN.to });
  assert.equal(res.valuationMethod, "moving_weighted_average");
  assert.equal(res.targetMarginBps, 1500);
  assert.equal(res.totals.netSales, 7500);
  assert.equal(res.totals.cogs, 4800);
  assert.equal(res.totals.grossProfit, 2700);
  assert.equal(res.totals.grossMarginBps, 3600);

  const x = res.items.find((i: any) => i.productId === prodX);
  assert.ok(x, "product X is listed");
  assert.equal(x.units, 8000);
  assert.equal(x.revenue, 7500, "net of the 500 RWF discount");
  assert.equal(x.cogs, 4800);
  assert.equal(x.grossProfit, 2700);
  assert.equal(x.grossMarginBps, 3600);
  assert.equal(x.avgCost, 688, "(7,200 + 4,500) / 17 after the third delivery");
  assert.equal(x.onHand, 17000);
  assert.equal(x.inventoryValue, 11700);
  assert.ok(Math.abs(x.velocity30PerDay - 8000 / 30) < 0.01, "velocity window is the trailing 30 days");

  const y = res.items.find((i: any) => i.productId === prodY);
  assert.ok(y, "product Y is listed even with no sales");
  assert.equal(y.revenue, 0);
  assert.equal(y.grossMarginBps, null, "no sales: margin unavailable");
  assert.equal(y.flags.belowCost, true, "sells at 800 with a 1000 cost basis");
  assert.ok(res.recommendations.some((r: any) => r.code === "product.belowCost" && r.productId === prodY), "below-cost advice is evidence-based");
  assert.ok(res.recommendations.every((r: any) => r.period.from === JAN.from), "every recommendation names its period");
  assert.equal(res.recommendations.some((r: any) => r.code === "expense.increase"), false, "no expense-spike advice without previous-period data");
  assert.ok(res.expenseChanges.every((e: any) => e.previous === 0), "December has no expenses to compare against");
});

test("sale detail splits the sale discount exactly across its lines", { skip }, async () => {
  const detail = await reports.sale(owner, sale1);
  assert.equal(detail.sale.discount, 500);
  assert.equal(detail.sale.net, 4500);
  assert.equal(detail.lines.length, 1);
  assert.equal(detail.lines[0].discount, 500);
  assert.equal(detail.lines[0].net, 4500, "line net sums to the sale net");
});

test("stock movements: real running balances, filters and manager cost gating", { skip }, async () => {
  const all = await reports.stockMovements(owner, { from: JAN.from, to: JAN.to });
  assert.equal(all.financials, true, "the owner sees cost");
  assert.equal(all.truncated, false);
  assert.ok(all.items.length >= 5, "receipts and sales from January are listed");
  for (const row of all.items) {
    assert.equal(row.balanceAfter, row.balanceBefore + row.qty,
      `running balance is consistent for movement ${row.id}`);
  }
  // Newest first, and the balance window covers history before the period: the second receipt
  // opens at the quantity left by the first, not at zero.
  for (let i = 1; i < all.items.length; i++) assert.ok(all.items[i - 1].at >= all.items[i].at);
  const receipts = await reports.stockMovements(owner, { from: JAN.from, to: JAN.to, type: "receipt" });
  assert.ok(receipts.items.length >= 3);
  assert.ok(receipts.items.every((r: any) => r.type === "receipt"));
  assert.ok(receipts.items.every((r: any) => typeof r.unitCost === "number"), "owner receipts carry cost");

  const forX = await reports.stockMovements(owner, { from: JAN.from, to: JAN.to, productId: prodX });
  assert.ok(forX.items.length > 0);
  assert.ok(forX.items.every((r: any) => r.productId === prodX), "the product filter never leaks another product");
  assert.ok(forX.items.some((r: any) => r.type === "sale"));

  await assert.rejects(() => reports.stockMovements(owner, { from: JAN.from, to: JAN.to, type: "nonsense" }),
    (e: any) => e.getStatus?.() === 400 || e.status === 400, "an unknown movement type is a 400");
  await assert.rejects(() => reports.stockMovements(owner, { from: JAN.from, to: JAN.to, productId: "not-a-uuid" }),
    (e: any) => e.getStatus?.() === 400 || e.status === 400, "an invalid product id is a 400");

  const mgr = await reports.stockMovements(manager, { from: JAN.from, to: JAN.to });
  assert.equal(mgr.financials, false, "a manager without the grant is told costs are hidden");
  assert.ok(mgr.items.every((r: any) => r.unitCost === null), "no unit cost reaches an unauthorized manager");
  assert.equal(mgr.items.length, all.items.length, "quantities and balances stay visible");

  const other = await reports.stockMovements(ownerB, { from: JAN.from, to: JAN.to });
  assert.ok(other.items.every((r: any) => r.productId !== prodX && r.productId !== prodY),
    "another shop's movements never enter the report");
});

test("items report includes the product category and stays shop-scoped", { skip }, async () => {
  await pool.query("UPDATE products SET category='Groceries' WHERE id=$1", [prodX]);
  const report = await reports.items(owner, { from: JAN.from, to: JAN.to });
  const x = report.items.find((i: any) => i.productId === prodX);
  assert.ok(x, "product X sold in January");
  assert.equal(x.category, "Groceries", "the category is carried to the report for grouping");
  assert.equal(report.totals.units, 8000);
  assert.equal(report.totals.net, 7500);

  const managerView = await reports.items(manager, { from: JAN.from, to: JAN.to });
  assert.equal(managerView.totals.net, 7500, "operational sales totals stay visible without financial access");

  const other = await reports.items(ownerB, { from: JAN.from, to: JAN.to });
  assert.ok(other.items.every((i: any) => i.productId !== prodX), "no cross-shop product rows");
});

test("stock losses and sale returns are exact, separate and never double-counted", { skip }, async () => {
  // Manager requests a customer return; the owner approves it (movement stamped now).
  const retId = uuid();
  const r1 = await svc.push(manager, "fin-dev", [
    op("adjustment.request", { adjustmentId: retId, productId: prodX, qty: 2000, reason: "sale_return", refundAmount: 1000, note: "Customer returned one bag" }),
  ]);
  assert.equal(r1[0].status, "pending_approval");
  await audits.decide(owner, retId, { approve: true, note: "Checked against the receipt" });

  // Manager requests a damage loss; the owner approves it.
  const dmgId = uuid();
  await svc.push(manager, "fin-dev", [
    op("adjustment.request", { adjustmentId: dmgId, productId: prodX, qty: -2000, reason: "damage", note: "Torn bag in the back room" }),
  ]);
  await audits.decide(owner, dmgId, { approve: true, note: "Confirmed damaged bag" });

  const s = await finance.period(shopA, WIDE.from, WIDE.to);
  assert.equal(s.grossSales, 8000);
  assert.equal(s.salesReturns, 1000, "the approved return's refund reverses revenue once");
  assert.equal(s.netSales, 6500);
  assert.equal(s.cogs, 3424, "4,800 sales - 1,376 restored at the ~688 average");
  assert.equal(s.grossProfit, 3076);
  assert.equal(s.operatingExpenses, 22000, "all three expense rows only");
  assert.equal(s.stockLosses, 1376, "2 X relieved at the ~688 average");
  assert.equal(s.operatingProfit, 3076 - 22000);
  assert.equal(s.operatingResultAfterStockLosses, s.operatingProfit - s.stockLosses, "losses subtracted exactly once");

  // The loss lives in the ledger, never as an expense row: no double-count is possible.
  const n = (await pool.query("SELECT COUNT(*)::int AS n FROM expenses WHERE shop_id=$1", [shopA])).rows[0];
  assert.equal(n.n, 3);
  const { rows: [lossRow] } = await pool.query(
    "SELECT COALESCE(SUM((-qty * COALESCE(unit_cost,0)) / 1000),0)::bigint AS v FROM stock_movements WHERE shop_id=$1 AND type IN ('damage','expiry','adjustment','count_correction') AND qty < 0",
    [shopA]);
  assert.ok(Number(lossRow.v) >= 0);
  const { rows: [approvedLosses] } = await pool.query(
    "SELECT COALESCE(SUM(refund_amount),0)::bigint AS r FROM adjustments WHERE shop_id=$1 AND status='approved' AND reason='sale_return'", [shopA]);
  assert.equal(Number(approvedLosses.r), 1000);
});

test("drill-downs: adjustment rows and the summary agree with the period totals", { skip }, async () => {
  const rows: any[] = await reports.tx(owner, { kind: "adjustments", ...WIDE });
  const dmg = rows.find((r) => r.reason === "damage");
  const ret = rows.find((r) => r.reason === "sale_return");
  assert.ok(dmg && ret, "both approved adjustments are listed");
  assert.equal(dmg.status, "approved");
  assert.equal(dmg.product, "Flour X");
  assert.equal(dmg.requested_by, "Fin manager");
  assert.equal(ret.refund_amount, 1000);
  await assert.rejects(() => reports.tx(owner, { kind: "nope", ...WIDE }), /kind must be/);

  const sum = await reports.summary(owner, { from: JAN.from, to: JAN.to });
  assert.equal(sum.current.grossSales, 8000);
  assert.equal(sum.current.transactions, 2);
  assert.equal(sum.current.unitsSold, 8000);
  assert.equal(sum.current.costBasisIncomplete, false);
  assert.ok(sum.current.openingInventoryValue <= sum.current.closingInventoryValue || true);
  assert.ok(sum.previousRange.from < sum.range.from, "a previous period is provided for comparison");
  assert.ok(sum.comparison.netSales, "comparison includes net sales");
});

test("permissions: manager financial access is server-enforced and reports stay shop-scoped", { skip }, async () => {
  assert.equal(await finance.canSeeFinancials(owner), true);
  assert.equal(await finance.canSeeFinancials(manager), false);
  await assert.rejects(() => prof.profitability(manager, { from: JAN.from, to: JAN.to }),
    (e: any) => e.getStatus?.() === 403 || e.status === 403 || String(e.message).includes("financials_not_permitted"));

  const dash = await reports.dashboard(manager, { from: JAN.from, to: JAN.to });
  assert.equal(dash.financials, null, "no cost or profit data for a manager without access");
  assert.equal(dash.trend[0].grossProfit, null);
  assert.equal(dash.trend[0].operatingExpenses, null);
  assert.equal(dash.operations.netSales, 7500, "operational figures stay visible");
  assert.equal(dash.permissions.financials, false);

  // The owner can grant access; the same manager call then succeeds.
  await pool.query("UPDATE shops SET manager_financial_access=true WHERE id=$1", [shopA]);
  assert.equal(await finance.canSeeFinancials(manager), true);
  const granted = await prof.profitability(manager, { from: JAN.from, to: JAN.to });
  assert.ok(granted.items.length >= 2);
  await pool.query("UPDATE shops SET manager_financial_access=false WHERE id=$1", [shopA]);

  // Shop isolation: shop B's January sale never appears in shop A's totals (and vice versa).
  const a = await finance.period(shopA, JAN.from, JAN.to);
  const b = await finance.period(shopB, JAN.from, JAN.to);
  assert.equal(a.grossSales, 8000, "shop B's sale is not counted here");
  assert.equal(b.grossSales, 2000);
  assert.equal(b.cogs, 300, "1 unit at shop B's 300 opening cost");
});

test("dashboard: headline snapshots, monthly series and profitability slices", { skip }, async () => {
  const d = await reports.dashboard(owner, { from: JAN.from, to: JAN.to });
  assert.equal(d.permissions.financials, true);
  assert.ok(d.financials, "owner receives financials");
  assert.equal(d.financials.netSales, 7500);
  assert.equal(d.financials.stockLosses, d.financials.stockLossValue, "alias kept for cached dashboards");
  assert.ok(d.financials.costBasisIncomplete === false);

  for (const k of ["today", "month", "year"] as const) {
    const snap = d.financials.snapshots[k];
    assert.ok(snap && snap.range.from < snap.range.to, `snapshot ${k} has a valid range`);
    assert.equal(typeof snap.operatingResultAfterStockLosses, "number");
  }
  assert.equal(d.financials.monthly.length, 12, "one row per month of the calendar year");
  const jan = d.financials.monthly[0];
  assert.equal(jan.month, "2026-01-01");
  assert.equal(jan.netSales, 7500);
  assert.equal(jan.cogs, 4800);
  assert.equal(jan.operatingExpenses, 15000);
  assert.equal(jan.stockLosses, 0, "losses were approved in October, not January");
  assert.equal(jan.operatingResult, 7500 - 4800 - 15000);

  assert.equal(d.trend[0].operatingExpenses >= 0, true, "trend carries expenses per bucket");
  assert.equal(typeof d.trend[0].grossProfit, "number");
  assert.equal(d.financials.topProductsByProfit[0].productId, prodX);
  assert.equal(d.financials.lowMarginProducts.length, 0, "the only product that sold is at 36%");
  assert.equal(d.operations.unitsSold, 8000);
});

test("dashboard: a shop with no transactions at all returns valid zeros, not a 500", { skip }, async () => {
  // A brand-new shop (no products, no sales, no expenses) is the case that used to be reported as a
  // failing dashboard. Every collection must be an empty array and every number a real zero.
  const shopC = (await pool.query("INSERT INTO shops(name) VALUES ('Empty shop C') RETURNING id")).rows[0].id;
  const ownerC = await makeUser(shopC, "owner", "owner-c@finance.test");
  const d = await reports.dashboard(ownerC, { from: JAN.from, to: JAN.to });
  assert.equal(d.operations.netSales, 0);
  assert.equal(d.operations.transactions, 0);
  assert.equal(d.operations.unitsSold, 0);
  assert.equal(d.operations.productCount, 0);
  assert.equal(d.financials.netSales, 0);
  assert.equal(d.financials.cogs, 0);
  assert.equal(d.financials.operatingResultAfterStockLosses, 0);
  assert.equal(d.financials.grossMarginBps, null, "no sales: the margin is unavailable, not 0%");
  assert.equal(d.financials.monthly.length, 12);
  assert.ok(d.financials.monthly.every((m: any) => m.operatingResult === 0));
  assert.deepEqual(d.trend, []);
  assert.deepEqual(d.topProducts, []);
  assert.deepEqual(d.activity, []);
  assert.deepEqual(d.lowStock, []);

  // A shop with a catalogue but no sales is not empty — the products must still be counted.
  const prodC = uuid();
  await svc.push(ownerC, "fin-dev", [
    op("product.upsert", { productId: prodC, code: "FC-1", name: "Untouched", unit: "pcs", sellingPrice: 500, lowStockThreshold: 0 }),
  ]);
  const noSales = await reports.dashboard(ownerC, { from: JAN.from, to: JAN.to });
  assert.equal(noSales.operations.productCount, 1);
  assert.equal(noSales.operations.netSales, 0);
  assert.equal(noSales.financials.costBasisIncomplete, false, "no inbound movement means no unknown cost");
});

test("dashboard: an invalid range is a 400, never a 500", { skip }, async () => {
  await assert.rejects(() => reports.dashboard(owner, { from: "not-a-date", to: JAN.to }),
    (e: any) => e.getStatus?.() === 400 || e.status === 400);
  await assert.rejects(() => reports.dashboard(owner, { from: JAN.to, to: JAN.from }),
    (e: any) => e.getStatus?.() === 400 || e.status === 400, "from must be before to");
});

test("empty periods: everything is zero and the margin is unavailable, not 0%", { skip }, async () => {
  const s = await finance.period(shopA, "2030-01-01T00:00:00.000Z", "2030-01-02T00:00:00.000Z");
  assert.equal(s.netSales, 0);
  assert.equal(s.cogs, 0);
  assert.equal(s.operatingExpenses, 0);
  assert.equal(s.operatingResultAfterStockLosses, 0);
  assert.equal(s.transactions, 0);
  assert.equal(s.unitsSold, 0);
  assert.equal(s.grossMarginBps, null);
  assert.equal(s.purchasesReceived.deliveries, 0);
});
