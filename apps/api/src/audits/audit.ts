import type { Pool, PoolClient } from "pg";
import { currentImpersonation } from "../auth/impersonation-context";

export interface AuditEntry { shopId: string | null; actorId: string | null; action: string; entity: string; entityId?: string; oldValue?: unknown; newValue?: unknown; reason?: string; approvalRef?: string }

/**
 * Actions that must stand out from routine trading activity when the trail is reviewed.
 * These are matched by prefix so every future credential, policy, suspension or administrative
 * access event is automatically classified.
 */
const SENSITIVE_PREFIXES = [
  "auth.", "user.password", "user.profile", "shop.policy", "shop.profile",
  "admin.", "staff.", "application.", "adjustment.", "conflict.",
];

const isSensitive = (action: string) => SENSITIVE_PREFIXES.some((p) => action.startsWith(p));

/**
 * Write one immutable audit row.
 *
 * Administrative access is resolved here, not by the caller: when the request is running inside an
 * impersonation session, the row is always attributed to the ORIGINAL administrator, stores the
 * target shop, records the impersonation session id and the target user, and sets
 * `impersonated=true`. Business services keep calling audit() with their normal actor; none of them
 * can accidentally attribute an administrator's action to the shop owner.
 */
export const audit = (c: Pool | PoolClient, e: AuditEntry) => {
  const imp = currentImpersonation();
  const actorId = imp ? imp.adminId : e.actorId;
  const shopId = imp ? (imp.targetShopId ?? e.shopId) : e.shopId;
  const onBehalfOf = imp ? imp.targetUserId : null;

  return c.query(
    `INSERT INTO audit_log(
       shop_id, actor_id, action, entity, entity_id, old_value, new_value, reason, approval_ref,
       impersonated, impersonation_session_id, on_behalf_of_user_id, sensitive
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      shopId, actorId, e.action, e.entity, e.entityId ?? null,
      e.oldValue ? JSON.stringify(e.oldValue) : null,
      e.newValue ? JSON.stringify(e.newValue) : null,
      e.reason ?? null, e.approvalRef ?? null,
      !!imp, imp?.sessionId ?? null, onBehalfOf,
      isSensitive(e.action),
    ],
  );
};
