/**
 * Unit-conversion arithmetic shared by the Add Product form, the receive screen, the sale screen,
 * the API contract and the Android/PWA SQLite/IndexedDB stores.
 *
 * Three unit concepts per product:
 *   purchase unit — how the shop buys  (e.g. bag), unitsPerPurchase base units per purchase unit
 *   base unit     — what the ledger stores everything in (e.g. kg) — products.unit
 *   selling unit  — how the shop sells (e.g. kg), unitsPerSelling base units per selling unit
 *
 * Every stock movement, valuation and on-hand figure is kept in BASE milli-units, so historical
 * quantities are never reinterpreted. The conversion runs identically offline on the client and
 * authoritatively on the server because both call these functions.
 *
 * All quantities are integer milli-units, all money integer RWF (see money.ts).
 */
import { assertInt, type QtyMilli, type Rwf } from "./money.ts";

function assertUnitsPer(unitsPer: number): void {
  if (!Number.isInteger(unitsPer) || unitsPer < 1) throw new Error(`unitsPer must be an integer >= 1, got ${unitsPer}`);
}

/** Natural quantity in milli purchase/selling units -> base milli-units, rounded half-up. */
export function toBaseQty(naturalMilli: QtyMilli, unitsPer: number): QtyMilli {
  assertInt(naturalMilli, "naturalMilli"); assertUnitsPer(unitsPer);
  const num = BigInt(naturalMilli) * BigInt(unitsPer);
  const neg = num < 0n; const abs = neg ? -num : num;
  const r = Number((abs + 500n) / 1000n);
  return neg ? -r : r;
}

/** Base milli-units -> natural milli units (round half-up; exact when evenly divisible). */
export function fromBaseQty(baseMilli: QtyMilli, unitsPer: number): QtyMilli {
  assertInt(baseMilli, "baseMilli"); assertUnitsPer(unitsPer);
  const num = BigInt(baseMilli) * 1000n;
  const den = BigInt(unitsPer);
  const neg = num < 0n; const abs = neg ? -num : num;
  const r = Number((abs + den / 2n) / den);
  return neg ? -r : r;
}

/**
 * Cost quoted per natural unit (RWF per bag/carton/...) -> integer RWF per BASE unit, rounded
 * half-up. The ledger stores an integer RWF unit cost, so a non-divisible conversion can differ
 * from the entered total by a fraction of a franc; callers display the ledger figure
 * (lineAmount of the base quantity) so the shown total is always the recorded total.
 */
export function costPerBaseUnit(costPerNatural: Rwf, unitsPer: number): Rwf {
  assertInt(costPerNatural, "costPerNatural"); assertUnitsPer(unitsPer);
  const num = BigInt(costPerNatural); const den = BigInt(unitsPer);
  const neg = num < 0n; const abs = neg ? -num : num;
  const r = Number((abs + den / 2n) / den);
  return neg ? -r : r;
}

/**
 * Exact below-cost test across unit bases: is a price quoted per `unitsPerPrice` base units below
 * the cost of one base unit? (price / unitsPerPrice < cost, cross-multiplied — no fractions.)
 * With a 1:1 unit setup this reduces to `price < cost`, i.e. the original behaviour.
 */
export function priceBelowCost(price: Rwf, unitsPerPrice: number, costPerBase: Rwf): boolean {
  assertInt(price, "price"); assertInt(costPerBase, "costPerBase"); assertUnitsPer(unitsPerPrice);
  return price < costPerBase * unitsPerPrice;
}

/** Profit quoted per base unit: floor(price per pricing unit) - cost per base unit, in whole RWF. */
export function profitPerBaseUnit(price: Rwf, unitsPerPrice: number, costPerBase: Rwf): Rwf {
  assertInt(price, "price"); assertInt(costPerBase, "costPerBase"); assertUnitsPer(unitsPerPrice);
  return Math.floor(price / unitsPerPrice) - costPerBase;
}