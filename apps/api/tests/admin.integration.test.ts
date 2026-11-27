/**
 * Platform administration: overview metrics, shop lifecycle, account recovery, and the
 * security/audit view — over REAL HTTP against a Nest app with the real guards and PostgreSQL
 * (schema wiped per run).
 *
 *   TEST_DATABASE_URL=postgres://... npm run test:api
 *
 * Companion coverage that already exists elsewhere in the suite:
 *   - owner application review round-trip and invalid transitions -> onboarding.integration.test.ts
 *   - role enforcement for /admin/applications and shop isolation -> onboarding.integration.test.ts
 *   - ledger, offline queue and duplicate protection -> sync.integration.test.ts
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

process.env.JWT_SECRET = "admin-test-secret-".padEnd(48, "x");
process.env.JWT_EXPIRES_IN = "15m";

const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : "TEST_DATABASE_URL not set";
process.env.DATABASE_URL = url ?? "";

const PASSWORD = "admin-pass-12345";
const ADMIN = "admin@platform.test";
const OWNER = "ownerA@platform.test";
const MGR = "managerA@platform.test";
const OWNER_B = "ownerB@platform.test";

let pool: Pool, app: any, base: string;
let shopA = "", shopB = "", userOwner = "", userMgr = "";

const call = async (method: string, path: string, body?: unknown, token?: string, headers: Record<string, string> = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data: any = null;
  try { data = await res.json(); } catch { /* empty body */ }
  return { status: res.status, data };
};
const msg = (d: any): string => String(d?.message ?? d?.error ?? "");
/** Login is throttled on purpose: each account signs in as few times as the test strictly needs. */
const sessions = new Map<string, string>();
const auth = async (email: string): Promise<string> => {
  const hit = sessions.get(email);
  if (hit) return hit;
  const r = await call("POST", "/auth/login", { email, password: PASSWORD });
  assert.ok(r.status < 300, `login ${email} -> ${r.status} ${JSON.stringify(r.data)}`);
  sessions.set(email, r.data.token);
  return r.data.token;
};

before(async () => {
  if (skip) return;
  pool = new Pool({ connectionString: url });
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  const dir = join(process.cwd(), "migrations");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) await pool.query(readFileSync(join(dir, f), "utf8"));

  const hash = await bcrypt.hash(PASSWORD, 4);
  await pool.query("INSERT INTO users(email_verified_at, shop_id,email,full_name,password_hash,role) VALUES (now(), NULL,$1,'Platform Admin',$2,'system_admin')", [ADMIN, hash]);

  const mkShop = async (name: string, ownerEmail: string, mgrEmail: string | null) => {
    const s = (await pool.query("INSERT INTO shops(name) VALUES ($1) RETURNING id", [name])).rows[0].id;
    const o = (await pool.query(
      "INSERT INTO users(email_verified_at, shop_id,email,full_name,password_hash,role) VALUES (now(), $1,$2,'Shop Owner',$3,'owner') RETURNING id",
      [s, ownerEmail, hash])).rows[0].id;
    let m = "";
    if (mgrEmail) m = (await pool.query(
      "INSERT INTO users(email_verified_at, shop_id,email,full_name,password_hash,role) VALUES (now(), $1,$2,'Shop Manager',$3,'manager') RETURNING id",
      [s, mgrEmail, hash])).rows[0].id;
    return { s, o, m };
  };
  const a = await mkShop("Platform Test Grocers", OWNER, MGR);
  shopA = a.s; userOwner = a.o; userMgr = a.m;
  const b = await mkShop("Platform Test Hardware", OWNER_B, null);
  shopB = b.s;

  // One live owner application so the overview/list counts have something real to count.
  await pool.query(
    `INSERT INTO owner_applications(contact_name,email,phone,shop_name,location,category,note,status,status_token_hash,submitted_at)
     VALUES ('Test Applicant','applicant@platform.test','+250788000000','Pending Test Shop','Kigali','grocery','','PENDING_REVIEW',$1, now())`,
    ["tok-" + "a".repeat(40)]);

  // Guards rely on design:paramtypes, which only tsc emits — build the real app and load dist.
  try { execSync("npx tsc -p tsconfig.json", { cwd: process.cwd(), stdio: "pipe" }); }
  catch (e: any) { throw new Error(`app build failed:\n${e?.stdout ?? ""}${e?.stderr ?? ""}`); }
  const { AppModule } = await import("../dist/app.module");
  const { NestFactory } = await import("@nestjs/core");
  app = await NestFactory.create(AppModule, { logger: ["error"] });
  await app.listen(0, "127.0.0.1");
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
});

