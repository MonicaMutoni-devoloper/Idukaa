import type { Rwf } from "./money.ts";

export interface PeriodInputs {
  grossSales: Rwf; discounts: Rwf; salesReturns: Rwf;
  cogs: Rwf;                 // from valuation (net of returned cost)
  operatingExpenses: Rwf;    // expenses INCURRED in period (accrual view)
  expensesPaid: Rwf;         // cash view
  cashCollected: Rwf;
  inventoryPurchases: Rwf;   // NOT an expense; becomes COGS when sold
  receivables: Rwf;          // sales on credit not yet collected
  /** Ledger cost of approved abnormal stock losses (damage/expiry/theft/count shortages) in period. */
  stockLosses?: Rwf;
}
export interface PeriodSummary extends PeriodInputs {
  netSales: Rwf; grossProfit: Rwf; operatingProfit: Rwf;
  /**
   * Operating profit minus recognized stock-loss costs. Stock losses are reported separately from
   * COGS and operating expenses, and are NEVER also recorded as operating expenses, so this
   * subtraction cannot double-count them (docs/FINANCE.md).
   */
  operatingResultAfterStockLosses: Rwf;
  stockLosses: Rwf;
  /** Gross margin in basis points, or null when net sales are zero (margin is unavailable, not 0%). */
  grossMarginBps: number | null;
  outstandingExpenses: Rwf;
}

/** Policy: operating profit = gross profit - operating expenses incurred. Purchases are never expensed directly. */
export function summarize(p: PeriodInputs): PeriodSummary {
  const stockLosses = p.stockLosses ?? 0;
  const netSales = p.grossSales - p.discounts - p.salesReturns;
  const grossProfit = netSales - p.cogs;
  const operatingProfit = grossProfit - p.operatingExpenses;
  const operatingResultAfterStockLosses = operatingProfit - stockLosses;
  const grossMarginBps = netSales > 0 ? Math.round((grossProfit * 10000) / netSales) : null;
  return {
    ...p, stockLosses, netSales, grossProfit, operatingProfit, operatingResultAfterStockLosses,
    grossMarginBps, outstandingExpenses: p.operatingExpenses - p.expensesPaid,
  };
}

export function compare(current: PeriodSummary, previous: PeriodSummary) {
  const d = (a: number, b: number) => ({ change: a - b, pct: b !== 0 ? Math.round(((a - b) * 10000) / Math.abs(b)) / 100 : null });
  return {
    netSales: d(current.netSales, previous.netSales),
    grossProfit: d(current.grossProfit, previous.grossProfit),
    operatingProfit: d(current.operatingProfit, previous.operatingProfit),
    operatingResultAfterStockLosses: d(current.operatingResultAfterStockLosses, previous.operatingResultAfterStockLosses),
  };
}

/**
 * Splits a sale-level discount across its lines in exact integer RWF, proportional to line amounts.
 * Uses largest-remainder so the shares always sum to exactly `discount` (never off by a franc),
 * and never assigns more than the line is worth. Empty input with a discount throws.
 */
export function allocateLineDiscounts(lineAmounts: Rwf[], discount: Rwf): Rwf[] {
  const gross = lineAmounts.reduce((s, a) => s + a, 0);
  if (discount <= 0 || gross <= 0) return lineAmounts.map(() => 0);
  if (discount >= gross) return lineAmounts.map((a) => a); // discount is capped at gross upstream
  const exact = lineAmounts.map((a) => (BigInt(a) * BigInt(discount)) / BigInt(gross)); // floor
  const remainders = lineAmounts.map((a, i) => ({
    i,
    frac: Number((BigInt(a) * BigInt(discount)) % BigInt(gross)), // always < gross, exact in BigInt
  }));
  remainders.sort((x, y) => y.frac - x.frac || x.i - y.i);
  let leftover = discount - Number(exact.reduce((s, n) => s + n, 0n));
  const out = exact.map((n) => Number(n));
  for (const r of remainders) {
    if (leftover <= 0) break;
    if (out[r.i]! < lineAmounts[r.i]!) { out[r.i]! += 1; leftover -= 1; }
  }
  // Safety net: any remaining francs go to the largest line that can still absorb them.
  for (let i = 0; leftover > 0 && i < out.length; i++) {
    const j = i % out.length;
    if (out[j]! < lineAmounts[j]!) { out[j]! += 1; leftover -= 1; }
  }
  const assigned = out.reduce((s, n) => s + n, 0);
  if (assigned !== discount) throw new Error("discount allocation failed");
  return out;
}

/** Documented default pricing target: 15% gross margin (informational only — nothing is auto-changed). */
export const TARGET_GROSS_MARGIN_BPS = 1500;

export interface ProductFlags {
  belowCost: boolean;             // selling price below current inventory cost
  negativeMargin: boolean;        // period margin below zero
  lowMargin: boolean;             // period margin below the configured target
  highVolumeLowMargin: boolean;   // at/above median sales volume AND low margin
  slowMoving: boolean;            // stock on hand with little or no trailing-30-day sales
  repeatedStockLosses: boolean;   // 2+ recognized stock losses in the period
  outOfStock: boolean;
  frequentStockouts: boolean;     // 2+ stockouts in the trailing 90 days
}

