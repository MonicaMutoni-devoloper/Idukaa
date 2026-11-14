/**
 * Rwandan mobile numbers, in the one shape the database can compare.
 *
 * The same person can be written as 0788123456, 0788 123 456, +250788123456 or 250788123456.
 * Storing the raw text would let a shop open four credit accounts for one customer, so every
 * customer phone is normalised to the 10-digit local form (0788123456) before it is saved, and
 * lookups compare normalised values. Nothing here guesses a country: a number that is not a
 * Rwandan mobile number is rejected rather than silently rewritten.
 */

/** Mobile prefixes in use in Rwanda (MTN 78/79, Airtel 72/73). */
const LOCAL_MOBILE = /^07[2389]\d{7}$/;

/**
 * `0788123456` for any accepted spelling of a Rwandan mobile number, or `null` when the input is
 * not one. Accepts spaces, dashes, dots, brackets and the `+250` / `250` / `00250` country forms.
 */
export function normalizeRwandaPhone(input: string | null | undefined): string | null {
  if (typeof input !== "string") return null;
  const digits = input.replace(/[^\d]/g, "");
  if (!digits) return null;
  // 250XXXXXXXXX, 00250XXXXXXXXX and 0XXXXXXXXX all describe the same national number.
  const national = digits.startsWith("00250") ? digits.slice(5)
    : digits.startsWith("250") ? digits.slice(3)
    : digits;
  if (national.length === 9 && /^7[2389]\d{7}$/.test(national)) return `0${national}`;
  return LOCAL_MOBILE.test(national) ? national : null;
}

/** True when two spellings describe the same Rwandan mobile number. */
export function samePhone(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeRwandaPhone(a);
  return na !== null && na === normalizeRwandaPhone(b);
}

/** Display form: `0788 123 456`. Unrecognised values are shown as they were stored. */
export function formatRwandaPhone(input: string | null | undefined): string {
  const n = normalizeRwandaPhone(input);
  if (!n) return typeof input === "string" ? input : "";
  return `${n.slice(0, 4)} ${n.slice(4, 7)} ${n.slice(7)}`;
}
