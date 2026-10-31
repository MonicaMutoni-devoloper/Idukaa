/**
 * Decimal-safe arithmetic.
 * - Money is an INTEGER number of RWF (RWF has no minor unit in practice).
 * - Quantity is an INTEGER number of thousandths of a unit ("milli-units"),
 *   so 2.5 kg = 2500. This avoids floating point entirely.
 */
export type Rwf = number;
export type QtyMilli = number;

export function assertInt(n: number, label = "value"): void {
  if (!Number.isSafeInteger(n)) throw new Error(`${label} must be a safe integer, got ${n}`);
}

/** Parse "2.5" -> 2500. Accepts up to 3 decimals. */
export function parseQty(input: string): QtyMilli {
  const m = /^(\d+)(?:\.(\d{1,3}))?$/.exec(input.trim());
  if (!m) throw new Error(`Invalid quantity: ${input}`);
  return Number(m[1]) * 1000 + Number((m[2] ?? "").padEnd(3, "0"));
}
export function formatQty(q: QtyMilli): string {
  const neg = q < 0; const a = Math.abs(q);
  const whole = Math.floor(a / 1000); const frac = String(a % 1000).padStart(3, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}

/** line amount = round-half-up(qtyMilli * unitPrice / 1000), computed with BigInt. */
export function lineAmount(qty: QtyMilli, unitPrice: Rwf): Rwf {
  assertInt(qty, "qty"); assertInt(unitPrice, "unitPrice");
  const num = BigInt(qty) * BigInt(unitPrice);
  const neg = num < 0n; const abs = neg ? -num : num;
  const r = (abs + 500n) / 1000n;
  return Number(neg ? -r : r);
}

export function formatRwf(n: Rwf, locale = "en-RW"): string {
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(n)} RWF`;
}
