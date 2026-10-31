/**
 * Full onboarding lifecycle, over REAL HTTP against a Nest app with the real guards, roles,
 * throttles and PostgreSQL (schema wiped per run). Run:
 *   TEST_DATABASE_URL=postgres://... npm run test -w @sms/api
 * Skipped automatically when TEST_DATABASE_URL is unset.
 *
 * Covers the acceptance list of the registration/approval/invitation spec:
 *   submit -> review (request-info / reject / approve) -> activate -> create shop ->
 *   invite -> preview -> activate manager -> login as each role,
 * plus the security invariants: status and activation are token-gated (never id/email),
 * tokens are single use and stored hashed, transitions are server-validated, and every
 * route is closed to the wrong role.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import "reflect-metadata";
import { execSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Pool } from "pg";
import bcrypt from "bcryptjs";

process.env.JWT_SECRET = "onboarding-test-secret-".padEnd(48, "x");
process.env.JWT_EXPIRES_IN = "15m";

const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : "TEST_DATABASE_URL not set";
process.env.DATABASE_URL = url ?? "";

const PASSWORD = "onboarding-pass-123";
const ADMIN_EMAIL = "admin@onboarding.test";
const OWNER_EMAIL = "owner@onboarding.test";
const MGR_EMAIL = "manager1@onboarding.test";

let pool: Pool, app: any, base: string;
let app1 = ""; // the application that walks the whole path
let app2 = ""; // rejected application
let statusToken = ""; // applicant's credential from submission
let shopId = "";

/** POST/GET helpers; error bodies carry the readable message under `message` or `error`. */
const call = async (method: string, path: string, body?: unknown, token?: string) => {
  const res = await fetch(base + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data: any = null;
  try { data = await res.json(); } catch { /* empty body */ }
  return { status: res.status, data };
};
const msg = (d: any): string => String(d?.message ?? d?.error ?? "");
type Session = { token: string; refreshToken: string; user: any };
/** Each role signs in exactly once: /auth/login is throttled to 8/min per IP on purpose. */
const sessions = new Map<string, Session>();
const auth = async (email: string): Promise<Session> => {
  const hit = sessions.get(email);
  if (hit) return hit;
  const r = await call("POST", "/auth/login", { email, password: PASSWORD });
  assert.ok(r.status < 300, `login ${email} -> ${r.status} ${JSON.stringify(r.data)}`);
  const s = r.data as Session;
  sessions.set(email, s);
  return s;
};

const application = (email: string, shopName: string) => ({
  contactName: "Aline Applicant",
  email,
  phone: "+250788000111",
  shopName,
  location: "Kigali, Nyarugenge",
  category: "grocery",
  note: "Two-year trading history",
});

before(async () => {
  if (skip) return;
  pool = new Pool({ connectionString: url });
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  const dir = join(process.cwd(), "migrations");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) await pool.query(readFileSync(join(dir, f), "utf8"));

  // The system administrator exists before onboarding (platform staff, no shop).
  await pool.query(
    "INSERT INTO users(shop_id,email,full_name,password_hash,role) VALUES (NULL,$1,'Platform Admin',$2,'system_admin')",
    [ADMIN_EMAIL, await bcrypt.hash(PASSWORD, 4)],
  );

  // Guards and controllers rely on `design:paramtypes`, which only tsc emits — esbuild (tsx) never
  // does — so the app under test is compiled with the project's real tsconfig and loaded from dist.
  try {
    execSync("npx tsc -p tsconfig.json", { cwd: process.cwd(), stdio: "pipe" });
  } catch (e: any) {
    throw new Error(`app build failed:\n${e?.stdout ?? ""}${e?.stderr ?? ""}`);
  }
  const { AppModule } = await import("../dist/app.module");
  const { NestFactory } = await import("@nestjs/core");
  app = await NestFactory.create(AppModule, { logger: ["error"] });
  await app.listen(0, "127.0.0.1");
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
});

after(async () => {
  if (skip) return;
  await app?.close();
  await pool.end();
});

