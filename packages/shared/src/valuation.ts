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
  /**
   * The cost per base unit this movement moved at.
   *
   * Required for costed inbound (opening, receipt, transfer_in). For a `sale` it is the moving
   * average the sale was posted at, recorded once and never recomputed; for a `sale_return` it is
   * the cost the returned goods originally left at. Left undefined on legacy rows, where the
   * replay falls back to the running average (the previous behaviour).
   */
  unitCost?: Rwf;
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

/**
 * Chronological order for a ledger replay. Missing timestamps sort first instead of throwing:
 * a single malformed row must never take a whole report down with "cannot read localeCompare".
 */
const byTime = (a: Movement, b: Movement) => String(a.occurredAt ?? "").localeCompare(String(b.occurredAt ?? ""));

export function replayLedger(movements: Movement[]): ValuationResult {
  const sorted = [...movements].sort(byTime);
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
    if (m.qty > 0) { // sale_return, positive adjustments: restored at the recorded cost, else current average
      // A return puts back exactly what left, so a cost change after the sale cannot rewrite either
      // the inventory value or the COGS the sale was reported with.
      const add = m.type === "sale_return" && m.unitCost !== undefined ? lineAmount(m.qty, m.unitCost) : share(m.qty);
      onHand += m.qty; value += add; per.push(add);
      if (m.type === "sale_return") cogs -= add;
      continue;
    }
    const outQty = -m.qty;
    // A sale records the cost it was posted at (perpetual weighted average under the sale's lock).
    // Legacy rows carry none and keep the historical running-average rule.
    const recorded = m.unitCost !== undefined ? lineAmount(outQty, m.unitCost) : null;
    const relieved = recorded !== null ? Math.min(recorded, value) : outQty >= onHand ? value : share(outQty);
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

/**
 * The moving weighted average cost per base unit an outbound movement posted now would use: the
 * running average of every movement already in the ledger up to (and including) `at`.
 *
 * Sale posting calls this INSIDE the transaction that holds the product row lock, so two concurrent
 * sales can never both read the same stale average, and the result is written to the movement and
 * the sale line. Returns use it only when no original sale cost was recorded (legacy rows).
 */
export function averageCostAt(movements: Movement[], at: string): Rwf {
  // Compare instants, not strings: a client may send an offset (…+02:00) while ledger rows are UTC.
  const cut = Date.parse(at);
  const before = Number.isNaN(cut)
    ? movements
    : movements.filter((m) => {
        const t = Date.parse(String(m.occurredAt ?? ""));
        return Number.isNaN(t) || t <= cut;
      });
  return replayLedger(before).avgCost;
}

export interface Discrepancy { expected: QtyMilli; counted: QtyMilli; difference: QtyMilli; requiresInvestigation: boolean }
export function compareCount(expected: QtyMilli, counted: QtyMilli): Discrepancy {
  const difference = counted - expected;
  return { expected, counted, difference, requiresInvestigation: difference !== 0 };
}

/** COGS and loss value attributable to movements inside [from, to) for ONE product, using the full-history moving average. */
export function periodCosts(movements: Movement[], from: string, to: string): { cogs: Rwf; lossValue: Rwf } {
  const sorted = [...movements].sort(byTime);
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
