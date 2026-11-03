/**
 * Security + notifications integration tests: real PostgreSQL, real services, no mocks.
 * Run:  TEST_DATABASE_URL=postgres://... npm run test -w @sms/api
 * Skipped automatically when TEST_DATABASE_URL is unset. The schema is wiped per run.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID as uuid } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import bcrypt from "bcryptjs";
import { authenticator } from "otplib";

process.env.TOTP_ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.JWT_EXPIRES_IN = "15m";

const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : "TEST_DATABASE_URL not set";
process.env.DATABASE_URL = url ?? "";

let db: any, pool: Pool, auth: any, notifications: any, shopA: string, shopB: string;
let owner: any, manager: any, outsider: any, admin: any;
const PASSWORD = "test-password-123";
const now = () => new Date().toISOString();

const meta = (deviceId = "test-device") => ({ deviceId, userAgent: "node-test", ip: "127.0.0.1" });
const makeUser = async (shop: string | null, role: string, email: string, password = PASSWORD) => {
  const r = await pool.query(
    "INSERT INTO users(shop_id,email,full_name,password_hash,role) VALUES ($1,$2,$3,$4,$5) RETURNING id, email, full_name, role, shop_id, token_version",
    [shop, email, `Test ${role}`, await bcrypt.hash(password, 4), role],
  );
  return { ...r.rows[0], shopId: r.rows[0].shop_id };
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
  notifications = new NotificationService(db);
  auth = new AuthService(db, new JwtService({ secret: "test-secret-".padEnd(48, "x"), signOptions: { expiresIn: "15m" } }), notifications);

  shopA = (await pool.query("INSERT INTO shops(name) VALUES ('Security shop A') RETURNING id")).rows[0].id;
  shopB = (await pool.query("INSERT INTO shops(name) VALUES ('Security shop B') RETURNING id")).rows[0].id;
  owner = await makeUser(shopA, "owner", "owner@security.test");
  manager = await makeUser(shopA, "manager", "manager@security.test");
  outsider = await makeUser(shopB, "manager", "manager@other.test");
  admin = await makeUser(null, "system_admin", "admin@security.test");
});
after(async () => { if (!skip) { await db.onModuleDestroy(); await pool.end(); } });

async function productWithStock(name: string, qty: number, threshold: number) {
  const { SyncService } = await import("../src/sync/sync.service");
  const svc = new SyncService(db);
  const productId = uuid();
  const r = await svc.push(owner, "d", [{
    opId: uuid(), deviceId: "test", createdAt: now(), type: "product.upsert",
    payload: { productId, code: `P-${productId.slice(0, 8)}`, name, unit: "pcs", sellingPrice: 1000, lowStockThreshold: threshold, initialQty: qty, initialUnitCost: 500 },
  }]);
  assert.equal(r[0].status, "applied");
  return productId;
}

/* ------------------------------------------------------------------ notification preferences */

test("notification preferences are persisted per user and never leak across users", { skip }, async () => {
  const defaults = await notifications.preferences(manager.id);
  assert.deepEqual(defaults, { lowStock: true, outOfStock: true, salesActivity: true, inventoryUpdates: true, security: true });

  const saved = await notifications.savePreferences(manager.id, { lowStock: false, salesActivity: false });
  assert.equal(saved.lowStock, false);
  assert.equal(saved.salesActivity, false);
  assert.equal(saved.security, true, "security notifications cannot be switched off");
  assert.deepEqual(await notifications.preferences(manager.id), saved);

  assert.deepEqual(await notifications.preferences(owner.id), defaults, "another user's preferences are untouched");
  const stored = (await pool.query("SELECT low_stock, sales_activity FROM notification_preferences WHERE user_id=$1", [manager.id])).rows[0];
  assert.equal(stored.low_stock, false);
  assert.equal(stored.sales_activity, false);
});

