# Shop Management System (offline-first, Rwanda)

One system for **Android phones and PCs**: a NestJS + PostgreSQL backend, shared business logic, and a single Expo (React Native) app that runs natively on Android and as a responsive web app / PWA on Windows, macOS and Linux browsers. Default currency **RWF**. Languages: **English** and **Kinyarwanda**. Roles: **owner**, **manager**, **system_admin**.

> Read `docs/STATUS.md` first: it states exactly what is implemented, what was verified, and what is still missing.

## Repository layout
```
apps/api          NestJS API, SQL migrations, integration tests
apps/mobile       Expo app (Android + web/PWA for PC), SQLite outbox, sync engine, en/rw
packages/shared   Money/quantity arithmetic, moving-average costing, finance summary, zod operation schemas (+ unit tests)
infrastructure    docker-compose (Postgres), backup/restore scripts
docs              Architecture, offline, finance, security, backup, deployment
```

## Requirements
Node.js 20+ (22 recommended), npm 10+, PostgreSQL 15+ (or Docker), Android phone with the **Expo Go** app (or an Android emulator), a modern Chromium/Edge/Firefox browser for the PC version.

## 1. Install
```bash
npm install            # installs all workspaces and builds @sms/shared (postinstall)
```
## 2. Database
```bash
export POSTGRES_PASSWORD='choose-a-strong-password'
npm run db:up                                   # or use your own PostgreSQL
cp .env.example apps/api/.env                   # then edit: DATABASE_URL, JWT_SECRET (>=48 random chars), CORS_ORIGINS
# 2FA needs a 32-byte key: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
#   paste it as TOTP_ENCRYPTION_KEY. Password-reset e-mail needs a provider; for local testing set
#   PASSWORD_RESET_DEV_MODE=true (ignored in production).
cd apps/api && set -a && . ./.env && set +a
npm run migrate                                 # applies apps/api/migrations/*.sql
SEED_PASSWORD='a-long-dev-password' npm run seed   # DEV ONLY: demo shop + owner/manager/admin @demo.local
```
## 3. Start the backend
```bash
npm run api            # http://localhost:3000  (dev, watch mode)
# production: npm run build -w @sms/api && node apps/api/dist/main.js
```
## 4. Run the phone app (Android)
```bash
echo "EXPO_PUBLIC_API_URL=http://<your-PC-LAN-IP>:3000" > apps/mobile/.env   # phone and PC on same Wi-Fi
npm run mobile         # scan the QR code with Expo Go on the phone
```
For a standalone APK: `npx eas build -p android --profile preview` (needs an Expo account), see `docs/DEPLOYMENT.md`.

## 5. Run / install the PC version (Windows etc.)
```bash
npm run web                        # dev server on http://localhost:8081
EXPO_PUBLIC_API_URL=https://<api-host> npm run build:web -w @sms/mobile   # production static build in apps/mobile/dist
# the build fails if EXPO_PUBLIC_API_URL is missing, loopback or not HTTPS (ALLOW_LOCAL_API=1 overrides)
npx serve apps/mobile/dist -l 8081 --single   # --single is required: client-side routes
```
Host the static files over HTTPS and rewrite unknown paths to `index.html`, otherwise refreshing on `/stock` or `/login` returns 404. The export includes `manifest.json` and an app-shell service worker; it never caches `/auth`, `/sync`, `/reports` or any other API response. Set `COOKIE_SECURE=true` on the API when it is served over HTTPS (the refresh cookie is `HttpOnly; SameSite=Strict`).

In Edge/Chrome open the HTTPS site → **Install app** (address bar icon) to run it as a desktop PWA. Layout switches automatically: ≥ 900 px wide = sidebar + top bar + tables; narrower = bottom navigation, stacked cards and a **More** tab.

Web storage uses **IndexedDB** (the web build does not use expo-sqlite); the previous localStorage store is imported automatically. See `docs/OFFLINE.md`.

## 6. Tests
```bash
npm run test:shared                                   # runs anywhere, no DB needed
npm run test:mobile                                   # English/Kinyarwanda parity, placeholders, untranslated copies
TEST_DATABASE_URL=postgres://... npm run test:api     # 44 real-Postgres tests in 4 files (sync, security, finance, onboarding)
npm run typecheck
```

### API tests need a throwaway database (`TEST_DATABASE_URL`)

Every API test file starts by dropping and recreating the `public` schema of the database named in
`TEST_DATABASE_URL`, then applies all `apps/api/migrations/*.sql`, and files run one at a time
(`--test-concurrency=1`). **Never point it at your development database.** The root command
`npm run test:api` checks the variable first (`scripts/require-test-db.mjs`): if it is missing or not
a `postgres://` URL the command **fails immediately** with setup instructions instead of reporting a
misleading green run. (The individual test files still skip themselves when run directly through
`npm run test -w @sms/api` without the variable — useful when you deliberately want a database-free
run.) The suite never falls back to the development `DATABASE_URL`.

```bash
createdb sms_test    # once; any empty throwaway DB works (psql -c "CREATE DATABASE sms_test")
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/sms_test npm run test:api
```

### The onboarding suite runs over real HTTP (and rebuilds `apps/api/dist`)

