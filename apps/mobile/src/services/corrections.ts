import { lineAmount } from "@sms/shared";
import { enqueue, kvGet, kvSet, listOutbox, type OutboxRow } from "../database";
import { refreshCounts, syncNow } from "../synchronization/engine";
import { NetworkError, request, useSession } from "./api";
import { uuid } from "./util";
import { cacheWriteMeta, touchCacheAccess } from "./cache-meta";

export type CorrectionStatus = "pending_approval" | "rejected" | "completed" | "reconciliation_required";
export type CorrectionDisplayStatus = CorrectionStatus | "pending_sync" | "sync_error";

export interface CorrectionLine {
  productId: string;
  name?: string | null;
  code?: string | null;
  unit?: string | null;
  sellingUnit?: string | null;
  qty: number;
  qtyEntered?: number;
  sellingQty?: number;
  unitPrice: number;
  lineAmount: number;
}

export interface Correction {
  id: string;
  saleId: string;
  status: CorrectionStatus;
  requestedBy: string;
  requestedByName: string | null;
  requestedAt: string | null;
  reason: string;
  evidence: string | null;
  fulfillment: "not_handed_over" | "handed_over";
  original: {
    at: string | null; cashier: string | null; gross: number; discount: number; net: number;
    collected: number; paymentMethod: string | null; lines: CorrectionLine[];
  };
  proposed: {
    gross: number; discount: number; net: number; collected: number; lines: CorrectionLine[];
  };
  expectedRefund: number;
  expectedAdditional: number;
  amountRefunded: number;
  amountCollected: number;
  decisionNote: string | null;
  decidedAt: string | null;
  ownerId: string | null;
  ownerName: string | null;
  reversalId: string | null;
  correctedSaleId: string | null;
  stockStatus: string;
  moneyStatus: string;
  alertId: string | null;
  settlementNote: string | null;
  settledAt: string | null;
  updatedAt: string | null;
  /** Server authority for this user: only a shop owner may decide or settle. */
  canDecide?: boolean;
  actions: { approve: boolean; reject: boolean; requestInfo: boolean; settleRefund: boolean };
  /** Device-only state for a queued request that has not reached the server yet. */
  displayStatus?: CorrectionDisplayStatus;
  pendingSync?: boolean;
  syncError?: string | null;
}

export interface CorrectionEvent {
  id: number;
  action: string;
  note: string | null;
  previous_status: string | null;
  new_status: string | null;
  details: Record<string, unknown> | null;
  at: string;
  actor: string | null;
}

export interface CorrectionDetail extends Correction {
  events: CorrectionEvent[];
  correctedSale: {
    id: string; status: string; at: string | null; gross: number; discount: number; net: number;
    amountPaid: number; paymentMethod: string; reversalId: string | null;
  } | null;
}

export interface CorrectionSaleContext {
  sale: {
    id: string; at: string; cashier: string; paymentMethod: string; status: string;
    dispatchedAt: string | null; reversalReason: string | null; gross: number; discount: number;
    net: number; amountPaid: number; balance: number;
    correctsSaleId: string | null; correctionId: string | null;
  };
  lines: CorrectionLine[];
  eligibility: {
    canRequest: boolean; reason: string | null; hasReturns: boolean;
    pendingCorrectionId: string | null; closedCorrectionId: string | null;
    fulfillmentDefault: "not_handed_over" | "handed_over";
  };
}

export interface CorrectionRequestDraft {
  saleId: string;
  reason: string;
  evidence?: string;
  fulfillment: "not_handed_over" | "handed_over";
  discount: number;
  amountPaid: number;
  lines: { productId: string; qty: number; unitPrice: number; sellingQty?: number }[];
  alertId?: string | null;
}

const scope = () => {
  const u = useSession.getState().user;
  if (!u?.shopId) throw new Error("no_shop");
  return { shopId: u.shopId, userId: u.id };
};
const isOffline = (e: unknown) => e instanceof NetworkError;

const listKey = (shopId: string) => `corrections:v1:${shopId}`;
const detailKey = (shopId: string, id: string) => `correction:v1:${shopId}:${id}`;
const contextKey = (shopId: string, saleId: string) => `correction-context:v1:${shopId}:${saleId}`;

async function readCache<T>(key: string): Promise<T | null> {
  try {
    const raw = await kvGet(key);
    if (!raw) return null;
    const e = JSON.parse(raw) as { version?: number; data?: T };
    if (e?.version !== 1 || !e.data) return null;
    void touchCacheAccess(key, raw);
    return e.data;
  } catch { return null; }
}
async function writeCache<T>(key: string, data: T) {
  const savedAt = new Date().toISOString();
  await kvSet(key, JSON.stringify({ version: 1, savedAt, data, ...cacheWriteMeta(savedAt) }));
}

