# Production deployment status

**Project:** Shop Management System (npm workspaces: `apps/api`, `apps/mobile`, `packages/shared`)
**Last updated:** 31 October 2026
**Status: NOT YET DEPLOYED.** GitHub + CI are done. Neon production `iduka-prod` is **migrated**:
9/9 migrations recorded, 28 tables, 0 rows of data (no demo seed) — §8.1. The Render Web Service
exists but its first deploy **failed** with `nest: not found` (exit 127); the one-field dashboard fix
is in §6.2 and has not been applied yet. Vercel is not created (§6.3). The web export now refuses to
build without a usable `EXPO_PUBLIC_API_URL`. Live verification (§8) cannot run until both services
exist — `scripts/verify-deployment.mjs` automates its machine-checkable half.

This file is the resume point for the next session: read §1 (what was already done), §3 (what this
session changed), and §9 (what is still blocked on you). Never commit real secrets to this file —
names only.

---

## 1. What the previous session had actually done

Investigated on 31 Oct 2026 by inspecting the workspace for evidence, not plans:

| Area | Evidence found | Status |
|---|---|---|
| Application code, tests, docs | `docs/STATUS.md` (verified 28 Oct 2026), 62 API tests, 26 shared, 5 i18n, 19-scenario browser E2E, CI workflow | COMPLETE (pre-existing) |
| Git repository | **No `.git` directory anywhere**; no remote; no branch | NOT STARTED |
| `.gitignore` | Existed but only covered `node_modules`, `dist`, `.env`, `.expo`, `*.log`, `backups/` | NEEDS VERIFICATION → hardened this session |
| GitHub remote | `git remote -v` empty; no `gh` CLI; no credentials | BLOCKED at investigation → **COMPLETE this session (§5)** |
| Neon production database | Project `iduka-prod` (`hidden-pine-19642939`, `aws-eu-central-1`, branch `production`, db `neondb`) found in the authenticated Neon org; both `.env.production` strings connect read-only, TLS confirmed at the socket | MIGRATED this session: 9/9 applied, 28 tables, 0 rows (§8.1) |
| Render API service | Service exists on the repo (first deploy 31 Oct 12:06); no `render.yaml` in the repo, so all settings live in the dashboard | DEPLOY FAILED (exit 127, devDependencies) → fix in §6.2 |
| Vercel frontend | No `vercel.json`, no Vercel notes | NOT STARTED → configured this session (§6) |
| Deployment progress record | This file did not exist | NOT STARTED → created now |
| Public health endpoint | Only `/admin/health`, which requires a `system_admin` token | FIXED this session (§3) |
| Demo seed script | No production guard | FIXED this session (§3) |

**Conclusion:** the previous session stopped after the local readiness work and before Phase 3
(GitHub). Nothing was deployed, nothing was half-configured, and no external resources exist that
could be duplicated.

---

## 2. Verification actually run this session (31 Oct 2026)

| Check | Command | Result |
|---|---|---|
| Typecheck (api + mobile + shared) | `npm run typecheck` | clean |
| Shared unit tests | `npm run test:shared` | **26/26 pass** |
| Mobile i18n tests | `npm run test:mobile` | **5/5 pass** |
| API integration tests (real PostgreSQL) | `TEST_DATABASE_URL=…sms_test npm run test:api` | **62/62 pass** (first run: 1 failure, see §3) |
| API tests again after every change in §3 | same | **62/62 pass** |
| Production web build | `npm run build:web -w @sms/mobile` | export written to `apps/mobile/dist` (manifest.json + sw.js present) |
| Browser E2E (Chrome, real API + built web app) | `node apps/mobile/tests/e2e-web.mjs` | first run **FAILED** at the application-tracking scenario; after the §3 fix: **19/19 scenarios pass, no console errors** |
| Health endpoint | `GET /health` on a locally built API | `200 {"status":"ok","db":"ok"}` |
| Unauthenticated access | `GET /sync/pull`, `GET /admin/health` | `401` / `401` (global default-deny guard) |
| Security headers | `curl -D /health` | helmet: CSP, HSTS, X-Content-Type-Options, Referrer-Policy, X-Frame-Options |
| Cookie policy knob | login response with and without `COOKIE_SAMESITE` | default `SameSite=Strict`; `COOKIE_SAMESITE=none` → `Secure; SameSite=None` |
| Secret scan before the first commit | pattern search over the whole tree | only placeholder strings (`CHANGE_ME`, `ci:ci`, `user:pass` in docs); no keys, tokens or credentialed URLs |
| GitHub Actions CI (first ever run) | push of `67d934c` to `main` | run #1 **success** in 1m 2s; all 9 steps green, including the API suite against the `postgres:16` service |
| Startup logs leak secrets? | grep of API log for `postgres://`, `password`, `secret` | only route names (`/auth/password/…`), no values |

