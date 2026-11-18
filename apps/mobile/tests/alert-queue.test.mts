/**
 * The offline overlay for Business Alerts.
 *
 * A decision is saved on the device first, so the screen has to show what the server will look like
 * once the queue is pushed — without pretending a refused decision was adopted, and without letting
 * a stale one overwrite a newer resolution made on another device.
 *   npm run test:alerts -w @sms/mobile
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  alertGroup, applyAlertOps, availableAlertActions, groupAlertOps, matchesStatusFilter, parseAlertOps, pendingEvents,
} from "../src/services/alert-queue.ts";

const baseAlert = {
  id: "a1", dedupeKey: "k", category: "discount", severity: "warning" as const,
  severityLevel: "high" as const, title: "Large discount", explanation: "why",
  entityType: "sale", entityId: "s1", evidence: {}, status: "open", statusGroup: "open" as const,
  notes: "", assignedTo: null, assignedToName: null, assignedAt: null,
  resolutionCategory: null, resolutionNote: null, correctiveAction: null,
  escalatedTo: null, escalatedToName: null, escalatedAt: null, approvedByName: null,
  firstSeenAt: "2026-11-18T06:00:00.000Z", lastSeenAt: "2026-11-18T06:00:00.000Z",
  resolvedAt: null, resolvedByName: null, updatedAt: "2026-11-18T06:00:00.000Z",
};

const op = (id: string, action: string, extra: Record<string, unknown> = {}, status = "pending", at = "2026-11-18T07:00:00.000Z") => ({
  opId: id, at, status: status as any, message: null as string | null,
  payload: { alertId: "a1", action: action as any, note: `note ${id}`, ...extra } as any,
});

const row = (o: any) => ({ op_id: o.opId, created_at: o.at, status: o.status, message: o.message, payload: JSON.stringify(o.payload) });

test("a queued investigation shows as investigating while it waits to sync", () => {
  const over = applyAlertOps(baseAlert, [op("1", "investigate")]);
  assert.equal(over.status, "investigating");
  assert.equal(over.statusGroup, "investigating");
  assert.equal(over.pending, true);
  assert.equal(over.pendingCount, 1);
  assert.equal(over.conflicted, false);
});

test("notes pile up in the order they were written, never replacing one another", () => {
  const over = applyAlertOps({ ...baseAlert, notes: "first look" }, [op("1", "note"), op("2", "note")]);
  assert.equal(over.notes, "first look\nnote 1\nnote 2");
  assert.equal(over.statusGroup, "open");
});

test("assigning starts the investigation and names the person from the cached staff list", () => {
  const over = applyAlertOps(baseAlert, [op("1", "assign", { assignedTo: "u2" })], { u2: "Mukamana" });
  assert.equal(over.statusGroup, "investigating");
  assert.equal(over.assignedTo, "u2");
  assert.equal(over.assignedToName, "Mukamana");
});

test("escalation is visible before the server acknowledges it", () => {
  const over = applyAlertOps(baseAlert, [op("1", "escalate", { escalateTo: "owner1" })], { owner1: "Owner" });
  assert.equal(over.statusGroup, "escalated");
  assert.equal(over.escalatedToName, "Owner");
  assert.equal(over.escalatedAt, "2026-11-18T07:00:00.000Z");
});

test("a resolution of suspicion escalates instead of closing, exactly like the server", () => {
  const suspicious = applyAlertOps(baseAlert, [op("1", "resolve", { category: "suspicious_activity" })]);
  assert.equal(suspicious.statusGroup, "escalated");
  assert.equal(suspicious.resolvedAt, null);

  const closed = applyAlertOps(baseAlert, [op("2", "resolve", { category: "human_error", correctiveAction: "retrained" })]);
  assert.equal(closed.statusGroup, "resolved");
  assert.equal(closed.resolutionCategory, "human_error");
  assert.equal(closed.correctiveAction, "retrained");
  assert.equal(closed.resolutionNote, "note 2");
  assert.equal(closed.resolvedAt, "2026-11-18T07:00:00.000Z");
});

test("reopening clears the decision so the alert is reviewable again", () => {
  const resolved = { ...baseAlert, status: "resolved", statusGroup: "resolved" as const, resolutionCategory: "other" as const, resolutionNote: "done", resolvedAt: "2026-11-18T06:30:00.000Z", escalatedTo: "u9", escalatedAt: "2026-11-18T06:31:00.000Z" };
  const over = applyAlertOps(resolved, [op("1", "reopen")]);
  assert.equal(over.status, "open");
  assert.equal(over.statusGroup, "open");
  assert.equal(over.resolutionCategory, null);
  assert.equal(over.resolvedAt, null);
  assert.equal(over.escalatedTo, null);
});

test("a refused decision is never applied — the screen must not claim it happened", () => {
  const over = applyAlertOps(baseAlert, [op("1", "resolve", { category: "other" }, "conflict")]);
  assert.equal(over.statusGroup, "open");
  assert.equal(over.pending, false);
  assert.equal(over.conflicted, true);
  assert.equal(over.resolutionCategory, null);
});

test("once the server has the decision, the overlay stops reapplying it", () => {
  const over = applyAlertOps(baseAlert, [op("1", "investigate", {}, "synced")]);
  assert.equal(over.status, "open");
  assert.equal(over.pending, false);
  assert.equal(over.conflicted, false);
});

test("outbox rows are parsed defensively and grouped by alert", () => {
  const ops = parseAlertOps([
    row(op("1", "note")), row(op("2", "investigate")),
    { op_id: "bad", created_at: "x", status: "pending", message: null, payload: "{not json" },
    { op_id: "bad2", created_at: "x", status: "pending", message: null, payload: JSON.stringify({ action: "note" }) },
  ]);
  assert.equal(ops.length, 2);
  const grouped = groupAlertOps(ops);
  assert.equal(grouped.get("a1")?.length, 2);
  assert.deepEqual(grouped.get("a1")?.map((o) => o.payload.action), ["note", "investigate"]);
});

test("queued steps appear in the history marked as not yet sent", () => {
  const detail = { ...baseAlert, resolution: {} as any, supporting: { kind: "", fields: [], related: [] }, events: [], actions: {} as any };
  const events = pendingEvents(detail as any, [op("1", "note"), op("2", "note", {}, "synced")], "Me");
  assert.equal(events.length, 1);
  assert.equal(events[0]!.note, "note 1");
  assert.equal(events[0]!.actor, "Me");
  assert.equal(events[0]!.details?.queued, true);
});

test("the status filter follows the overlaid status, not the stale server row", () => {
  const over = applyAlertOps({ ...baseAlert, status: "legacy", statusGroup: "open" as const }, [op("1", "investigate")]);
  assert.equal(matchesStatusFilter(over, "investigating"), true);
  assert.equal(matchesStatusFilter(over, "open"), false);
  assert.equal(matchesStatusFilter(over, undefined), true);
});

test("offered actions follow the workflow and the reviewer's role", () => {
  const open = availableAlertActions("manager", "open");
  assert.equal(open.resolve, true);
  assert.equal(open.reopen, false);      // owner-only
  assert.equal(open.note, true);
  assert.equal(availableAlertActions("owner", "resolved").reopen, true);
  assert.equal(availableAlertActions("manager", "escalated").resolve, true);
  assert.equal(alertGroup("legitimate"), "resolved");
});