/** Server corrections plus this device's queued requests, in one consistent list. */
export async function loadCorrections(): Promise<{ corrections: Correction[]; source: "server" | "cache"; savedAt: string | null }> {
  const { shopId, userId } = scope();
  let server: Correction[] = [];
  let source: "server" | "cache" = "server";
  let savedAt: string | null = null;
  try {
    const r = await request<{ corrections: Correction[] }>("/corrections");
    server = r.corrections ?? [];
    await writeCache(listKey(shopId), server);
  } catch (e) {
    if (!isOffline(e)) throw e;
    server = (await readCache<Correction[]>(listKey(shopId))) ?? [];
    source = "cache";
    const raw = await kvGet(listKey(shopId)).catch(() => null);
    if (raw) {
      try { savedAt = (JSON.parse(raw) as { savedAt?: string }).savedAt ?? null; } catch { /* ignore */ }
    }
  }

  const outbox = await listOutbox(userId, shopId).catch(() => [] as OutboxRow[]);
  const queued = outbox
    .filter((r) => r.type === "correction.request" && ["pending", "retry", "pending_approval", "conflict", "rejected"].includes(r.status))
    .map((r) => queuedCorrection(r))
    .filter((x): x is Correction => x !== null);
  const known = new Set(server.map((c) => c.id));
  return { corrections: [...queued.filter((q) => !known.has(q.id)), ...server], source, savedAt };
}

function queuedCorrection(row: OutboxRow): Correction | null {
  try {
    const p = JSON.parse(row.payload) as CorrectionRequestDraft & { correctionId?: string };
    const lines = (p.lines ?? []).map((l) => ({
      productId: l.productId, qty: l.qty, sellingQty: l.sellingQty ?? l.qty,
      unitPrice: l.unitPrice, lineAmount: lineAmount(l.sellingQty ?? l.qty, l.unitPrice),
    }));
    const gross = lines.reduce((s, l) => s + l.lineAmount, 0);
    const net = Math.max(0, gross - (p.discount ?? 0));
    const corrId = p.correctionId ?? row.op_id;
    const user = useSession.getState().user;
    const failed = row.status === "conflict" || row.status === "rejected";
    return {
      id: corrId, saleId: p.saleId, status: "pending_approval",
      requestedBy: row.user_id, requestedByName: user?.name ?? null,
      requestedAt: row.created_at, reason: p.reason, evidence: p.evidence ?? null,
      fulfillment: p.fulfillment,
      original: { at: null, cashier: null, gross: 0, discount: 0, net: 0, collected: 0, paymentMethod: null, lines: [] },
      proposed: { gross, discount: p.discount ?? 0, net, collected: p.amountPaid ?? 0, lines },
      expectedRefund: Math.max(0, (p.amountPaid ?? 0) - net),
      expectedAdditional: Math.max(0, net - (p.amountPaid ?? 0)),
      amountRefunded: 0, amountCollected: 0,
      decisionNote: null, decidedAt: null, ownerId: null, ownerName: null,
      reversalId: null, correctedSaleId: null, stockStatus: "pending", moneyStatus: "pending",
      alertId: p.alertId ?? null, settlementNote: null, settledAt: null, updatedAt: null,
      actions: { approve: false, reject: false, requestInfo: false, settleRefund: false },
      displayStatus: failed ? "sync_error" : "pending_sync", pendingSync: !failed, syncError: failed ? row.message ?? row.status : null,
    };
  } catch { return null; }
}

export async function loadCorrection(id: string): Promise<{ correction: CorrectionDetail; source: "server" | "cache" }> {
  const { shopId } = scope();
  try {
    const correction = await request<CorrectionDetail>(`/corrections/${id}`);
    await writeCache(detailKey(shopId, id), correction);
    return { correction, source: "server" };
  } catch (e) {
    if (!isOffline(e)) throw e;
    const cached = await readCache<CorrectionDetail>(detailKey(shopId, id));
    if (!cached) throw e;
    return { correction: cached, source: "cache" };
  }
}

/** Original sale and eligibility; cached so a manager can start a request while offline. */
export async function loadCorrectionSale(saleId: string): Promise<{ context: CorrectionSaleContext; source: "server" | "cache" }> {
  const { shopId } = scope();
  try {
    const context = await request<CorrectionSaleContext>(`/corrections/sale/${saleId}`);
    await writeCache(contextKey(shopId, saleId), context);
    return { context, source: "server" };
  } catch (e) {
    if (!isOffline(e)) throw e;
    const cached = await readCache<CorrectionSaleContext>(contextKey(shopId, saleId));
    if (!cached) throw e;
    return { context: cached, source: "cache" };
  }
}

/**
 * Save the request durably before reporting success. It is only a request: no stock, money or
 * report effect is applied locally, and the owner cannot approve it from this device offline.
 */
export async function queueCorrectionRequest(draft: CorrectionRequestDraft): Promise<{ correctionId: string; opId: string }> {
  const { userId } = scope();
  const correctionId = uuid();
  const payload = { correctionId, ...draft };
  await enqueue(userId, correctionId, "correction.request", payload, {}, undefined, undefined, { record: false });
  await refreshCounts(true);
  void syncNow();
  return { correctionId, opId: correctionId };
}

export const approveCorrection = (id: string, note?: string) =>
  request<CorrectionDetail>(`/corrections/${id}/approve`, { method: "POST", body: { note } });
export const rejectCorrection = (id: string, note: string) =>
  request<CorrectionDetail>(`/corrections/${id}/reject`, { method: "POST", body: { note } });
export const requestCorrectionInfo = (id: string, note: string) =>
  request<CorrectionDetail>(`/corrections/${id}/request-info`, { method: "POST", body: { note } });
export const settleCorrectionRefund = (id: string, amount: number, note: string) =>
  request<CorrectionDetail>(`/corrections/${id}/settle-refund`, { method: "POST", body: { amount, note } });
