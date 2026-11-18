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

/** Natural quantity in milli purchase/selling units -> base milli-units (exact: milli x integer factor). */
export function toBaseQty(naturalMilli: QtyMilli, unitsPer: number): QtyMilli {
  assertInt(naturalMilli, "naturalMilli"); assertUnitsPer(unitsPer);
  const r = Number(BigInt(naturalMilli) * BigInt(unitsPer));
  if (!Number.isSafeInteger(r)) throw new Error(`toBaseQty overflows: ${naturalMilli} x ${unitsPer}`);
  return r;
}

/** Base milli-units -> natural milli units (round half-up; exact when evenly divisible). */
export function fromBaseQty(baseMilli: QtyMilli, unitsPer: number): QtyMilli {
  assertInt(baseMilli, "baseMilli"); assertUnitsPer(unitsPer);
  const num = BigInt(baseMilli);
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

/**
 * One way a product can be sold: a named package containing `qtyBase` base units at `price` per
 * package. A product with units `[{Bottle, 1, 500}, {Crate, 12, 5600}]` can be sold either way in
 * the same sale; the ledger still records base units, and the package chosen is only a pricing and
 * entry convenience.
 */
export interface SellingUnit { id: string; name: string; qtyBase: number; price: Rwf }

/**
 * The unit a cashier gets by default: the one that IS the base unit (qtyBase 1) when the product has
 * one, otherwise the first, so a product configured only as "crate of 12" still opens on the crate.
 * Returns null for a product with no package rows (legacy rows before the units table existed).
 */
export function defaultSellingUnit<T extends { qtyBase: number }>(units: readonly T[]): T | null {
  return units.find((u) => u.qtyBase === 1) ?? units[0] ?? null;
}

/** Look a chosen unit up by id; null when the id is unknown (a stale offline product, for example). */
export function sellingUnitById<T extends { id: string }>(units: readonly T[], id: string | null | undefined): T | null {
  if (!id) return null;
  return units.find((u) => u.id === id) ?? null;
}

/** True when this package is the base unit itself (sold individually, not as a package). */
export function isBaseUnit(unit: { qtyBase: number }): boolean {
  return unit.qtyBase === 1;
}

/** Profit quoted per base unit: floor(price per pricing unit) - cost per base unit, in whole RWF. */
export function profitPerBaseUnit(price: Rwf, unitsPerPrice: number, costPerBase: Rwf): Rwf {
  assertInt(price, "price"); assertInt(costPerBase, "costPerBase"); assertUnitsPer(unitsPerPrice);
  return Math.floor(price / unitsPerPrice) - costPerBase;
}