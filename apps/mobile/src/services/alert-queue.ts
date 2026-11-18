import { canTransition, mayPerform, type AlertAction, type ResolutionCategory } from "@sms/shared";
import type { Alert, AlertDetail, AlertEvent, AlertStatusGroup } from "./business";
import type { OutboxStatus, OutboxRow } from "../database";

/**
 * A decision queued in the outbox, in the shape the UI overlays on the server's (or cached) alert.
 * Only operations that have not been judged by the server are applied: once one is `synced` the
 * server's row already shows it, and once it is `conflict`/`rejected` it must not keep claiming a
 * status the shop did not actually adopt.
 */
export interface PendingAlertOp {
  opId: string;
  at: string;
  status: OutboxStatus;
  message: string | null;
  payload: {
    alertId: string;
    action: AlertAction;
    note: string;
    category?: ResolutionCategory | null;
    correctiveAction?: string | null;
    assignedTo?: string | null;
    escalateTo?: string | null;
  };
}

export type PendingAlert = Alert & { pending: boolean; pendingCount: number; conflicted: boolean };

const GROUP: Record<string, AlertStatusGroup> = {
  open: "open", investigating: "investigating", action_required: "action_required",
  escalated: "escalated", resolved: "resolved", legitimate: "resolved",
};

/** Mirrors the server's displayStatus(): older rows store `legitimate` for a resolved alert. */
export const alertGroup = (status: string): AlertStatusGroup => GROUP[status] ?? "open";

const PENDING: OutboxStatus[] = ["pending", "retry", "pending_approval"];
const REFUSED: OutboxStatus[] = ["conflict", "rejected"];

/** Parse outbox rows into typed pending decisions. A malformed legacy row is ignored, never thrown. */
export function parseAlertOps(rows: Pick<OutboxRow, "op_id" | "created_at" | "status" | "message" | "payload">[]): PendingAlertOp[] {
  const out: PendingAlertOp[] = [];
  for (const r of rows) {
    try {
      const p = JSON.parse(r.payload);
      if (!p || typeof p.alertId !== "string" || typeof p.action !== "string" || typeof p.note !== "string") continue;
      out.push({ opId: r.op_id, at: r.created_at, status: r.status as OutboxStatus, message: r.message ?? null, payload: p });
    } catch { /* ignore an unreadable row: the outbox itself still reports it */ }
  }
  return out;
}

/** Queued decisions per alert, oldest first, for the overlay. */
export function groupAlertOps(ops: PendingAlertOp[]): Map<string, PendingAlertOp[]> {
  const m = new Map<string, PendingAlertOp[]>();
  for (const op of ops) {
    const list = m.get(op.payload.alertId);
    if (list) list.push(op); else m.set(op.payload.alertId, [op]);
  }
  return m;
}

/**
 * Apply this device's queued decisions on top of an alert. The result is what the reviewer will see
 * once the queue reaches the server, so the screen never shows an action as saved while the list
 * still reads "open". Nothing here touches the alert on the server, and a refused operation is not
 * applied at all.
 */
export function applyAlertOps<T extends Alert>(
  alert: T,
  ops: PendingAlertOp[],
  names: Record<string, string> = {},
): T & { pending: boolean; pendingCount: number; conflicted: boolean } {
  let status = alert.status;
  let assignedTo = alert.assignedTo;
  let assignedToName = alert.assignedToName;
  let assignedAt = alert.assignedAt;
  let notes = alert.notes ?? "";
  let escalatedTo = alert.escalatedTo;
  let escalatedToName = alert.escalatedToName;
  let escalatedAt = alert.escalatedAt;
  let category = alert.resolutionCategory;
  let resolutionNote = alert.resolutionNote;
  let correctiveAction = alert.correctiveAction;
  let resolvedAt = alert.resolvedAt;
  let applied = 0;
  let conflicted = false;

  for (const op of ops) {
    if (REFUSED.includes(op.status)) { conflicted = true; continue; }
    if (!PENDING.includes(op.status)) continue;
    const p = op.payload;
    applied++;
    switch (p.action) {
      case "investigate":
        if (alertGroup(status) === "open") status = "investigating";
        break;
      case "assign":
        if (p.assignedTo) { assignedTo = p.assignedTo; assignedToName = names[p.assignedTo] ?? assignedToName; assignedAt = op.at; }
        if (alertGroup(status) === "open") status = "investigating";
        break;
      case "note":
        notes = notes ? `${notes}\n${p.note}` : p.note;
        break;
      case "escalate":
        status = "escalated";
        if (p.escalateTo) { escalatedTo = p.escalateTo; escalatedToName = names[p.escalateTo] ?? escalatedToName; }
        escalatedAt = op.at;
        break;
      case "resolve":
        category = p.category ?? category;
        resolutionNote = p.note;
        correctiveAction = p.correctiveAction ?? null;
        if (p.category === "suspicious_activity") {
          // Suspicion is not a closure: it is handed to the owner, exactly as the server does.
          status = "escalated"; escalatedAt = op.at;
        } else {
          status = "resolved"; resolvedAt = op.at;
        }
        break;
      case "reopen":
        status = "open";
        category = null; resolutionNote = null; correctiveAction = null;
        resolvedAt = null; escalatedAt = null; escalatedTo = null; escalatedToName = null;
        break;
    }
  }

  return {
    ...alert, status, statusGroup: alertGroup(status), assignedTo, assignedToName, assignedAt,
    notes, escalatedTo, escalatedToName, escalatedAt, resolutionCategory: category,
    resolutionNote, correctiveAction, resolvedAt, pending: applied > 0, pendingCount: applied, conflicted,
  };
}

/** The actions this reviewer could take on the overlaid alert, minus what the workflow forbids. */
export function availableAlertActions(role: "owner" | "manager", group: AlertStatusGroup) {
  const actions: Record<AlertAction, boolean> = {
    investigate: false, assign: false, note: true, escalate: false, resolve: false, reopen: false,
  };
  for (const a of Object.keys(actions) as AlertAction[]) {
    if (!mayPerform(role, a)) continue;
    if (a === "note") continue;
    if (a === "investigate") actions[a] = group === "open" || group === "action_required";
    else if (a === "assign") actions[a] = group !== "resolved";
    else if (a === "escalate") actions[a] = canTransition(group, "escalated");
    else if (a === "resolve") actions[a] = canTransition(group, "resolved");
    else if (a === "reopen") actions[a] = group === "resolved";
  }
  return actions;
}

/** Queued decisions still waiting to be sent, as timeline entries the reviewer can see. */
export function pendingEvents(detail: AlertDetail, ops: PendingAlertOp[], actor: string | null): AlertEvent[] {
  return ops.filter((o) => PENDING.includes(o.status)).map((o, i) => ({
    id: -1 - i, action: o.payload.action === "resolve" && o.payload.category === "suspicious_activity" ? "escalated" : o.payload.action,
    note: o.payload.note, at: o.at, actor,
    previous_status: null, new_status: null, details: { queued: true },
  }));
}

/** True when the alert as overlaid still belongs in the requested status filter. */
export function matchesStatusFilter(alert: { statusGroup: AlertStatusGroup }, filter?: string): boolean {
  return !filter || filter === alert.statusGroup;
}
