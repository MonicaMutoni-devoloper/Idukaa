# Implementation status (evidence-based)

Last verified: 28 October 2026, on Windows 11 with Node 24.11, PostgreSQL 18, Chrome (headless),
the API running against the development database plus a throwaway `sms_test` database, and the web app
served by the Expo dev server.

> Supersedes earlier notes. Everything in section 1 was executed in this workspace; section 3 lists
> what was **not** run here.

## 1. Verified this session

| Area | How it was checked | Result |
|---|---|---|
| TypeScript (API, mobile, shared) | `npm run typecheck` | clean |
| Money, quantities, moving average, finance summary, purchase-line arithmetic | `npm run test:shared` | 26/26 pass |
| API + PostgreSQL integration (`sms_test`) | `TEST_DATABASE_URL=… npm run test:api` | 44/44 pass (18 sync + 10 security + 9 finance + 7 onboarding-over-HTTP) |
| English/Kinyarwanda parity, no empty/copied strings, matching placeholders | `npm run test:mobile` | 5/5 pass |
| Root API test command without a test database | `npm run test:api` (no `TEST_DATABASE_URL`) | fails with exit 1 and setup instructions (`scripts/require-test-db.mjs`) — no misleading green run, no fallback to `DATABASE_URL` |
| CI workflow definition | `node -e "require('js-yaml').load(...)"` over `.github/workflows/ci.yml` | parses; triggers, read-only permissions, `postgres:16` service + health check, `TEST_DATABASE_URL` and all 7 steps present. **Not executed on GitHub Actions from this environment** — see §3 |
| Web export | `npm run build:web -w @sms/mobile` | export produced in `apps/mobile/dist` |
| Web app in Chrome, full flows | `node apps/mobile/tests/e2e-web.mjs` | 16 scenarios pass on two consecutive runs, no runtime console errors |
| PWA shell | headless Chrome against the static export on `http://localhost` | manifest complete, service worker active and controlling, 10 shell assets cached, no API path cached, offline reload renders the shell |
| Migration 004 on the development database | `npm run migrate` | applied |

### API integration tests (real PostgreSQL, no mocks)

Existing coverage (unchanged): receipts and cumulative-delivery limits; sale totals and ledger
movements; idempotent replay; oversell conflicts; count → investigation; owner approvals; role and shop
isolation; immutable ledger/audit; incremental pull; open purchases; payment method and the manager
discount ceiling; below-cost acknowledgement/audit/policy; sale void; CSV escaping; manager financial
data gating; receiving stock into an existing product without duplication; sale detail; products sold;
name change and password rotation; owner-only shop rename and route role metadata.

New in `apps/api/tests/security.integration.test.ts`:

- Notification preferences are persisted per user, defaults apply, and one user cannot read or change
  another user's preferences.
- Low-stock/out-of-stock alerts are generated only when enabled, are de-duplicated, and stay inside the
  shop; security notifications are delivered even when every optional category is off; marking read
  lowers the unread count.
- Password reset answers identically for unknown accounts, stores only a hash, verifies, expires,
  is single-use, invalidates earlier links, bumps `token_version`, revokes refresh sessions and is
  audited without the token.
- 2FA enrollment needs a correct password **and** a valid code; the secret is stored encrypted (and
  decrypts with the server key), `/auth/me` never returns it; password-only login returns a challenge
  with no token; wrong codes and replayed codes are rejected; a challenge is deleted after five failures;
  recovery codes work once; disabling needs password + code; other users are unaffected.
- Refresh tokens rotate, only hashes are stored, reuse revokes the whole family and is audited; logout
  revokes one session; logout-all revokes every session and invalidates old access tokens; expired
  refresh sessions are refused and marked; a password change keeps the current device and revokes others.

New in `apps/api/tests/finance.integration.test.ts` (a backdated January fixture pushed through the real
sync pipeline, then read back through the real report controllers):

- Calendar-month totals come from persisted records with Africa/Kigali day boundaries: an expense at
  23:59 Kigali stays in January, one at 00:00 lands in February, and purchases are inventory, not expenses.
- A later, more expensive purchase never rewrites the cost basis of earlier sales (moving average is
  computed per sale date).
- The profitability report's revenue, COGS, margins, evidence flags and advice line up with the ledger.
- A sale's discount is split exactly across its lines in the sale detail.
- Stock losses and sale-return refunds are exact, reported separately, and never double-counted into
  COGS or operating profit.
- Drill-down rows (adjustments) reconcile with the summary's period totals.
- Manager financial access is server-enforced (`financials: null`, 403 on `/reports/summary`) and every
  report stays shop-scoped.
- The dashboard's headline snapshots, monthly series and profitability slices agree with each other.
- Empty periods return zeros with margin **unavailable**, never 0%.

