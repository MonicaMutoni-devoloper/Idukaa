import type { OperationT, Role } from "@sms/shared";

/**
 * WHO MAY PERFORM EACH OFFLINE OPERATION.
 *
 * The rule this table exists to enforce: **OWNER = ALL MANAGER OPERATIONS + OWNER-ONLY ONES**.
 * A manager may never be able to do something the owner cannot, so every operation a manager can
 * perform is also open to the owner. Owner-*only* controls are not operations at all — voiding a
 * sale, deciding an adjustment, inviting staff, changing shop settings and reading the audit log
 * are separate routes with `@Roles("owner")`, so widening this table can never expose them.
 *
 * The table is typed as a complete `Record` over the operation union: adding a new operation type
 * without deciding its roles is a compile error, and `tests/permissions.test.ts` proves the
 * hierarchy for every entry.
 */
export const OP_ROLES: Record<OperationT["type"], Role[]> = {
  // The owner sells, buys, receives, counts, corrects, and maintains the catalogue exactly like a
  // manager. Being the owner must never mean "cannot use my own shop".
  "sale.create": ["manager", "owner"],
  "purchase.create": ["manager", "owner"],
  "receipt.create": ["manager", "owner"],
  "count.submit": ["manager", "owner"],
  "adjustment.request": ["manager", "owner"],
  "expense.create": ["manager", "owner"],
  "expense.update": ["manager", "owner"],
  "product.upsert": ["manager", "owner"],
  "supplier.upsert": ["manager", "owner"],
};

/** Does this role have this operation? Unknown roles (e.g. `system_admin`) have none. */
export function canRunOp(role: string, type: OperationT["type"]): boolean {
  return (OP_ROLES[type] ?? []).includes(role as Role);
}