after(async () => { await app?.close(); await pool?.end(); });

test("every admin endpoint refuses non-admin roles and anonymous callers", { skip }, async () => {
  const owner = await auth(OWNER); const mgr = await auth(MGR);
  const surfaces = [
    ["GET", "/admin/overview", undefined],
    ["GET", "/admin/users", undefined],
    ["GET", "/admin/shops", undefined],
    ["GET", "/admin/audit", undefined],
    ["POST", `/admin/shops/${shopA}/suspend`, { reason: "testing" }],
    ["POST", `/admin/users/${userMgr}/revoke`, {}],
  ] as const;
  for (const [method, path, body] of surfaces) {
    assert.equal((await call(method, path, body, owner)).status, 403, `${method} ${path} must refuse an owner`);
    assert.equal((await call(method, path, body, mgr)).status, 403, `${method} ${path} must refuse a manager`);
    assert.equal((await call(method, path, body)).status, 401, `${method} ${path} must refuse an anonymous caller`);
  }
});

test("overview metrics are real database counts", { skip }, async () => {
  const admin = await auth(ADMIN);
  const r = await call("GET", "/admin/overview", undefined, admin);
  assert.equal(r.status, 200);
  const shops = (await pool.query("SELECT count(*)::int n FROM shops")).rows[0].n;
  const users = (await pool.query("SELECT count(*)::int n FROM users")).rows[0].n;
  const pending = (await pool.query("SELECT count(*)::int n FROM owner_applications WHERE status='PENDING_REVIEW'")).rows[0].n;
  assert.equal(r.data.shops.total, shops, "shop total matches the table");
  assert.equal(r.data.users.total, users, "user total matches the table");
  assert.equal(r.data.applications.pending, pending, "pending applications match the table");
  assert.equal(r.data.database.status, "ok", "database health is reported");
  assert.ok(r.data.recentApplications.length >= 1, "the pending application is listed");
  assert.ok(typeof r.data.securityEvents30d === "number", "security events are counted, not fabricated");
});

/**
 * The console enters support access from a single click, so no reason is typed. The server still
 * stores one (the session column and the audit view must never be blank), the platform surface
 * stays closed while access is active, and ending it restores the console. This is the regression
 * guard for the reason prompt that was removed from the UI and the overview query it broke.
 */
test("support access works without a typed reason and never opens the admin surface", { skip }, async () => {
  const admin = await auth(ADMIN);

  const enter = await call("POST", "/admin/impersonate/shop", { targetShopId: shopB }, admin);
  assert.equal(enter.status, 201, JSON.stringify(enter.data));
  const sessionId = enter.data.sessionId as string;
  const stored = (await pool.query("SELECT reason, status FROM impersonation_sessions WHERE id=$1", [sessionId])).rows[0];
  assert.equal(stored.status, "active");
  assert.equal(stored.reason, "Administrative access", "a standard reason is always stored");
  const audited = (await pool.query(
    "SELECT new_value FROM audit_log WHERE action='admin.impersonate.shop' AND entity_id=$1", [sessionId])).rows[0];
  assert.equal(audited?.new_value?.reason, "Administrative access", "the audit row states the same reason");

  // Inside access the caller sees the target shop (never the platform administration).
  const asTarget = { "x-impersonation-session": sessionId };
  const me = await call("GET", "/auth/me", undefined, admin, asTarget);
  assert.equal(me.status, 200);
  assert.equal(me.data.shopId, shopB);
  assert.equal((await call("GET", "/reports/inventory", undefined, admin, asTarget)).status, 200,
    "the shop's own screens work during support access");
  const blocked = await call("GET", "/admin/overview", undefined, admin, asTarget);
  assert.equal(blocked.status, 403, "platform administration is closed during support access");
  assert.equal(msg(blocked.data), "not_allowed_during_impersonation");

  const end = await call("POST", "/admin/impersonate/end", { sessionId }, admin);
  assert.equal(end.status, 200);
  assert.equal(end.data.ended, true);
  assert.equal((await call("GET", "/admin/overview", undefined, admin)).status, 200,
    "the admin dashboard is available again after access is ended");

  // Impersonating a person (not a shop) is the same one-click path.
  const asUser = await call("POST", "/admin/impersonate/user", { targetUserId: userOwner }, admin);
  assert.equal(asUser.status, 201, JSON.stringify(asUser.data));
  const userSession = (await pool.query("SELECT reason FROM impersonation_sessions WHERE id=$1", [asUser.data.sessionId])).rows[0];
  assert.equal(userSession.reason, "Administrative access");
  assert.equal((await call("POST", "/admin/impersonate/end", { sessionId: asUser.data.sessionId }, admin)).status, 200);
});