New in `apps/api/tests/onboarding.integration.test.ts` — the full registration/approval/invitation
lifecycle driven over **real HTTP** against the running Nest app (real guards, roles, throttles and
PostgreSQL, schema wiped per run):

- Submission validates on the server, refuses duplicate applications and addresses that already have
  an account, and issues a status token; status is reachable only with that token (never by id or
  e-mail), and only its SHA-256 hash is stored.
- Review: request-info → applicant responds → back to review; rejection is terminal with a visible
  reason and frees the address at the unique index; double approval / a second decision returns 409.
- Activation: generic 401 before the account is usable, an expired 7-day window is reported on the
  status page and re-issued by the administrator, password policy is enforced server-side, the
  credential is single use, and the audit log records every stage without ever containing a raw token.
- Shop creation happens once, by the activated owner only (anonymous, admin and repeat calls refused),
  and ties the application to the shop.
- Invitation: hash-only token, fixed `manager` role, ineligible targets refused, preview → accept →
  sign-in, single-use link; revoke is terminal, resend rotates the token, expiry flips the owner's row.
- Role enforcement: admin review and staff management return 401/403 for every wrong role.

**Bootstrap detail:** this file compiles the app with `npx tsc -p tsconfig.json` in its `before()` hook
and imports `../dist/app.module`. Nest DI needs `design:paramtypes`, which only `tsc` emits — esbuild
(`tsx`) does not, so guards would get an `undefined` `Reflector` and every request would 500. Running
the suite therefore refreshes `apps/api/dist/`.

### Browser scenarios exercised (real UI, real API)

1. Manager signs in.
2. Creates a product with opening stock and a barcode → server on-hand and barcode match; selling search
   finds it by barcode.
3. Records a sale paid by mobile money.
4. Records a purchase delivered immediately.
5. Saves a purchase without receiving, then receives it later.
6. Blocks the API, records a sale, reloads → the queued operation survives; reconnecting and pressing
   “Sync now” drains it and server stock matches (the queued sale ended at `attempts: 1`).
7. Receives stock below cost with a reason; the audit and product price are correct.
8. Requests a damage adjustment (`pending_approval`).
9. Adds stock to the same product (preview = previous + received), then edits its price without moving stock.
10. Manager opens Reports → Products sold, the sales ledger and a sale's line items.
11. Settings: password reveal/hide, profile rename persisted and restored, and **the session survives a
    page reload by exchanging the HttpOnly refresh cookie** (the access token is memory-only).
12. **Notifications:** toggles a preference, waits for the saved confirmation, reads the value back from
    the API, confirms `security` is always on, then restores the original value.
13. **Security:** the 2FA card and session controls render; `/auth/2fa` returns a status object without a
    secret.
14. Owner sees the dashboard, voids that sale (stock returns), drills into reports, approves the
    adjustment and saves shop policy.
15. Administrator gets a separate area, sees shops/users/health, is refused `/reports/*` (403).
16. Phone width (390 px): every manager screen — including **Notifications** and **Security** — renders the
    tab bar with no horizontal overflow.

## 2. What the product does now

See `README.md` for the summary, `ARCHITECTURE.md` for the design and **`AUTH.md`** for tokens, password
reset, 2FA and notifications.

- **Manager:** dashboard with real operational data; checkout (search by name/SKU/barcode, stock checks,
  discount limit, payment method, amount paid, balance); purchase entry with conversions and partial
  deliveries; Add stock and Edit product; Reports (sales, products sold, purchases, expenses, sale dialog);
  stock, counts and low stock; expenses; sync queue; notifications and account security; profile,
  password and device settings.
- **Owner:** business dashboard, transaction reports and CSV export, sale voiding, approvals,
  investigations and conflicts, shop name and shop policy, notifications, 2FA and session management.
- **System administrator:** shops, users (create/revoke) and health only — no tenant financial data.
- **Every role:** optional TOTP two-step verification, recovery codes, sign-out-everywhere, password
  recovery and per-user notification preferences (in English and Kinyarwanda).
- **Sessions:** 15-minute access tokens, rotating hashed refresh tokens, reuse detection, server-side
  revocation. The web keeps the refresh token in an HttpOnly `SameSite=Strict` cookie with double-submit
  CSRF protection; Android keeps both tokens in SecureStore.
- **Offline:** every write is stored in the local outbox first, retried with backoff, replayed
  idempotently, and never auto-resolved on conflict. A missing access token after an offline reload does
  not show cached data as a valid server session: sync simply resumes once a refresh succeeds.
- **PWA:** manifest (name, icons, start URL, standalone, theme/background colours) and an app-shell service
  worker that never caches `/auth`, `/sync`, `/reports`, `/notifications` or any other API response.