/* ------------------------------------------------------------------ 1. the applicant applies */

test("submission validates input, blocks duplicates and issues a status token", { skip }, async () => {
  // The application itself is public but throttled: an applicant has no account yet.
  assert.equal((await call("POST", "/applications", { ...application(OWNER_EMAIL, "Ubumwe Mart"), contactName: "x" })).status, 400,
    "server-side validation, not only in the UI");

  const created = await call("POST", "/applications", application(OWNER_EMAIL, "Ubumwe Mart"));
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.status, "PENDING_REVIEW");
  assert.ok(created.data.statusToken.length >= 20, "a status credential is issued at submission");
  app1 = created.data.id;
  statusToken = created.data.statusToken;

  // Duplicates: same email twice, and an address that already has an account.
  assert.equal((await call("POST", "/applications", application(OWNER_EMAIL, "Ubumwe Mart"))).status, 409);
  assert.equal((await call("POST", "/applications", application(ADMIN_EMAIL, "Admin Shop"))).status, 409);

  // Status is protected by the token — never by id, email or guesswork.
  assert.equal((await call("POST", "/applications/status", { statusToken: "not-a-real-status-token-value" })).status, 400);
  const st = await call("POST", "/applications/status", { statusToken });
  assert.equal(st.status, 201, "Nest answers POST with 201");
  assert.equal(st.data.status, "PENDING_REVIEW");
  assert.equal(st.data.contactName, "Aline Applicant");
  assert.equal(st.data.shopName, "Ubumwe Mart");
  assert.equal(st.data.accountActive, false);
  assert.equal(st.data.activation, null, "activation is not offered before approval");

  // Only a SHA-256 hash of the credential reaches PostgreSQL.
  const stored = (await pool.query("SELECT status_token_hash FROM owner_applications WHERE id=$1", [app1])).rows[0];
  assert.notEqual(stored.status_token_hash, statusToken);

  // A review decision needs the administrator role and a real session.
  assert.equal((await call("GET", "/admin/applications")).status, 401);
});

/* ------------------------------------------------------------------ 2. administrator review */

test("administrator review: request-info round-trip, terminal rejection, approval", { skip }, async () => {
  const admin = await auth(ADMIN_EMAIL);

  const list = await call("GET", "/admin/applications", undefined, admin.token);
  assert.equal(list.status, 200);
  assert.ok(list.data.some((a: any) => a.id === app1), "the pending application is listed");

  // Ask for more information; the applicant answers from their status page.
  assert.equal((await call("POST", `/admin/applications/${app1}/request-info`, { message: "Please upload the trading licence" }, admin.token)).status, 201);
  let st = await call("POST", "/applications/status", { statusToken });
  assert.equal(st.data.status, "ADDITIONAL_INFORMATION_REQUIRED");
  assert.equal(st.data.infoMessage, "Please upload the trading licence");

  assert.equal((await call("POST", "/applications/respond", { statusToken, message: "Licence attached, number 12345" })).status, 201);
  st = await call("POST", "/applications/status", { statusToken });
  assert.equal(st.data.status, "PENDING_REVIEW", "the applicant's answer returns the file to review");
  assert.equal(st.data.infoMessage, null);

  // A second application is rejected; the decision is visible to its applicant only.
  const other = await call("POST", "/applications", application("rejected@onboarding.test", "Rejected Mart"));
  app2 = other.data.id;
  const reason = "Incomplete business plan";
  assert.equal((await call("POST", `/admin/applications/${app2}/reject`, { reason }, admin.token)).status, 201);
  const st2 = await call("POST", "/applications/status", { statusToken: other.data.statusToken });
  assert.equal(st2.data.status, "REJECTED");
  assert.equal(st2.data.decisionReason, reason);
  assert.equal(st2.data.activation, null, "a rejected application never activates");
  // A decision is terminal: no second decision on the same file.
  assert.equal((await call("POST", `/admin/applications/${app2}/approve`, {}, admin.token)).status, 409);
  assert.equal((await call("POST", `/admin/applications/${app2}/request-info`, { message: "Anything to add?" }, admin.token)).status, 409);
  // Rejection frees the address for a fresh attempt — proven at the constraint itself,
  // without a sixth POST (the public route is deliberately limited to 5/min).
  const { hashToken } = await import("../src/auth/security");
  await pool.query(
    `INSERT INTO owner_applications(contact_name,email,phone,shop_name,location,category,status_token_hash)
     VALUES ('Aline Applicant','rejected@onboarding.test','+250788000111','Second Try Mart','Kigali','grocery',$1)`,
    [hashToken("second-attempt-status-token-for-the-test")],
  );
  await pool.query("DELETE FROM owner_applications WHERE shop_name='Second Try Mart'");

  // Approval creates the owner account in `pending_activation` — no usable password yet.
  assert.equal((await call("POST", `/admin/applications/${app1}/approve`, { note: "Documents verified" }, admin.token)).status, 201);
  assert.equal((await call("POST", `/admin/applications/${app1}/approve`, {}, admin.token)).status, 409, "double approval is refused");
  const row = (await pool.query(
    "SELECT a.status, a.user_id, u.account_status, u.active, u.shop_id FROM owner_applications a JOIN users u ON u.id=a.user_id WHERE a.id=$1",
    [app1])).rows[0];
  assert.equal(row.status, "APPROVED");
  assert.equal(row.account_status, "pending_activation");
  assert.equal(row.active, false);
  assert.equal(row.shop_id, null, "the shop does not exist yet");
  assert.equal((await call("GET", "/admin/applications/not-a-uuid", undefined, admin.token)).status, 400, "an id is validated before it is used");
});

