/**
 * Pricing and break-even tools (docs/FINANCE.md). Pure integer-RWF math, no floats in money.
 *
 * Two DIFFERENT percentages — never interchangeable:
 *   markup      = (price − cost) ÷ cost   × 100   (how much above cost)
 *   gross margin = (price − cost) ÷ price × 100   (share of the price that is gross profit)
 */
import type { Rwf } from "./money.ts";

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Markup percentage, or null when the cost basis is unknown/zero. */
export function markupPct(unitCost: Rwf, sellingPrice: Rwf): number | null {
  if (unitCost <= 0) return null;
  return round1(((sellingPrice - unitCost) / unitCost) * 100);
}

/** Gross margin percentage of the selling price, or null when the price is zero. */
export function grossMarginPct(unitCost: Rwf, sellingPrice: Rwf): number | null {
  if (sellingPrice <= 0) return null;
  return round1(((sellingPrice - unitCost) / sellingPrice) * 100);
}

/**
 * Recommended selling price for a target gross margin: price = cost ÷ (1 − margin).
 * The result is rounded UP to whole RWF so the target margin is never undercut.
 * Returns null when the target is outside [0, 100) or the cost basis is unknown.
 */
export function recommendedPrice(unitCost: Rwf, targetMarginPct: number): Rwf | null {
  if (!Number.isFinite(targetMarginPct) || targetMarginPct < 0 || targetMarginPct >= 100) return null;
  if (unitCost <= 0) return null;
  const bps = Math.round(targetMarginPct * 100);                 // target margin in basis points
  const numerator = BigInt(unitCost) * 10_000n;
  const denominator = 10_000n - BigInt(bps);
  if (denominator <= 0n) return null;
  return Number((numerator + denominator - 1n) / denominator);    // ceil
}

export interface BreakEven {
  /** Period operating expenses treated as fixed costs. */
  fixedCosts: Rwf;
  /** Costs that vary with sales, proxied by COGS for the period. */
  variableCosts: Rwf;
  /** (net sales − variable costs) ÷ net sales, in basis points. */
  contributionMarginRatioBps: number;
  /** Net sales needed to cover the fixed costs: fixed ÷ ratio (rounded up). */
  breakEvenRevenue: Rwf;
}

/**
 * Break-even net sales for a period. Returns null — never a misleading number — when there are
 * no sales, the contribution margin is zero or negative, or the inputs are nonsensical.
 */
export function breakEven(netSales: Rwf, cogs: Rwf, fixedCosts: Rwf): BreakEven | null {
  if (netSales <= 0 || fixedCosts < 0 || cogs < 0) return null;
  const contribution = netSales - cogs;
  if (contribution <= 0) return null;
  const ratio = contribution / netSales;
  return {
    fixedCosts,
    variableCosts: cogs,
    contributionMarginRatioBps: Math.round(ratio * 10_000),
    breakEvenRevenue: Math.ceil(fixedCosts / ratio),
  };
}