## 3. Not verified here

| Item | Why | What to do |
|---|---|---|
| GitHub Actions run of `.github/workflows/ci.yml` | No GitHub repository/runner available from this environment, so the workflow itself has not executed on Actions | Push to GitHub and watch the **CI** workflow; locally the same YAML parses and every command in it (`npm ci` equivalent install, typecheck, shared, mobile, `test:api` → 44/44) was run successfully. |
| Android on a physical device or emulator | No device/emulator or Expo Go in this environment | `npm run mobile`, scan the QR in Expo Go (SDK 58). Then follow the checklist in section 6. |
| Installed PWA over HTTPS | No HTTPS deployment or interactive browser session here; the install prompt cannot be exercised headlessly | Serve `apps/mobile/dist` over HTTPS with SPA fallback, open it, use **Install app**, then check login, refresh, logout and offline reload (section 6). |
| 2FA with a real authenticator app on a phone | No phone; enrollment was verified through the API and generated TOTP codes | On a phone: Security → set up 2FA, scan the QR with Google Authenticator/Authy, confirm, sign out, sign in with the code, then try a recovery code. |
| Production e-mail delivery for password reset | No provider credentials | Configure an e-mail/SMS provider and send `PASSWORD_RESET_URL?token=…`; until then only `PASSWORD_RESET_DEV_MODE` works (development/test). |
| Secure-cookie behaviour behind real HTTPS | Local API runs on `http://localhost`; `Secure` cannot be validated over plain HTTP | Set `COOKIE_SECURE=true` (or send `X-Forwarded-Proto: https`), verify the `sms_rt` cookie is `Secure; HttpOnly; SameSite=Strict` and that refresh works. |
| Kinyarwanda wording | Translated as a non-native speaker | Have a native speaker (ideally a shop owner) review `apps/mobile/src/localization/rw.ts`, especially the new `security.*`, `notifications.*`, `forgot.*` and `reset.*` keys. |
| CSV download shelf, multi-tab IndexedDB, installed APK | As before | See the previous notes; unchanged by this work. |

## 4. Known limitations and deliberate choices

1. **The dashboard works offline; other reports still need connectivity.** The dashboard is now
   calculated on the device from the records saved there (see `apps/mobile/src/services/local-dashboard.ts`)
   and labels each figure as calculated locally, pending synchronization, synchronized, failed or in
   conflict. It falls back to the last downloaded copy only when the device has no records for the
   requested period. Coverage starts at the oldest record on that device: older history still needs a
   connection, and the dashboard says so. Transaction lists, CSV export and voiding still need
   connectivity.
2. **Costing is moving weighted average**, recomputed from the ledger. Voiding a sale returns stock at the
   current average cost.
3. **Stock corrections** only happen through owner-approved adjustments.
4. **Expenses are immutable.**
5. **Transport, duty or purchase discounts are not allocated into unit cost.**
6. **Barcodes are typed, not scanned** (a keyboard-wedge scanner works). No camera scanner, no label printing,
   no uniqueness constraint.
7. **Not built:** PDF export, printing, receipt/supplier attachments, transfers, batches/expiry, cash
   reconciliation, **e-mail address changes**, SMS/e-mail/push notification delivery and production
   password-reset e-mail delivery.
8. **2FA is optional and off by default.** Nothing forces existing users to enroll; the owner/admin can
   ask them to. There is no organisation-wide "require 2FA" policy yet.
9. **Notification delivery is in-app only.** The preferences are real and enforced when alerts are
   generated, but no SMS/e-mail/push provider is configured, so the UI says so.
10. **No device/session list.** Sessions can be revoked individually only by the device holding the token
    (logout) or all at once (logout-all / admin revoke). There is no per-device session table in the UI.
11. **Refresh sessions are not garbage-collected.** Revoked/expired rows remain for audit; add a periodic
    `DELETE FROM refresh_sessions WHERE expires_at < now() - interval '30 days'` in production.
12. **The web cookie flow needs a same-site deployment** (`app.example.rw` + `api.example.rw`). Cross-site
    APIs would need `SameSite=None; Secure` and a different CSRF strategy.
13. **Web access token is memory-only**; a reload always performs one refresh. Offline after a reload, the
    shell and cached data render but server access waits for the network (the UI never claims otherwise).
14. **PC storage caveat:** clearing site data deletes unsynced work.
15. **Single-record IndexedDB store:** the whole local state is written as one record per mutation.
16. **No ESLint or Prettier.** CI now exists: `.github/workflows/ci.yml` runs typecheck, shared,
   mobile i18n and the full API suite against a `postgres:16` service on every push/PR — but it has
   **not been executed on GitHub Actions yet** (no repository/runner here), so its first real run is
   unverified. The E2E script is manual.