`apps/api/tests/onboarding.integration.test.ts` boots the actual Nest app on a random port and drives
it with `fetch`, so the real guards, `@Roles`, throttles and validation are what gets tested. Nest's
dependency injection needs `design:paramtypes` metadata, which **only `tsc` emits** — esbuild (and
therefore `tsx`) never does, so a guard would receive an `undefined` `Reflector` and every request
would 500. The test's `before()` hook therefore runs `npx tsc -p tsconfig.json` (plain `tsc`, already
a devDependency) and imports the compiled `../dist/app.module`. Side effect to be aware of: running
this suite refreshes `apps/api/dist/`; delete it if you want a pristine tree.

### Continuous integration (`.github/workflows/ci.yml`)

Every push to `main`/`master` and every pull request runs the full verification in GitHub Actions:
`npm ci` (reproducible install from the committed lockfile), `npm run typecheck`, `test:shared`,
`test:mobile`, and `npm run test:api` — the complete 44-test API integration suite including the
onboarding lifecycle. The job runs against a **`postgres:16` service container** with a health check
(`pg_isready`) and a dedicated throwaway `sms_test` database supplied via `TEST_DATABASE_URL`; no
secrets are required and the workflow has read-only permissions. Because `apps/api/dist/` is
gitignored, the onboarding suite builds it itself with plain `tsc` during the run — CI never relies
on a pre-existing build.

End-to-end web check (API + web export running, Chrome installed):
```bash
node apps/mobile/tests/e2e-web.mjs   # logs in, sells, receives, reloads offline, approves, checks admin
node apps/mobile/tests/e2e-pwa.mjs   # manifest/installability, offline download, cached report with API blocked
```
It writes demo records to the development database. See `docs/STATUS.md` for the latest results.

## Behaviour summary
- Every write (sale, purchase, receipt, expense, count, adjustment, product, supplier) is saved to the **local SQLite outbox first**, then pushed to `POST /sync/push` with a stable `opId`. The server's `operations` table (PK = opId) makes replays idempotent; verdicts are `applied | duplicate | conflict | rejected | pending_approval`.
- Stock = append-only **ledger** (`stock_movements`, DB triggers forbid UPDATE/DELETE). Quantity on hand is derived.
- Overselling or over-receiving never overwrites anything: the op is stored as a **conflict** for owner review.
- **Receiving stock without creating a duplicate:** on Stock, *Add stock* records a purchase received now against the selected existing product (quantity, unit cost, selling price, supplier, invoice reference, date, notes, amount paid) and shows previous stock, quantity received and the resulting stock before confirming. *Edit product* changes name, code, barcode, unit, price or low-stock threshold only — it never moves stock. Both are offline-first operations with a stable `opId`, so a retried sync cannot receive the same stock twice. Owners and managers may receive stock; only the owner changes shop-wide rules.
- Purchases can be received immediately or kept open and received later, in one or several deliveries; received quantity may never exceed the ordered quantity. A line records quantity, purchase unit/conversion, unit or total cost, selling price, expected revenue/profit and margin.
- Below-cost selling prices require an explicit reason and are audited; the owner can instead block managers. Managers have an owner-set discount ceiling. Both rules are enforced by the API.
- Sales record a payment method (cash, mobile money, bank, credit), amount paid, balance and change. Completed sales are never edited or deleted: the owner can void one once, with a reason, which returns stock and keeps the record for audit.
- Counts compare expected vs counted, open an **investigation** (neutral wording), and never auto-correct stock. Corrections go through **owner-approved adjustments**.
- The manager dashboard shows real operational data. Cost, COGS and profit are owner-only unless the owner enables manager financial access; the API enforces that. **Managers have Reports**: the sales ledger (with a posted/voided filter), a **Products sold** view with units and value per product, purchases, expenses, CSV export and a **sale dialog with its line items**, all shop-scoped and without cost or profit. Voiding stays owner-only. The system administrator has a separate area for shops, users and health, and no route exposes a shop's financial data to that role.
- **Settings** has working sections for the account (e-mail, shop, role), the display name, **password change** (current + new, at least 10 characters with a letter and a number, other devices are signed out), the shop name (owner), the shop policy (owner), **notifications**, **account security**, language, appearance, and this device's storage/sync state with **Sync now**. Password fields have a show/hide eye button on phone and PC, localised in English and Kinyarwanda.
- **Authentication:** short-lived access tokens plus rotating, hashed refresh tokens; reuse of a rotated token revokes the session family; logout, logout-all, password change/reset and admin revocation take effect immediately. Android keeps both tokens in SecureStore; the web keeps the refresh token in an HttpOnly `SameSite=Strict` cookie (CSRF-protected with a double-submit token) and only the access token in memory.
- **Password recovery:** “Forgot password?” on the login screen, single-use hashed reset tokens with a configurable expiry, generic responses, rate limits and full session revocation after a reset. The reset page is localised and shows clear success/failure states. **No e-mail provider is configured**, so production delivery is not implemented; `PASSWORD_RESET_DEV_MODE=true` returns the link in development only.
- **Two-step verification (TOTP):** optional per account. Enrollment shows a QR code and manual key once, requires a valid code, stores the secret AES-256-GCM encrypted (`TOTP_ENCRYPTION_KEY`), issues 10 single-use recovery codes (hashes only), block password-only login, rejects replayed codes and rate-limits attempts. Paths and the token lifecycle are documented in `docs/AUTH.md`.
- **Notifications:** per-user preferences (low stock, out of stock, sales activity, inventory updates) enforced by the API when alerts are generated; security notifications cannot be turned off. Alerts are **in-app only** — no SMS, e-mail or push is sent because no provider is configured.
- Money is integer RWF; quantities are integer milli-units. No floating point in money paths. Purchases are inventory, not expenses; COGS comes from the ledger using moving weighted average.