---

## 3. What this session changed (all committed)

1. **`apps/api/tests/security.integration.test.ts`** — stale fixture: the applicant INSERT omitted
   `location`/`category`, both `NOT NULL` since migration `005`. The real registration flow sends
   them; the test was behind the schema. **This was the only failing test.**
2. **`apps/api/src/common/health.controller.ts` (new)** — public `GET /health` (status, db reachability,
   uptime; nothing sensitive). `200` when the database answers, `503` when it does not. Registered in
   `app.module.ts`. Needed because Render's health check cannot authenticate against `/admin/health`.
3. **`apps/api/src/db/seed.ts`** — refuses to run when `NODE_ENV=production`, so demo shops/users can
   never be written to the production database by accident.
4. **`apps/api/src/db/migrate.ts`** — uses `DIRECT_URL` when set (Neon's non-pooling endpoint) and
   fails fast with a clear message if neither URL is configured. Runtime traffic still uses the
   pooled `DATABASE_URL`.
5. **`apps/mobile/app/{register,login,application-status}.tsx`** — the status token was a single
   storage key, so a second registration on the same browser overwrote the first applicant's token and
   “Track your application” opened the wrong file (this is exactly what the E2E caught). The token is
   now also stored per e-mail, and the login screen passes the e-mail it was trying to sign in with.
   **This is a product bug, not just a test bug.**
6. **`apps/api/src/common/http.ts`** — `COOKIE_SAMESITE` env knob (`strict` default = unchanged
   behaviour, `none` forces `Secure`) because `*.vercel.app` → `*.onrender.com` is a cross-site
   request and `SameSite=Strict` would otherwise drop the refresh cookie (see §7).
7. **`.gitignore`** — added `.env.*` (with `!.env.example`), `*.pem`, `*.key`, `*.p12`, `*.keystore`.
8. **`.env.example`** — documented `DIRECT_URL` and `COOKIE_SAMESITE`.
9. **`vercel.json` (new)** — install/build/output + SPA fallback for the static export.
10. **Git repository initialized** on branch `main`, first commit `c57d60f` (180 files, no `.env`,
    no key material).

---

## 4. Security and data isolation (Phase 2) — findings

Verified by tests that were executed, not by reading code alone:

- **Server-side shop isolation** — passing in the 62-test run: `sync.integration.test.ts`
  (“role + shop isolation: owners cannot record sales; other shop cannot use this shop's product”),
  `finance.integration.test.ts` (shop B's January sale never appears in shop A's totals),
  `security.integration.test.ts` (notifications and preferences never cross users/shops),
  `onboarding.integration.test.ts` (role enforcement 401/403 across every wrong role).
  Every controller scopes by `u.shopId`; `AuthGuard` is registered as a **global** `APP_GUARD`
  (default deny, `@Public()` only on login/refresh/registration/status routes) and re-reads the user
  row every request, so revoked accounts and bumped `token_version` die immediately.
- **The reported “products from one shop appear in another” issue** — two layers now:
  *server*: pull/queries are `WHERE shop_id = $1`; *client*: `bindShop()` drops the cached catalogue
  and pull checkpoints whenever a different shop signs in on the same device/browser (web IndexedDB
  and native SQLite implementations both). Covered by the E2E scenario
  “no other shop's products leak into the new owner's stock” — **PASS**.
- **Offline sync cannot cross shops or duplicate stock** — outbox rows are keyed by `op_id`
  (server rejects an `op_id` owned by another shop), replays answer `duplicate`, and the E2E run
  showed queued operations surviving a reload and draining exactly once (`attempts: 1`).
- **Passwords** — bcrypt (cost 12 for seeded/admin-created users), policy ≥10 chars with letter+digit,
  enforced server-side.
- **Tokens/sessions** — 15-minute access tokens, rotating **hashed** refresh tokens with reuse
  detection and family revocation, `token_version` bump on password change, HttpOnly cookie on web.
- **Owner verification / admin creation** — onboarding suite (over real HTTP): activation links are
  single-use and hash-only, shop creation only by the activated owner, `system_admin` cannot be
  created through public registration (only via `POST /admin/*` behind the `system_admin` role, or
  directly in SQL as documented).
- **Error handling** — global filter returns `{error:"internal_error"}` for anything unexpected;
  Zod errors → 400. DB details are logged, never returned.
- **Audit log** — sensitive operations (login/failed login, approvals, voids, adjustments, policy
  changes, admin actions, sync verdicts) write to `audit_log`, without raw tokens.
- **Secrets in frontend** — the web app only knows `EXPO_PUBLIC_API_URL`; no JWT secret, no database
  URL. `TOTP_ENCRYPTION_KEY` and friends are API-side only.

**No cross-shop defect remains reproducible locally. Do not open registration to real users until the
post-deploy checks in §8 pass against the real deployment.**

---

## 5. GitHub (Phase 3) — **COMPLETE**

- Repository initialized at the project root, branch **`main`** (production branch), commits
  `c57d60f` (readiness fixes) and `67d934c` (Vercel config + this document).
- **Remote:** `origin` → `https://github.com/MonicaMutoni-devoloper/Idukaa.git`; pushed and verified —
  `git ls-remote` shows `refs/heads/main` at `67d934c`, identical to the local `HEAD`, and
  `git status` reports `main...origin/main` with a clean tree.
- **Push access:** this machine was signed in as `kellyaudace`, which has no permission on that
  repository (first push rejected with 403). The stored `github.com` credential was cleared and the
  push completed as `MonicaMutoni-devoloper` — that is now the stored identity for future pushes.
- `.gitignore` excludes `.env`, `.env.*` (except `.env.example`), `node_modules`, `dist`, `*.log`,
  `backups/`, key material. Both real env files (`apps/api/.env`, `apps/mobile/.env`) are ignored —
  verified with `git check-ignore`.
- Secret scan of everything staged: clean (placeholders only).

**First CI run on GitHub Actions — PASS (31 Oct 2026):**
run `#1` on `67d934c`, job `test`, conclusion **success**, 1m 2s. Every step executed and succeeded:
checkout → setup-node → `npm ci` (16s) → type-check (5s) → shared tests → i18n tests →
API integration tests against the `postgres:16` service (17s). This closes the “CI has never run”
item that `docs/STATUS.md` §3 used to list.

Run URL: `https://github.com/MonicaMutoni-devoloper/Idukaa/actions`

Never force-push; CI runs automatically on every push to `main` and every pull request.

---

## 6. Service configuration (Phases 4–6)

### 6.1 Neon — production PostgreSQL (not created yet)

1. Create a **new project** (do not reuse the development database). Suggested region: the same one
   you pick for Render, to keep latency low.
2. From the Neon dashboard → **Connection details**, copy two strings (never paste them into chat):
   - the **pooled** endpoint → becomes `DATABASE_URL`, append `?sslmode=require`
   - the **direct** endpoint → becomes `DIRECT_URL` (used only by migrations)
3. Migrations: `apps/api/migrations/*.sql` applied in name order, each in its own transaction, tracked
   in `schema_migrations` — the system already in use; nothing new was invented. Run it **once**
   through Render's deploy command (§6.2) or locally:
   ```bash
   DIRECT_URL=<direct-connection-string> npm run migrate
   ```
   Files: `001_init`, `002_purchase_metadata`, `003_purchase_policy_and_sale_void`,
   `004_auth_security_and_notifications`, `005_owner_onboarding`, `005_reporting_indexes`,
   `006_owner_registration`, `007_admin_platform`, `007_refresh_session_cleanup`. They are idempotent
   (re-running skips applied ones); reviewed this session for destructive statements — they only
   `CREATE TABLE/INDEX` and `ALTER TABLE … ADD COLUMN`.
4. **Never run `npm run seed` against production** — it is now hard-blocked when
   `NODE_ENV=production`, and `SEED_PASSWORD` must simply not be set on Render.
5. Constraints/indexes and shop ownership: enforced by the schema (`shop_id` columns, FKs to `shops`,
   unique active-application index per e-mail, `operations.op_id` uniqueness) and exercised by the
   test suite.
6. **Backup/restore:** Neon takes daily backups per plan; additionally
   `infrastructure/backup.sh` writes a `pg_dump --format=custom` file (run it with `DATABASE_URL`
   pointing at the pooled endpoint, store the file encrypted off-site) and
   `infrastructure/restore.sh` restores it. Keep `TOTP_ENCRYPTION_KEY` backed up too — losing it
   breaks 2FA for enrolled users.

### 6.2 Render — NestJS API (not created yet)

Create **Web Service** → connect the GitHub repo → settings:

| Setting | Value |
|---|---|
| Root Directory | *(leave empty — repository root)* |
| Runtime | Node |
| Build Command | `npm install --include=dev && npm run build -w @sms/api` |
| Start Command | `npm run start -w @sms/api` |
| Deploy/Release Command | `npm run migrate` (runs `npm run migrate -w @sms/api`; uses `DIRECT_URL`) |
| Health Check Path | `/health` |

Environment variables (**names only**): `NODE_ENV=production`, `DATABASE_URL` (pooled, `sslmode=require`),
`DIRECT_URL`, `JWT_SECRET`, `JWT_EXPIRES_IN`, `REFRESH_TOKEN_TTL_DAYS`, `TOTP_ENCRYPTION_KEY`,
`PASSWORD_RESET_URL`, `PASSWORD_RESET_DEV_MODE=false`, `COOKIE_SECURE=true`, `CORS_ORIGINS`,
`COOKIE_SAMESITE` (see §7), `PORT` (Render injects it — `main.ts` listens on `process.env.PORT`, verified).

Verified locally: the server binds `0.0.0.0`, sets `trust proxy` (so `X-Forwarded-Proto: https` makes
cookies `Secure`), and startup logs contain no connection strings or secrets.

**Why the build command installs explicitly (first deploy failed, 2026-10-31 12:06):**

```
> @sms/api@1.0.0 build
> nest build
sh: 1: nest: not found            → npm error code 127
```

Two facts combine here. Render's Node build runs the Build Command *instead of* a separate
install step, so `npm run build` alone has no `node_modules`. And because `NODE_ENV=production`
is set on the service, npm's `omit` defaults to `dev` — verified on this machine with
`NODE_ENV=production npm config get omit` → `dev`. `@nestjs/cli` (the `nest` binary) and `tsx`
(needed by `npm run migrate` / `npm run seed`) are **devDependencies**, so they are skipped.
`--include=dev` reverses the omission (`npm config get omit --include=dev` → empty) and installs
the build tooling; it does not change what the running server loads.

If the build command is changed back to a bare `npm run build`, the deploy fails again with
exit 127 — the same error also appears in the Pre-Deploy step (`npm run migrate` → `tsx: not found`)
for the same reason. After editing this field, use **Manual Deploy → Clear build cache & deploy**
so the stale `node_modules` from the failed build is not reused.

**Service identity (confirmed from the dashboard, 31 Oct 2026):** name `Idukaa`, ID `srv-dbirr8gae00c73ch5apg`,
URL `https://idukaa-qqk2.onrender.com`, region Frankfurt (EU Central), plan **Free**, root directory
empty, branch `main`, auto-deploy on commit.

**Second failure — Start Command was set to the build command (deploy `252a3e0`, 1m59s, failed):**

| Field | Dashboard had | Must be |
|---|---|---|
| Build Command | `npm install --include=dev && npm run build -w @sms/api` | unchanged — **this part is correct now** |
| Start Command | `npm run build -w @sms/api` ❌ | `npm run start -w @sms/api` |
| Pre-Deploy Command | *(empty)* | `npm run migrate` |

The build succeeded (install + `nest build`, which is why the deploy lasted ~2 min instead of 2 s) and
then Render ran `npm run build` a second time as the **start** command. `nest build` exits 0 and no
long-running process is left, so nothing ever bound the injected `PORT`, the port scan failed, and the
deploy was marked Failed. `apps/api` `start` is `node dist/main.js`; the workspace-qualified
`npm run start -w @sms/api` invokes it from the repository root.

Probed after that failure (31 Oct): `GET /health`, `/` and `/sync/pull` on `idukaa-qqk2.onrender.com`
all **timed out after 25 s** with no bytes — expected, since a failed deploy leaves no live instance
(and the Free plan sleeps when idle, so the first request after a successful deploy may take ~50 s
to wake).

### 6.3 Vercel — Expo web frontend (not created yet)

`vercel.json` at the repository root already pins the build:

| Setting | Value |
|---|---|
| Root Directory | *(repository root — do **not** set it to `apps/mobile`, the workspace install needs the root)* |
| Framework Preset | Other (values come from `vercel.json`) |
| Install Command | `npm install` (root postinstall builds `@sms/shared`) |
| Build Command | `npm run build:web -w @sms/mobile` |
| Output Directory | `apps/mobile/dist` |
| SPA fallback | `rewrites: /* → /index.html` in `vercel.json` |

Environment variables (**names only**): `EXPO_PUBLIC_API_URL` = the deployed Render API URL
(baked in at build time; **production** and **preview** scopes must be set separately).

#### Vercel dashboard steps (exact)

1. https://vercel.com/new → **Import Git Repository** → `MonicaMutoni-devoloper/Idukaa`.
2. **Configure Project** → leave **Root Directory** empty (click *Edit* and confirm it is `./`).
   Do **not** point it at `apps/mobile`: the install needs the root workspace + the root `postinstall`
   that builds `@sms/shared`.
3. **Framework Preset:** `Other`. Leave **Build and Output Settings** untouched — `vercel.json`
   supplies `installCommand`, `buildCommand`, `outputDirectory` and the SPA rewrite.
4. **Environment Variables** → add `EXPO_PUBLIC_API_URL` twice, once per scope:

   | Name | Value | Environment |
   |---|---|---|
   | `EXPO_PUBLIC_API_URL` | `https://<render-service>.onrender.com` | Production |
   | `EXPO_PUBLIC_API_URL` | `https://<render-service>-preview.onrender.com` (or the same URL) | Preview |

   Rules for the value: `https://`, **no trailing slash**, no path, no `/api` suffix — the client
   concatenates paths itself (`${API_URL}${path}`).
5. **Deploy**.

**What happens if the variable is missing (why this is not optional):** `resolveApiUrl()` in
`apps/mobile/src/services/api.ts` returns `process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:3000"`
on the web platform, and Metro inlines `EXPO_PUBLIC_*` at build time. A deploy without the variable
builds *successfully* but every API call goes to the visitor's own machine and fails. Changing the
value later requires a **new deployment** — editing the env var does not rewrite an existing bundle.

**Verify after deploy** (should print one hit and no `localhost:3000`):

```bash
cd apps/mobile
grep -ro "https://[a-z0-9.-]*onrender\\.com" dist | head -3   # API URL baked in
grep -rlo "localhost:3000" dist | head -3                    # must be empty
```

**Build guard (added 31 Oct 2026):** `npm run build:web` runs `apps/mobile/scripts/check-api-url.mjs`
before `expo export`, so the build **fails** when `EXPO_PUBLIC_API_URL` is unset, loopback
(`localhost`, `127.0.0.1`, `[::1]`), non-HTTPS, carries a path/query, or ends with a trailing slash.
Verified: 6/6 cases behave as intended and a valid HTTPS origin exports with the URL inlined.
`ALLOW_LOCAL_API=1` is the deliberate escape hatch for LAN/loopback exports.

**Two settings that must agree with the Vercel domain (set on Render, not Vercel):**
`CORS_ORIGINS=https://<vercel-domain>` (exact origin, no trailing slash, comma-separated for
preview domains) and `PASSWORD_RESET_URL` / `STAFF_INVITE_URL`, which are built from the same web
origin. A mismatch shows up as a browser CORS error on every request while `/health` stays green.

---

## 7. Cross-site cookie constraint — decision needed

The web app keeps its refresh token in an `HttpOnly`, `SameSite=Strict` cookie and reloads exchange
it for a new access token. `Strict` only works when the site and the API share a registrable domain.
With the default hosts (`something.vercel.app` → `something.onrender.com`) the request is **cross-site**,
so the cookie would be dropped and **every page reload would require signing in again**.

Two options (both verified working in code):

- **A — custom domains (recommended):** point `app.<yourdomain>` at Vercel and `api.<yourdomain>` at
  Render (same parent domain). Keep `COOKIE_SAMESITE` unset → `Strict`, the strongest posture.
- **B — cross-site cookies:** set `COOKIE_SAMESITE=none` on Render. Verified output:
  `Set-Cookie: sms_rt=…; Secure; SameSite=None`. Protection still holds: HTTPS-only, `HttpOnly`,
  and the double-submit `x-csrf-token` header (client already sends it).

Until you choose, the app works but a reload on default hosts will re-prompt for sign-in.

---

## 8. Post-deploy verification checklist (Phase 9) — not run yet

Run these **against the real deployment** before inviting real users; local passes do not count:

1. `GET https://<api>/health` → `200 {"status":"ok","db":"ok"}`.
2. Register an owner → administrator approves → owner signs in (admin verification not bypassable).
3. Manager signs in; product with opening stock; stock receive; sale; report totals.
4. Second shop (second owner): its catalogue starts **empty**, first shop's products never appear.
5. Unauthenticated calls to `/sync/pull`, `/reports/summary`, `/admin/*` → `401/403`.
6. Frontend build with the production API URL; verify no `localhost` request in the browser network tab.
7. Cookies: `sms_rt` is `HttpOnly` (+`Secure` over HTTPS); DevTools cache storage contains no API URLs.
8. Offline: record a sale offline → reload → reconnect → sync → retry → no duplicates, stocks correct.
9. `curl -I https://<web>` → HTTPS only, service worker installs (PWA needs HTTPS).
10. Check Render/Vercel logs for leaked values.

**Rollback:** Render → the service's **Deploys** tab → previous successful deploy → **Rollback to
this deploy**. Vercel → project → **Deployments** → previous deployment → **Promote to Production**.
Database migrations are forward-only and additive; if a release must be reverted, roll back the code
first — never drop tables to “undo” a migration.

---

## 8.1 Executed against production (31 Oct 2026) — verified

| Step | Result |
|---|---|
| Neon migrations | **9/9 applied** through `apps/api/src/db/migrate.ts` over `DIRECT_URL` (direct, non-pooled endpoint), each file in its own transaction |
| `schema_migrations` | 9 rows, names identical to the 9 files in `apps/api/migrations/` |
| Schema produced | 28 public tables, 69 indexes, 325 constraints |
| Demo data | `users`, `shops`, `products`, `sales`, `purchases`, `expenses`, `stock_movements` → **0 rows**; the seed script was never run |
| Re-run safety | The runner skips names already in `schema_migrations`, so Render's Pre-Deploy `npm run migrate` will apply nothing |
| Web build guard | 6/6 cases correct (unset, loopback, non-HTTPS, trailing slash, path suffix → exit 1; valid HTTPS origin → exit 0, URL inlined, no `localhost:3000` in `dist/`) |
| Render pipeline rehearsal (clean clone of `c425e5a`, 31 Oct) | `NODE_ENV=production npm install --include=dev` → exit 0, 917 packages, `nest` + `tsx` present, `@sms/shared` built by the root `postinstall`; `npm run build -w @sms/api` → exit 0, `apps/api/dist/main.js` written; `npm run migrate` → exit 0, nothing re-applied; `node dist/main.js` → `/health` `200 {"status":"ok","db":"ok"}`, `/sync/pull` `401`, no connection string in the log |
| Live HTTP checks | **blocked** — no Render or Vercel URL exists yet (probed `iduka-api`/`iduka`/`iduka-backend`/`shop-management-api` `.onrender.com`: no such service); `scripts/verify-deployment.mjs` runs them in one command once they do |

---

## 9. What remains blocked on you (exact actions)

1. ~~**GitHub**~~ — **done**: pushed to `MonicaMutoni-devoloper/Idukaa`, CI run #1 green (§5).
2. **Neon:** done — `iduka-prod` exists and is fully migrated (§8.1). Two follow-ups: (i) **rotate the
   `neondb_owner` password** if a connection string was ever pasted into a chat or echoed into a
   terminal log (one was, on 31 Oct), then re-fill `apps/api/.env.production` and Render's
   `DATABASE_URL` / `DIRECT_URL` with the fresh strings; (ii) keep the pooled string for Render's
   runtime and the direct string for the Pre-Deploy migration.
3. **Render:** the Web Service exists — `Idukaa`, `https://idukaa-qqk2.onrender.com`, Frankfurt, Free,
   root directory empty, branch `main`. Build Command is **now correct**
   (`npm install --include=dev && npm run build -w @sms/api`) but the last deploy (`252a3e0`) still
   failed, because **Start Command was `npm run build -w @sms/api`** and **Pre-Deploy was empty** (§6.2).
   Fix those two fields — Start → `npm run start -w @sms/api`, Pre-Deploy → `npm run migrate` — keep
   Health Check Path `/health`, then **Manual Deploy → Clear build cache & deploy**.
   *Free plan:* if Pre-Deploy is greyed out, skip it — all 9 migrations are already applied (§8.1), so
   nothing needs to run before the server starts.
4. **Vercel:** import the repository with root = repository root (§6.3); set `EXPO_PUBLIC_API_URL`
   for Production **and** Preview — the build now fails without it.
5. **Choose option A or B in §7** (custom domains vs `COOKIE_SAMESITE=none`), then set `CORS_ORIGINS`
   on Render to the exact web origin(s).
6. Run §8 against the live deployment and paste the results back here.

**Not started by design (recorded as a follow-up task, per instructions):** Android APK/AAB packaging
via Expo EAS and the Windows native target — the repository contains the Expo/Android project but no
release pipeline; a web build says nothing about native packages. Native work should start only after
§8 passes.

---

## 10. Known limitations carried over

- Reports need connectivity (the dashboard falls back to the last downloaded copy).
- No e-mail/SMS provider: password-reset links only work with `PASSWORD_RESET_DEV_MODE=true`, which is
  ignored under `NODE_ENV=production` — self-service recovery is unavailable until a provider is
  integrated.
- Notification delivery is in-app only; 2FA is opt-in.
- The E2E script writes demo/test records into whatever database it points at — never point it at
  production.
- Login throttle is 8/min per IP; a shared NAT can rate-limit a busy shop.
