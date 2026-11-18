/**
 * Business Alert workflow over REAL HTTP and REAL PostgreSQL: no mocks.
 * Run:  TEST_DATABASE_URL=postgres://... npm run test -w @sms/api
 * Skipped automatically when TEST_DATABASE_URL is unset (this file wipes schema public).
 *
 * It covers the parts the unit tests cannot: route-level role enforcement, the transaction that
 * writes the alert row + event + audit entry together, the optimistic version check that stops one
 * device overwriting another's decision, and the same workflow reached through the offline outbox
 * (`/sync/push`, `alert.action`).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import "reflect-metadata";
import { execSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import bcrypt from "bcryptjs";

process.env.JWT_SECRET = "alerts-test-secret-".padEnd(48, "x");
process.env.JWT_EXPIRES_IN = "15m";
const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : "TEST_DATABASE_URL not set";
process.env.DATABASE_URL = url ?? "";
const PASSWORD = "alerts-pass-123";

let pool: Pool, app: any, base = "";
let shopA = "", shopB = "";
let ownerA = "", managerA = "", ownerB = "";

const call = async (method: string, path: string, body?: unknown, token?: string) => {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data: any = null;
  try { data = await res.json(); } catch { /* empty */ }
  return { status: res.status, data };
};
const msg = (d: any) => String(d?.message ?? d?.error ?? "");
const auth = async (email: string) => {
  const r = await call("POST", "/auth/login", { email, password: PASSWORD });
  assert.ok(r.status < 300, `login ${email}: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data as { token: string; user: any };
};

async function addUser(email: string, name: string, role: "owner" | "manager", shopId: string) {
  const r = await pool.query(
    "INSERT INTO users(email_verified_at, shop_id,email,full_name,password_hash,role) VALUES (now(),$1,$2,$3,$4,$5) RETURNING id",
    [shopId, email, name, await bcrypt.hash(PASSWORD, 4), role]);
  return r.rows[0].id as string;
}

/** One alert with the numbers that would have produced it, as detection stores it. */
async function addAlert(shopId: string, key: string, extra: Partial<{
  category: string; severity: string; severity_level: string; title: string; explanation: string;
  status: string; notes: string; assignedTo: string; evidence: unknown;
}> = {}) {
  const r = await pool.query(
    `INSERT INTO business_alerts(shop_id,dedupe_key,category,severity,severity_level,title,explanation,evidence,status,notes,assigned_to)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [shopId, key, extra.category ?? "discount", extra.severity ?? "warning", extra.severity_level ?? "high",
      extra.title ?? "Large discount on a sale", extra.explanation ?? "50% discount was given on a 20,000 RWF sale.",
      JSON.stringify(extra.evidence ?? {}), extra.status ?? "open", extra.notes ?? "", extra.assignedTo ?? null]);
  return r.rows[0].id as string;
}
const alertRow = async (id: string) => (await pool.query("SELECT * FROM business_alerts WHERE id=$1", [id])).rows[0];
const events = async (id: string) =>
  (await pool.query("SELECT action, note, previous_status, new_status, actor_id FROM alert_events WHERE alert_id=$1 ORDER BY id", [id])).rows;
const audits = async (id: string) =>
  (await pool.query("SELECT action, actor_id, reason FROM audit_log WHERE entity='business_alert' AND entity_id=$1 ORDER BY id", [id])).rows;