test("admin lists are searchable, filtered and bounded", { skip }, async () => {
  const admin = await auth(ADMIN);
  const all = await call("GET", "/admin/users?limit=200", undefined, admin);
  assert.equal(all.status, 200);
  assert.ok(all.data.length >= 4, "the fixture accounts are listed");

  const search = await call("GET", `/admin/users?q=${encodeURIComponent(OWNER)}`, undefined, admin);
  assert.equal(search.data.length, 1, "search narrows to the matching account");
  assert.equal(search.data[0].email, OWNER);

  const page1 = await call("GET", "/admin/users?limit=2&offset=0", undefined, admin);
  const page2 = await call("GET", "/admin/users?limit=2&offset=2", undefined, admin);
  assert.equal(page1.data.length, 2, "limit is honoured");
  assert.ok(!page1.data.some((u: any) => page2.data.some((x: any) => x.id === u.id)), "pages do not overlap");

  const bounded = await call("GET", "/admin/users?limit=9999", undefined, admin);
  assert.ok(bounded.status === 400, "an absurd page size is refused, not executed");
});

test("the audit view shows platform events and never a shop's financial activity", { skip }, async () => {
  const admin = await auth(ADMIN);
  // A financial audit row exists for a shop; it must not be readable by platform administration.
  await pool.query(
    "INSERT INTO audit_log(shop_id,actor_id,action,entity,new_value) VALUES ($1,$2,'sale.discount','sale','{\"discount\":500}')",
    [shopA, userOwner]);
  await pool.query(
    "INSERT INTO audit_log(shop_id,actor_id,action,entity,entity_id) VALUES (NULL,$1,'application.submitted','owner_application',$2)",
    [null, "00000000-0000-4000-8000-000000000000"]);
  const r = await call("GET", "/admin/audit?limit=200", undefined, admin);
  assert.equal(r.status, 200);
  const actions: string[] = r.data.map((e: any) => e.action);
  assert.ok(actions.some((a) => a.startsWith("auth.") || a.startsWith("application.")),
    "sign-ins and application decisions are visible");
  assert.ok(!actions.includes("sale.discount"), "a shop's financial events are never exposed to the admin");

  const filtered = await call("GET", "/admin/audit?q=application", undefined, admin);
  assert.ok(filtered.data.every((e: any) => e.action.startsWith("application.")), "the prefix filter works");
  assert.ok(filtered.data.length >= 1, "application events exist after the fixtures ran");
});