test("optional alerts respect preferences, are de-duplicated, and security alerts are always delivered", { skip }, async () => {
  await productWithStock("Low stock rice", 4000, 5000);
  await productWithStock("Sold out sugar", 0, 5000);

  // Everything optional is off.
  await notifications.savePreferences(manager.id, { lowStock: false, outOfStock: false, salesActivity: false, inventoryUpdates: false });
  let inbox = await notifications.inbox(manager.id, shopA);
  assert.equal(inbox.items.filter((i: any) => i.category !== "security").length, 0, "no optional notification is generated when disabled");

  await notifications.security(manager.id, shopA, "password_changed");
  inbox = await notifications.inbox(manager.id, shopA);
  assert.equal(inbox.items.some((i: any) => i.kind === "password_changed"), true, "security notifications ignore preferences");

  // Low-stock alerts on: one row per product, even after generating twice.
  await notifications.savePreferences(manager.id, { lowStock: true });
  inbox = await notifications.inbox(manager.id, shopA);
  const low = inbox.items.filter((i: any) => i.category === "low_stock");
  assert.equal(low.length, 1, "one low-stock alert for the low product");
  assert.equal(low[0].data.productName, "Low stock rice");
  assert.equal(inbox.items.filter((i: any) => i.category === "out_of_stock").length, 0, "out-of-stock stays disabled");
  const again = await notifications.inbox(manager.id, shopA);
  assert.equal(again.items.filter((i: any) => i.category === "low_stock").length, 1, "alerts are not duplicated");

  // Out-of-stock on for another user: the shop scope stays intact.
  await notifications.savePreferences(owner.id, { outOfStock: true });
  const other = await notifications.inbox(owner.id, shopA);
  assert.equal(other.items.filter((i: any) => i.category === "out_of_stock").length, 1);
  assert.equal((await notifications.inbox(outsider.id, shopB)).items.length, 0, "another shop sees nothing");

  const before = await notifications.inbox(manager.id, shopA);
  await notifications.markRead(manager.id, [before.items[0].id]);
  const afterRead = await notifications.inbox(manager.id, shopA);
  assert.ok(afterRead.unread < before.unread, "marking one as read lowers the unread count");
  await notifications.markRead(manager.id);
  assert.equal((await notifications.inbox(manager.id, shopA)).unread, 0);
});

/* ------------------------------------------------------------------ password reset */

