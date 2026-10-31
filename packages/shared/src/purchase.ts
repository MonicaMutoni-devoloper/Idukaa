import { assertInt, lineAmount, type QtyMilli, type Rwf } from './money.ts';

/**
 * Purchase-line arithmetic shared by the receive screen and the API contract.
 *
 * The ledger stores one integer RWF cost per SELLABLE unit, so a line entered as
 * "28 bottles for 40,000" is stored at round-half-up(40,000 / 28) = 1,429 per bottle and
 * the recorded line cost becomes 40,012. The rounding difference is returned explicitly
 * so the UI can show it instead of hiding a different total.
 */
export function unitCostFromTotal(totalCost: Rwf, qty: QtyMilli): Rwf {
  assertInt(totalCost, 'totalCost'); assertInt(qty, 'qty');
  if (qty <= 0) throw new Error('qty must be positive');
  const num = BigInt(totalCost) * 1000n; const den = BigInt(qty);
  return Number((num + den / 2n) / den);
}

export function totalFromUnitCost(qty: QtyMilli, unitCost: Rwf): Rwf {
  return lineAmount(qty, unitCost);
}

export interface LineProjection {
  unitCost: Rwf;      // stored cost per sellable unit (integer RWF)
  recordedCost: Rwf;  // qty x unitCost, the amount that reaches the ledger
  rounding: Rwf;      // recordedCost - entered total (0 when the division is exact)
  revenue: Rwf;       // expected revenue if every sellable unit is sold at sellingPrice
  profit: Rwf;        // expected revenue - recorded cost
  marginBps: number;  // expected profit as basis points of revenue (0 when revenue is 0)
  belowCost: boolean; // selling price per unit is below the stored unit cost
}

export function projectLine(input: { qty: QtyMilli; totalCost: Rwf; sellingPrice: Rwf }): LineProjection {
  const unitCost = unitCostFromTotal(input.totalCost, input.qty);
  const recordedCost = totalFromUnitCost(input.qty, unitCost);
  const revenue = lineAmount(input.qty, input.sellingPrice);
  const profit = revenue - recordedCost;
  return {
    unitCost, recordedCost, rounding: recordedCost - input.totalCost, revenue, profit,
    marginBps: revenue > 0 ? Math.round((profit * 10000) / revenue) : 0,
    belowCost: input.sellingPrice < unitCost,
  };
}

/** A purchase line is below cost when its proposed selling price is under the cost per sellable unit. */
export function isBelowCost(unitCost: Rwf, sellingPrice: Rwf): boolean {
  return sellingPrice < unitCost;
}
