/**
 * The five-field "Create a Shop" registration flow, over REAL HTTP against a Nest app with the
 * real guards, roles, throttles and PostgreSQL (schema wiped per run). Run:
 *   TEST_DATABASE_URL=postgres://... npm run test -w @sms/api
 * Skipped automatically when TEST_DATABASE_URL is unset.
 *
 * Own file (not appended to onboarding.integration.test.ts) because every file boots its own app
 * instance: the public submission route is limited to 5/min per IP and sign-in to 8/min, budgets
 * the older suite already spends to the last slot.
 *
 * Covers the spec's acceptance list:
 *   - submission validates every field server-side and hashes the password;
 *   - the application stays PENDING until an administrator approves it — no account, no shop,
 *     no token, no dashboard access before that;
 *   - pending and rejected applicants get named sign-in messages instead of a session;
 *   - approval activates the owner account AND the proposed shop, with the role assigned by the
 *       server (a client-supplied role is ignored);
 *   - rejection keeps the account and shop inaccessible;
 *   - unauthorized callers (anonymous, manager) cannot decide applications;
 *   - duplicates are refused.
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

process.env.JWT_SECRET = "registration-test-secret-".padEnd(48, "x");
process.env.JWT_EXPIRES_IN = "15m";

const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : "TEST_DATABASE_URL not set";
process.env.DATABASE_URL = url ?? "";

const PASSWORD = "registration-pass-123";
const ADMIN_EMAIL = "admin@registration.test";
const MGR_EMAIL = "manager@registration.test";
const PENDING_EMAIL = "pending.owner@registration.test";
const REJECTED_EMAIL = "rejected.owner@registration.test";

let pool: Pool, app: any, base: string;
let pendingAppId = "";
let rejectedAppId = "";

/** POST/GET helpers; error bodies carry the readable message under `message` or `error`. */
const call = async (method: string, path: string, body?: unknown, token?: string) => {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
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

/** The five-field form: no location, no category, and a role field the server must ignore. */
const registration = (email: string, shopName: string) => ({
  contactName: "Regina Register",
  email,
  phone: "+250788100200",
  shopName,
  password: PASSWORD,
  role: "system_admin", // never trusted: zod strips it and the service assigns 'owner'
});

before(async () => {
  if (skip) return;
  pool = new Pool({ connectionString: url });
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  const dir = join(process.cwd(), "migrations");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) await pool.query(readFileSync(join(dir, f), "utf8"));

  // The system administrator (decides) and a shop manager (must not) exist before onboarding.
  await pool.query(
    "INSERT INTO users(shop_id,email,full_name,password_hash,role) VALUES (NULL,$1,'Platform Admin',$2,'system_admin')",
    [ADMIN_EMAIL, await bcrypt.hash(PASSWORD, 4)],
  );
  const { rows: [shop] } = await pool.query("INSERT INTO shops(name) VALUES ('Existing Shop') RETURNING id");
  await pool.query(
    "INSERT INTO users(shop_id,email,full_name,password_hash,role) VALUES ($1,$2,'Tina Manager',$3,'manager')",
    [shop.id, MGR_EMAIL, await bcrypt.hash(PASSWORD, 4)],
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

/* ------------------------------------------------------------------ 1. submission stays pending */

/* Submission budget: the public route allows exactly 5 POSTs per minute per IP, so the
 * whole file uses five: weak-password (400), pending, duplicate, rejected, manager-address. */

test("five-field submission validates, stays pending and blocks sign-in", { skip }, async () => {
  // Server-side validation of every field — the UI is never the only gate.
  const weak = await call("POST", "/applications", {
    contactName: "Weak Password", email: "weak@registration.test", phone: "+250788100201",
    shopName: "Weak Mart", password: "short",
  });
  assert.equal(weak.status, 400, "the password policy is applied by the server");
  assert.match(msg(weak.data), /at least 10/);

  // The real submission: exactly the five fields (plus a forged role the server must drop).
  const created = await call("POST", "/applications", registration(PENDING_EMAIL, "Pending Mart"));
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.status, "PENDING_REVIEW");
  pendingAppId = created.data.id;
  assert.ok(created.data.statusToken.length >= 20);

  // Duplicate applications are refused (one live file per address).
  const dup = await call("POST", "/applications", registration(PENDING_EMAIL, "Pending Mart Again"));
  assert.equal(dup.status, 409);
  assert.equal(msg(dup.data), "application_duplicate");

  // Registration alone never creates an account — there is nothing to access yet.
  const users = (await pool.query("SELECT count(*)::int AS n FROM users WHERE lower(email)=lower($1)", [PENDING_EMAIL])).rows[0];
  assert.equal(users.n, 0, "no account exists before approval");

  // Wrong password for the applicant's address: the generic answer, no state leak.
  const wrong = await call("POST", "/auth/login", { email: PENDING_EMAIL, password: "not-the-password-123" });
  assert.equal(wrong.status, 401);
  assert.equal(msg(wrong.data), "invalid_credentials");

  // Right password: the named pending state, still no session and no dashboard access.
  const blocked = await call("POST", "/auth/login", { email: PENDING_EMAIL, password: PASSWORD });
  assert.equal(blocked.status, 403);
  assert.equal(msg(blocked.data), "application_pending_review");
  assert.equal(blocked.data.token, undefined, "a pending applicant never receives a token");
  assert.equal((await call("GET", "/auth/me")).status, 401, "protected APIs stay closed");

  // The stored password is a bcrypt hash, never the plaintext.
  const stored = (await pool.query("SELECT password_hash FROM owner_applications WHERE id=$1", [pendingAppId])).rows[0];
  assert.ok(stored.password_hash && stored.password_hash !== PASSWORD);
  assert.equal(await bcrypt.compare(PASSWORD, stored.password_hash), true);
});

/* ------------------------------------------------------------------ 2. approval */

test("approval activates the owner account and the proposed shop", { skip }, async () => {
  // Anonymous callers cannot decide — the route needs an authenticated administrator.
  assert.equal((await call("POST", `/admin/applications/${pendingAppId}/approve`)).status, 401);

  const admin = await auth(ADMIN_EMAIL);
  const approved = await call("POST", `/admin/applications/${pendingAppId}/approve`, {}, admin.token);
  assert.equal(approved.status, 201, JSON.stringify(approved.data));

  const row = (await pool.query(
    `SELECT a.status, a.shop_id AS app_shop, s.name AS shop_name, u.role, u.active, u.account_status, u.shop_id AS user_shop
       FROM owner_applications a JOIN users u ON u.id=a.user_id JOIN shops s ON s.id=a.shop_id
      WHERE a.id=$1`, [pendingAppId])).rows[0];
  assert.equal(row.status, "APPROVED");
  assert.equal(row.role, "owner", "the role is assigned by the server, never by the client");
  assert.equal(row.active, true, "the account is active right after approval");
  assert.equal(row.account_status, "active");
  assert.equal(row.shop_name, "Pending Mart", "the proposed shop was created from the application");
  assert.ok(row.app_shop && row.app_shop === row.user_shop, "application and owner point at the same shop");

  // The decision is terminal: a second approval is refused.
  assert.equal((await call("POST", `/admin/applications/${pendingAppId}/approve`, {}, admin.token)).status, 409);

  // The approved owner signs in with the registration password and reaches their own shop.
  const owner = await auth(PENDING_EMAIL);
  assert.equal(owner.user.role, "owner");
  assert.ok(owner.user.shopId, "the session carries the shop");
  const me = await call("GET", "/auth/me", undefined, owner.token);
  assert.equal(me.data.shopName, "Pending Mart");
  const staff = await call("GET", "/shop/staff", undefined, owner.token);
  assert.equal(staff.status, 200, "the owner can open their own shop's dashboard data");
  assert.equal(staff.data.staff.length, 1);

  // Duplicate shop creation stays impossible for the new owner too.
  assert.equal((await call("POST", "/shop", { name: "Second Mart" }, owner.token)).status, 409);
});

/* ------------------------------------------------------------------ 3. rejection */

test("rejection keeps the account and shop inaccessible", { skip }, async () => {
  const created = await call("POST", "/applications", registration(REJECTED_EMAIL, "Rejected Mart"));
  assert.equal(created.status, 201, JSON.stringify(created.data));
  rejectedAppId = created.data.id;

  const admin = await auth(ADMIN_EMAIL);
  const rejected = await call("POST", `/admin/applications/${rejectedAppId}/reject`, { reason: "Incomplete business details" }, admin.token);
  assert.equal(rejected.status, 201, JSON.stringify(rejected.data));

  // A rejection needs a reason, and the decision is terminal.
  const noReason = await call("POST", `/admin/applications/${pendingAppId}/reject`, { reason: "x" }, admin.token);
  assert.equal(noReason.status, 400, "a decision needs a real reason and this file is already decided");

  // Sign-in while rejected: named message, no token, no account, no shop.
  const blocked = await call("POST", "/auth/login", { email: REJECTED_EMAIL, password: PASSWORD });
  assert.equal(blocked.status, 403);
  assert.equal(msg(blocked.data), "application_rejected");
  assert.equal(blocked.data.token, undefined);
  const counts = (await pool.query(
    `SELECT (SELECT count(*)::int FROM users WHERE lower(email)=lower($1)) AS users,
            (SELECT count(*)::int FROM shops WHERE name='Rejected Mart') AS shops`,
    [REJECTED_EMAIL])).rows[0];
  assert.equal(counts.users, 0, "a rejected applicant never gains an account");
  assert.equal(counts.shops, 0, "a rejected application never creates a shop");

  // A wrong password on the same address still gets the generic answer.
  const wrong = await call("POST", "/auth/login", { email: REJECTED_EMAIL, password: "not-the-password-123" });
  assert.equal(wrong.status, 401);
  assert.equal(msg(wrong.data), "invalid_credentials");
});

/* ------------------------------------------------------------------ 4. authorization */

test("managers and anonymous callers cannot decide applications", { skip }, async () => {
  const mgr = await auth(MGR_EMAIL);
  for (const [method, path, body] of [
    ["GET", "/admin/applications", undefined],
    ["GET", `/admin/applications/${pendingAppId}`, undefined],
    ["POST", `/admin/applications/${pendingAppId}/approve`, {}],
    ["POST", `/admin/applications/${rejectedAppId}/reject`, { reason: "manager says no" }],
  ] as const) {
    const r = await call(method, path, body, mgr.token);
    assert.equal(r.status, 403, `${method} ${path} must refuse a manager`);
  }

  // A manager is already an account, so the public form never turns them into an owner.
  const asOwner = await call("POST", "/applications", registration(MGR_EMAIL, "Manager Side Shop"));
  assert.equal(asOwner.status, 409);
  assert.equal(msg(asOwner.data), "application_email_in_use");
});
