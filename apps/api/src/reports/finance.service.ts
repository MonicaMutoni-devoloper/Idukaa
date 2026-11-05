import { BadRequestException, Injectable } from "@nestjs/common";
import { z } from "zod";
import {
  TARGET_GROSS_MARGIN_BPS, periodCosts, priceBelowCost, replayLedger, summarize, valueAt,
  type ExpenseChange, type Movement, type PeriodSummary, type ProductFinanceRow,
} from "@sms/shared";
import { Db } from "../db/db.service";

const Range = z.object({ from: z.string().datetime(), to: z.string().datetime() }).refine(r => r.from < r.to, "from must be before to");
/** Shared ?from&to validation for every report endpoint (ISO instants, from < to). */
export function parseRange(q: unknown): { from: string; to: string } {
  const r = Range.safeParse(q);
  if (!r.success) throw new BadRequestException(r.error.issues[0]?.message);
  return r.data;
}

/** Everything the reporting layer needs beyond raw SQL, in one place, so the dashboard,
 *  the summary endpoint and the profitability report can never disagree on a number. */
export interface PeriodResult extends PeriodSummary {
  /** @deprecated alias of stockLosses, kept so previously cached dashboards still render. */
  stockLossValue: number;
  transactions: number;
  unitsSold: number;
  /** Receipt movements that landed inside the period (distinct deliveries, products, units, cost value). */
  purchasesReceived: { deliveries: number; products: number; units: number; value: number };
  /** Moving-average valuation of the whole ledger just before `from` and just before `to`. */
  openingInventoryValue: number;
  closingInventoryValue: number;
  /** Derived quantities (milli-units) at the same two instants. */
  openingInventoryUnits: number;
  closingInventoryUnits: number;
  /** True when any inbound movement in history has no unit cost: historical COGS is then not fully verifiable. */
  costBasisIncomplete: boolean;
}

const LOSS_TYPES = new Set(["damage", "expiry", "adjustment", "count_correction"]);
const INBOUND_TYPES = new Set(["opening", "receipt", "transfer_in"]);

@Injectable()
export class FinanceService {
  constructor(private db: Db) {}

  /** Owner always sees profit; a manager only when the owner enabled it for the shop. Enforced here, not in the UI. */
  async canSeeFinancials(u: { role: string; shopId?: string | null }): Promise<boolean> {
    if (u.role === "owner") return true;
    const [s] = await this.db.query("SELECT manager_financial_access FROM shops WHERE id=$1", [u.shopId]);
    return !!s?.manager_financial_access;
  }

  /** Full stock ledger for a shop, grouped per product and ordered by occurrence (costing replay input). */
  async movements(shopId: string): Promise<Map<string, Movement[]>> {
    // COALESCE on the timestamp and a filter on impossible rows: the ledger is NOT NULL by schema,
    // but a report must never throw because one legacy row cannot be ordered (see valuation#byTime).
    const rows = await this.db.query("SELECT product_id, type, qty, unit_cost, to_char(COALESCE(occurred_at, recorded_at) AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS at FROM stock_movements WHERE shop_id=$1 AND COALESCE(occurred_at, recorded_at) IS NOT NULL ORDER BY COALESCE(occurred_at, recorded_at), id", [shopId]);
    const m = new Map<string, Movement[]>();
    for (const r of rows) { const l = m.get(r.product_id) ?? []; l.push({ type: r.type, qty: r.qty, unitCost: r.unit_cost ?? undefined, occurredAt: r.at }); m.set(r.product_id, l); }
    return m;
  }