/* ------------------------------------------------------------------ 3. activation */

test("activation: token-gated, server-side password policy, single use, then sign-in", { skip }, async () => {
  const admin = await auth(ADMIN_EMAIL);

  let st = await call("POST", "/applications/status", { statusToken });
  assert.deepEqual(st.data.activation, { available: true });

  // The account exists but cannot sign in: no password of theirs exists yet (generic 401).
  const blocked = await call("POST", "/auth/login", { email: OWNER_EMAIL, password: PASSWORD });
  assert.equal(blocked.status, 401);
  assert.equal(msg(blocked.data), "invalid_credentials", "no account-state leak before activation");

  // A lapsed 7-day window is refused silently on the status page, then re-issued by the admin.
  await pool.query("UPDATE onboarding_tokens SET expires_at=now() - interval '1 day' WHERE application_id=$1", [app1]);
  st = await call("POST", "/applications/status", { statusToken });
  assert.deepEqual(st.data.activation, { available: false }, "the screen can say 'ask the administrator' instead of failing");
  assert.equal((await call("POST", `/admin/applications/${app1}/activation-window`, {}, admin.token)).status, 201);
  st = await call("POST", "/applications/status", { statusToken });
  assert.deepEqual(st.data.activation, { available: true });

  // Password policy is applied by the server, never only by the UI.
  const weak = await call("POST", "/applications/activate", { statusToken, password: "short" });
  assert.equal(weak.status, 400);
  assert.match(msg(weak.data), /at least 10/);

  const ok = await call("POST", "/applications/activate", { statusToken, password: PASSWORD });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.equal(ok.data.ok, true);
  assert.equal(ok.data.email, OWNER_EMAIL);

  // Single use: the credential cannot be replayed.
  const replay = await call("POST", "/applications/activate", { statusToken, password: PASSWORD });
  assert.equal(replay.status, 400);
  assert.equal(msg(replay.data), "activation_token_invalid");

  st = await call("POST", "/applications/status", { statusToken });
  assert.equal(st.data.accountActive, true);
  assert.equal(st.data.activation, null, "activation is over");

  const u = (await pool.query(
    "SELECT u.account_status, u.active, t.used_at FROM owner_applications a JOIN users u ON u.id=a.user_id JOIN onboarding_tokens t ON t.application_id=a.id WHERE a.id=$1",
    [app1])).rows[0];
  assert.equal(u.account_status, "active");
  assert.equal(u.active, true);
  assert.ok(u.used_at, "the activation token is consumed");
  assert.equal(await bcrypt.compare(PASSWORD, (await pool.query(
    "SELECT u.password_hash FROM owner_applications a JOIN users u ON u.id=a.user_id WHERE a.id=$1", [app1])).rows[0].password_hash),
    true, "the placeholder hash is replaced by the applicant's own password");

  // And the new owner can actually sign in.
  const owner = await auth(OWNER_EMAIL);
  assert.equal(owner.user.role, "owner");
  assert.equal(owner.user.shopId, null, "no shop until they create it");
  const me = await call("GET", "/auth/me", undefined, owner.token);
  assert.equal(me.data.email, OWNER_EMAIL);
  assert.equal(me.data.shopName, null);

  // Every stage of the lifecycle is in the audit log, and no raw token ever reaches it.
  const actions = (await pool.query(
    "SELECT action FROM audit_log WHERE entity='owner_application' AND entity_id=$1 ORDER BY id", [app1])).rows.map((r) => r.action);
  assert.deepEqual(actions, ["application.submit", "application.request_info", "application.respond", "application.approve", "application.activation_extended", "application.activate"]);
  const auditText = JSON.stringify((await pool.query("SELECT * FROM audit_log")).rows);
  assert.ok(!auditText.includes(statusToken), "the status token is never written to the audit log");
});

