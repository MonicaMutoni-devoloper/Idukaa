import { lineAmount, type QtyMilli, type Rwf } from "./money.ts";

/**
 * Stock movement ledger = source of truth. Quantities are signed from the shop's view
 * (receipt +, sale -, etc.). Costing policy: MOVING WEIGHTED AVERAGE COST (documented in docs/FINANCE.md).
 */
export type MovementType =
  | "opening" | "receipt" | "sale" | "sale_return" | "supplier_return"
  | "damage" | "expiry" | "adjustment" | "count_correction" | "transfer_in" | "transfer_out";

export interface Movement {
  type: MovementType;
  qty: QtyMilli;          // signed
  unitCost?: Rwf;         // required for inbound (opening, receipt, transfer_in); ignored otherwise
  occurredAt: string;     // ISO
}

export interface ValuationResult {
  onHand: QtyMilli;
  value: Rwf;             // inventory value at moving average
  avgCost: Rwf;
  cogs: Rwf;              // cost of everything that left via sale (net of sale returns)
  lossValue: Rwf;         // damage, expiry, supplier-excluded negative adjustments
  perMovementCost: Rwf[]; // cost attributed to each movement (outbound: cost relieved)
}

function mulDiv(a: number, b: number, d: number): number {
  const num = BigInt(a) * BigInt(b); const den = BigInt(d);
  return Number((num + den / 2n) / den);
}
const INBOUND_COSTED: MovementType[] = ["opening", "receipt", "transfer_in"];

export function replayLedger(movements: Movement[]): ValuationResult {
  const sorted = [...movements].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  let onHand = 0, value = 0, cogs = 0, lossValue = 0;
  const per: Rwf[] = [];
  for (const m of sorted) {
    const share = (q: number) => (onHand > 0 ? mulDiv(value, q, onHand) : 0); // value * q / onHand, no intermediate rounding
    if (INBOUND_COSTED.includes(m.type) && m.qty > 0) {
      if (m.unitCost === undefined) throw new Error(`${m.type} requires unitCost`);
      const add = lineAmount(m.qty, m.unitCost);
      onHand += m.qty; value += add; per.push(add);
      continue;
    }
    if (m.qty > 0) { // sale_return, positive adjustments: restored at current average cost
      const add = share(m.qty); onHand += m.qty; value += add; per.push(add);
      if (m.type === "sale_return") cogs -= add;
      continue;
    }
    const outQty = -m.qty;
    const relieved = outQty >= onHand ? value : share(outQty);
    onHand -= outQty; value -= relieved; per.push(relieved);
    if (m.type === "sale") cogs += relieved;
    else if (m.type !== "supplier_return" && m.type !== "transfer_out") lossValue += relieved;
  }
  const avgCost = onHand > 0 ? Math.round((value * 1000) / onHand) : 0;
  return { onHand, value, avgCost, cogs, lossValue, perMovementCost: per };
}

/** expected = opening + receipts - sales ... (sum of signed movements). */
export function expectedStock(movements: Movement[]): QtyMilli {
  return movements.reduce((s, m) => s + m.qty, 0);
}

/**
 * Inventory quantity and value at an instant, replaying only movements that occurred before it.
 * Used for opening/closing inventory valuation in period reports. Same moving-average policy.
 */
export function valueAt(movements: Movement[], at: string): { onHand: QtyMilli; value: Rwf } {
  const before = movements.filter((m) => m.occurredAt < at);
  const r = replayLedger(before);
  return { onHand: r.onHand, value: r.value };
}

export interface Discrepancy { expected: QtyMilli; counted: QtyMilli; difference: QtyMilli; requiresInvestigation: boolean }
export function compareCount(expected: QtyMilli, counted: QtyMilli): Discrepancy {
  const difference = counted - expected;
  return { expected, counted, difference, requiresInvestigation: difference !== 0 };
}

/** COGS and loss value attributable to movements inside [from, to) for ONE product, using the full-history moving average. */
export function periodCosts(movements: Movement[], from: string, to: string): { cogs: Rwf; lossValue: Rwf } {
  const sorted = [...movements].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  const r = replayLedger(sorted);
  let cogs = 0, lossValue = 0;
  sorted.forEach((m, i) => {
    if (m.occurredAt < from || m.occurredAt >= to) return;
    const cost = r.perMovementCost[i] ?? 0;
    if (m.type === "sale") cogs += cost;
    else if (m.type === "sale_return") cogs -= cost;
    else if (m.qty < 0 && m.type !== "supplier_return" && m.type !== "transfer_out") lossValue += cost;
  });
  return { cogs, lossValue };
}