test("password reset: generic answers, hashed single-use tokens, expiry and session revocation", { skip }, async () => {
  const unknown = await auth.requestPasswordReset("nobody@security.test", "127.0.0.1");
  assert.deepEqual(unknown, { ok: true }, "an unknown account gets the same generic answer and no token");

  process.env.PASSWORD_RESET_DEV_MODE = "true";
  try {
    const requested = await auth.requestPasswordReset(manager.email, "127.0.0.1");
    assert.equal(requested.ok, true);
    assert.ok(requested.devToken, "development mode exposes the reset token for manual testing");
    assert.match(requested.devUrl, /reset-password\?token=/);

    const stored = (await pool.query("SELECT token_hash, used_at, expires_at FROM password_reset_tokens WHERE user_id=$1", [manager.id])).rows[0];
    assert.notEqual(stored.token_hash, requested.devToken, "only a hash of the reset token is stored");
    assert.equal(stored.used_at, null);

    assert.deepEqual(await auth.verifyResetToken(requested.devToken), { valid: true });
    assert.deepEqual(await auth.verifyResetToken("not-a-real-token"), { valid: false });

    await assert.rejects(() => auth.resetPassword(requested.devToken, "short"), /at least 10/);

    // A session exists before the reset; the reset must revoke it.
    const session = await auth.login(manager.email, PASSWORD, meta());
    assert.ok(session.refreshToken);
    const versionBefore = Number((await pool.query("SELECT token_version FROM users WHERE id=$1", [manager.id])).rows[0].token_version);

    await auth.resetPassword(requested.devToken, "brand-new-password-456");
    assert.equal(await bcrypt.compare("brand-new-password-456", (await pool.query("SELECT password_hash FROM users WHERE id=$1", [manager.id])).rows[0].password_hash), true);
    const versionAfter = Number((await pool.query("SELECT token_version FROM users WHERE id=$1", [manager.id])).rows[0].token_version);
    assert.equal(versionAfter, versionBefore + 1, "the password reset bumps token_version, killing old access tokens");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM refresh_sessions WHERE user_id=$1 AND revoked_at IS NULL", [manager.id])).rows[0].n, 0,
      "every refresh session is revoked");
    await assert.rejects(() => auth.refresh(session.refreshToken, meta()), /refresh_reused|refresh_invalid/);
    await assert.rejects(() => auth.login(manager.email, PASSWORD, meta()), /invalid_credentials/);
    assert.ok((await auth.login(manager.email, "brand-new-password-456", meta())).token);

    // Single use: the same token cannot be replayed.
    await assert.rejects(() => auth.resetPassword(requested.devToken, "another-password-789"), /reset_token_invalid/);

    // Expired tokens are refused even when unused.
    const expired = "expired-token-value-for-tests";
    await pool.query(
      "INSERT INTO password_reset_tokens(user_id, token_hash, expires_at) VALUES ($1, encode(sha256($2::bytea),'hex'), now() - interval '1 minute')",
      [manager.id, expired],
    );
    assert.deepEqual(await auth.verifyResetToken(expired), { valid: false });
    await assert.rejects(() => auth.resetPassword(expired, "another-password-789"), /reset_token_invalid/);

    // A new request invalidates the previous unused link.
    const first = await auth.requestPasswordReset(manager.email, "127.0.0.1");
    const second = await auth.requestPasswordReset(manager.email, "127.0.0.1");
    await assert.rejects(() => auth.resetPassword(first.devToken, "another-password-789"), /reset_token_invalid/);
    assert.deepEqual(await auth.verifyResetToken(second.devToken), { valid: true });

    const auditCount = Number((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action='auth.password.reset' AND entity_id=$1", [manager.id])).rows[0].n);
    assert.ok(auditCount >= 1, "the successful reset is audited");
    const auditText = JSON.stringify((await pool.query("SELECT * FROM audit_log WHERE action LIKE 'auth.password.reset%'")).rows);
    assert.ok(!auditText.includes(second.devToken), "no reset token is written to the audit log");
  } finally {
    delete process.env.PASSWORD_RESET_DEV_MODE;
  }
});

/* ------------------------------------------------------------------ two-factor authentication */

test("2FA enrollment needs a valid code, stores the secret encrypted and blocks password-only login", { skip }, async () => {
  const u = await makeUser(shopA, "manager", `twofa-${Date.now()}@security.test`);
  const user = { id: u.id, role: "manager" as const, shopId: shopA };

  await assert.rejects(() => auth.startTwoFactorEnrollment(u.id, "wrong-password-1"), /current_password_incorrect/);
  const setup = await auth.startTwoFactorEnrollment(u.id, PASSWORD);
  assert.match(setup.otpauth, /^otpauth:\/\/totp\//);
  assert.match(setup.qrDataUrl, /^data:image\/png;base64,/);

  await assert.rejects(() => auth.enableTwoFactor(u.id, shopA, PASSWORD, "000000"), /invalid_code/);
  assert.equal((await auth.me(u.id)).twoFactorEnabled, false, "a failed code does not enable 2FA");

  const code = authenticator.generate(setup.secret);
  const enabled = await auth.enableTwoFactor(u.id, shopA, PASSWORD, code);
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.recoveryCodes.length, 10);

  const stored = (await pool.query("SELECT totp_secret, totp_enabled_at, totp_last_step FROM users WHERE id=$1", [u.id])).rows[0];
  assert.ok(stored.totp_enabled_at);
  assert.notEqual(stored.totp_secret, setup.secret, "the TOTP secret is not stored in plaintext");
  const { decryptSecret } = await import("../src/auth/security");
  assert.equal(decryptSecret(stored.totp_secret), setup.secret, "the stored secret decrypts with the server key");

  const profile = await auth.me(u.id);
  assert.equal(profile.twoFactorEnabled, true);
  assert.equal("totp_secret" in profile, false, "the secret is never returned by /auth/me");

  // Enrollment consumed the current time-step; allow the next login to use a fresh code.
  await pool.query("UPDATE users SET totp_last_step=totp_last_step-1 WHERE id=$1", [u.id]);

  // Password alone is no longer enough.
  const first = await auth.login(u.email, PASSWORD, meta());
  assert.equal(first.twoFactorRequired, true);
  assert.equal("token" in first, false, "no access token before the second factor");
  assert.equal("refreshToken" in first, false);
  const challengeToken = first.challengeToken;

  await assert.rejects(() => auth.verifyTwoFactorLogin(challengeToken, "111111", meta()), /invalid_code/);

  const accepted = await auth.verifyTwoFactorLogin(challengeToken, authenticator.generate(setup.secret), meta());
  assert.ok(accepted.token && accepted.refreshToken);

  // The same challenge cannot be consumed twice.
  await assert.rejects(() => auth.verifyTwoFactorLogin(challengeToken, authenticator.generate(setup.secret), meta()), /two_factor_challenge_invalid/);

  // Replay of an accepted time-step is refused with a fresh challenge.
  const next = await auth.login(u.email, PASSWORD, meta());
  await assert.rejects(() => auth.verifyTwoFactorLogin(next.challengeToken, authenticator.generate(setup.secret), meta()), /invalid_code/);

  // Recovery codes are single use.
  const recovery = enabled.recoveryCodes[0];
  const recLogin = await auth.login(u.email, PASSWORD, meta());
  const viaRecovery = await auth.verifyTwoFactorLogin(recLogin.challengeToken, recovery, meta());
  assert.ok(viaRecovery.token);
  const recAgain = await auth.login(u.email, PASSWORD, meta());
  await assert.rejects(() => auth.verifyTwoFactorLogin(recAgain.challengeToken, recovery, meta()), /invalid_code/);

  assert.equal(Number((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action='auth.2fa.recovery.used' AND entity_id=$1", [u.id])).rows[0].n), 1);
  assert.equal(Number((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action='auth.2fa.verified' AND entity_id=$1", [u.id])).rows[0].n), 1);

  // Disabling needs the password and a valid code, and restores password-only login.
  await assert.rejects(() => auth.disableTwoFactor(u.id, shopA, "wrong-password-1", "123456"), /current_password_incorrect/);
  await assert.rejects(() => auth.disableTwoFactor(u.id, shopA, PASSWORD, "000000"), /invalid_code/);
  await pool.query("UPDATE users SET totp_last_step=totp_last_step-1 WHERE id=$1", [u.id]);
  await auth.disableTwoFactor(u.id, shopA, PASSWORD, authenticator.generate(setup.secret));
  assert.equal((await auth.me(u.id)).twoFactorEnabled, false);
  const plain = await auth.login(u.email, PASSWORD, meta());
  assert.ok(plain.token, "login is password-only again");

  // 2FA is opt-in: other accounts are untouched.
  assert.equal((await auth.me(manager.id)).twoFactorEnabled, false);
});

test("a 2FA challenge is rate-limited: five wrong codes invalidate it", { skip }, async () => {
  const u = await makeUser(shopA, "manager", `twofa-limit-${Date.now()}@security.test`);
  const setup = await auth.startTwoFactorEnrollment(u.id, PASSWORD);
  const enabled = await auth.enableTwoFactor(u.id, shopA, PASSWORD, authenticator.generate(setup.secret));
  assert.ok(enabled.recoveryCodes.length);
  await pool.query("UPDATE users SET totp_last_step=totp_last_step-1 WHERE id=$1", [u.id]);

  const challenge = await auth.login(u.email, PASSWORD, meta());
  for (let i = 0; i < 5; i++) {
    await assert.rejects(() => auth.verifyTwoFactorLogin(challenge.challengeToken, "000000", meta()));
  }
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM two_factor_challenges WHERE user_id=$1", [u.id])).rows[0].n, 0,
    "the challenge is deleted after five failures");
  await assert.rejects(() => auth.verifyTwoFactorLogin(challenge.challengeToken, authenticator.generate(setup.secret), meta()), /two_factor_challenge_invalid/);
  await pool.query("UPDATE users SET totp_last_step=totp_last_step-1 WHERE id=$1", [u.id]);
  await auth.disableTwoFactor(u.id, shopA, PASSWORD, authenticator.generate(setup.secret));
});

/* ------------------------------------------------------------------ refresh sessions */

test("refresh tokens rotate and reuse outside the grace window revokes the whole family", { skip }, async () => {
  const u = await makeUser(shopA, "manager", `refresh-${Date.now()}@security.test`);
  const session = await auth.login(u.email, PASSWORD, meta());
  const rotated = await auth.refresh(session.refreshToken, meta());
  assert.notEqual(rotated.refreshToken, session.refreshToken, "the refresh token rotates on use");
  assert.ok(rotated.token);

  const stored = (await pool.query("SELECT id, token_hash, family_id, revoked_at, replaced_by FROM refresh_sessions WHERE user_id=$1 ORDER BY created_at, id", [u.id])).rows;
  assert.equal(stored.length, 2);
  assert.notEqual(stored[0].token_hash, session.refreshToken, "only a hash is stored");
  assert.equal(stored[0].family_id, stored[1].family_id, "rotation stays inside one session family");
  assert.ok(stored[0].revoked_at);
  assert.equal(stored[0].replaced_by, stored[1].id);

  // A real theft presents the old token long after the rotation: with the grace window disabled the
  // original, strict behaviour applies (revoke every session in the family).
  process.env.REFRESH_REUSE_GRACE_SECONDS = "0";
  try {
    await assert.rejects(() => auth.refresh(session.refreshToken, meta()), /refresh_reused/);
    await assert.rejects(() => auth.refresh(rotated.refreshToken, meta()), /refresh_reused/,
      "reusing a rotated token revokes the new token in the same family");
  } finally {
    delete process.env.REFRESH_REUSE_GRACE_SECONDS;
  }
  assert.ok(Number((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action='auth.refresh.reuse_detected' AND actor_id=$1", [u.id])).rows[0].n) >= 1,
    "reuse is recorded in the audit log");
});

/* The two cases below are the production failure: the browser presents a refresh token that was
 * rotated moments ago (two tabs refreshing together, or a rotation whose Set-Cookie never arrived
 * because the client timed out during a cold start). Neither may destroy the session. */

test("a quick replay inside the grace window keeps the family alive and rotates the live successor", { skip }, async () => {
  delete process.env.REFRESH_REUSE_GRACE_SECONDS; // default 30s
  const u = await makeUser(shopA, "manager", `grace-${Date.now()}@security.test`);
  const first = await auth.login(u.email, PASSWORD, meta("tab-a"));
  const second = await auth.refresh(first.refreshToken, meta("tab-a")); // tab A refreshes
  const third = await auth.refresh(first.refreshToken, meta("tab-b")); // tab B still holds the old one

  assert.ok(third.token && third.refreshToken, "the stale tab gets a working session instead of a lockout");
  assert.notEqual(third.refreshToken, second.refreshToken, "the replay rotates the live successor");
  assert.ok((await auth.refresh(third.refreshToken, meta("tab-b"))).token, "the newest token keeps working");

  const live = await pool.query("SELECT count(*)::int AS n FROM refresh_sessions WHERE user_id=$1 AND revoked_at IS NULL", [u.id]);
  assert.equal(live.rows[0].n, 1, "one live session row remains");
  assert.ok(Number((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action='auth.refresh.grace_reuse' AND actor_id=$1", [u.id])).rows[0].n) >= 1,
    "the benign replay is recorded distinctly from reuse detection");
});

test("simultaneous refreshes with one token all succeed and never revoke the session", { skip }, async () => {
  delete process.env.REFRESH_REUSE_GRACE_SECONDS;
  const u = await makeUser(shopA, "manager", `race-${Date.now()}@security.test`);
  const session = await auth.login(u.email, PASSWORD, meta());

  const results = await Promise.all([
    auth.refresh(session.refreshToken, meta("a")),
    auth.refresh(session.refreshToken, meta("b")),
    auth.refresh(session.refreshToken, meta("c")),
  ]);
  for (const r of results) {
    assert.ok(r.token, "every concurrent caller receives an access token");
    assert.ok((await auth.refresh(r.refreshToken, meta())).token, "every issued refresh token is usable");
  }
  const live = await pool.query("SELECT count(*)::int AS n FROM refresh_sessions WHERE user_id=$1 AND revoked_at IS NULL", [u.id]);
  assert.equal(live.rows[0].n, 1, "the session family is intact after the race");
});

test("logout revokes one session, logout-all revokes every session and old access tokens", { skip }, async () => {
  const u = await makeUser(shopA, "manager", `logout-${Date.now()}@security.test`);
  const a = await auth.login(u.email, PASSWORD, meta("phone"));
  const b = await auth.login(u.email, PASSWORD, meta("pc"));

  await auth.logout(a.refreshToken);
  await assert.rejects(() => auth.refresh(a.refreshToken, meta()), /refresh_reused|refresh_invalid/);
  const stillValid = await auth.refresh(b.refreshToken, meta());
  assert.ok(stillValid.token, "logging out one device keeps the other session");

  const versionBefore = Number((await pool.query("SELECT token_version FROM users WHERE id=$1", [u.id])).rows[0].token_version);
  await auth.logoutAll(u.id, shopA);
  assert.equal(Number((await pool.query("SELECT token_version FROM users WHERE id=$1", [u.id])).rows[0].token_version), versionBefore + 1);
  await assert.rejects(() => auth.refresh(stillValid.refreshToken, meta()), /refresh_reused|refresh_invalid/);
  assert.equal(Number((await pool.query("SELECT count(*)::int AS n FROM refresh_sessions WHERE user_id=$1 AND revoked_at IS NULL", [u.id])).rows[0].n), 0);

  // An access token minted before logout-all no longer matches token_version (the guard rejects it).
  const decoded = JSON.parse(Buffer.from(b.token.split(".")[1]!, "base64url").toString("utf8"));
  const current = await pool.query("SELECT token_version FROM users WHERE id=$1", [u.id]);
  assert.notEqual(decoded.tv, current.rows[0].token_version);
});

test("expired refresh sessions are refused and marked revoked", { skip }, async () => {
  const u = await makeUser(shopA, "manager", `expiry-${Date.now()}@security.test`);
  const session = await auth.login(u.email, PASSWORD, meta());
  await pool.query("UPDATE refresh_sessions SET expires_at=now() - interval '1 second' WHERE user_id=$1", [u.id]);
  await assert.rejects(() => auth.refresh(session.refreshToken, meta()), /refresh_expired/);
  assert.equal((await pool.query("SELECT revoke_reason FROM refresh_sessions WHERE user_id=$1", [u.id])).rows[0].revoke_reason, "expired");
  assert.ok((await auth.login(u.email, PASSWORD, meta())).token);
});

test("password change keeps this device signed in and revokes the other sessions", { skip }, async () => {
  const u = await makeUser(shopA, "manager", `change-${Date.now()}@security.test`);
  const other = await auth.login(u.email, PASSWORD, meta("other-device"));
  const result = await auth.changePassword(u.id, shopA, PASSWORD, "changed-password-789", meta("this-device"));
  assert.ok(result.token && result.refreshToken);
  await assert.rejects(() => auth.refresh(other.refreshToken, meta()), /refresh_reused|refresh_invalid/);
  assert.ok((await auth.refresh(result.refreshToken, meta())).token, "the device that changed the password stays signed in");
});

test("notifications remain scoped to the authenticated user, for every role", { skip }, async () => {
  assert.equal((await notifications.inbox(admin.id, null)).items.length, 0);
  await notifications.security(admin.id, null, "password_changed");
  assert.equal((await notifications.inbox(admin.id, null)).items.length, 1);
  assert.equal((await notifications.inbox(outsider.id, shopB)).items.length, 0);
});

/* ------------------------------------------------------------------ session hygiene + applicant states */

test("refresh sessions are purged 30 days after expiry; live sessions survive", { skip }, async () => {
  const u = await makeUser(shopA, "manager", `gc-${Date.now()}@security.test`);
  await pool.query(
    `INSERT INTO refresh_sessions(user_id, family_id, token_hash, expires_at) VALUES
       ($1, gen_random_uuid(), 'expired-session-hash', now() - interval '40 days'),
       ($1, gen_random_uuid(), 'live-session-hash', now() + interval '10 days')`,
    [u.id],
  );

  // Every new session runs the opportunistic purge (never a sign-in failure).
  assert.ok((await auth.login(u.email, PASSWORD, meta("gc-device"))).token);

  const hashes = (await pool.query("SELECT token_hash FROM refresh_sessions WHERE user_id=$1", [u.id])).rows.map((r: any) => r.token_hash);
  assert.equal(hashes.includes("expired-session-hash"), false, "a session expired 30+ days ago is purged");
  assert.equal(hashes.includes("live-session-hash"), true, "sessions inside the retention window are kept");
  assert.equal(hashes.length, 2, "the retained live session plus the one just created");
});

test("an applicant learns the info-required state only after proving the registration password", { skip }, async () => {
  const email = `info-${Date.now()}@security.test`;
  await pool.query(
    `INSERT INTO owner_applications(contact_name,email,phone,shop_name,location,category,status_token_hash,password_hash,status)
     VALUES ('Ivy Applicant',$1,'+250788000123','Info Mart','Kigali','Grocery','unused-status-hash',$2,'ADDITIONAL_INFORMATION_REQUIRED')`,
    [email, await bcrypt.hash(PASSWORD, 4)],
  );

  // Wrong password: the generic answer — no state leaks to a stranger.
  await assert.rejects(() => auth.login(email, "wrong-password-123", meta()), /invalid_credentials/);
  // Right password: the NAMED state, so the applicant opens their status page and replies.
  await assert.rejects(() => auth.login(email, PASSWORD, meta()), /application_info_required/);
  // Still no session: there is no account until approval.
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM users WHERE lower(email)=lower($1)", [email])).rows[0].n, 0);
});