/* ------------------------------------------------------------------ 4. shop creation */

test("shop creation: once, by the activated owner only", { skip }, async () => {
  const owner = await auth(OWNER_EMAIL);

  assert.equal((await call("POST", "/shop", { name: "Ubumwe Mart" })).status, 401, "anonymous callers get nothing");
  const admin = await auth(ADMIN_EMAIL);
  assert.equal((await call("POST", "/shop", { name: "Admin Mart" }, admin.token)).status, 403, "the administrator cannot mint a shop for an owner");

  const created = await call("POST", "/shop", { name: "Ubumwe Mart", location: "Kigali", category: "grocery" }, owner.token);
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.name, "Ubumwe Mart");
  shopId = created.data.id;
  assert.ok(shopId);

  // One shop per owner, ever — a second call (or a race) loses cleanly.
  const again = await call("POST", "/shop", { name: "Ubumwe Mart 2" }, owner.token);
  assert.equal(again.status, 409);
  assert.equal(msg(again.data), "shop_already_created");

  const row = (await pool.query(
    "SELECT u.shop_id, a.shop_id AS app_shop FROM owner_applications a JOIN users u ON u.id=a.user_id WHERE a.id=$1", [app1])).rows[0];
  assert.equal(row.shop_id, shopId, "the owner is attached to their shop");
  assert.equal(row.app_shop, shopId, "the application is tied to the shop for the audit trail");
  assert.ok(Number((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action='shop.create' AND entity_id=$1", [shopId])).rows[0].n) >= 1);

  const me = await call("GET", "/auth/me", undefined, owner.token);
  assert.equal(me.data.shopName, "Ubumwe Mart");
});

/* ------------------------------------------------------------------ 5. manager invitation */

test("manager invitation: invite, preview, accept, sign in — all token-gated", { skip }, async () => {
  const owner = await auth(OWNER_EMAIL);

  const team = await call("GET", "/shop/staff", undefined, owner.token);
  assert.equal(team.status, 200);
  assert.equal(team.data.staff.length, 1);
  assert.equal(team.data.staff[0].role, "owner");
  assert.equal(team.data.invitations.length, 0);

  const inv = await call("POST", "/shop/staff/invitations", { fullName: "Marie Manager", email: MGR_EMAIL }, owner.token);
  assert.equal(inv.status, 201, JSON.stringify(inv.data));
  assert.equal(inv.data.status, "invited");
  const token = new URL(inv.data.inviteUrl).searchParams.get("token");
  assert.ok(token, "the owner shares an invitation link");
  const stored = (await pool.query("SELECT token_hash, role, shop_id FROM staff_invitations WHERE id=$1", [inv.data.id])).rows[0];
  assert.notEqual(stored.token_hash, token, "only a hash of the invitation token is stored");
  assert.equal(stored.role, "manager", "an invitation can never grant more than manager");

  // One live invitation per address; the platform's own accounts are never invite targets.
  assert.equal((await call("POST", "/shop/staff/invitations", { fullName: "Dup", email: MGR_EMAIL }, owner.token)).status, 409);
  assert.equal((await call("POST", "/shop/staff/invitations", { fullName: "Self", email: OWNER_EMAIL }, owner.token)).status, 409);
  assert.equal((await call("POST", "/shop/staff/invitations", { fullName: "Admin", email: ADMIN_EMAIL }, owner.token)).status, 409);

  // The invitee previews before committing: no account exists yet.
  assert.equal((await call("POST", "/staff-invitations/preview", { token: "definitely-not-the-invite-token-abc" })).status, 400);
  const preview = await call("POST", "/staff-invitations/preview", { token });
  assert.equal(preview.status, 201);
  assert.equal(preview.data.status, "invited");
  assert.equal(preview.data.shopName, "Ubumwe Mart");
  assert.equal(preview.data.email, MGR_EMAIL);
  assert.equal(preview.data.existingAccount, false);

  // The password policy applies here too.
  assert.equal((await call("POST", "/staff-invitations/accept", { token, password: "short" })).status, 400);

  const accepted = await call("POST", "/staff-invitations/accept", { token, password: PASSWORD });
  assert.equal(accepted.status, 201, JSON.stringify(accepted.data));
  assert.equal(accepted.data.ok, true);
  assert.equal(accepted.data.shopName, "Ubumwe Mart");

  // Single use: the link cannot be accepted twice.
  assert.equal((await call("POST", "/staff-invitations/accept", { token, password: PASSWORD })).status, 400);

  const mgr = await auth(MGR_EMAIL);
  assert.equal(mgr.user.role, "manager");
  assert.equal(mgr.user.shopId, shopId, "the manager belongs to the inviting shop");
  const me = await call("GET", "/auth/me", undefined, mgr.token);
  assert.equal(me.data.shopName, "Ubumwe Mart");

  const team2 = await call("GET", "/shop/staff", undefined, owner.token);
  assert.equal(team2.data.staff.length, 2, "owner and the new manager");
  assert.equal(team2.data.staff[1].role, "manager");
  assert.equal(team2.data.invitations[0].status, "active");
  assert.ok(Number((await pool.query(
    "SELECT count(*)::int AS n FROM audit_log WHERE action='staff.invitation.accepted' AND entity_id=$1",
    [team2.data.invitations[0].id])).rows[0].n) === 1);
});

/* ------------------------------------------------------------------ 6. invitation lifecycle */

test("invitation lifecycle: revoke is terminal, resend rotates the token, expiry flips the row", { skip }, async () => {
  const owner = await auth(OWNER_EMAIL);

  // Re-inviting an active colleague is refused.
  assert.equal((await call("POST", "/shop/staff/invitations", { fullName: "Marie Again", email: MGR_EMAIL }, owner.token)).status, 409);

  // Revoked: terminal for this link — the owner creates a new one instead.
  const revoked = await call("POST", "/shop/staff/invitations", { fullName: "Second Manager", email: "manager2@onboarding.test" }, owner.token);
  assert.equal(revoked.status, 201);
  const revokedToken = new URL(revoked.data.inviteUrl).searchParams.get("token");
  assert.equal((await call("POST", `/shop/staff/invitations/${revoked.data.id}/revoke`, undefined, owner.token)).data.status, "revoked");
  assert.equal((await call("POST", "/staff-invitations/preview", { token: revokedToken })).data.status, "revoked");
  assert.equal((await call("POST", "/staff-invitations/accept", { token: revokedToken, password: PASSWORD })).status, 400);
  assert.equal((await call("POST", `/shop/staff/invitations/${revoked.data.id}/revoke`, undefined, owner.token)).data.status, "revoked",
    "revoking twice is idempotent");
  assert.equal((await call("POST", `/shop/staff/invitations/${revoked.data.id}/resend`, undefined, owner.token)).status, 409,
    "a revoked invitation is never resurrected by resend");

  // Resend rotates the credential: the old link dies, a fresh one works.
  const third = await call("POST", "/shop/staff/invitations", { fullName: "Third Manager", email: "manager3@onboarding.test" }, owner.token);
  const oldToken = new URL(third.data.inviteUrl).searchParams.get("token");
  const resent = await call("POST", `/shop/staff/invitations/${third.data.id}/resend`, undefined, owner.token);
  assert.equal(resent.status, 201);
  const newToken = new URL(resent.data.inviteUrl).searchParams.get("token");
  assert.notEqual(newToken, oldToken, "resend issues a new token");
  assert.equal((await call("POST", "/staff-invitations/preview", { token: oldToken })).status, 400, "the superseded link is dead");

  // A lapsed link reports EXPIRED to both sides and flips the owner's row.
  await pool.query("UPDATE staff_invitations SET expires_at=now() - interval '1 minute' WHERE id=$1", [third.data.id]);
  const expired = await call("POST", "/staff-invitations/preview", { token: newToken });
  assert.equal(expired.data.status, "expired");
  assert.equal((await pool.query("SELECT status FROM staff_invitations WHERE id=$1", [third.data.id])).rows[0].status, "expired",
    "the owner's list stops showing a lapsed invite as pending");
  assert.equal((await call("POST", "/staff-invitations/accept", { token: newToken, password: PASSWORD })).status, 400);

  const team = await call("GET", "/shop/staff", undefined, owner.token);
  const statuses = team.data.invitations.map((i: any) => i.status);
  assert.deepEqual(statuses, ["expired", "revoked", "active"], "the owner sees the real state of every invitation");
});

/* ------------------------------------------------------------------ 7. role enforcement */

test("role enforcement over HTTP: every surface is closed to the wrong role", { skip }, async () => {
  const owner = await auth(OWNER_EMAIL);
  const mgr = await auth(MGR_EMAIL);
  const admin = await auth(ADMIN_EMAIL);

  // Administration of the platform belongs to system_admin only.
  for (const [method, path, body] of [
    ["GET", "/admin/applications", undefined],
    ["POST", `/admin/applications/${app1}/approve`, {}],
  ] as const) {
    assert.equal((await call(method, path, body, owner.token)).status, 403, `${method} ${path} must refuse an owner`);
    assert.equal((await call(method, path, body, mgr.token)).status, 403, `${method} ${path} must refuse a manager`);
  }

  // The administrator runs the platform but never a shop's team.
  assert.equal((await call("GET", "/shop/staff", undefined, admin.token)).status, 403);
  assert.equal((await call("GET", "/shop/settings", undefined, admin.token)).status, 403);
  assert.equal((await call("POST", "/shop", { name: "Nope" }, admin.token)).status, 403);

  // Team management belongs to the owner of that shop — the manager cannot invite or revoke.
  assert.equal((await call("GET", "/shop/staff", undefined, mgr.token)).status, 403);
  assert.equal((await call("POST", "/shop/staff/invitations", { fullName: "X", email: "x@onboarding.test" }, mgr.token)).status, 403);
  // ...and no route can move another shop: the shop always comes from the signed-in row.
  assert.equal((await call("POST", "/shop", { name: "Second Shop" }, owner.token)).status, 409, "still one shop per owner");

  // The manager works inside the shop: read access to their own team's shop is owner-only too,
  // but reports stay open to both roles (an existing authorization rule, unchanged here).
  assert.equal((await call("GET", "/shop/profile", undefined, mgr.token)).status, 200);
  assert.equal((await call("PATCH", "/shop/profile", { name: "Renamed" }, mgr.token)).status, 403, "only the owner renames the shop");

  // Guards reject tampered or foreign tokens outright.
  assert.equal((await call("GET", "/auth/me", undefined, "Bearer not.a.token")).status, 401);
  assert.equal((await call("GET", "/shop/staff")).status, 401);
});
