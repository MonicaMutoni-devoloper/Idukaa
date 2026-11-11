/**
 * Quantity rules for the sale quick-add popup. Kept free of React Native so the stock and
 * unit-conversion math can be checked by the Node test suite, and so the popup, the inline cart
 * and the cart review modal all enforce exactly the same limit.
 *
 * Quantities here are milli selling-units (the JSON/year 3-decimal convention used across the app);
 * `stockBase` is milli BASE units (the ledger unit). `toBaseQty` multiplies by the product's
 * units-per-selling factor, which is why this file never assumes a product is sold one-for-one.
 */
import { formatQty, parseQty, toBaseQty } from "@sms/shared";

export type QuickAddFailure = "positive" | "stock";

export function unitsPerSelling(value: number | null | undefined): number {
  return Number.isInteger(value) && (value as number) > 0 ? (value as number) : 1;
}

/** Largest quantity the popup may accept, in milli selling-units. Zero means out of stock. */
export function maxSellingMilli(stockBase: number, perSelling: number): number {
  const factor = unitsPerSelling(perSelling);
  if (!Number.isFinite(stockBase) || stockBase <= 0) return 0;
  return Math.floor(stockBase / factor);
}

export function parseQtyInput(input: string): number | null {
  try {
    const qty = parseQty(input.replace(",", "."));
    return qty > 0 ? qty : null;
  } catch {
    return null;
  }
}

/**
 * Validate a typed quantity against available stock. `qty` is returned in milli selling-units and
 * `base` in milli base units, so the caller never has to repeat the conversion.
 */
export function validateQuickAddQty(
  input: string,
  stockBase: number,
  perSelling: number,
): { ok: true; qty: number; base: number } | { ok: false; reason: QuickAddFailure; max: number } {
  const factor = unitsPerSelling(perSelling);
  const max = maxSellingMilli(stockBase, factor);
  const qty = parseQtyInput(input);
  if (qty === null) return { ok: false, reason: "positive", max };
  const base = toBaseQty(qty, factor);
  if (base > stockBase) return { ok: false, reason: "stock", max };
  return { ok: true, qty, base };
}

/** One plus/minus tap moves by a whole selling unit (e.g. one kg, one bottle) and never exceeds stock. */
export function stepSellingQty(input: string, delta: number, stockBase: number, perSelling: number): string {
  const factor = unitsPerSelling(perSelling);
  const max = maxSellingMilli(stockBase, factor);
  const current = parseQtyInput(input) ?? 1000;
  const next = Math.max(1000, current + delta * 1000);
  return formatQty(max > 0 ? Math.min(next, max) : next);
}

/**
 * Merge an added quantity into a line that is already in the cart. Returns the new input string,
 * or null when the merged quantity would exceed available stock.
 */
export function mergeCartQty(
  existingInput: string,
  addMilli: number,
  stockBase: number,
  perSelling: number,
): string | null {
  const factor = unitsPerSelling(perSelling);
  const current = parseQtyInput(existingInput) ?? 0;
  const merged = current + addMilli;
  if (toBaseQty(merged, factor) > stockBase) return null;
  return formatQty(merged);
}

/** Total selling quantity across cart lines, for the compact summary. Mixed units are summed as
 * numbers only for the "items" count; the transaction total always comes from the priced lines. */
export function cartSellingQty(lines: { qty: string }[]): number {
  return lines.reduce((sum, line) => sum + (parseQtyInput(line.qty) ?? 0), 0);
}
