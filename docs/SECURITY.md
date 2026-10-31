# Security notes

## Implemented

- **Passwords:** bcrypt cost 12; policy 10–200 characters with a letter and a digit, enforced by the API.
  Never stored or logged in plaintext.
- **Access tokens:** short-lived JWT (`JWT_EXPIRES_IN`, default 15m) with `sub` + `token_version`. The
  guard re-reads the user row on every request (`active`, `token_version`), so revocation is immediate.
- **Refresh tokens:** 48 random bytes, only SHA-256 hashes stored in `refresh_sessions`, rotated on every
  use, bound to a user and a session family. Presenting a rotated token revokes the family and is audited.
- **Storage:** Android/iOS use `expo-secure-store` (Keystore/Keychain) for both tokens. The web keeps only
  the access token in memory; the refresh token is an `HttpOnly`, `SameSite=Strict`, `Secure` (HTTPS)
  cookie scoped to `/auth`. A readable CSRF cookie plus a required `x-csrf-token` header protect
  cookie-based refresh/logout.
- **Logout / logout-all / password change / password reset** revoke server-side sessions; the last three
  also bump `token_version`. Admin `POST /admin/users/:id/revoke` deactivates the account and bumps it.
- **Password reset:** cryptographically random single-use tokens, hash-only storage, configurable expiry,
  generic responses (no account enumeration), rate limits (5/min request, 20/min verify, 10/min reset),
  earlier links invalidated, audit row without secrets. Production e-mail delivery is **not** implemented;
  `PASSWORD_RESET_DEV_MODE` is ignored when `NODE_ENV=production`.
- **2FA (TOTP):** optional; `otplib` with a ±1 step window; secrets encrypted with AES-256-GCM using
  `TOTP_ENCRYPTION_KEY` and never returned by any endpoint or written to logs; enrollment requires the
  password plus a valid code; 10 single-use recovery codes stored as hashes; replay of an accepted
  time-step rejected; challenges expire after 5 minutes and are deleted after 5 wrong codes; disable and
  regeneration require password + code; every outcome is audited without codes/secrets.
- **Authorization:** role + shop scoping derived from the session, never from client input. The owner,
  manager and `system_admin` roles all use the same login path, so 2FA cannot be bypassed by another route.
  `/admin/*` exposes accounts and platform health only — no shop financial data.
- **Input validation:** zod on every auth/notification body; consistent error responses; no stack traces
  to clients; helmet; explicit CORS allow-list with `credentials: true` (specific origins only).
- **Rate limits:** login 8/min, refresh 30/min, forgot 5/min, reset 10/min, reset verify 20/min,
  2FA verify 10/min, global 240/min.
- **Audit trail:** append-only `audit_log` (DB triggers forbid UPDATE/DELETE) records logins, 2FA
  enrollment/verification/failures, password changes and resets, logout-all, refresh-token reuse and
  notification-independent security events. No password, reset token, TOTP secret or recovery code is
  written to it.
- **PWA caching:** the service worker caches app-shell static assets only. It skips any request with an
  `Authorization` header and every API prefix (`/auth`, `/sync`, `/reports`, `/notifications`, `/audit`,
  `/sales`, `/purchases`, `/shop`, `/admin`, `/health`), so authentication and business responses are
  never stored in the HTTP cache.
- **Notifications:** per-user, server-generated, scoped by the authenticated user; security notifications
  cannot be disabled. No third-party delivery provider is configured.

## Before production

1. Serve the API and web app over **HTTPS only**; set `COOKIE_SECURE=true` (or `trust proxy` +
   `X-Forwarded-Proto`) and verify the cookie flags.
2. Set a real `TOTP_ENCRYPTION_KEY` from a secrets manager and back it up: losing it disables 2FA
   verification for enrolled users (they would need a recovery code or an admin reset).
3. Configure an e-mail/SMS provider for password reset and set `PASSWORD_RESET_DEV_MODE=false`.
4. Keep the API and web app on the **same site** so the `SameSite=Strict` refresh cookie is sent.
5. Add a periodic cleanup of expired/revoked `refresh_sessions` and `password_reset_tokens` rows.
6. Use separate PostgreSQL roles (the app role should not own tables or have TRUNCATE/DROP).
7. Consider encrypted-at-rest local storage (SQLCipher) for lost-device risk.
8. Run `npm audit`, a dependency update pass and a penetration test. There is no CI.
9. Optional hardening not implemented: organisation-wide "require 2FA", a visible device/session list,
   password history/breach checks, WebAuthn, and alerting on repeated authentication failures.

## Lost or stolen device

An administrator calls `POST /admin/users/:id/revoke` (or the user signs out everywhere from **Security**).
Access and refresh tokens stop working immediately. Unsynced data on that device cannot be recovered
remotely.