before(async () => {
  if (skip) return;
  const dbName = new URL(url!).pathname.replace(/^\//, "");
  if (!/test/i.test(dbName) && process.env.ALLOW_DESTRUCTIVE_TEST_DB !== "1") {
    throw new Error(`Refusing to wipe schema public in database "${dbName}": point TEST_DATABASE_URL at a dedicated test database`);
  }
  pool = new Pool({ connectionString: url });
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  const dir = join(process.cwd(), "migrations");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) await pool.query(readFileSync(join(dir, f), "utf8"));

  shopA = (await pool.query("INSERT INTO shops(name) VALUES ('Alerts shop A') RETURNING id")).rows[0].id;
  shopB = (await pool.query("INSERT INTO shops(name) VALUES ('Alerts shop B') RETURNING id")).rows[0].id;
  ownerA = await addUser("owner@alerts.test", "Owner A", "owner", shopA);
  managerA = await addUser("manager@alerts.test", "Manager A", "manager", shopA);
  ownerB = await addUser("owner@alerts-b.test", "Owner B", "owner", shopB);

  try { execSync("npx tsc -p tsconfig.json", { cwd: process.cwd(), stdio: "pipe" }); }
  catch (e: any) { throw new Error(`app build failed:\n${e?.stdout ?? ""}${e?.stderr ?? ""}`); }
  const { AppModule } = await import("../dist/app.module");
  const { NestFactory } = await import("@nestjs/core");
  app = await NestFactory.create(AppModule, { logger: ["error"] });
  await app.listen(0, "127.0.0.1");
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
});
after(async () => { if (skip) return; await app?.close(); await pool.end(); });

test("list and detail are shop-scoped and expose the version a decision is checked against", { skip }, async () => {
  const o = await auth("owner@alerts.test");
  const b = await auth("owner@alerts-b.test");
  const mine = await addAlert(shopA, "discount:a");
  const theirs = await addAlert(shopB, "discount:b", { title: "Another shop's alert" });

  const list = await call("GET", "/alerts", undefined, o.token);
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.data.alerts));
  assert.deepEqual(list.data.alerts.map((a: any) => a.id), [mine], "only this shop's alerts");
  assert.equal(list.data.summary.open, 1);
  assert.equal(list.data.summary.total, 1);

  const detail = await call("GET", `/alerts/${mine}`, undefined, o.token);
  assert.equal(detail.status, 200);
  assert.match(detail.data.updatedAt, /^\d{4}-\d{2}-\d{2}T/, "the version the client must send back");
  assert.deepEqual(detail.data.actions.investigate, true);
  assert.deepEqual(detail.data.actions.reopen, false);

  // Another shop cannot read or act on it, and gets no clue that it exists.
  assert.equal((await call("GET", `/alerts/${mine}`, undefined, b.token)).status, 404);
  assert.equal((await call("GET", `/alerts/${theirs}`, undefined, o.token)).status, 404);
  const foreign = await call("POST", `/alerts/${mine}/actions`, { action: "note", note: "looking" }, b.token);
  assert.equal(foreign.status, 404);
  assert.equal(Number((await alertRow(mine)).notes.length), 0);
});

