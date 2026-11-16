/**
 * "A real address, proven by a click": the sign-in gate, the confirmation link and the resend path,
 * over REAL HTTP against a Nest app with the real guards, throttles and PostgreSQL (schema wiped).
 * Run:  TEST_DATABASE_URL=postgres://... npm run test -w @sms/api
 * Skipped automatically when TEST_DATABASE_URL is unset.
 *
 * It deliberately inserts the token row itself with a known plaintext instead of reading an e-mail:
 * no SMTP credential exists in CI, and the property under test is what the server does with a
 * token it issued — not how Gmail stores the message.
 *
 * Covers:
 *   - an unconfirmed address cannot sign in, and is told exactly that (`email_not_verified`);
 *   - the public resend route answers the same for unknown, confirmed and unconfirmed addresses;
 *   - a fresh link confirms the account once, and the second click is refused;
 *   - an expired link is refused;
 *   - a link issued for an address that has since changed is refused;
 *   - EMAIL_VERIFICATION_REQUIRED=false is an operator escape hatch, not a code change.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import "reflect-metadata";
import { execSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import bcrypt from "bcryptjs";
import { hashToken } from "../src/auth/security";

process.env.JWT_SECRET = "email-verification-secret-".padEnd(48, "x");
process.env.JWT_EXPIRES_IN = "15m";
process.env.EMAIL_VERIFICATION_REQUIRED = "true";
// No provider in CI: the code must cope with a message that cannot be delivered.
delete process.env.MAIL_SMTP_USER;
delete process.env.MAIL_SMTP_PASS;

const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : "TEST_DATABASE_URL not set";
process.env.DATABASE_URL = url ?? "";

const PASSWORD = "verification-pass-123";
const UNVERIFIED = "new.owner@verification.test";
const UNKNOWN = "nobody@verification.test";

let pool: Pool, app: any, base: string, userId = "", shopId = "";

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

/** Inserts a link exactly as the service does, but with a plaintext the test is allowed to know. */
async function issueLink(email: string, opts: { expiresIn?: string } = {}) {
  const token = randomBytes(24).toString("base64url");
  await pool.query(
    `INSERT INTO email_verification_tokens(user_id, email, token_hash, expires_at)
     VALUES ($1,$2,$3, now() + $4::interval)`,
    [userId, email, hashToken(token), opts.expiresIn ?? "48 hours"],
  );
  return token;
}

