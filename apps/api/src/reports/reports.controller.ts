import { BadRequestException, Controller, ForbiddenException, Get, NotFoundException, Param, Query, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { z } from "zod";
import {
  TARGET_GROSS_MARGIN_BPS, allocateLineDiscounts, compare, dayRange, kigaliDay, presetRange,
  replayLedger, type CalendarPreset, type Movement,
} from "@sms/shared";
import { Db } from "../db/db.service";
import { Me, Roles, type AuthUser } from "../common/auth";
import { FinanceService, parseRange as parse } from "./finance.service";
import { reportLog } from "../common/report-log";

interface DashboardProduct { id: string; name: string; qty: string | number; net_sales: string | number }

@Controller("reports") @Roles("owner", "manager")
export class ReportsController {
  constructor(private db: Db, private finance: FinanceService) {}

  /** Owner always sees profit; a manager only when the owner enabled it for the shop. Enforced here, not in the UI. */
  private canSeeFinancials(u: AuthUser): Promise<boolean> { return this.finance.canSeeFinancials(u); }

  /**
   * Runs one optional dashboard section so its failure cannot take the whole report down.
   *
   * The headline totals (sales, expenses, COGS, profit, stock) come from the finance service and must
   * succeed; the supporting panels (trend charts, activity feed, staff list, expense breakdown) are
   * decoration around them. Before this, one bad optional query — a schema drift in production, a
   * dropped connection — answered HTTP 500 and the shop owner saw no figures at all even though the
   * numbers were available. The failure is still recorded, with the request id, so it can be fixed.
   */
  private async section<T>(req: Request | undefined, name: string, run: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await run();
    } catch (e) {
      reportLog(req, "reports.section_failed", name, e);
      this.degradation(req).push(name);
      return fallback;
    }
  }

  /** Names of the panels that could not be computed, sent with the response so the UI can say so. */
  private degradation(req?: Request): string[] {
    if (!req) return [];
    const r = req as Request & { degradedSections?: string[] };
    return (r.degradedSections ??= []);
  }

  @Get("summary") @Roles("owner", "manager") async summary(@Me() u: AuthUser, @Query() q: unknown) {
    if (!(await this.canSeeFinancials(u))) throw new ForbiddenException("financials_not_permitted");
    const { from, to } = parse(q); const cur = await this.finance.period(u.shopId!, from, to);
    const span = Date.parse(to) - Date.parse(from); const pf = new Date(Date.parse(from) - span).toISOString();
    const prev = await this.finance.period(u.shopId!, pf, from);
    return { range: { from, to }, previousRange: { from: pf, to: from }, current: cur, previous: prev, comparison: compare(cur, prev) };
  }

  @Get("inventory") async inventory(@Me() u: AuthUser) { return this.inventoryData(u); }

  private async inventoryData(u: AuthUser, moves?: Map<string, Movement[]>) {
    const canSeeFinancials = await this.canSeeFinancials(u);
    const products = await this.db.query("SELECT id, code, name, unit, selling_price, low_stock_threshold FROM products WHERE shop_id=$1 AND active ORDER BY name", [u.shopId]);
    const mv = moves ?? await this.finance.movements(u.shopId!);
    // Average cost and inventory value are cost data: managers only receive them when the owner allows it.
    const items = products.map(p => {
      const r = replayLedger(mv.get(p.id) ?? []);
      const base = { ...p, onHand: r.onHand, low: r.onHand <= p.low_stock_threshold };
      return canSeeFinancials ? { ...base, avgCost: r.avgCost, value: r.value } : base;
    });
    return {
      items, lowStockCount: items.filter(i => i.low).length,
      totalValue: canSeeFinancials ? (items as any[]).reduce((s, i) => s + i.value, 0) : null,
      valuationMethod: canSeeFinancials ? "moving_weighted_average" : null,
    };
  }

  /**
   * One dashboard read for both roles. Operational figures are shared; cost, profit and margin are
   * only computed for owners so a manager token can never receive sensitive financial data.
   * The stock ledger is loaded ONCE and shared by every consumer below — never re-read per query.
   */
  @Get("dashboard")
  async dashboard(@Me() u: AuthUser, @Query() q: unknown, @Req() req?: Request) {
    const { from, to } = parse(q);
    const shopId = u.shopId!;
    const canSeeFinancials = await this.canSeeFinancials(u);
    const moves = canSeeFinancials ? await this.finance.movements(shopId) : new Map<string, Movement[]>();
    const cur = await this.finance.period(shopId, from, to, moves);
    const span = Date.parse(to) - Date.parse(from);
    const prevFrom = new Date(Date.parse(from) - span).toISOString();
    const prev = await this.finance.period(shopId, prevFrom, from, moves);
    const inventory = await this.inventoryData(u, moves);

    const openPurchases = await this.section(req, "open_purchases", () => this.db.query<{ c: number }>(
      `SELECT COUNT(DISTINCT pu.id)::int AS c FROM purchases pu JOIN purchase_lines pl ON pl.purchase_id=pu.id
       WHERE pu.shop_id=$1 AND pl.qty_received < pl.qty_ordered`, [shopId]), []).then((r) => r[0] ?? { c: 0 });

    const payables = await this.section(req, "payables", () => this.db.query<{ p: number }>(
      `SELECT COALESCE(SUM(total_amount - amount_paid),0)::bigint AS p FROM purchases WHERE shop_id=$1`, [shopId]), []).then((r) => r[0] ?? { p: 0 });

    const issues = await this.section(req, "issues", () => this.db.query<{ pending_approvals: number; open_investigations: number; open_conflicts: number }>(
      `SELECT
        (SELECT COUNT(*)::int FROM adjustments WHERE shop_id=$1 AND status='pending') AS pending_approvals,
        (SELECT COUNT(*)::int FROM investigations WHERE shop_id=$1 AND status IN ('open','investigating')) AS open_investigations,
        (SELECT COUNT(*)::int FROM operations WHERE shop_id=$1 AND status IN ('conflict','rejected') AND resolved_at IS NULL) AS open_conflicts`, [shopId]), [])
      .then((r) => r[0] ?? { pending_approvals: 0, open_investigations: 0, open_conflicts: 0 });

    const spanDays = span / 86_400_000;
    const bucket = spanDays > 400 ? "month" : spanDays > 62 ? "week" : "day";
    const trend = await this.section(req, "trend", () => this.db.query(
      `SELECT to_char(date_trunc($4, s.sold_at AT TIME ZONE 'Africa/Kigali'),'YYYY-MM-DD') AS date,
              COALESCE(SUM(s.gross_amount - s.discount),0)::bigint AS net_sales,
              COUNT(*)::int AS transactions
       FROM sales s WHERE s.shop_id=$1 AND s.status='posted' AND s.sold_at>=$2 AND s.sold_at<$3
       GROUP BY 1 ORDER BY 1`, [shopId, from, to, bucket]), []);

    // Operating expenses per bucket, so the trend can show gross profit vs. expenses consistently.
    const expTrend = canSeeFinancials ? await this.section(req, "trend_expenses", () => this.db.query(
      `SELECT to_char(date_trunc($4, incurred_at AT TIME ZONE 'Africa/Kigali'),'YYYY-MM-DD') AS date,
              COALESCE(SUM(amount),0)::bigint AS amount
       FROM expenses WHERE shop_id=$1 AND incurred_at>=$2 AND incurred_at<$3
       GROUP BY 1`, [shopId, from, to, bucket]), []) : [];
    const expByDate = new Map<string, number>((expTrend as any[]).map(e => [e.date, Number(e.amount)]));

    // The calendar year (Africa/Kigali) containing the range start: the monthly chart's year.
    const year = Number(kigaliDay(from).slice(0, 4));
    const yearFrom = dayRange(`${year}-01-01`)?.from ?? from;
    const yearTo = dayRange(`${year + 1}-01-01`)?.from ?? to;

    // Cost of goods sold per bucket AND per Kigali month, from the same ledger replay used by the
    // period totals, so the profit trend can never disagree with the headline gross profit. Owners only.
    const kigaliKey = (iso: string) => {
      const d = new Date(Date.parse(iso) + 2 * 3_600_000); // Africa/Kigali is UTC+2 year-round
      if (bucket === "month") return `${d.toISOString().slice(0, 7)}-01`;
      if (bucket === "week") {
        const offset = (d.getUTCDay() + 6) % 7; // Monday start, matching date_trunc('week')
        d.setUTCDate(d.getUTCDate() - offset);
      }
      return d.toISOString().slice(0, 10);
    };
    const kigaliMonthKey = (iso: string) => `${new Date(Date.parse(iso) + 2 * 3_600_000).toISOString().slice(0, 7)}-01`;
    const cogsByBucket = new Map<string, number>();
    const cogsByMonth = new Map<string, number>();
    const lossByMonth = new Map<string, number>();
    if (canSeeFinancials) {
      for (const list of moves.values()) {
        const sorted = [...list].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
        const r = replayLedger(sorted);
        sorted.forEach((m, i) => {
          const cost = r.perMovementCost[i] ?? 0;
          const inYear = m.occurredAt >= yearFrom && m.occurredAt < yearTo;
          const inRange = m.occurredAt >= from && m.occurredAt < to;
          if (inYear) {
            const mk = kigaliMonthKey(m.occurredAt);
            if (m.type === "sale" || m.type === "sale_return") {
              cogsByMonth.set(mk, (cogsByMonth.get(mk) ?? 0) + (m.type === "sale" ? cost : -cost));
            } else if (m.qty < 0 && m.type !== "supplier_return" && m.type !== "transfer_out") {
              lossByMonth.set(mk, (lossByMonth.get(mk) ?? 0) + cost);
            }
          }
          if (inRange && (m.type === "sale" || m.type === "sale_return")) {
            const key = kigaliKey(m.occurredAt);
            cogsByBucket.set(key, (cogsByBucket.get(key) ?? 0) + (m.type === "sale" ? cost : -cost));
          }
        });
      }
    }

    // Monthly operating results for that year: net sales (less returns), COGS, expenses, stock losses.
    const monthSales = canSeeFinancials ? await this.section(req, "monthly_sales", () => this.db.query(
      `SELECT to_char(date_trunc('month', sold_at AT TIME ZONE 'Africa/Kigali'),'YYYY-MM-DD') AS month,
              COALESCE(SUM(gross_amount - discount),0)::bigint AS net
       FROM sales WHERE shop_id=$1 AND status='posted' AND sold_at>=$2 AND sold_at<$3 GROUP BY 1`, [shopId, yearFrom, yearTo]), []) : [];
    const monthReturns = canSeeFinancials ? await this.section(req, "monthly_returns", () => this.db.query(
      `SELECT to_char(date_trunc('month', decided_at AT TIME ZONE 'Africa/Kigali'),'YYYY-MM-DD') AS month,
              COALESCE(SUM(refund_amount),0)::bigint AS r
       FROM adjustments WHERE shop_id=$1 AND status='approved' AND reason='sale_return'
         AND decided_at>=$2 AND decided_at<$3 GROUP BY 1`, [shopId, yearFrom, yearTo]), []) : [];
    const monthExp = canSeeFinancials ? await this.section(req, "monthly_expenses", () => this.db.query(
      `SELECT to_char(date_trunc('month', incurred_at AT TIME ZONE 'Africa/Kigali'),'YYYY-MM-DD') AS month,
              COALESCE(SUM(amount),0)::bigint AS amount
       FROM expenses WHERE shop_id=$1 AND incurred_at>=$2 AND incurred_at<$3 GROUP BY 1`, [shopId, yearFrom, yearTo]), []) : [];
    const numMap = (rows: any[], key: string, val: string) => new Map<string, number>(rows.map(r => [r[key], Number(r[val])]));
    const mNet = numMap(monthSales as any[], "month", "net");
    const mRet = numMap(monthReturns as any[], "month", "r");
    const mExp = numMap(monthExp as any[], "month", "amount");
    const monthly = canSeeFinancials ? Array.from({ length: 12 }, (_, i) => {
      const key = `${year}-${String(i + 1).padStart(2, "0")}-01`;
      const netSales = (mNet.get(key) ?? 0) - (mRet.get(key) ?? 0);
      const cogs = cogsByMonth.get(key) ?? 0;
      const operatingExpenses = mExp.get(key) ?? 0;
      const stockLosses = lossByMonth.get(key) ?? 0;
      return { month: key, year, monthNumber: i + 1, netSales, cogs, operatingExpenses, stockLosses,
        operatingResult: netSales - cogs - operatingExpenses - stockLosses };
    }) : null;

    // Headline cards (spec §5): today / this month / this year on Africa/Kigali business days.
    const snap = async (p: CalendarPreset) => {
      const r = presetRange(p);
      const s = await this.finance.period(shopId, r.from, r.to, moves);
      return {
        range: r, netSales: s.netSales, cogs: s.cogs, grossProfit: s.grossProfit,
        grossMarginBps: s.grossMarginBps, operatingExpenses: s.operatingExpenses,
        operatingProfit: s.operatingProfit, stockLosses: s.stockLosses,
        operatingResultAfterStockLosses: s.operatingResultAfterStockLosses,
        transactions: s.transactions, costBasisIncomplete: s.costBasisIncomplete,
      };
    };
    const snapshots = canSeeFinancials
      ? { today: await snap("today"), month: await snap("month"), year: await snap("year") }
      : null;

    // Product profitability slices for the charts (top by gross profit, weak margins). Owners only.
    const productFin = canSeeFinancials ? await this.finance.productProfitability(shopId, from, to, moves) : [];
    const topProductsByProfit = productFin.filter(i => i.units > 0)
      .sort((a, b) => b.grossProfit - a.grossProfit).slice(0, 5)
      .map(p => ({ productId: p.productId, name: p.name, units: p.units, revenue: p.revenue,
        cogs: p.cogs, grossProfit: p.grossProfit, grossMarginBps: p.grossMarginBps }));
    const lowMarginProducts = productFin.filter(i => i.grossMarginBps !== null && i.grossMarginBps < TARGET_GROSS_MARGIN_BPS)
      .sort((a, b) => (a.grossMarginBps ?? 0) - (b.grossMarginBps ?? 0)).slice(0, 5)
      .map(p => ({ productId: p.productId, name: p.name, units: p.units, revenue: p.revenue,
        grossMarginBps: p.grossMarginBps, sellingPrice: p.sellingPrice, sellingUnit: p.sellingUnit, avgCost: p.avgCost, belowCost: p.flags.belowCost }));

    const productTotals = await this.section(req, "product_totals", () => this.db.query<DashboardProduct>(
      `SELECT p.id, p.name, COALESCE(SUM(sl.qty),0)::bigint AS qty, COALESCE(SUM(sl.line_amount),0)::bigint AS net_sales
       FROM sale_lines sl JOIN sales s ON s.id=sl.sale_id JOIN products p ON p.id=sl.product_id
       WHERE s.shop_id=$1 AND s.status='posted' AND s.sold_at>=$2 AND s.sold_at<$3
       GROUP BY p.id, p.name ORDER BY net_sales DESC`, [shopId, from, to]), []);

    const activity = await this.section(req, "activity", () => this.db.query(
      `SELECT a.id, a.at, a.action, a.entity, a.entity_id, a.reason, us.full_name AS actor, p.name AS product_name,
              sp.names AS sale_products, sa.gross_amount AS sale_total,
              pu.total_amount AS purchase_total, pu.reference AS purchase_reference, su.name AS supplier_name
       FROM audit_log a LEFT JOIN users us ON us.id=a.actor_id
       LEFT JOIN products p ON a.entity='product' AND p.id::text = a.entity_id
       LEFT JOIN sales sa ON sa.op_id::text = a.entity_id
       LEFT JOIN purchases pu ON pu.op_id::text = a.entity_id
       LEFT JOIN suppliers su ON su.id = pu.supplier_id
       LEFT JOIN LATERAL (SELECT string_agg(p2.name, ', ') AS names FROM sale_lines sl JOIN products p2 ON p2.id=sl.product_id WHERE sl.sale_id=sa.id) sp ON true
       WHERE a.shop_id=$1 AND a.action NOT LIKE 'auth.%'
       ORDER BY a.id DESC LIMIT 10`, [shopId]), []);

    const expenseBreakdown = canSeeFinancials ? await this.section(req, "expenses_by_category", () => this.db.query(
      `SELECT category, COALESCE(SUM(amount),0)::bigint AS amount, COALESCE(SUM(amount) FILTER (WHERE NOT paid),0)::bigint AS unpaid
       FROM expenses WHERE shop_id=$1 AND incurred_at>=$2 AND incurred_at<$3
       GROUP BY category ORDER BY amount DESC LIMIT 8`, [shopId, from, to]), []) : [];

    const staff = await this.section(req, "staff_activity", () => this.db.query(
      `SELECT us.full_name AS actor, COUNT(*)::int AS actions
       FROM audit_log a JOIN users us ON us.id=a.actor_id
       WHERE a.shop_id=$1 AND a.at>=$2 AND a.at<$3 AND a.action NOT LIKE 'auth.%' AND a.action <> 'sale.discount'
       GROUP BY us.full_name ORDER BY actions DESC LIMIT 6`, [shopId, from, to]), []);

    const transactions = cur.transactions;
    const netSales = cur.netSales;
    const avgTransaction = transactions ? Math.round(netSales / transactions) : 0;
    const shape = (p: DashboardProduct) => ({ id: p.id, name: p.name, qty: Number(p.qty), netSales: Number(p.net_sales) });
    const ordered = productTotals as DashboardProduct[];
    const topProducts = ordered.slice(0, 5).map(shape);
    // Worst = weakest sellers; a product already shown under "top" must not appear in both lists.
    const topIds = new Set(topProducts.map(p => p.id));
    const worstProducts = [...ordered].reverse().filter(p => !topIds.has(p.id)).slice(0, 5).map(shape);
    const comparison = compare(cur, prev);

    return {
      role: u.role,
      // Empty when every panel was computed. A non-empty list means those panels fell back to
      // zero/empty and the figures they would have shown are NOT known — the UI must say so.
      degraded: this.degradation(req),
      range: { from, to },
      previousRange: { from: prevFrom, to: from },
      permissions: { financials: canSeeFinancials },
      financials: canSeeFinancials ? {
        grossSales: cur.grossSales, discounts: cur.discounts, salesReturns: cur.salesReturns,
        netSales: cur.netSales, cogs: cur.cogs, grossProfit: cur.grossProfit, grossMarginBps: cur.grossMarginBps,
        operatingExpenses: cur.operatingExpenses, operatingProfit: cur.operatingProfit,
        inventoryPurchases: cur.inventoryPurchases, stockLosses: cur.stockLosses,
        stockLossValue: cur.stockLossValue,
        operatingResultAfterStockLosses: cur.operatingResultAfterStockLosses,
        outstandingExpenses: cur.outstandingExpenses, expensesPaid: cur.expensesPaid,
        costBasisIncomplete: cur.costBasisIncomplete,
        snapshots, monthly, topProductsByProfit, lowMarginProducts,
      } : null,
      financialComparison: canSeeFinancials ? comparison : null,
      operations: {
        netSales, transactions, unitsSold: cur.unitsSold, averageTransaction: avgTransaction,
        cashCollected: cur.cashCollected, receivables: cur.receivables,
        grossSales: cur.grossSales, discounts: cur.discounts,
        deliveries: cur.purchasesReceived.deliveries, productsReceived: cur.purchasesReceived.products,
        unitsReceived: cur.purchasesReceived.units, purchasesReceivedValue: cur.purchasesReceived.value,
        pendingReceipts: Number(openPurchases.c), inventoryValue: canSeeFinancials ? inventory.totalValue : null,
        supplierPayables: Number(payables.p), productCount: inventory.items.length,
        lowStockCount: inventory.lowStockCount, outOfStockCount: inventory.items.filter(i => i.onHand <= 0).length,
        pendingApprovals: Number(issues.pending_approvals), openInvestigations: Number(issues.open_investigations),
        openConflicts: Number(issues.open_conflicts ?? 0),
      },
      salesComparison: { netSales: comparison.netSales },
      trend: trend.map((t: any) => ({
        date: t.date, netSales: Number(t.net_sales), transactions: Number(t.transactions),
        grossProfit: canSeeFinancials ? Number(t.net_sales) - (cogsByBucket.get(t.date) ?? 0) : null,
        operatingExpenses: canSeeFinancials ? (expByDate.get(t.date) ?? 0) : null,
      })),
      topProducts,
      worstProducts,
      activity: activity.map((a: any) => ({
        id: a.id, at: a.at, action: a.action, entity: a.entity, entityId: a.entity_id, reason: a.reason, actor: a.actor,
        productName: a.product_name ?? a.sale_products ?? a.supplier_name ?? null,
        saleTotal: a.sale_total === null ? null : Number(a.sale_total),
        purchaseTotal: a.purchase_total === null ? null : Number(a.purchase_total),
        purchaseReference: a.purchase_reference ?? null,
      })),
      staffActivity: staff,
      expensesByCategory: (expenseBreakdown as any[]).map((e) => ({ category: e.category, amount: Number(e.amount), unpaid: Number(e.unpaid) })),
      lowStock: inventory.items.filter(i => i.low).sort((a, b) => a.onHand - b.onHand).slice(0, 6).map(i => ({ id: i.id, name: i.name, onHand: i.onHand, unit: i.unit, threshold: i.low_stock_threshold })),
    };
  }

  /**
   * Products sold in a period: units and sales value per product, from posted sale lines only.
   * Managers get this too (it is sales data, not cost or profit). Scoped to the caller's shop.
   */
  @Get("items") @Roles("owner", "manager")
  async items(@Me() u: AuthUser, @Query() q: unknown) {
    const { from, to } = parse(q);
    const rows = await this.db.query(
      `SELECT p.id, p.name, p.code, p.unit,
              COALESCE(SUM(sl.qty),0)::bigint AS units,
              COALESCE(SUM(sl.line_amount),0)::bigint AS gross,
              COUNT(DISTINCT s.id)::int AS sales
       FROM sale_lines sl JOIN sales s ON s.id = sl.sale_id JOIN products p ON p.id = sl.product_id
       WHERE s.shop_id=$1 AND s.status='posted' AND s.sold_at>=$2 AND s.sold_at<$3
       GROUP BY p.id, p.name, p.code, p.unit ORDER BY gross DESC, p.name`, [u.shopId, from, to]);
    const [totals] = await this.db.query(
      `SELECT COALESCE(SUM(gross_amount - discount),0)::bigint AS net, COALESCE(SUM(discount),0)::bigint AS discounts
       FROM sales WHERE shop_id=$1 AND status='posted' AND sold_at>=$2 AND sold_at<$3`, [u.shopId, from, to]);
    const items = rows.map((r: any) => ({
      productId: r.id, name: r.name, code: r.code, unit: r.unit,
      units: Number(r.units), gross: Number(r.gross), sales: Number(r.sales),
      avgUnitPrice: Number(r.units) > 0 ? Math.round(Number(r.gross) / (Number(r.units) / 1000)) : 0,
    }));
    return {
      range: { from, to }, items,
      totals: {
        units: items.reduce((s, i) => s + i.units, 0),
        gross: items.reduce((s, i) => s + i.gross, 0),
        products: items.length, sales: items.reduce((s, i) => s + i.sales, 0),
        net: Number(totals.net), discounts: Number(totals.discounts),
      },
    };
  }

  /** One sale with its line items, including each line's share of the sale discount. Same data for owner and manager, shop-scoped. */
  @Get("sales/:id") @Roles("owner", "manager")
  async sale(@Me() u: AuthUser, @Param("id") id: string) {
    if (!z.string().uuid().safeParse(id).success) throw new NotFoundException("sale_not_found");
    const [sale] = await this.db.query(
      `SELECT s.id, to_char(s.sold_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at,
              s.gross_amount, s.discount, s.amount_paid, s.payment_method, s.status,
              to_char(s.reversed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS reversed_at,
              s.reversal_reason, us.full_name AS cashier
       FROM sales s JOIN users us ON us.id=s.user_id
       WHERE s.id=$1 AND s.shop_id=$2`, [id, u.shopId]);
    if (!sale) throw new NotFoundException("sale_not_found");
    const lines = await this.db.query(
      `SELECT sl.product_id, p.name, p.code, p.unit, sl.qty, sl.unit_price, sl.line_amount
       FROM sale_lines sl JOIN products p ON p.id=sl.product_id
       WHERE sl.sale_id=$1 ORDER BY sl.id`, [id]);
    // Exact integer split of the sale-level discount across lines, so line nets always sum to the sale net.
    const shares = allocateLineDiscounts(lines.map((l: any) => Number(l.line_amount)), Number(sale.discount));
    return {
      sale: {
        id: sale.id, at: sale.at, cashier: sale.cashier, paymentMethod: sale.payment_method, status: sale.status,
        grossAmount: Number(sale.gross_amount), discount: Number(sale.discount), amountPaid: Number(sale.amount_paid),
        net: Number(sale.gross_amount) - Number(sale.discount),
        balance: Number(sale.gross_amount) - Number(sale.discount) - Number(sale.amount_paid),
        reversedAt: sale.reversed_at ?? null, reversalReason: sale.reversal_reason ?? null,
      },
      lines: lines.map((l: any, i: number) => ({
        productId: l.product_id, name: l.name, code: l.code, unit: l.unit,
        qty: Number(l.qty), unitPrice: Number(l.unit_price), lineAmount: Number(l.line_amount),
        discount: shares[i] ?? 0, net: Number(l.line_amount) - (shares[i] ?? 0),
      })),
    };
  }

  /** Drill-down: every transaction behind a total (paginated by LIMIT for large datasets). */
  @Get("transactions") @Roles("owner", "manager") async tx(@Me() u: AuthUser, @Query() q: any) {
    const { from, to } = parse(q); const p = [u.shopId, from, to];
    const kind = q.kind;
    if (kind === "sales") return this.db.query(`SELECT s.id, s.sold_at AT TIME ZONE 'UTC' AS at, s.gross_amount, s.discount, s.amount_paid, s.payment_method, s.status, us.full_name AS by,
        (SELECT COALESCE(SUM(sl.qty),0)::bigint FROM sale_lines sl WHERE sl.sale_id=s.id) AS units,
        (SELECT COALESCE(string_agg(pr.name, ', ' ORDER BY pr.name), '') FROM sale_lines sl JOIN products pr ON pr.id=sl.product_id WHERE sl.sale_id=s.id) AS products
      FROM sales s JOIN users us ON us.id=s.user_id WHERE s.shop_id=$1 AND s.sold_at>=$2 AND s.sold_at<$3 ORDER BY s.sold_at DESC LIMIT 500`, p);
    if (kind === "purchases") return this.db.query(`SELECT pu.id, pu.ordered_at AT TIME ZONE 'UTC' AS at, pu.total_amount, pu.amount_paid, pu.reference, pu.notes, su.name AS supplier FROM purchases pu LEFT JOIN suppliers su ON su.id=pu.supplier_id WHERE pu.shop_id=$1 AND pu.ordered_at>=$2 AND pu.ordered_at<$3 ORDER BY pu.ordered_at DESC LIMIT 500`, p);
    if (kind === "expenses") return this.db.query(`SELECT e.id, e.incurred_at AT TIME ZONE 'UTC' AS at, e.category, e.amount, e.paid, e.note, e.user_id, us.full_name AS by
      FROM expenses e LEFT JOIN users us ON us.id=e.user_id WHERE e.shop_id=$1 AND e.incurred_at>=$2 AND e.incurred_at<$3 ORDER BY e.incurred_at DESC LIMIT 500`, p);
    if (kind === "adjustments") return this.db.query(`SELECT a.id, COALESCE(a.decided_at, o.received_at) AT TIME ZONE 'UTC' AS at, p.name AS product, a.qty, a.reason, a.note,
        a.status, a.refund_amount, m.unit_cost, rb.full_name AS requested_by, du.full_name AS decided_by, a.decision_note
      FROM adjustments a JOIN operations o ON o.op_id=a.op_id JOIN products p ON p.id=a.product_id
      LEFT JOIN users rb ON rb.id=a.requested_by LEFT JOIN users du ON du.id=a.decided_by
      LEFT JOIN stock_movements m ON m.source_type='adjustment' AND m.source_id=a.id
      WHERE a.shop_id=$1 AND COALESCE(a.decided_at, o.received_at)>=$2 AND COALESCE(a.decided_at, o.received_at)<$3
      ORDER BY 2 DESC LIMIT 500`, p);
    throw new BadRequestException("kind must be sales|purchases|expenses|adjustments");
  }

  /**
   * CSV of the same rows the report shows, with plain integer RWF amounts (no locale separators).
   * Escaping is done here so names and notes containing commas or quotes stay in one column.
   */
  @Get("export") @Roles("owner", "manager")
  async exportCsv(@Me() u: AuthUser, @Query() q: any, @Res() res: Response) {
    const { from, to } = parse(q); const p = [u.shopId, from, to];
    const cols: Record<string, { key: string; title: string }[]> = {
      sales: [
        { key: "sold_at", title: "sold_at_utc" }, { key: "id", title: "sale_id" }, { key: "cashier", title: "cashier" },
        { key: "products", title: "products" },
        { key: "payment_method", title: "payment_method" }, { key: "gross_amount", title: "gross_rwf" },
        { key: "discount", title: "discount_rwf" }, { key: "net", title: "net_rwf" }, { key: "amount_paid", title: "paid_rwf" },
        { key: "balance", title: "balance_rwf" }, { key: "status", title: "status" },
      ],
      purchases: [
        { key: "ordered_at", title: "ordered_at_utc" }, { key: "id", title: "purchase_id" }, { key: "supplier", title: "supplier" },
        { key: "reference", title: "reference" }, { key: "total_amount", title: "total_rwf" },
        { key: "amount_paid", title: "paid_rwf" }, { key: "balance", title: "balance_rwf" }, { key: "notes", title: "notes" },
      ],
      expenses: [
        { key: "incurred_at", title: "incurred_at_utc" }, { key: "id", title: "expense_id" }, { key: "category", title: "category" },
        { key: "amount", title: "amount_rwf" }, { key: "paid", title: "paid" }, { key: "note", title: "note" },
      ],
    };
    const def = cols[q.kind];
    if (!def) throw new BadRequestException("kind must be sales|purchases|expenses");
    const rows = q.kind === "sales"
      ? await this.db.query(`SELECT to_char(s.sold_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS sold_at, s.id, us.full_name AS cashier, s.payment_method,
             (SELECT COALESCE(string_agg(pr.name, ', ' ORDER BY pr.name), '') FROM sale_lines sl JOIN products pr ON pr.id=sl.product_id WHERE sl.sale_id=s.id) AS products,
             s.gross_amount, s.discount, (s.gross_amount - s.discount) AS net, s.amount_paid, (s.gross_amount - s.discount - s.amount_paid) AS balance, s.status
             FROM sales s JOIN users us ON us.id=s.user_id WHERE s.shop_id=$1 AND s.sold_at>=$2 AND s.sold_at<$3 ORDER BY s.sold_at DESC LIMIT 5000`, p)
      : q.kind === "purchases"
      ? await this.db.query(`SELECT to_char(pu.ordered_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ordered_at, pu.id, su.name AS supplier, pu.reference,
             pu.total_amount, pu.amount_paid, (pu.total_amount - pu.amount_paid) AS balance, pu.notes
             FROM purchases pu LEFT JOIN suppliers su ON su.id=pu.supplier_id WHERE pu.shop_id=$1 AND pu.ordered_at>=$2 AND pu.ordered_at<$3 ORDER BY pu.ordered_at DESC LIMIT 5000`, p)
      : await this.db.query(`SELECT to_char(incurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS incurred_at, id, category, amount, paid, note
             FROM expenses WHERE shop_id=$1 AND incurred_at>=$2 AND incurred_at<$3 ORDER BY incurred_at DESC LIMIT 5000`, p);

    const cell = (v: unknown) => {
      const s = v === null || v === undefined ? "" : String(v);
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [def.map(c => c.title).join(","), ...rows.map((r: any) => def.map(c => cell(r[c.key])).join(","))].join("\r\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="shop-${q.kind}-${from.slice(0, 10)}.csv"`);
    res.send("\uFEFF" + csv + "\r\n");
  }
}