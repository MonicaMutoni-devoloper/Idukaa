import { normalizeRwandaPhone } from "@sms/shared";

/**
 * The credit-sale rules that must hold identically online and offline.
 *
 * Kept pure and separate from the Sell screen so the awkward cases (a phone typed four different
 * ways, a second account for the same person, a debt pushed past the limit) are testable without a
 * rendered form. The API re-checks every one of them when the operation finally syncs.
 */

export type NewCustomerCheck =
  | { ok: true; phone: string; name: string }
  | { ok: false; reason: "name" | "phone" | "duplicate"; duplicateId?: string };

/**
 * A credit customer needs a real name and a Rwandan mobile number, and the number must not already
 * belong to another account — otherwise the shop ends up chasing two balances for one person.
 */
export function validateNewCreditCustomer(
  draft: { name: string; phone: string },
  existing: { id: string; phone: string | null }[],
): NewCustomerCheck {
  const name = draft.name.trim();
  if (name.length < 2) return { ok: false, reason: "name" };
  const phone = normalizeRwandaPhone(draft.phone);
  if (!phone) return { ok: false, reason: "phone" };
  const dupe = existing.find((c) => normalizeRwandaPhone(c.phone) === phone);
  if (dupe) return { ok: false, reason: "duplicate", duplicateId: dupe.id };
  return { ok: true, phone, name };
}

/** What this sale leaves owing, and what the customer's account will owe afterwards. */
export function creditTotals(input: { total: number; paid: number; previousBalance: number }) {
  const credit = Math.max(0, Math.round(input.total) - Math.round(input.paid));
  const previousBalance = Math.max(0, Math.round(input.previousBalance));
  return { credit, previousBalance, newBalance: previousBalance + credit };
}

/**
 * How the account compares with its credit line. `none` means the owner deliberately opened no
 * credit line (a zero limit is not an unlimited one), which the API refuses outright.
 */
export function creditLimitState(input: { limit: number; newBalance: number }): "none" | "over" | "ok" {
  const limit = Math.max(0, Math.round(input.limit));
  if (limit <= 0) return "none";
  return Math.round(input.newBalance) > limit ? "over" : "ok";
}