17. **The E2E script writes demo records** to the development database (`UI Test Rice …` products, their
    sales/purchases/voids, notification preference changes and a revoked `e2e-…@demo.local` account per
    run). Reset with a fresh database for a clean demo.
18. **Password policy:** at least 10 characters with a letter and a digit; there is no strength meter,
    no password history and no breached-password check.
19. **Login throttle is 8/minute per IP** (global 240/min). A shared NAT can therefore rate-limit several
    people signing in at once; tune `@Throttle` if that matters for a large shop.

## 5. How to run it (Windows PowerShell)

From the repository root:

```powershell
npm install
Copy-Item .env.example apps/api/.env      # edit DATABASE_URL, JWT_SECRET (>=32 chars), CORS_ORIGINS
# Optional but required for 2FA: a 32-byte key (base64 or 64 hex)
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # paste as TOTP_ENCRYPTION_KEY
# For local password-reset testing only:
#   PASSWORD_RESET_DEV_MODE=true
npm run migrate
$env:SEED_PASSWORD = "dev-password-2026"; npm run seed

# Terminal 1 – API (watch mode)
npm run api

# Terminal 2 – web app (dev server)
npm run web

# or serve the production export with a single-page fallback
npm run build:web -w @sms/mobile
npx serve apps/mobile/dist -l 8081 --single
```

Phone (same Wi-Fi): set `EXPO_PUBLIC_API_URL=http://<PC-LAN-IP>:3000` in `apps/mobile/.env`, then
`npm run mobile` and scan the QR code with Expo Go (SDK 58).

Demo accounts (development only): `owner@demo.local`, `manager@demo.local`, `admin@demo.local`,
password `dev-password-2026`.

## 6. Manual checks to run on your PC and phone

**Password recovery (PC):** set `PASSWORD_RESET_DEV_MODE=true`, restart the API, open `/login` →
“Forgot password?”, enter `manager@demo.local`, open the development link, set a new password, sign in.
Confirm the old password no longer works and other devices were signed out.

**2FA (PC then phone):** set `TOTP_ENCRYPTION_KEY`, restart the API, Settings → Account security → set up
2FA, scan the QR, enter the code, save the recovery codes. Sign out and sign in again: the code is
required. On the phone, repeat against the same account and check the code entry and recovery code. Turn
2FA off at the end if the demo account should stay password-only.

**Notifications:** Notifications → switch a category off, reload, confirm it stayed off; confirm the
security row cannot be switched off.

**HTTPS / PWA:** deploy the static export and API behind HTTPS (`COOKIE_SECURE=true`, `CORS_ORIGINS` =
the exact web origin). In Chrome/Edge, confirm the install icon appears, install, sign in, reload (the
access token is refreshed from the HttpOnly cookie), sign out, go offline and reload (shell renders), then
reconnect and sync a sale. In DevTools → Application: `sms_rt` must be `HttpOnly; Secure; SameSite=Strict`,
and the cache storage must contain no `/auth` or API URLs.

**Android device:** `npm run mobile`, open in Expo Go, then check sign-in, 2FA, password recovery (the
development link opens the reset screen in-app), notifications, language switching, keyboard behaviour on
the login/reset forms, airplane-mode sale → reconnect → sync, and logout/logout-all.

**Kinyarwanda:** switch to RW and read every new screen (login 2FA step, forgot/reset, security,
notifications) with a native speaker.

## 7. Verification commands

```powershell
npm run typecheck
npm run test:shared
npm run test:mobile
$env:TEST_DATABASE_URL = "postgres://.../sms_test"; npm run test:api
npm run build:web -w @sms/mobile
node apps/mobile/tests/e2e-web.mjs      # API :3000 + web :8081 (--single) must be running
```

The API test suite wipes (`DROP SCHEMA public`) the database in `TEST_DATABASE_URL`, applies every
migration and runs files one at a time. Always use a throwaway database:

```bash
createdb sms_test    # once; any empty throwaway DB works
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/sms_test npm run test:api
```

The onboarding suite boots the real Nest app over HTTP and rebuilds `apps/api/dist` first (`tsc`, not
`tsx`, because esbuild never emits the decorator metadata Nest DI relies on) — see README section 6.

`npm run test:api` (the root command) **requires** `TEST_DATABASE_URL` and exits 1 with instructions
when it is missing (`scripts/require-test-db.mjs`); only a direct workspace run
(`npm run test -w @sms/api`) skips. CI (`.github/workflows/ci.yml`) runs exactly these steps on every
push to `main`/`master` and every pull request, against an ephemeral `postgres:16` service and a
dedicated `sms_test` database — no secrets, read-only permissions.
