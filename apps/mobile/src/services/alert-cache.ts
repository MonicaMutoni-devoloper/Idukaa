import { alertOps, enqueue, kvGet, kvSet } from "../database";
import { NetworkError, useSession } from "./api";
import {
  actOnAlert, getAlert, getAlerts, getAlertStaff,
  type Alert, type AlertAction, type AlertDetail, type AlertFilters, type AlertStaff, type AlertSummary,
  type AlertResolutionCategory,
} from "./business";
import {
  applyAlertOps, availableAlertActions, groupAlertOps, matchesStatusFilter, parseAlertOps, pendingEvents,
  type PendingAlertOp,
} from "./alert-queue";
import { refreshCounts, syncNow } from "../synchronization/engine";
import { uuid } from "./util";
import { cacheWriteMeta, touchCacheAccess } from "./cache-meta";

/**
 * Business Alerts on a device that may not be online.
 *
 * Reads: the server's answer is cached per shop + user + filter, and served when the request fails
 * for lack of a network (never for 403/401 — those are real answers the screen must show). Every
 * cached response carries the time it was saved so the screen can say how old it is.
 *
 * Decisions: an investigation step is written to the outbox first (durable before the UI says
 * saved), then the normal sync pass pushes it. It carries the alert version the reviewer saw, so a
 * decision made elsewhere in the meantime is a conflict the server reports — the queue never
 * overwrites a newer resolution.
 *
 * The pending overlay comes from the outbox itself, so an action never has a second copy of state
 * that could disagree with what will actually be sent.
 */

export type AlertSource = "server" | "cache";

export interface AlertListResult {
  alerts: (Alert & { pending: boolean; pendingCount: number; conflicted: boolean })[];
  summary: AlertSummary;
  source: AlertSource;
  savedAt: string | null;
  /** Decisions still queued on this device. */
  pending: number;
  /** Queued decisions the server refused because the alert changed: the reviewer must look again. */
  conflicts: number;
}

export interface AlertDetailResult {
  alert: AlertDetail & { pending: boolean; pendingCount: number; conflicted: boolean };
  source: AlertSource;
  savedAt: string | null;
  pending: number;
  conflicts: number;
}

interface Snapshot<T> { version: 1; savedAt: string; data: T }
const VERSION = 1;

const scope = (shopId: string, userId: string) => `alerts:v1:${shopId}:${userId}`;
const keyFor = (shopId: string, userId: string, part: string) => `${scope(shopId, userId)}:${part}`;