test("suspending a shop needs a reason, is audited, blocks sign-in and sync, and keeps every record", { skip }, async () => {
  const admin = await auth(ADMIN);
  const managerToken = await auth(MGR); // signed in BEFORE the suspension
  const before = {
    users: (await pool.query("SELECT count(*)::int n FROM users")).rows[0].n,
    sales: (await pool.query("SELECT count(*)::int n FROM sales")).rows[0].n,
    movements: (await pool.query("SELECT count(*)::int n FROM stock_movements")).rows[0].n,
    audits: (await pool.query("SELECT count(*)::int n FROM audit_log")).rows[0].n,
  };

  assert.equal((await call("POST", `/admin/shops/${shopA}/suspend`, {}, admin)).status, 400, "a reason is required");
  assert.equal((await call("POST", `/admin/shops/${shopA}/suspend`, { reason: "no" }, admin)).status, 400, "the reason must be at least 3 characters");

  const ok = await call("POST", `/admin/shops/${shopA}/suspend`, { reason: "Payment review pending" }, admin);
  assert.equal(ok.status, 200);
  assert.equal((await pool.query("SELECT status FROM shops WHERE id=$1", [shopA])).rows[0].status, "suspended");

  const auditRow = (await pool.query(
    "SELECT action, reason FROM audit_log WHERE action='admin.shop.suspend' AND entity_id=$1 ORDER BY id DESC LIMIT 1", [shopA])).rows[0];
  assert.ok(auditRow, "the suspension is audited");
  assert.equal(auditRow.reason, "Payment review pending", "the reason is stored with the audit entry");

  // Invalid transition: a shop that is already suspended cannot be suspended again.
  assert.equal((await call("POST", `/admin/shops/${shopA}/suspend`, { reason: "again please" }, admin)).status, 404);

  // Sign-in is refused with a specific, honest error...
  sessions.delete(OWNER);
  const blocked = await call("POST", "/auth/login", { email: OWNER, password: PASSWORD });
  assert.equal(blocked.status, 403);
  assert.equal(msg(blocked.data), "shop_suspended");

  // ...and a session that was already open can no longer write: the sync push (the offline-first
  // write path, used for sales, expenses and stock alike) is refused at the door, while reads stay
  // available so nothing already on screen breaks.
  assert.equal((await call("GET", "/auth/me", undefined, managerToken)).status, 200, "reads still work for a suspended shop");
  const write = await call("POST", "/sync/push", {
    batchId: "33333333-3333-4333-8333-333333333333", deviceId: "d",
    operations: [{ opId: "44444444-4444-4444-8444-444444444444", createdAt: new Date().toISOString(),
      type: "expense.create", payload: { expenseId: "55555555-5555-4555-8555-555555555555", amount: 500, paid: true, incurredAt: new Date().toISOString() } }],
  }, managerToken);
  assert.equal(write.status, 403, "a suspended shop cannot push any write");
  assert.equal(msg(write.data), "shop_suspended");

  // Nothing was deleted: suspension is metadata only.
  const after = {
    users: (await pool.query("SELECT count(*)::int n FROM users")).rows[0].n,
    sales: (await pool.query("SELECT count(*)::int n FROM sales")).rows[0].n,
    movements: (await pool.query("SELECT count(*)::int n FROM stock_movements")).rows[0].n,
  };
  assert.deepEqual(after, { users: before.users, sales: before.sales, movements: before.movements },
    "users, sales and the stock ledger are untouched by a suspension");
  assert.ok((await pool.query("SELECT count(*)::int n FROM audit_log")).rows[0].n > before.audits, "the audit log only ever grows");
});

test("reactivation restores access and is equally auditable", { skip }, async () => {
  const admin = await auth(ADMIN);
  assert.equal((await call("POST", `/admin/shops/${shopA}/reactivate`, { reason: "review complete" }, admin)).status, 200);
  assert.equal((await pool.query("SELECT status FROM shops WHERE id=$1", [shopA])).rows[0].status, "active");
  // Invalid transition: an active shop cannot be reactivated.
  assert.equal((await call("POST", `/admin/shops/${shopA}/reactivate`, { reason: "again" }, admin)).status, 404);

  const row = (await pool.query(
    "SELECT reason FROM audit_log WHERE action='admin.shop.reactivate' AND entity_id=$1 ORDER BY id DESC LIMIT 1", [shopA])).rows[0];
  assert.equal(row?.reason, "review complete");

  const ownerToken = await auth(OWNER); // the cached session was cleared when sign-in was refused
  const me = await call("GET", "/auth/me", undefined, ownerToken);
  assert.equal(me.status, 200, "the owner can sign in again after reactivation");
  assert.equal(me.data.role, "owner");
});