before(async () => {
  if (skip) return;
  pool = new Pool({ connectionString: url });
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  const dir = join(process.cwd(), "migrations");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) await pool.query(readFileSync(join(dir, f), "utf8"));

  const { rows: [shop] } = await pool.query("INSERT INTO shops(name) VALUES ('Verification Shop') RETURNING id");
  shopId = shop.id;
  const { rows: [u] } = await pool.query(
    `INSERT INTO users(shop_id,email,full_name,password_hash,role,active,account_status,email_verified_at)
     VALUES ($1,$2,'New Owner',$3,'owner',true,'active',NULL) RETURNING id`,
    [shopId, UNVERIFIED, await bcrypt.hash(PASSWORD, 4)],
  );
  userId = u.id;

  // Guards and controllers rely on `design:paramtypes`, which esbuild (tsx) never emits.
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

test("an unconfirmed address cannot sign in, and is told why", { skip }, async () => {
  const r = await call("POST", "/auth/login", { email: UNVERIFIED, password: PASSWORD });
  assert.equal(r.status, 403);
  assert.equal(msg(r.data), "email_not_verified", "a named reason, not a generic failure");

  const [row] = (await pool.query(
    "SELECT new_value->>'reason' AS reason FROM audit_log WHERE entity_id=$1 AND action='auth.login.blocked' ORDER BY at DESC LIMIT 1",
    [userId])).rows;
  assert.equal(row?.reason, "email_unverified", "the refusal is auditable");
});

test("resend never reveals whether an address exists, and stores a fresh link", { skip }, async () => {
  const before = (await pool.query("SELECT count(*)::int AS n FROM email_verification_tokens WHERE user_id=$1", [userId])).rows[0].n;

  const unknown = await call("POST", "/auth/email/resend", { email: UNKNOWN });
  assert.equal(unknown.status, 201);
  assert.deepEqual(unknown.data, { ok: true });

  const known = await call("POST", "/auth/email/resend", { email: UNVERIFIED.toUpperCase() });
  assert.equal(known.status, 201);
  assert.deepEqual(known.data, { ok: true }, "the same answer for a real unconfirmed account");

  const afterCount = (await pool.query("SELECT count(*)::int AS n FROM email_verification_tokens WHERE user_id=$1", [userId])).rows[0].n;
  assert.equal(afterCount, before + 1, "one link was written for the unconfirmed account");
  assert.equal((await pool.query(
    "SELECT count(*)::int AS n FROM email_verification_tokens WHERE email=$1", [UNKNOWN])).rows[0].n, 0,
  "an unknown address gets nothing — and cannot be used to probe the table");

  const [live] = (await pool.query(
    "SELECT used_at, expires_at > now() AS alive FROM email_verification_tokens WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1",
    [userId])).rows;
  assert.equal(live.used_at, null);
  assert.equal(live.alive, true);
});

test("the link confirms the address once, and signs the account in", { skip }, async () => {
  const token = await issueLink(UNVERIFIED);

  const ok = await call("POST", "/auth/email/verify", { token });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.equal(ok.data.email, UNVERIFIED);

  const [u] = (await pool.query("SELECT email_verified_at FROM users WHERE id=$1", [userId])).rows;
  assert.ok(u.email_verified_at, "the account is recorded as confirmed");

  const replay = await call("POST", "/auth/email/verify", { token });
  assert.equal(replay.status, 400);
  assert.equal(msg(replay.data), "verification_token_invalid", "a second click cannot confirm again or move accounts");

  const login = await call("POST", "/auth/login", { email: UNVERIFIED, password: PASSWORD });
  assert.ok(login.status < 300, `login -> ${login.status} ${JSON.stringify(login.data)}`);
  assert.equal(login.data.user.role, "owner");
});

test("an expired link, and a link for a changed address, are both refused", { skip }, async () => {
  await pool.query("UPDATE users SET email_verified_at=NULL WHERE id=$1", [userId]);

  const expired = await issueLink(UNVERIFIED, { expiresIn: "-1 hour" });
  const r1 = await call("POST", "/auth/email/verify", { token: expired });
  assert.equal(r1.status, 400);
  assert.equal(msg(r1.data), "verification_token_invalid");

  const stale = await issueLink(UNVERIFIED);
  await pool.query("UPDATE users SET email=$2 WHERE id=$1", [userId, "moved.owner@verification.test"]);
  const r2 = await call("POST", "/auth/email/verify", { token: stale });
  assert.equal(r2.status, 400, "the link was issued for an address the account no longer has");
  assert.equal((await pool.query("SELECT email_verified_at FROM users WHERE id=$1", [userId])).rows[0].email_verified_at, null);
  await pool.query("UPDATE users SET email=$2 WHERE id=$1", [userId, UNVERIFIED]);
});

test("EMAIL_VERIFICATION_REQUIRED=false lets an operator turn the gate off without a deploy", { skip }, async () => {
  await pool.query("UPDATE users SET email_verified_at=NULL WHERE id=$1", [userId]);
  process.env.EMAIL_VERIFICATION_REQUIRED = "false";
  try {
    const login = await call("POST", "/auth/login", { email: UNVERIFIED, password: PASSWORD });
    assert.ok(login.status < 300, `login -> ${login.status} ${JSON.stringify(login.data)}`);
  } finally {
    process.env.EMAIL_VERIFICATION_REQUIRED = "true";
  }
});
