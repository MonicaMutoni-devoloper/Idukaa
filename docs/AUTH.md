# Authentication, sessions and account security

Implemented in `apps/api/src/auth/*` (`auth.service.ts`, `security.ts`), `apps/api/src/common/http.ts`,
`apps/api/src/notifications/*` and migration `004_auth_security_and_notifications.sql`.
Clients: `apps/mobile/src/services/api.ts`, `app/login.tsx`, `app/forgot-password.tsx`,
`app/reset-password.tsx`, `app/(app)/security.tsx`, `app/(app)/notifications.tsx`.

## 1. Token lifecycle

| Item | Value |
|---|---|
| Access token | JWT, `JWT_EXPIRES_IN` (default `15m`), claims `sub` (user id) and `tv` (`users.token_version`) |
| Refresh token | 48 random bytes (base64url), stored as a SHA-256 hash in `refresh_sessions` |
| Refresh lifetime | `REFRESH_TOKEN_TTL_DAYS` (default 30), clamped 1–365 |
| Rotation | Every successful refresh revokes the presented row (`revoke_reason='rotated'`) and inserts a new row in the same `family_id` |
| Reuse detection | Presenting an already-revoked token revokes the whole family and audits `auth.refresh.reuse_detected`; the client must sign in again |
| Revocation | `token_version` is bumped on password change, password reset, "sign out of all devices" and by the admin revoke route. `AuthGuard` re-reads the user row on every request, so old access tokens die immediately |
| Logout | Revokes only the presented refresh session |
| Logout all | Bumps `token_version` and revokes every refresh session of the user |
| Expired access token | The client refreshes once (single in-flight request, no retry loop) and retries the original request once |
| Failed refresh | Clears the local token; the local database, outbox and cached screens are kept |

**Where tokens live**

- Android/iOS: access **and** refresh token in `expo-secure-store` (Android Keystore / iOS Keychain).
- Web: the refresh token never reaches JavaScript. It is set as `sms_rt` — `HttpOnly`, `SameSite=Strict`,
  `Secure` when HTTPS, `Path=/auth`, `Max-Age` = refresh lifetime. The access token is kept in memory
  only; after a reload the browser exchanges the cookie for a new short-lived access token. The user
  record (id, name, role, shop) is kept in `localStorage` for instant rendering; it is not a credential.
- No token is ever placed in a URL, a log line or a cached HTTP response. The service worker skips
  `/auth`, `/sync`, `/reports`, `/notifications` and every other API prefix.

**CSRF (web cookie flow).** Login/refresh also set a readable `sms_csrf` cookie. A cookie-based
`POST /auth/refresh` or `/auth/logout` must send `x-csrf-token` equal to that cookie (double submit) and
is rejected with `403 csrf_failed` otherwise. Native clients send the refresh token in the JSON body.

> The cookie is `SameSite=Strict`. Serve the API and the web app on the **same site** (same registrable
> domain, e.g. `app.example.rw` + `api.example.rw`). An API on an unrelated domain cannot use the cookie
> flow, because browsers will not send a strict cross-site cookie.

## 2. Endpoints

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/auth/login` | public | Returns a session, or `{ twoFactorRequired, challengeToken }` when 2FA is on. Rate limit 8/min |
| POST | `/auth/refresh` | public | Body `{ refreshToken? }` or the `sms_rt` cookie + `x-csrf-token`. Rotates |
| POST | `/auth/logout` | public | Revokes the presented session, clears cookies |
| POST | `/auth/logout-all` | access token | Revokes every session and bumps `token_version` |
| GET | `/auth/me` | access token | Profile + `twoFactorEnabled` (never the secret) |
| PATCH | `/auth/me` | access token | Display name only (no e-mail change route exists) |
| POST | `/auth/password` | access token | Current + new password; other devices are signed out |
| POST | `/auth/password/forgot` | public | Always `{ ok: true }`; 5/min |
| POST | `/auth/password/reset/verify` | public | `{ valid: boolean }`; 20/min |
| POST | `/auth/password/reset` | public | Single-use token + new password; 10/min |
| GET | `/auth/2fa` | access token | `{ enabled, recoveryCodesRemaining, encryptionConfigured }` |
| POST | `/auth/2fa/setup` | access token | Password → secret, `otpauth://` URI and a PNG QR code |
| POST | `/auth/2fa/enable` | access token | Password + code → enables, returns 10 recovery codes once |
| POST | `/auth/2fa/disable` | access token | Password + code (TOTP or recovery) |
| POST | `/auth/2fa/recovery-codes` | access token | Password + code → new codes, old ones deleted |
| POST | `/auth/2fa/verify` | public | `challengeToken` + code → session; 10/min, 5 attempts per challenge |
| GET/PUT | `/notifications/preferences` | access token | Per-user, defaults on first read |
| GET | `/notifications` | access token | Inbox (50 newest) + unread count + preferences |
| POST | `/notifications/read` | access token | `{ ids?: [] }`; all unread when omitted |