/** Stable filter identity: two screens asking for the same alerts share one cache entry. */
const filterKey = (f: AlertFilters) =>
  Object.entries(f).filter(([, v]) => v != null && v !== "").sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`).join("&") || "all";

async function readSnapshot<T>(key: string): Promise<{ data: T; savedAt: string } | null> {
  try {
    const raw = await kvGet(key);
    if (!raw) return null;
    const e = JSON.parse(raw) as Snapshot<T>;
    if (!e || e.version !== VERSION || typeof e.savedAt !== "string" || Number.isNaN(Date.parse(e.savedAt))) return null;
    void touchCacheAccess(key, raw);
    return { data: e.data, savedAt: e.savedAt };
  } catch { return null; }
}

async function writeSnapshot<T>(key: string, data: T): Promise<string> {
  const savedAt = new Date().toISOString();
  await kvSet(key, JSON.stringify({ version: VERSION, savedAt, data, ...cacheWriteMeta(savedAt) }));
  return savedAt;
}

/** Names of the people an investigation can be handed to, cached so the overlay can show a name. */
async function staffNames(shopId: string, userId: string, online: boolean): Promise<Record<string, string>> {
  const key = keyFor(shopId, userId, "staff");
  const cached = await readSnapshot<AlertStaff[]>(key);
  if (!online) return Object.fromEntries((cached?.data ?? []).map((s) => [s.id, s.name]));
  try {
    const staff = await getAlertStaff();
    await writeSnapshot(key, staff);
    return Object.fromEntries(staff.map((s) => [s.id, s.name]));
  } catch {
    return Object.fromEntries((cached?.data ?? []).map((s) => [s.id, s.name]));
  }
}

const staffCache = new Map<string, Record<string, string>>();

async function names(shopId: string, userId: string, online: boolean) {
  const k = `${shopId}:${userId}`;
  const hit = staffCache.get(k);
  if (hit) return hit;
  const v = await staffNames(shopId, userId, online);
  staffCache.set(k, v);
  return v;
}

const userScope = () => {
  const u = useSession.getState().user;
  if (!u?.shopId) throw new Error("no_shop");
  return { shopId: u.shopId, userId: u.id, role: u.role as "owner" | "manager" };
};

const isOffline = (e: unknown) => e instanceof NetworkError;

/** Alerts for a filter, from the server when possible and from the last saved copy when not. */
export async function loadAlertsCached(filters: AlertFilters = {}): Promise<AlertListResult> {
  const { shopId, userId } = userScope();
  const key = keyFor(shopId, userId, `list:${filterKey(filters)}`);
  let payload: { alerts: Alert[]; summary: AlertSummary };
  let source: AlertSource = "server";
  let savedAt: string | null = null;

  try {
    payload = await getAlerts(filters);
    savedAt = await writeSnapshot(key, payload);
  } catch (e) {
    if (!isOffline(e)) throw e;
    const cached = await readSnapshot<{ alerts: Alert[]; summary: AlertSummary }>(key);
    if (!cached) throw e;
    payload = cached.data; source = "cache"; savedAt = cached.savedAt;
  }

  const ops = parseAlertOps(await alertOps(userId, shopId));
  const grouped = groupAlertOps(ops);
  const people = await names(shopId, userId, source === "server");
  const alerts = payload.alerts
    .map((a) => applyAlertOps(a, grouped.get(a.id) ?? [], people))
    .filter((a) => matchesStatusFilter(a, filters.status));
  const mine = alerts.reduce((n, a) => n + a.pendingCount, 0);

  return {
    alerts, summary: payload.summary, source, savedAt,
    pending: mine,
    conflicts: ops.filter((o) => o.status === "conflict" || o.status === "rejected").length,
  };
}

/** One alert with this device's queued decisions applied, cached for offline opening. */
export async function loadAlertCached(id: string): Promise<AlertDetailResult> {
  const { shopId, userId, role } = userScope();
  const key = keyFor(shopId, userId, `detail:${id}`);
  let payload: AlertDetail;
  let source: AlertSource = "server";
  let savedAt: string | null = null;

  try {
    payload = await getAlert(id);
    savedAt = await writeSnapshot(key, payload);
  } catch (e) {
    if (!isOffline(e)) throw e;
    const cached = await readSnapshot<AlertDetail>(key);
    if (!cached) throw e;
    payload = cached.data; source = "cache"; savedAt = cached.savedAt;
  }

  const all = parseAlertOps(await alertOps(userId, shopId));
  const mine = groupAlertOps(all).get(id) ?? [];
  const people = await names(shopId, userId, source === "server");
  const alert = applyAlertOps(payload, mine, people);
  const queued = pendingEvents(payload, mine, useSession.getState().user?.name ?? null);
  const actions = alert.pending ? availableAlertActions(role, alert.statusGroup) : payload.actions;

  return {
    alert: { ...alert, events: [...payload.events, ...queued], actions },
    source, savedAt,
    pending: alert.pendingCount,
    conflicts: all.filter((o) => o.payload.alertId === id && (o.status === "conflict" || o.status === "rejected")).length,
  };
}

export interface AlertDecision {
  action: AlertAction;
  note: string;
  assignedTo?: string | null;
  category?: AlertResolutionCategory | null;
  correctiveAction?: string | null;
  escalateTo?: string | null;
  approvedBy?: string | null;
  /** The `updatedAt` of the alert the reviewer was looking at. */
  expectedUpdatedAt?: string | null;
}

/**
 * Queue a decision on this device. It is durable (and visible as pending) before this resolves;
 * pushing it is the sync engine's job, and it may happen immediately when the device is online.
 * Returns the operation id so the screen can point at the exact queued step.
 */
export async function actOnAlertQueued(id: string, decision: AlertDecision): Promise<string> {
  const { shopId, userId } = userScope();
  const opId = uuid();
  await enqueue(userId, opId, "alert.action", {
    alertId: id,
    action: decision.action,
    note: decision.note,
    assignedTo: decision.assignedTo ?? null,
    category: decision.category ?? null,
    correctiveAction: decision.correctiveAction ?? null,
    escalateTo: decision.escalateTo ?? null,
    approvedBy: decision.approvedBy ?? null,
    expectedUpdatedAt: decision.expectedUpdatedAt ?? null,
  }, {}, undefined, undefined, { record: false });
  await refreshCounts(true);
  void syncNow();
  return opId;
}

/** Queued decisions for the screen's banners (e.g. which alert needs a second look). */
export async function queuedAlertOps(): Promise<PendingAlertOp[]> {
  const u = useSession.getState().user;
  if (!u?.shopId) return [];
  return parseAlertOps(await alertOps(u.id, u.shopId));
}