  /**
   * All period totals from persisted records: sales, returns, expenses, purchases, ledger COGS,
   * stock-loss cost and opening/closing inventory. COGS/losses use the moving weighted average of
   * the FULL history (periodCosts) so a new purchase never rewrites an earlier sale's cost basis.
   * Pass `moves` when the caller already loaded the ledger to avoid reloading it per call.
   */
  async period(shopId: string, from: string, to: string, moves?: Map<string, Movement[]>): Promise<PeriodResult> {
    const q = async <T = any>(sql: string, params: unknown[] = [shopId, from, to]): Promise<T> =>
      (await this.db.query<T>(sql, params))[0] as T;
    const sales = await q<any>(`SELECT COALESCE(SUM(gross_amount),0)::bigint g, COALESCE(SUM(discount),0)::bigint d,
        COALESCE(SUM(amount_paid),0)::bigint paid, COALESCE(SUM(gross_amount-discount-amount_paid),0)::bigint recv,
        COUNT(*)::int n
      FROM sales WHERE shop_id=$1 AND status='posted' AND sold_at>=$2 AND sold_at<$3`);
    const units = await q<any>(`SELECT COALESCE(SUM(sl.qty),0)::bigint u FROM sale_lines sl JOIN sales s ON s.id=sl.sale_id
      WHERE s.shop_id=$1 AND s.status='posted' AND s.sold_at>=$2 AND s.sold_at<$3`);
    const ret = await q<any>(`SELECT COALESCE(SUM(refund_amount),0)::bigint r FROM adjustments
      WHERE shop_id=$1 AND status='approved' AND reason='sale_return' AND decided_at>=$2 AND decided_at<$3`);
    const exp = await q<any>(`SELECT COALESCE(SUM(amount),0)::bigint a, COALESCE(SUM(amount) FILTER (WHERE paid),0)::bigint p
      FROM expenses WHERE shop_id=$1 AND incurred_at>=$2 AND incurred_at<$3`);
    const pur = await q<any>(`SELECT COALESCE(SUM(total_amount),0)::bigint t FROM purchases
      WHERE shop_id=$1 AND ordered_at>=$2 AND ordered_at<$3`);
    const recv = await q<any>(`SELECT COUNT(DISTINCT source_id)::int d, COUNT(DISTINCT product_id)::int pr,
        COALESCE(SUM(qty),0)::bigint u,
        COALESCE(SUM((qty * COALESCE(unit_cost,0) + 500) / 1000),0)::bigint v
      FROM stock_movements WHERE shop_id=$1 AND type='receipt' AND occurred_at>=$2 AND occurred_at<$3`);

    const mv = moves ?? await this.movements(shopId);
    let cogs = 0, loss = 0, opening = 0, closing = 0, openingUnits = 0, closingUnits = 0, costBasisIncomplete = false;
    for (const list of mv.values()) {
      const c = periodCosts(list, from, to);
      cogs += c.cogs; loss += c.lossValue;
      const o = valueAt(list, from), e = valueAt(list, to);
      opening += o.value; openingUnits += o.onHand;
      closing += e.value; closingUnits += e.onHand;
      if (!costBasisIncomplete && list.some(m => INBOUND_TYPES.has(m.type) && m.qty > 0 && !m.unitCost)) costBasisIncomplete = true;
    }

    const base = summarize({
      grossSales: sales.g, discounts: sales.d, salesReturns: ret.r, cogs,
      operatingExpenses: exp.a, expensesPaid: exp.p, cashCollected: sales.paid,
      inventoryPurchases: pur.t, receivables: sales.recv, stockLosses: loss,
    });
    return {
      ...base, stockLossValue: loss,
      transactions: sales.n, unitsSold: units.u,
      purchasesReceived: { deliveries: recv.d, products: recv.pr, units: recv.u, value: recv.v },
      openingInventoryValue: opening, closingInventoryValue: closing,
      openingInventoryUnits: openingUnits, closingInventoryUnits: closingUnits, costBasisIncomplete,
    };
  }

