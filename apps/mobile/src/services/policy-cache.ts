import { kvGet, kvSet } from "../database";
import { request } from "./api";
import { readPolicySnapshot, type PolicySnapshot } from "./offline-policy";

/** Versioned, shop-scoped snapshot of the rules that must still be enforced offline. */
export interface ShopPolicyPayload {
  managerFinancialAccess: boolean;
  belowCostPolicy: "acknowledge" | "block";
  maxDiscountPercent: number;
}

const key = (shopId: string | null) => `policy:v1:${shopId ?? "none"}`;

export async function readCachedPolicy(shopId: string | null): Promise<PolicySnapshot | null> {
  try {
    return readPolicySnapshot(await kvGet(key(shopId)), shopId);
  } catch {
    return null;
  }
}

export async function savePolicySnapshot(shopId: string | null, p: ShopPolicyPayload): Promise<PolicySnapshot> {
  const snapshot: PolicySnapshot = {
    version: 1,
    shopId,
    fetchedAt: new Date().toISOString(),
    maxDiscountPercent: p.maxDiscountPercent,
    belowCostPolicy: p.belowCostPolicy,
    managerFinancialAccess: p.managerFinancialAccess,
  };
  await kvSet(key(shopId), JSON.stringify(snapshot));
  return snapshot;
}

/** Fetch the live policy and replace the snapshot only after a complete server answer. */
export async function refreshPolicy(shopId: string | null): Promise<PolicySnapshot> {
  const p = await request<ShopPolicyPayload>("/shop/settings");
  return savePolicySnapshot(shopId, p);
}
