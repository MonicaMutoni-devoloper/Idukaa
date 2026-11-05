/**
 * Refresh-session lifecycle: real PostgreSQL, real AuthService, no mocks.
 * Run:  TEST_DATABASE_URL=postgres://... npm run test -w @sms/api
 * Skipped automatically when TEST_DATABASE_URL is unset. The schema is wiped per run.
 *
 * These are the cases the production 401 was reported against. They pin the guarantees the client
 * relies on, so a change here cannot silently turn "temporary failure" into "signed out":
 *   - a valid refresh rotates and keeps working;
 *   - an expired credential is refused;
 *   - a request that presents NO credential is distinguishable from a refused one;
 *   - two concurrent refreshes both succeed (single-flight + the reuse grace window);
 *   - a credential reused outside the grace window is treated as theft and the family dies.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID as uuid } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import bcrypt from "bcryptjs";

process.env.JWT_EXPIRES_IN = "15m";
const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : "TEST_DATABASE_URL not set";
process.env.DATABASE_URL = url ?? "";

let db: any, pool: Pool, auth: any, pool2: Pool;
let shop: string, owner: any;
const PASSWORD = "test-password-123";
const meta = (deviceId = "refresh-test") => ({ deviceId, userAgent: "node-test", ip: "127.0.0.1" });

/** Minimal Request/Response stand-ins: the controller only reads headers and sets cookies. */
const fakeReq = (cookie?: string) => ({ headers: cookie ? { cookie } : {}, method: "POST", path: "/auth/refresh", ip: "127.0.0.1" } as any);
const fakeRes = () => ({ cookie() {}, clearCookie() {} } as any);

const is401 = (pattern?: RegExp) => (e: any) => {
  const status = e?.getStatus?.() ?? e?.status;
  if (status !== 401) return false;
  return pattern ? pattern.test(String(e?.message ?? "")) : true;
};

before(async () => {
  if (skip) return;
  pool = new Pool({ connectionString: url });
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  const dir = join(process.cwd(), "migrations");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) await pool.query(readFileSync(join(dir, f), "utf8"));

  const { Db } = await import("../src/db/db.service");
  const { AuthService } = await import("../src/auth/auth.service");
  const { NotificationService } = await import("../src/notifications/notifications.service");
  const { JwtService } = await import("@nestjs/jwt");
  db = new Db();
  pool2 = db.pool;
  auth = new AuthService(db, new JwtService({ secret: "test-secret-".padEnd(48, "x"), signOptions: { expiresIn: "15m" } }), new NotificationService(db));

  shop = (await pool.query("INSERT INTO shops(name) VALUES ('Refresh shop') RETURNING id")).rows[0].id;
  const r = await pool.query(
    `INSERT INTO users(shop_id,email,full_name,password_hash,role,account_status,active)
     VALUES ($1,$2,$3,$4,'owner','active',true) RETURNING id, email, full_name, role, shop_id, token_version`,
    [shop, "owner@refresh.test", "Refresh owner", await bcrypt.hash(PASSWORD, 4)],
  );
  owner = r.rows[0];
});
after(async () => { if (!skip) { await db.onModuleDestroy(); await pool.end(); } });

test("a valid refresh rotates the credential and keeps the session usable", { skip }, async () => {
  const session = await auth.login(owner.email, PASSWORD, meta());
  assert.ok(session.refreshToken, "login issues a refresh credential");
  assert.equal(session.user.role, "owner");

  const next = await auth.refresh(session.refreshToken, meta());
  assert.notEqual(next.refreshToken, session.refreshToken, "the credential rotates on every use");
  assert.ok(next.token && next.expiresIn > 0, "a fresh access token is issued");

  // The rotated credential is the live one.
  const third = await auth.refresh(next.refreshToken, meta());
  assert.ok(third.refreshToken);
});

test("an expired refresh credential is refused", { skip }, async () => {
  const session = await auth.login(owner.email, PASSWORD, meta());
  const { hashToken } = await import("../src/auth/security");
  await pool2.query("UPDATE refresh_sessions SET expires_at = now() - interval '1 minute' WHERE token_hash=$1", [hashToken(session.refreshToken)]);

  await assert.rejects(() => auth.refresh(session.refreshToken, meta()), is401(/refresh_expired/));
});

test("no credential at all is a MISSING credential, not an invalid one", { skip }, async () => {
  // The whole point: a browser that never sent the cookie must not be told its session is dead.
  const { AuthController } = await import("../src/auth/auth.controller");
  const controller = new AuthController(auth);

  await assert.rejects(() => controller.refresh({}, fakeReq(undefined), fakeRes()), (e: any) => {
    if (e?.getStatus?.() !== 401) return false;
    const body = e.getResponse();
    return body?.message === "refresh_missing_credential";
  });

  // A credential the server HAS seen and refused keeps the old, unambiguous code.
  await assert.rejects(() => controller.refresh({ refreshToken: "x".repeat(40) }, fakeReq(undefined), fakeRes()), (e: any) => {
    const body = e?.getResponse?.();
    return e?.getStatus?.() === 401 && body?.message === "refresh_invalid";
  });
});

test("two concurrent refreshes both succeed instead of locking the user out", { skip }, async () => {
  const session = await auth.login(owner.email, PASSWORD, meta());
  const results = await Promise.allSettled([
    auth.refresh(session.refreshToken, meta("tab-a")),
    auth.refresh(session.refreshToken, meta("tab-b")),
  ]);

  assert.equal(results.filter((r) => r.status === "fulfilled").length, 2,
    `both tabs must get a session: ${results.map((r) => r.status === "rejected" ? String((r as any).reason?.message) : "ok").join(", ")}`);

  // Whichever credential the winner returned is still usable: the family was not revoked.
  const winner = (results[0] as PromiseFulfilledResult<any>).value;
  const after = await auth.refresh(winner.refreshToken, meta("tab-a"));
  assert.ok(after.token, "the session survives a racing refresh");
});

test("a credential reused outside the grace window is treated as theft", { skip }, async () => {
  const prevGrace = process.env.REFRESH_REUSE_GRACE_SECONDS;
  process.env.REFRESH_REUSE_GRACE_SECONDS = "0";
  try {
    const session = await auth.login(owner.email, PASSWORD, meta());
    const successor = await auth.refresh(session.refreshToken, meta());

    // Replay of the already-rotated credential, with no grace window: real reuse.
    await assert.rejects(() => auth.refresh(session.refreshToken, meta()), is401());
    // ...and the family it belonged to is dead, including the live successor.
    await assert.rejects(() => auth.refresh(successor.refreshToken, meta()), is401());
  } finally {
    if (prevGrace === undefined) delete process.env.REFRESH_REUSE_GRACE_SECONDS;
    else process.env.REFRESH_REUSE_GRACE_SECONDS = prevGrace;
  }
});

test("a refresh never crosses into another user's session", { skip }, async () => {
  const otherEmail = `other-${uuid().slice(0, 8)}@refresh.test`;
  await pool.query(
    `INSERT INTO users(shop_id,email,full_name,password_hash,role,account_status,active)
     VALUES ($1,$2,'Other owner',$3,'owner','active',true)`,
    [shop, otherEmail, await bcrypt.hash(PASSWORD, 4)],
  );
  const other = await auth.login(otherEmail, PASSWORD, meta("other-device"));
  const session = await auth.login(owner.email, PASSWORD, meta());

  assert.notEqual(other.user.id, session.user.id);
  const refreshed = await auth.refresh(other.refreshToken, meta("other-device"));
  assert.equal(refreshed.user.id, other.user.id, "refresh returns the session's own user");
});
