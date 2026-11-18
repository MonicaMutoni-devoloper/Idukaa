/**
 * How much of a product is left, said in the packages the shop actually counts in.
 *
 * A shop that sells bottles and crates does not want to hear "73 left" and divide by 12 at the
 * counter. `splitStock` turns the on-hand figure into whole packages, largest first, with the
 * remainder in the base unit — 75 bottles becomes 6 Crates + 3 Bottles.
 *
 * It only answers when the answer is exact and honest:
 *  - at least two packages on file, one of them the base unit itself (qtyBase 1) to hold the
 *    remainder;
 *  - a whole number of base units (a product sold in kilograms keeps its decimal stock and falls
 *    back to the plain figure).
 * Otherwise it returns an empty list and the caller shows the ordinary "N <unit> left" text.
 */
export interface StockPackage {
  name: string;
  qtyBase: number;
}

export interface StockPart {
  qty: number;
  unit: string;
}

export function splitStock(baseMilli: number, packages: readonly StockPackage[]): StockPart[] {
  if (!Number.isFinite(baseMilli) || baseMilli <= 0) return [];
  if (baseMilli % 1000 !== 0) return []; // fractional base stock: never round it into "whole crates"
  const usable = packages.filter((p) => Number.isInteger(p.qtyBase) && p.qtyBase > 0);
  const base = usable.find((p) => p.qtyBase === 1);
  if (!base || usable.length < 2) return [];

  const ordered = [...usable].sort((a, b) => b.qtyBase - a.qtyBase);
  let rest = baseMilli / 1000;
  const parts: StockPart[] = [];
  for (const p of ordered) {
    if (p.qtyBase === 1) continue;
    const count = Math.floor(rest / p.qtyBase);
    if (count > 0) {
      parts.push({ qty: count, unit: p.name });
      rest -= count * p.qtyBase;
    }
  }
  if (rest > 0) parts.push({ qty: rest, unit: base.name });

  // A list that is only the base unit ("7 Bottle") says nothing the plain figure does not, so the
  // caller keeps its own text. A single real package ("6 Crate") is exactly the point.
  return parts.some((p) => p.unit !== base.name) ? parts : [];
}