test("the workflow records each step, its previous/next status and an audit entry", { skip }, async () => {
  const o = await auth("owner@alerts.test");
  const id = await addAlert(shopA, "discount:workflow");

  const investigate = await call("POST", `/alerts/${id}/actions`, { action: "investigate", note: "Checking the till roll" }, o.token);
  assert.equal(investigate.status, 201);
  assert.equal(investigate.data.status, "investigating");
  assert.equal(investigate.data.statusGroup, "investigating");

  const note = await call("POST", `/alerts/${id}/actions`, { action: "note", note: "Receipt matches the promotion" }, o.token);
  assert.equal(note.status, 201);
  assert.match(note.data.notes, /Receipt matches the promotion/, "a note is appended to the investigation notes");

  const assign = await call("POST", `/alerts/${id}/actions`, { action: "assign", note: "Assigning the manager", assignedTo: managerA }, o.token);
  assert.equal(assign.status, 201);
  assert.equal(assign.data.assignedTo, managerA);
  assert.ok(assign.data.assignedAt);
  assert.equal((await call("GET", `/alerts/${id}`, undefined, o.token)).data.assignedToName, "Manager A");

  const escalate = await call("POST", `/alerts/${id}/actions`, { action: "escalate", note: "Owner should decide", escalateTo: ownerA }, o.token);
  assert.equal(escalate.status, 201);
  assert.equal(escalate.data.status, "escalated");
  assert.equal((await call("GET", `/alerts/${id}`, undefined, o.token)).data.escalatedToName, "Owner A");

  const resolve = await call("POST", `/alerts/${id}/actions`, {
    action: "resolve", note: "Approved promotion, recorded in the book", category: "approved_activity", correctiveAction: "None needed",
  }, o.token);
  assert.equal(resolve.status, 201);
  assert.equal(resolve.data.status, "resolved");
  assert.equal(resolve.data.resolutionCategory, "approved_activity");
  assert.equal(resolve.data.correctiveAction, "None needed");
  assert.equal((await call("GET", `/alerts/${id}`, undefined, o.token)).data.resolvedByName, "Owner A");

  const reopen = await call("POST", `/alerts/${id}/actions`, { action: "reopen", note: "The promotion was never approved" }, o.token);
  assert.equal(reopen.status, 201);
  assert.equal(reopen.data.status, "open");
  assert.equal(reopen.data.resolutionCategory, null);
  assert.equal(reopen.data.resolvedAt, null);

  const ev = await events(id);
  assert.deepEqual(ev.map((e: any) => e.action),
    ["investigate", "note", "assign", "escalate", "resolve", "reopen"]);
  assert.deepEqual(ev.map((e: any) => [e.previous_status, e.new_status]), [
    ["open", "investigating"], ["investigating", "investigating"], ["investigating", "investigating"],
    ["investigating", "escalated"], ["escalated", "resolved"], ["resolved", "open"],
  ]);
  assert.equal(ev[0].actor_id, ownerA);

  // Every action is also in the append-only audit trail, with the note as the reason.
  const logged = await audits(id);
  assert.deepEqual(logged.map((a: any) => a.action),
    ["anomaly.investigate", "anomaly.note", "anomaly.assign", "anomaly.escalate", "anomaly.resolve", "anomaly.reopen"]);
  assert.equal(logged[4].reason, "Approved promotion, recorded in the book");

  // Reopening preserved the earlier decision inside the event, not by editing history.
  const previous = (await pool.query(
    "SELECT details FROM alert_events WHERE alert_id=$1 AND action='reopen'", [id])).rows[0].details;
  assert.equal(previous.previousResolution.category, "approved_activity");
});

test("managers investigate and close ordinary cases, but cannot reopen or approve an exception", { skip }, async () => {
  const m = await auth("manager@alerts.test");
  const o = await auth("owner@alerts.test");
  const id = await addAlert(shopA, "discount:roles");
  await call("POST", `/alerts/${id}/actions`, { action: "investigate", note: "Starting the review" }, m.token);

  const forbiddenCategory = await call("POST", `/alerts/${id}/actions`, {
    action: "resolve", note: "It was fine", category: "approved_activity",
  }, m.token);
  assert.equal(forbiddenCategory.status, 403);
  assert.match(msg(forbiddenCategory.data), /resolution_category_forbidden:approved_activity/);

  const resolved = await call("POST", `/alerts/${id}/actions`, {
    action: "resolve", note: "Cashier miscounted the change", category: "human_error",
  }, m.token);
  assert.equal(resolved.status, 201);
  assert.equal(resolved.data.status, "resolved");
  assert.equal((await call("GET", `/alerts/${id}`, undefined, m.token)).data.resolvedByName, "Manager A");

  const reopen = await call("POST", `/alerts/${id}/actions`, { action: "reopen", note: "Needs a second look" }, m.token);
  assert.equal(reopen.status, 403);
  assert.match(msg(reopen.data), /alert_action_forbidden:reopen/);
  assert.equal((await alertRow(id)).status, "resolved", "the refused reopen changed nothing");

  // The owner may reopen, and a plain "investigate" from a closed alert is not a legal move.
  assert.equal((await call("POST", `/alerts/${id}/actions`, { action: "reopen", note: "Reopening for audit" }, o.token)).status, 201);
  const badTransition = await call("POST", `/alerts/${id}/actions`, { action: "reopen", note: "again" }, o.token);
  assert.equal(badTransition.status, 400, "an open alert cannot be reopened");
});

