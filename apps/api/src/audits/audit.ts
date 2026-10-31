import type { Pool, PoolClient } from "pg";
export interface AuditEntry { shopId: string | null; actorId: string | null; action: string; entity: string; entityId?: string; oldValue?: unknown; newValue?: unknown; reason?: string; approvalRef?: string }
export const audit = (c: Pool | PoolClient, e: AuditEntry) =>
  c.query("INSERT INTO audit_log(shop_id,actor_id,action,entity,entity_id,old_value,new_value,reason,approval_ref) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [e.shopId, e.actorId, e.action, e.entity, e.entityId ?? null, e.oldValue ? JSON.stringify(e.oldValue) : null, e.newValue ? JSON.stringify(e.newValue) : null, e.reason ?? null, e.approvalRef ?? null]);