/** One row of the product profitability report. Quantities are milli-units (QtyMilli), money is integer RWF. */
export interface ProductFinanceRow {
  productId: string;
  name: string;
  code: string | null;
  unit: string;
  sellingPrice: Rwf;
  avgCost: Rwf;               // current moving-average unit cost; 0 when the cost basis is unknown
  onHand: number;
  inventoryValue: Rwf;
  lowStock: boolean;
  units: number;              // sold during the reporting period
  revenue: Rwf;               // net of the product's share of sale discounts
  cogs: Rwf;
  grossProfit: Rwf;
  grossMarginBps: number | null; // null when revenue is zero (margin unavailable, not 0%)
  stockLosses: Rwf;
  stockLossCount: number;
  velocityPerDay: number;     // milli-units/day across the reporting period
  velocity30PerDay: number;   // milli-units/day across the trailing 30 days ending at range end
  stockouts90: number;
  flags: ProductFlags;
}

export type Severity = "info" | "warning" | "danger";

/** A suggestion only — never applied automatically; consequential changes require authorization. */
export interface Recommendation {
  code: string;
  severity: Severity;
  productId?: string;
  productName?: string;
  params: Record<string, string | number | null>;
}

export interface ExpenseChange { category: string; amount: Rwf; previous: Rwf; pct: number }

/**
 * Evidence-based recommendations. Every entry carries the metric behind it in `params`, and the
 * caller attaches the period. Categories: pricing below cost, low/negative margins, high-volume
 * low-margin items, repeated stock losses, slow movers, stockouts, expense spikes, and overall
 * margin vs. the configured target. Advisory only — nothing is auto-changed.
 */
export function buildRecommendations(
  items: ProductFinanceRow[],
  totals: { netSales: Rwf; grossMarginBps: number | null },
  expenseChanges: ExpenseChange[],
  targetMarginBps: number = TARGET_GROSS_MARGIN_BPS,
): Recommendation[] {
  const recs: Recommendation[] = [];
  const targetPct = targetMarginBps / 100;
  const pct = (bps: number | null) => (bps === null ? null : Math.round(bps) / 100);

  if (totals.netSales > 0 && totals.grossMarginBps !== null && totals.grossMarginBps < targetMarginBps) {
    recs.push({ code: "margin.belowTarget", severity: "warning",
      params: { marginPct: pct(totals.grossMarginBps), targetPct } });
  }

  const belowCost = items.filter((i) => i.flags.belowCost).slice(0, 5);
  for (const i of belowCost) recs.push({ code: "product.belowCost", severity: "danger", productId: i.productId, productName: i.name,
    params: { price: i.sellingPrice, cost: i.avgCost } });

  const out = items.filter((i) => i.flags.outOfStock && i.units > 0).slice(0, 3);
  for (const i of out) recs.push({ code: "product.outOfStock", severity: "danger", productId: i.productId, productName: i.name,
    params: { units: i.units, revenue: i.revenue } });

  const highVol = items.filter((i) => i.flags.highVolumeLowMargin).sort((a, b) => b.units - a.units).slice(0, 3);
  for (const i of highVol) recs.push({ code: "product.highVolumeLowMargin", severity: "warning", productId: i.productId, productName: i.name,
    params: { marginPct: pct(i.grossMarginBps), targetPct, units: i.units } });

  const lowVol = items.filter((i) => i.flags.lowMargin && !i.flags.highVolumeLowMargin)
    .sort((a, b) => b.revenue - a.revenue).slice(0, 3);
  for (const i of lowVol) recs.push({ code: "product.lowMargin", severity: "warning", productId: i.productId, productName: i.name,
    params: { marginPct: pct(i.grossMarginBps), targetPct, units: i.units, revenue: i.revenue } });

  const neg = items.filter((i) => i.flags.negativeMargin).sort((a, b) => b.cogs - a.cogs).slice(0, 3);
  for (const i of neg) recs.push({ code: "product.negativeMargin", severity: "danger", productId: i.productId, productName: i.name,
    params: { marginPct: pct(i.grossMarginBps), revenue: i.revenue, cogs: i.cogs } });

  const losses = items.filter((i) => i.flags.repeatedStockLosses)
    .sort((a, b) => b.stockLossCount - a.stockLossCount).slice(0, 3);
  for (const i of losses) recs.push({ code: "product.repeatedStockLosses", severity: "warning", productId: i.productId, productName: i.name,
    params: { count: i.stockLossCount, value: i.stockLosses } });

  const stockouts = items.filter((i) => i.flags.frequentStockouts).sort((a, b) => b.stockouts90 - a.stockouts90).slice(0, 2);
  for (const i of stockouts) recs.push({ code: "product.frequentStockouts", severity: "warning", productId: i.productId, productName: i.name,
    params: { count: i.stockouts90, windowDays: 90 } });

  const slow = items.filter((i) => i.flags.slowMoving && !i.flags.outOfStock)
    .sort((a, b) => b.inventoryValue - a.inventoryValue).slice(0, 3);
  for (const i of slow) recs.push({ code: "product.slowMoving", severity: "info", productId: i.productId, productName: i.name,
    params: { onHand: i.onHand, value: i.inventoryValue, velocity30: i.velocity30PerDay } });

  const spikes = expenseChanges.filter((e) => e.previous >= 1000 && e.pct >= 20)
    .sort((a, b) => b.pct - a.pct).slice(0, 3);
  for (const e of spikes) recs.push({ code: "expense.increase", severity: "warning",
    params: { category: e.category, pct: e.pct, amount: e.amount, previous: e.previous } });

  return recs;
}