test("suspicion escalates instead of closing, and a stale version is refused with 409", { skip }, async () => {
  const m = await auth("manager@alerts.test");
  const id = await addAlert(shopA, "discount:conflict");
  const before = await alertRow(id);
  const version = (await call("GET", `/alerts/${id}`, undefined, m.token)).data.updatedAt;

  const suspicious = await call("POST", `/alerts/${id}/actions`, {
    action: "resolve", note: "The cashier may have kept the difference", category: "suspicious_activity",
  }, m.token);
  assert.equal(suspicious.status, 201);
  assert.equal(suspicious.data.status, "escalated", "suspicion is handed to the owner, not closed");
  assert.equal(suspicious.data.resolutionCategory, "suspicious_activity");
  assert.equal(suspicious.data.resolvedAt, null);
  const ev = await events(id);
  assert.equal(ev.at(-1).action, "escalated");
  assert.equal((await audits(id)).at(-1).action, "anomaly.escalated");

  const eventsBefore = ev.length;
  const stale = await call("POST", `/alerts/${id}/actions`, {
    action: "investigate", note: "I did not see the escalation", expectedUpdatedAt: version,
  }, m.token);
  assert.equal(stale.status, 409);
  assert.equal(msg(stale.data), "alert_changed_on_server");
  assert.equal((await events(id)).length, eventsBefore, "a refused action writes no event");
  assert.equal((await alertRow(id)).status, "escalated");
  assert.notEqual(new Date(before.updated_at).toISOString(), new Date((await alertRow(id)).updated_at).toISOString());

  // The same action with the current version is accepted.
  const current = (await call("GET", `/alerts/${id}`, undefined, m.token)).data.updatedAt;
  const fresh = await call("POST", `/alerts/${id}/actions`, { action: "note", note: "Now I see it", expectedUpdatedAt: current }, m.token);
  assert.equal(fresh.status, 201);
});

test("a decision queued offline goes through the same workflow in the sync pipeline", { skip }, async () => {
  const m = await auth("manager@alerts.test");
  const o = await auth("owner@alerts.test");
  const id = await addAlert(shopA, "discount:outbox");
  const version = (await call("GET", `/alerts/${id}`, undefined, m.token)).data.updatedAt;

  const push = (token: string, operation: unknown) =>
    call("POST", "/sync/push", { operations: [operation] }, token);
  const queued = (payload: unknown) =>
    ({ opId: randomUUID(), deviceId: "alerts-device", createdAt: new Date().toISOString(), type: "alert.action", payload });

  const applied = await push(m.token, queued({
    alertId: id, action: "investigate", note: "Queued from the phone", expectedUpdatedAt: version,
  }));
  assert.equal(applied.status, 201, JSON.stringify(applied.data));
  assert.equal(applied.data.results[0].status, "applied");
  assert.equal((await alertRow(id)).status, "investigating");
  const appliedEvent = (await events(id)).at(-1);
  assert.equal(appliedEvent.action, "investigate");
  assert.equal(appliedEvent.note, "Queued from the phone");
  assert.equal(appliedEvent.actor_id, managerA);
  assert.equal((await audits(id)).at(-1).action, "anomaly.investigate");

  // A retried push of the same operation is a duplicate, not a second investigation step.
  const once = queued({ alertId: id, action: "note", note: "Only once" });
  assert.equal((await push(m.token, once)).data.results[0].status, "applied");
  const again = await push(m.token, once);
  assert.equal(again.data.results[0].status, "duplicate");
  assert.equal((await events(id)).filter((e: any) => e.note === "Only once").length, 1, "idempotent by opId");

  // A decision made against an out-of-date version is refused with `conflict`, and nothing is written.
  const statusBefore = (await alertRow(id)).status;
  const eventsBefore = (await events(id)).length;
  const stale = await push(m.token, queued({
    alertId: id, action: "resolve", note: "Closing on the old copy", category: "other", expectedUpdatedAt: version,
  }));
  assert.equal(stale.status, 201);
  assert.equal(stale.data.results[0].status, "conflict");
  assert.equal(stale.data.results[0].message, "alert_changed_on_server");
  assert.equal((await alertRow(id)).status, statusBefore);
  assert.equal((await events(id)).length, eventsBefore);
  assert.equal((await pool.query(
    "SELECT status FROM operations WHERE op_id=$1", [stale.data.results[0].opId])).rows[0].status, "conflict");

  // The role rules are enforced on this path too: a manager cannot reopen through the queue.
  const managerReopen = await push(m.token, queued({ alertId: id, action: "reopen", note: "Reopening quietly" }));
  assert.equal(managerReopen.data.results[0].status, "rejected");
  assert.match(managerReopen.data.results[0].message, /alert_action_forbidden:reopen/);

  // ...and an owner can, once the alert is actually closed.
  await call("POST", `/alerts/${id}/actions`, { action: "resolve", note: "Closing properly", category: "other" }, o.token);
  const ownerReopen = await push(o.token, queued({ alertId: id, action: "reopen", note: "Audit found a problem" }));
  assert.equal(ownerReopen.data.results[0].status, "applied");
  assert.equal((await alertRow(id)).status, "open");

  // An operation for another shop's alert is refused, never looked up by id alone.
  const foreign = await addAlert(shopB, "discount:foreign");
  const crossShop = await push(o.token, queued({ alertId: foreign, action: "note", note: "Wrong shop" }));
  assert.equal(crossShop.data.results[0].status, "rejected");
  assert.equal(crossShop.data.results[0].message, "alert_not_found");
});