## 3. Password reset

- Token: 48 random bytes, only `sha256(token)` stored in `password_reset_tokens`, expiry
  `PASSWORD_RESET_TTL_MINUTES` (default 30, 5–240), single use (`used_at`).
- Issuing a new link invalidates earlier unused links for that user.
- Unknown e-mail, disabled account and malformed body all return `{ ok: true }` — no account enumeration.
- A successful reset bumps `token_version`, revokes every refresh session, invalidates remaining reset
  links and writes `auth.password.reset` (no password or token in the audit row).
- Password policy (server): 10–200 characters, at least one letter and one digit. bcrypt cost 12.
- **Delivery:** this repository has no e-mail provider, so production e-mail delivery is **not**
  implemented. `PASSWORD_RESET_DEV_MODE=true` (ignored when `NODE_ENV=production`) makes the API return
  `devToken` / `devUrl` and prints the link to the local console; the Forgot-password screen shows that
  link with a "Development only" warning. In production without a provider the request still answers
  generically but no link can reach the user — configure an e-mail/SMS provider before relying on it.

## 4. Two-factor authentication (TOTP)

- `otplib` (TOTP, 30 s step, ±1 step drift) + `qrcode` for the enrollment QR.
- Optional per account; nothing is enabled automatically. The secret is generated with 160 bits,
  stored **AES-256-GCM encrypted** (`TOTP_ENCRYPTION_KEY`, 32 bytes base64 or 64 hex). Without the key
  enrollment fails closed with 503 `two_factor_not_configured`.
- Enrollment: password → QR + manual key (only during enrollment) → 6-digit code → enabled.
  The plaintext secret is never returned by `/auth/me`, notifications, logs or the audit log.
- Login: password → `two_factor_challenges` row (5-minute challenge, hashed token, max 5 attempts) →
  TOTP code or recovery code → session. A consumed challenge cannot be reused.
- Replay: the accepted time-step is stored in `users.totp_last_step`; the same or an older code is
  rejected. (Changing the secret clears it.)
- Recovery codes: 10 codes, `XXXXX-XXXXX`, only SHA-256 hashes stored, single use, regenerable after
  password + code reauthentication.
- Disabling and regenerating require the password plus a current TOTP/recovery code.
- Audited: `auth.2fa.enabled`, `.disabled`, `.verified`, `.recovery.used`, `.enroll.failed`,
  `.verify.failed`, `.disable.failed`, `.recovery.regenerated`. Codes and secrets are never logged.
- All roles (`owner`, `manager`, `system_admin`) use the same login path, so no role can bypass 2FA.

## 5. Notifications

- `notification_preferences` (one row per user) stores optional categories: low stock, out of stock,
  sales activity, inventory updates. `security` is deliberately not a column and is always delivered.
- `GET /notifications` generates the optional alerts this user may receive (low/out-of-stock from the
  ledger-derived quantity, other people's sales and purchases from the last 24 hours), de-duplicated per
  entity for 12 hours, then returns the newest 50.
- Security notifications (`password_changed`, `password_reset_requested`, `password_reset_completed`,
  `two_factor_enabled/disabled`, `two_factor_login`, `recovery_code_used`, `recovery_codes_regenerated`)
  are inserted by the auth flows regardless of preferences.
- **Delivery:** in-app only. No SMS, e-mail or push provider is configured, so nothing pretends to send them.

## 6. Configuration

See `.env.example`. Relevant keys: `JWT_SECRET`, `JWT_EXPIRES_IN`, `REFRESH_TOKEN_TTL_DAYS`,
`TOTP_ENCRYPTION_KEY`, `TWO_FACTOR_CHALLENGE_MINUTES`, `PASSWORD_RESET_URL`,
`PASSWORD_RESET_TTL_MINUTES`, `PASSWORD_RESET_DEV_MODE`, `COOKIE_SECURE`, `CORS_ORIGINS` (must list the
exact web origin; credentials are enabled).

## 7. Migration and rollback

`004_auth_security_and_notifications.sql` is additive: new tables and nullable `users` columns, no
rewrite of existing rows. Existing users keep their passwords and are not enrolled in 2FA. Rollback
statements are at the bottom of the file; rolling back signs every device out and disables 2FA.

## 8. Tests

`apps/api/tests/security.integration.test.ts` (real PostgreSQL): preference isolation and enforcement,
security notifications, generic reset answers, hashed/expiring/single-use tokens, session invalidation on
reset, encrypted TOTP secret, password-only login blocked, wrong codes, replay, recovery-code single use,
challenge lockout after five attempts, refresh rotation, reuse detection, logout, logout-all, expired
refresh, password change. Browser coverage is in `apps/mobile/tests/e2e-web.mjs`.