  /**
   * Product-level profitability for a period: revenue net of each product's share of sale discounts,
   * COGS and stock losses from the same ledger replay as the headline report, current cost basis,
   * stock on hand/value, and clearly defined velocity windows (period, trailing 30d, stockouts/90d).
   * Includes products with no sales in the period (tied-up capital and slow movers must stay visible).
   */
  async productProfitability(shopId: string, from: string, to: string, moves?: Map<string, Movement[]>): Promise<ProductFinanceRow[]> {
    const mv = moves ?? await this.movements(shopId);
    const products = await this.db.query<any>(
      "SELECT id, name, code, unit, selling_unit, selling_price, low_stock_threshold, units_per_selling FROM products WHERE shop_id=$1 AND active ORDER BY name", [shopId]);

    // Revenue per product, net of a proportional share of the sale-level discount (numeric rounding,
    // so a product's share never exceeds its line). Groups in SQL — never loads all transactions.
    const revRows = await this.db.query<any>(
      `SELECT sl.product_id AS id, COALESCE(SUM(sl.qty),0)::bigint AS units,
              COALESCE(SUM(GREATEST(0, sl.line_amount - ROUND(s.discount::numeric * sl.line_amount / NULLIF(s.gross_amount,0)))),0)::bigint AS net
       FROM sale_lines sl JOIN sales s ON s.id = sl.sale_id
       WHERE s.shop_id=$1 AND s.status='posted' AND s.sold_at>=$2 AND s.sold_at<$3
       GROUP BY sl.product_id`, [shopId, from, to]);
    const revenue = new Map(revRows.map((r: any) => [r.id, { units: Number(r.units), net: Number(r.net) }]));

    // Trailing 30-day sales window ending at the range end — the velocity reference period.
    const v30From = new Date(Date.parse(to) - 30 * 86_400_000).toISOString();
    const v30Rows = await this.db.query<any>(
      `SELECT sl.product_id AS id, COALESCE(SUM(sl.qty),0)::bigint AS units
       FROM sale_lines sl JOIN sales s ON s.id = sl.sale_id
       WHERE s.shop_id=$1 AND s.status='posted' AND s.sold_at>=$2 AND s.sold_at<$3
       GROUP BY sl.product_id`, [shopId, v30From, to]);
    const v30 = new Map(v30Rows.map((r: any) => [r.id, Number(r.units)]));

    const periodDays = Math.max(1, (Date.parse(to) - Date.parse(from)) / 86_400_000);
    const from90 = new Date(Date.parse(to) - 90 * 86_400_000).toISOString();
    const items: ProductFinanceRow[] = [];

    for (const p of products) {
      const list = [...(mv.get(p.id) ?? [])].sort((a, b) => String(a.occurredAt ?? "").localeCompare(String(b.occurredAt ?? "")));
      const r = replayLedger(list);
      const pc = periodCosts(list, from, to);
      let lossCount = 0, stockouts = 0, balance = 0;
      for (const m of list) {
        if (m.occurredAt >= to) break;
        if (m.occurredAt >= from && m.qty < 0 && LOSS_TYPES.has(m.type)) lossCount++;
        const before = balance; balance += m.qty;
        if (m.occurredAt >= from90 && before > 0 && balance <= 0) stockouts++;
      }
      const rev = revenue.get(p.id) ?? { units: 0, net: 0 };
      const grossProfit = rev.net - pc.cogs;
      const marginBps = rev.net > 0 ? Math.round((grossProfit * 10_000) / rev.net) : null;
      const velocity30 = (v30.get(p.id) ?? 0) / 30;
      const onHand = r.onHand;
      items.push({
        productId: p.id, name: p.name, code: p.code, unit: p.unit,
        sellingPrice: p.selling_price, sellingUnit: p.selling_unit ?? p.unit, avgCost: r.avgCost, onHand, inventoryValue: r.value,
        lowStock: onHand <= p.low_stock_threshold,
        units: rev.units, revenue: rev.net, cogs: pc.cogs, grossProfit, grossMarginBps: marginBps,
        stockLosses: pc.lossValue, stockLossCount: lossCount,
        velocityPerDay: rev.units / periodDays, velocity30PerDay: velocity30, stockouts90: stockouts,
        flags: {
          // selling_price is quoted per SELLING unit while avgCost is per BASE unit; compare on a
          // single basis (cross-multiplied, exact in integer RWF) instead of mixing the two.
          belowCost: r.avgCost > 0 && priceBelowCost(p.selling_price, Number(p.units_per_selling ?? 1), r.avgCost) && onHand > 0,
          negativeMargin: marginBps !== null && marginBps < 0,
          lowMargin: marginBps !== null && marginBps >= 0 && marginBps < TARGET_GROSS_MARGIN_BPS,
          highVolumeLowMargin: false, // recomputed below against the median volume of sold products
          slowMoving: onHand > 0 && (velocity30 <= 0 || onHand / velocity30 > 90),
          repeatedStockLosses: lossCount >= 2,
          outOfStock: onHand <= 0,
          frequentStockouts: stockouts >= 2,
        },
      });
    }

    // "High volume" = at or above the median units among products that actually sold in the period.
    const soldUnits = items.filter(i => i.units > 0).map(i => i.units).sort((a, b) => a - b);
    const median = soldUnits.length ? soldUnits[Math.floor((soldUnits.length - 1) / 2)]! : 0;
    for (const i of items) i.flags.highVolumeLowMargin = i.flags.lowMargin && i.units > 0 && i.units >= median;

    return items.sort((a, b) => b.revenue - a.revenue || a.name.localeCompare(b.name));
  }

  /** Per-category expense totals for two adjacent periods, as changes for evidence-based recommendations. */
  async expenseChanges(shopId: string, curFrom: string, curTo: string, prevFrom: string, prevTo: string): Promise<ExpenseChange[]> {
    const rows = await this.db.query<any>(
      `SELECT category, CASE WHEN incurred_at>=$2 AND incurred_at<$3 THEN 1 ELSE 0 END AS cur,
              COALESCE(SUM(amount),0)::bigint AS amount
       FROM expenses
       WHERE shop_id=$1 AND ((incurred_at>=$2 AND incurred_at<$3) OR (incurred_at>=$4 AND incurred_at<$5))
       GROUP BY 1, 2`, [shopId, curFrom, curTo, prevFrom, prevTo]);
    const map = new Map<string, { cur: number; prev: number }>();
    for (const r of rows) {
      const e = map.get(r.category) ?? { cur: 0, prev: 0 };
      if (r.cur) e.cur += Number(r.amount); else e.prev += Number(r.amount);
      map.set(r.category, e);
    }
    return [...map].map(([category, e]) => ({
      category, amount: e.cur, previous: e.prev,
      pct: e.prev > 0 ? Math.round(((e.cur - e.prev) * 10_000) / e.prev) / 100 : 0,
    })).sort((a, b) => b.pct - a.pct);
  }
}