test("detection thresholds are owner-only, validated and per shop", { skip }, async () => {
  const m = await auth("manager@alerts.test");
  const o = await auth("owner@alerts.test");

  const asManager = await call("PUT", "/alerts/settings", { discountPercentMin: 25 }, m.token);
  assert.equal(asManager.status, 403, "a manager cannot change what counts as unusual");
  const unknown = await call("PUT", "/alerts/settings", { notAThreshold: 5 }, o.token);
  assert.equal(unknown.status, 400);
  const negative = await call("PUT", "/alerts/settings", { discountPercentMin: -1 }, o.token);
  assert.equal(negative.status, 400);

  const saved = await call("PUT", "/alerts/settings", { discountPercentMin: 25, lookbackDays: 14 }, o.token);
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.thresholds.discountPercentMin, 25);
  assert.equal(saved.data.thresholds.lookbackDays, 14);

  const read = await call("GET", "/alerts/settings", undefined, m.token);
  assert.equal(read.status, 200);
  assert.equal(read.data.thresholds.discountPercentMin, 25);
  assert.equal(read.data.thresholds.marginMinPercent, read.data.defaults.marginMinPercent, "unsaved keys keep the documented default");
  assert.equal(Number((await pool.query("SELECT count(*)::int n FROM alert_settings WHERE shop_id=$1", [shopB])).rows[0].n), 0,
    "the other shop's settings are untouched");
  assert.equal(Number((await pool.query(
    "SELECT count(*)::int n FROM audit_log WHERE action='alerts.settings.update' AND shop_id=$1", [shopA])).rows[0].n), 1);
});

test("staff lists the people an investigation can be handed to, in this shop only", { skip }, async () => {
  const o = await auth("owner@alerts.test");
  const staff = await call("GET", "/alerts/staff", undefined, o.token);
  assert.equal(staff.status, 200);
  assert.deepEqual(staff.data.map((s: any) => s.id).sort(), [ownerA, managerA].sort());
  assert.ok(staff.data.every((s: any) => s.role === "owner" || s.role === "manager"));
  assert.ok(!staff.data.some((s: any) => s.id === ownerB));
});