test("a revoked account can be reactivated; a pending activation never can", { skip }, async () => {
  const admin = await auth(ADMIN);
  const revoke = await call("POST", `/admin/users/${userMgr}/revoke`, {}, admin);
  assert.equal(revoke.status, 200);
  assert.equal((await pool.query("SELECT active, account_status FROM users WHERE id=$1", [userMgr])).rows[0].account_status, "suspended");

  assert.equal((await call("POST", `/admin/users/${userMgr}/activate`, {}, admin)).status, 200);
  const back = (await pool.query("SELECT active, account_status FROM users WHERE id=$1", [userMgr])).rows[0];
  assert.equal(back.active, true);
  assert.equal(back.account_status, "active");
  // Invalid transition: only a suspended account may be reactivated.
  assert.equal((await call("POST", `/admin/users/${userMgr}/activate`, {}, admin)).status, 404);
  assert.ok((await pool.query(
    "SELECT 1 FROM audit_log WHERE action IN ('admin.user.revoke','admin.user.activate') AND entity_id=$1", [userMgr])).rowCount);

  // An owner application that has not completed activation stays protected by its single-use link.
  await pool.query("UPDATE users SET account_status='pending_activation', active=false WHERE id=$1", [userOwner]);
  assert.equal((await call("POST", `/admin/users/${userOwner}/activate`, {}, admin)).status, 404,
    "reactivation cannot bypass the onboarding activation step");
  await pool.query("UPDATE users SET account_status='active', active=true WHERE id=$1", [userOwner]); // restore for later runs
});

test("the second shop stays independent: suspension of A never touches B", { skip }, async () => {
  const admin = await auth(ADMIN);
  const b = (await pool.query("SELECT status FROM shops WHERE id=$1", [shopB])).rows[0];
  assert.equal(b.status, "active", "shop B is unaffected by shop A's lifecycle changes");
  const ownerB = await auth(OWNER_B);
  assert.equal((await call("GET", "/auth/me", undefined, ownerB)).status, 200, "the other shop's owner still works");
});

test("a sign-in from another computer is recorded with its device and kept to that account", { skip }, async () => {
  // Two different browsers on two different addresses: the shape of a second computer.
  const uaOwner = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/129.0 Safari/537.36";
  const uaManager = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/17 Safari/605.1.15";
  const a = await call("POST", "/auth/login", { email: OWNER, password: PASSWORD }, undefined, { "user-agent": uaOwner });
  assert.ok(a.status < 300, `owner login -> ${a.status}`);
  const b = await call("POST", "/auth/login", { email: MGR, password: PASSWORD }, undefined, { "user-agent": uaManager });
  assert.ok(b.status < 300, `manager login -> ${b.status}`);

  // The history is the server's, so a browser that never stored anything still sees it.
  const mine = await call("GET", "/auth/activity", undefined, a.data.token);
  assert.equal(mine.status, 200);
  assert.ok(mine.data.some((e: any) => e.action === "auth.login" && /Chrome/.test(String(e.userAgent)) && e.ip),
    "the owner's own sign-in is listed with its browser and address");
  // Chrome's own user agent contains "Safari", so the platform is the discriminator here.
  assert.ok(!mine.data.some((e: any) => /Macintosh/.test(String(e.userAgent))),
    "another account's sign-in never appears in this account's history");

  const theirs = await call("GET", "/auth/activity", undefined, b.data.token);
  assert.ok(theirs.data.some((e: any) => e.action === "auth.login" && /Macintosh/.test(String(e.userAgent))),
    "the manager sees the sign-in from their own browser");
  assert.ok(!theirs.data.some((e: any) => /Windows NT/.test(String(e.userAgent))),
    "the owner's browser is not in the manager's history");

  // The shop trail names the person who signed in, not the device or the shop owner.
  const log = await call("GET", "/audit/log", undefined, await auth(OWNER));
  assert.equal(log.status, 200);
  assert.ok(log.data.some((r: any) => r.action === "auth.login" && r.actor === "Shop Manager"),
    "the shop activity log attributes the manager's sign-in to the manager");
});
