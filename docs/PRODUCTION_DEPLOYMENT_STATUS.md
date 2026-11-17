# Production deployment status

**Project:** Shop Management System (npm workspaces: `apps/api`, `apps/mobile`, `packages/shared`)
**Last updated:** 1 November 2026
**Status: DEPLOYED AND FULLY VERIFIED BY SCRIPT — 23/23. Interactive UAT still owed.** API
`https://idukaa-qqk2.onrender.com` (Render, Free, Frankfurt) and web `https://idukaa-api.vercel.app`
(Vercel) are both live, and `scripts/verify-deployment.mjs` now passes **23/23** (§8.4), including
`CORS allow-list contains the web origin` — `CORS_ORIGINS` was set on Render and the preflight returns
`access-control-allow-origin: https://idukaa-api.vercel.app` with `allow-credentials: true`. The web
bundle carries `idukaa-qqk2.onrender.com` and no `localhost`. GitHub + CI done, Neon `iduka-prod`
migrated 9/9 with no demo data (§8.1), platform administrator exists (§8.3).

**What is still unproven:** no signed-in session has ever been exercised against this deployment. The
public landing/sign-in page renders and every unauthenticated boundary rejects correctly, but
sign-in, owner registration, admin approval, manager login, product/stock/sale entry, reports,
two-shop isolation and offline sync have **not** been run here — they need credentials a script does
not hold. Treat that list as the gate before real users (§8, step 2 onward).

**Visual regression:** diagnosed 1 Nov 2026 — near-black hero text on the navy sign-in panel, visible
whenever the OS/browser prefers dark. Fixed, deployed and verified against the live site (§8.6).

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
  (“the owner inherits every manager operation, and another shop still cannot touch these records”),
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

### 6.2 Render — NestJS API (deployed — see §8.2)

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

### 6.3 Vercel — Expo web frontend (deployed — see §8.4)

**Live project:** `idukaa-api` → `https://idukaa-api.vercel.app` (production domain, valid
configuration, no redirect to another domain). The project name is misleading — this is the **web** app,
not an API proxy — but the hostname is what `CORS_ORIGINS` must match. Renaming the project would change
the hostname, so leave it until the custom-domain decision in §7 is made.

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

## 7. Cross-site cookie constraint — RESOLVED in code (3 Nov 2026)

The web app keeps its refresh token in an `HttpOnly` cookie. The default hosts put the web app on
`*.vercel.app` and the API on `*.onrender.com`, which are **different sites**. That produced the live
`POST /auth/refresh 401` loop, through two independent mechanisms:

1. **Transport.** The cookie was `SameSite=Strict`. A browser does not attach a `Strict` cookie to a
   cross-site request, so the API never received it and answered `401 refresh_invalid` — on the first
   load, on every reload, for every user.
2. **CSRF check.** Even with the cookie attached, `sms_csrf` belongs to the API host. JavaScript on the
   web origin can never read it (`document.cookie` is origin-scoped), so the double-submit header could
   not match and the call was rejected `403 csrf_failed`.

What the code does now:

- **SameSite is derived per request** from the caller's `Origin` (`apps/api/src/common/http.ts`):
  same registrable domain → `strict`; different sites → `none` + `Secure`. An explicit
  `COOKIE_SAMESITE` still overrides. No deployment-time configuration is required.
- **CSRF adapts to the deployment**: matching double submit wins; when the caller provably cannot read
  the cookie (cross-site), the API trusts its own `CORS_ORIGINS` allow-list plus the required header.
  A page that is not allow-listed can never pass the preflight, and `Origin` is set by the browser and
  cannot be forged by script.
- **Rotation no longer punishes races.** A refresh token presented within `REFRESH_REUSE_GRACE_SECONDS`
  (default 30) of its rotation — two tabs, a reload during a Render cold start, a client that timed out
  mid-rotation and lost the `Set-Cookie` — now rotates the live successor instead of revoking the whole
  session family. Outside that window, reuse is still treated as theft and revokes the family.

Verified in a real browser, cross-site, against the local API
(`http://web.localhost:8081` → `http://api.localhost:3000`, the same shape as Vercel → Render):
login `201`, `POST /auth/refresh` `201` with the cookie actually received (`cookiePresent: true` in the
API log), and a second refresh `201` as well.

**Still recommended (deployment, not code):** give the app `app.<yourdomain>` and the API
`api.<yourdomain>`. Same-site cookies are first-party, so they are immune to Chrome's third-party
cookie phase-out; the cross-site path above works today but is the one browsers are restricting.

**iOS update (16 Nov 2026).** `SameSite=None` is not enough on iPhone: Safari/iOS blocks *every*
third-party cookie, so the cross-site refresh cookie is never sent and each reload or PWA relaunch
started from `401 refresh_missing_credential`, leaving the outbox and pulls stalled until the user
signed in again (`runPass` returns silently when no token can be obtained). The web client now keeps
the refresh token it receives in the response body and presents it in `/auth/refresh` **only** after
that exact answer, then persists the rotation; if neither cookie nor stored copy exists it reports the
session as ended instead of silently idling. Verified in Chrome by signing in, deleting `sms_rt` via
DevTools (the iOS condition), reloading: `POST /auth/refresh` `401` → `201`, `GET /sync/pull` `200`.
The proxy/DNS fix above is still the durable answer.

---

## 7.1 Authentication diagnostics (3 Nov 2026)

Every auth decision now emits one greppable JSON line (never a token, cookie, password or header):
`evt`, `category`, `requestId`, `method`, `path`, `crossSite`, plus non-secret context. Categories:
`missing_refresh_credential` (cookie never arrived — a transport/cookie problem), `csrf_rejected`,
`unknown_token`, `token_expired`, `token_reused`, `session_revoked`, `invalid_access_token`,
`session_state_mismatch`, `shop_suspended`, `role_not_allowed`, `database_error`, `ok`. `x-request-id`
is echoed on every response and accepts an inbound value, so a browser console error, a Render log line
and the audit row can be matched. `auth.refresh.grace_reuse` is audited separately from
`auth.refresh.reuse_detected`, so a benign race is never mistaken for a stolen token.

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
| Live HTTP checks | **blocked at the time** — no Render or Vercel URL existed yet. Superseded by §8.2. |

---

## 8.2 Render API — deployed and verified (1 Nov 2026, 20:12 GMT+2)

Deploy `dep-dbjo26dh3lcs738ja830`, commit `6904bec`, trigger **Start command updated**, duration
1m12s, **Status: Deploy succeeded / Live**. Startup log ended with
`Nest application successfully started` and `Available at your primary URL https://idukaa-qqk2.onrender.com`;
all 12 controllers and their routes mapped; **no connection string, password or JWT value in the log**.

`node scripts/verify-deployment.mjs --api=https://idukaa-qqk2.onrender.com` → **13/13 checks passed**:

| Check | Live result |
|---|---|
| `/health` | `200`, body `{"status":"ok","db":"ok"}` — the API really reached Neon, not just a liveness stub |
| Response body leaks | no database URL in the health body |
| helmet | `X-Content-Type-Options: nosniff`, CSP present, `Strict-Transport-Security: max-age=15552000; includeSubDomains` |
| Unauthenticated access | `/sync/pull`, `/reports/summary`, `/shop/settings`, `/notifications`, `/admin/health` → **401 each** (global default-deny guard) |
| Failed login | `401` and **no `sms_rt` cookie issued** |
| CORS preflight, foreign origin (`https://evil.example`) | `204` but **no `Access-Control-Allow-Origin`** — refused |
| CORS preflight, deployed web origin | still absent, because `CORS_ORIGINS` is unset — the one remaining failure, see §8.4 |

Notes carried from the deploy log:

- `NODE_ENV=production` + `--include=dev` install worked: `postinstall` built `@sms/shared`, `nest build`
  succeeded, `npm run start -w @sms/api` → `node dist/main.js`.
- **Pre-Deploy Command is still empty.** All 9 migrations were applied on 31 Oct (§8.1), so nothing is
  missing today — but a future migration will need that field set to `npm run migrate`.
- Nine minutes after start, `node-postgres` printed a **security warning**: `sslmode=require` is
  currently treated as `verify-full`, and pg v9 will weaken that. Convenient today (Neon verifies the
  certificate), but for a warning-free, explicitly-safe configuration change the pooled/direct strings
  to `?sslmode=verify-full` once Neon supplies its CA, or accept the current behaviour.
- `WEB_CONCURRENCY=1` set by Render (Free instance, 1 CPU).
- Render Free spins down when idle: **the first request after ~15 min costs 50 s or more** (banner in the
  dashboard). `scripts/verify-deployment.mjs` warms the API before asserting, but real shop owners
  will see that delay on a cold start — the web client shows its offline/last-cached state instead.

---

## 8.3 First `system_admin` — required before any owner can be approved

Production has **0 users** (§8.1), and owner registration is deliberately not self-activating: an
owner submits an application and a `system_admin` approves it. With no admin, that queue can never be
cleared — so this is a hard prerequisite for real users, not a nicety.

The `seed` script is unusable by design (`NODE_ENV=production` is refused) and must stay that way. The
intended path, per `docs/DEPLOYMENT.md`, is one deliberate INSERT for the platform administrator.
`001_init.sql` already runs `CREATE EXTENSION IF NOT EXISTS pgcrypto`, so no tooling is needed:

1. Neon console → project `iduka-prod` → **SQL Editor** (branch `main`, database `neondb`).
2. Run this, replacing the e-mail and choosing a strong password **in the editor itself** (never paste
   it into a chat or a terminal — the hash is all that is stored):

   ```sql
   INSERT INTO users (shop_id, email, full_name, password_hash, role)
   VALUES (NULL, 'admin@your-domain.rw', 'Platform Admin',
           crypt('<choose-a-strong-password>', gen_salt('bf', 12)), 'system_admin')
   RETURNING id, email, role, account_status;
   ```

   `shop_id` must be `NULL` for this role — the table's `CHECK ((role = 'system_admin') = (shop_id IS NULL))`
   enforces it. `account_status` defaults to `'active'`, `active` to `true`, so the account can sign in
   immediately. `gen_salt('bf', 12)` yields a `$2a$12$…` hash, which `bcryptjs` (used by the API)
   verifies; the 12 rounds match the `NODE_ENV=production` seed path.
3. Sign in with that account on the deployed web app. It is routed to `/admin` (the client redirects
   `system_admin` out of shop screens, and the API enforces the same boundary with `@Roles`).
4. Approve the first owner application from **Admin → Applications**.

**Executed 1 Nov 2026 — done.** The profile returned by `RETURNING` was
`id 7a4e4457-6e88-414c-806a-5d2e6920574b`, `role system_admin`, `account_status active`. A read-only
check afterwards confirmed the stored hash is `$2a$12$` (60 chars), `shop_id` is `NULL`, `active` is
true, `token_version` 0, and `users` now holds exactly that one row. The administrator's e-mail is
**deliberately not recorded in this file** — it is a personal address and this repository is public.
Signing in has not been exercised yet: it needs a browser front end, which does not exist until Vercel
is connected. Nothing about the application changed to achieve this — it is one data row, created with
the existing schema and the API's own bcrypt parameters.

Why this cannot be abused by the public: `POST /applications` and `POST /admin/users` strip/reject a
caller-supplied role, so registration always produces an `owner` application — asserted by
`registration.integration.test.ts` (`role: "system_admin"` is stripped and the service assigns `owner`).

Do **not** share this account. Create per-person admin accounts later from `POST /admin/users`.

---

## 8.4 Vercel web — live, and API↔web integration (1 Nov 2026, 21:35 GMT+2)

The frontend is deployed as Vercel project **`idukaa-api`** at `https://idukaa-api.vercel.app`
(production domain, valid configuration, no redirect to another domain). The name reads like an API
host, but it serves the Expo web export: `/` returns the 2.5 KB Expo `index.html`
(`<title>Shop Management</title>`, three `/_expo/static/js/web/*.js` bundles), `/manifest.json` is `200`,
and a deep route (`/inventory/products`) returns the SPA shell.

`node scripts/verify-deployment.mjs --api=https://idukaa-qqk2.onrender.com --web=https://idukaa-api.vercel.app`
→ **22/23 passed**, exit 1 on the one expected failure:

| Group | Result |
|---|---|
| API (13) | all pass — `/health` 200 `{"status":"ok","db":"ok"}`, helmet headers, 5× 401, failed login 401 with no cookie, foreign-origin CORS refused |
| Web (6) | all pass — HTML 200, `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`, SPA fallback 200, 3 script tags, 1388 KB bundle fetched, **bundle contains `idukaa-qqk2.onrender.com`** and **no `localhost:3000`** |
| CORS (3) | all pass after `CORS_ORIGINS` was set on Render — `allow-origin=https://idukaa-api.vercel.app`, `allow-credentials: true`, foreign origin refused |

So the deployed bundle **is** wired to the real API; only the server-side allow-list entry is missing.
`apps/api/src/main.ts` does `(process.env.CORS_ORIGINS ?? "").split(",").filter(Boolean)` — unset yields
an empty array, which matches no origin, so the preflight succeeds (`204`) while omitting
`Access-Control-Allow-Origin`. The browser then blocks the request itself, which is why `/health` stays
green while the app cannot sign in. Fix: §9.6.

**Cold start measured:** the first `/health` after ~20 min idle took **11.2 s** (Free plan sleeps), which
exceeds the script's 15 s per-request timeout and shows up as `FAIL GET /health reachable [timeout]` —
not an outage. Warm it first (`curl -m 120 https://idukaa-qqk2.onrender.com/health`) or simply re-run.

---

## 8.5 Re-run after `CORS_ORIGINS` was set — 23/23 (1 Nov 2026, 22:05 GMT+2)

Render → `Idukaa` → Environment was updated with the web origin, and the verification was re-run
against the live services. **`node scripts/verify-deployment.mjs --api=https://idukaa-qqk2.onrender.com --web=https://idukaa-api.vercel.app`
→ 23/23 checks passed, exit 0.**

Explicit preflight, `OPTIONS /auth/login` with `Origin: https://idukaa-api.vercel.app`:

```
HTTP/1.1 204 No Content
access-control-allow-origin: https://idukaa-api.vercel.app
access-control-allow-credentials: true
access-control-allow-methods: GET,HEAD,PUT,PATCH,POST,DELETE
access-control-allow-headers: content-type
vary: Origin, Access-Control-Request-Headers
```

`vary: Origin` means the allow-list is evaluated per request rather than cached across origins, which is
the correct behaviour for a credential-bearing API. `/health` answered in **0.59 s** (instance warm from
the preceding request), confirming the earlier 11 s figure was cold-start, not degradation.

**Still manual:** `COOKIE_SAMESITE` could not be confirmed from outside — the `SameSite` attribute only
appears on a *successful* login response, and this script deliberately never succeeds at login. Verify it
in DevTools → Application → Cookies on `onrender.com` after the first real sign-in: it must read
`Secure; HttpOnly; SameSite=None`. If it reads `Strict`, reloading the page will silently sign the user
out and `COOKIE_SAMESITE=none` is still missing (or Render has not finished redeploying).

---

## 8.6 Visual regression — diagnosis and fix (1 Nov 2026)

### Cause

No styling code changed after deployment. `git diff c57d60f..HEAD -- apps/mobile/src/theme apps/mobile/app apps/mobile/public apps/mobile/src/components`
returns **only** `apps/mobile/scripts/check-api-url.mjs` (a build-time guard, no styles), and
the last commit touching the visual layer is `c57d60f` — the pre-deployment commit. The appearance
therefore could not have been altered by the deploy itself. What does change per visitor is the
**colour scheme**: `useEffectiveScheme()` defaults to the OS preference, so a browser/OS in dark mode
receives the `dark` palette instead of the `light` one the app was reviewed in.

That exposed a real token misuse, not a palette change. `apps/mobile/app/login.tsx` painted the whole
hero panel — headline, bullet list, wordmark, footer — with `c.onPrimary` while its background was
`c.sidebar`. `onPrimary` is the *foreground for teal-filled buttons*, and in the dark palette it is
`#04211F`: near-black text on a `#101E36` panel. Measured from the live site with Chrome
(`Emulation.setEmulatedMedia { prefers-color-scheme: dark }`), the headline rendered dark green on navy,
and the three bullets were effectively unreadable. Light mode was unaffected because `onPrimary` is
`#FFFFFF` there — which is why it looked correct before anyone opened it in dark mode.

### Evidence (live deployment, before the fix)

| Probe | Light | Dark |
|---|---|---|
| `document.documentElement.colorScheme` | `light` | `dark` |
| body background | `rgb(246,248,250)` = `#F6F8FA` | `rgb(13,21,32)` = `#0D1520` |
| hero headline | white on navy — readable | dark on navy — **unreadable** |

Screenshots were captured for both schemes at 1440×960 and at 390×844 (phone).

### Changes made (deployed 1 Nov 2026, commit `a220ae6`)

| File | Change | Why |
|---|---|---|
| `apps/mobile/app/login.tsx` | hero headline, wordmark and bullet markers: `c.onPrimary` → `c.sidebarInk`; tagline and footer: → `c.sidebarMuted`; redundant `opacity` dropped | text is drawn on `c.sidebar`, so it needs the sidebar foreground tokens, which are correct in both palettes by construction |
| `apps/mobile/public/index.html` | boot background `#F4F6F3` → `#F6F8FA`, `#0C1210` → `#0D1520`; `theme-color` `#0F5C4D` → `#172B4D` | this file is the template actually served (its `%LANG_ISO_CODE%` placeholders appear substituted in the deployed HTML), and it still carried the superseded green palette, causing a green flash before hydration |
| `apps/mobile/app.json` | web `themeColor` `#0F5C4D` → `#172B4D` | Expo emits a second `theme-color` meta from here; it kept the old green in the export |

Light mode is visually unchanged (`sidebarInk` `#E7ECF4` replaces white on navy). No palette value, type
scale, spacing token, layout or component was redesigned. `app.json`'s **Android** `adaptiveIcon.backgroundColor`
was deliberately left at `#0F5C4D` — that is icon artwork, a separate decision from the web chrome.

### Verification (local build, same export pipeline as Vercel)

| Check | Command | Result |
|---|---|---|
| TypeScript | `npm run typecheck` | **PASS**, exit 0 |
| Lint | `npm run lint --if-present` | **PASS** — the workspace defines no `lint` script, so nothing was executed; this row reports the absence, not a clean lint |
| Mobile unit tests | `npm run test:mobile` | **PASS**, exit 0 |
| Web export | `EXPO_PUBLIC_API_URL=https://idukaa-qqk2.onrender.com npm run build:web -w @sms/mobile` | **PASS**, exit 0, guard passed, `Exported: dist` |
| Dark-mode hero | Chrome CDP, `prefers-color-scheme: dark` at 1440×960 and 390×844 | **PASS** — headline and bullets render near-white and legible |
| Light-mode regression | same capture, `prefers-color-scheme: light` | **PASS** — unchanged |
| Old palette gone | `grep -c 0F5C4D apps/mobile/dist/index.html` | **PASS** — 0 occurrences; both `theme-color` metas read `#172B4D` |
| Production API baked in | `grep -ro idukaa-qqk2.onrender.com dist/_expo/static/js/web/` | **PASS** — 1 hit |
| No localhost fallback | `grep -rl localhost:3000 apps/mobile/dist` | **PASS** — 0 files |
| API integration suite (62 tests) | needs `TEST_DATABASE_URL` | **NOT TESTED** — the change is presentational (inline style values in one screen plus static HTML meta), so the database suite was not re-run |
| Browser E2E (19 scenarios) | `node apps/mobile/tests/e2e-web.mjs` | **NOT TESTED** — needs a seeded development database and a local API; it writes demo records and must never point at production |

### Deployed and verified live (1 Nov 2026)

`c8d2def` (fix) and `a220ae6` (this runbook) were pushed to `main`; Vercel picked the commit up
automatically and the new bundle was being served **within ~60 s** (confirmed by polling `/` for the
marker `0F5C4D` until it disappeared — the old palette was the one thing uniquely present in the
superseded build).

| Check against the live site after the deploy | Result |
|---|---|
| `scripts/verify-deployment.mjs --api=… --web=https://idukaa-api.vercel.app` | **PASS — 23/23, exit 0** |
| `theme-color` metas in the served HTML | **PASS** — both read `#172B4D`; no `0F5C4D` anywhere |
| Boot background in the served HTML | **PASS** — `#F6F8FA` (old `#F4F6F3` gone) |
| Dark scheme, 1440×960, `prefers-color-scheme: dark` | **PASS** — hero headline and bullets near-white, legible; navy panel and teal accents intact |
| Dark scheme, 390×844 | **PASS** — phone layout carries no hero panel and is unaffected |
| Light scheme, 1440×960 | **PASS** — unchanged from the approved appearance |
| API `/health` | **PASS** — `200` in 0.69 s (warm), `db: ok` |

The sign-in screen is now readable in both schemes and the deploy introduced no regression elsewhere:
every protected route still answers `401`, the CORS allow-list still matches the web origin, and the
bundle still carries `idukaa-qqk2.onrender.com` with no `localhost` fallback.

### Defect found and deliberately NOT changed

On the sign-in card the two fields occupy ~150 px each, leaving a large blank band under every input
(visible in both light and dark captures). Cause: `Field` in `src/components/ui.tsx` sets
`flexBasis: 150` on its wrapper, which is a **width** basis where fields sit in a wrapping row — the
normal case in every form — but becomes a **height** basis in the card's column, so each field is
stretched. It is pre-existing (it predates the deploy and is identical in both schemes) and fixing it
would change the density of every form in the app, so it is recorded here instead of being swept into
this fix. Say the word and it becomes its own reviewed change with before/after captures per screen.

---

## 8.7 Manual runbook — two-shop isolation and offline sync (live)

Run this in a browser against `https://idukaa-api.vercel.app`. It is the half of §8 that needs a
signed-in session. Test data only: names prefixed `TEST`, never real shop money.

**Starting state:** production holds **0 shops, 0 owners, 1 `system_admin`** (§8.3). Everything below
begins with registration because there is no shop to sign in to yet.

### Stage 1 — two independent shops

| # | Do this | Expect |
|---|---|---|
| 1 | Sign in as the administrator | Redirected straight to `/admin`; shop screens are unreachable (`_layout.tsx` bounces a `system_admin` out of `/`) |
| 2 | `/admin/applications` → *Request information* on nothing yet: instead open `/login` → **Create a Shop** | Five fields only: username, shop, e-mail, password, phone |
| 3 | Register **TEST Shop A** with `owner-a@…` | "awaiting administrator approval"; sign-in with this address is refused while pending |
| 4 | Register **TEST Shop B** with `owner-b@…` | Same pending state, separate application |
| 5 | `/admin/applications` → approve A | Row flips to approved; A appears in `/admin/shops` |
| 6 | Approve B | A second, distinct shop id |
| 7 | Sign in as owner A | Lands on `/` with **Shop A** as context; `/stock` is **empty** |
| 8 | `/stock` → *Add product*: `TEST Rice A`, code `RICE-A`, qty `20`, cost `900`, price `1200` | "Product saved"; stock shows 20 |
| 9 | Sign out, sign in as owner B, open `/stock` | **Empty.** `TEST Rice A` must not appear — this is the `bindShop()` cache wipe plus the server's `shop_id` scoping |
| 10 | Add `TEST Rice B`, code `RICE-B`, qty `35` | Stock shows 35 |
| 11 | Sign back in as A, `/stock` | Rice A present, **Rice B absent**; then the reverse for B |

API-level proof (run in your own terminal — never paste the token into chat). Take `token` from the
`POST /auth/login` response in DevTools → Network, then:

```bash
curl -s https://idukaa-qqk2.onrender.com/sync/pull -H "Authorization: Bearer $TOKEN_A" \
  | grep -o 'TEST Rice [AB]' | sort -u          # must print only "TEST Rice A"
```

Cross-shop attempt — a product id from the other shop must be rejected, not silently accepted:

```bash
curl -s -X POST https://idukaa-qqk2.onrender.com/sync/push \
  -H "Authorization: Bearer $TOKEN_A" -H "Content-Type: application/json" \
  -d '{"operations":[{"opId":"11111111-1111-4111-8111-111111111111","deviceId":"probe","createdAt":"2026-11-01T12:00:00.000Z","type":"sale.create","payload":{"saleId":"22222222-2222-4222-8222-222222222222","productId":"<PRODUCT_ID_FROM_SHOP_B>"}}]}'
```

Expect a per-operation error/rejection (`rejected` or `conflict`), and **no** stock movement in shop B.

### Stage 2 — a manager account (needed for the offline pass)

Either path works; B is fewer clicks for a test:

- **A — owner invites:** sign in as owner A → `/team` → invite a manager → the one-time link appears in
  `team-invite-url` → open it → `/invite` → set a password → sign in.
- **B — admin creates:** `/admin/users` → name, e-mail, password, role **manager**, pick **Shop A**.
  (The create button is disabled until at least one shop exists — hence Stage 1 first.)

Sign in as that manager: the sidebar shows **Home · Sell · Stock · Reports · Expense · Sync ·
Notifications · Security · Settings** — no `/approvals`, no `/team`, no `/admin`. Visiting `/admin` by
URL redirects to `/`.

### Stage 3 — offline sale, restart, sync, retry

| # | Do this | Expect |
|---|---|---|
| 1 | Signed in as the manager, open `/stock`, note Rice A's on-hand | e.g. 20 |
| 2 | DevTools → **Network → Offline** (this is the same thing the E2E does via `Network.setBlockedURLs`) | Top-bar badge switches to offline within a few seconds |
| 3 | `/sell` → search `RICE-A` → qty `2` → save | "Sale saved" — local only; **no** server confirmation is claimed |
| 4 | `/stock` | Shows 18 locally — the optimistic decrement |
| 5 | `/sync` | Pending count ≥ 1, queue row `sale.create` with status *pending*, attempts 0; a progress bar marked *waiting to sync* |
| 6 | **Reload the page while still offline** | App shell loads (service worker), you land signed in, the sale and the queue row are still there — IndexedDB survived |
| 7 | DevTools → **Online** | The engine syncs automatically; to force it immediately press **Sync now** (`sync-now`, which also clears the retry backoff) |
| 8 | Watch `/sync` | Row goes *synced*, pending → 0, attempts 1 |
| 9 | `/stock` and `/reports` → *Sales* | On-hand 18 in the shop header, **exactly one** `TEST Rice A` sale row of 2 units |
| 10 | Press **Sync now** again | Nothing moves: pending stays 0, on-hand stays 18, still one sale row — the same `op_id` is not replayed as a second sale |
| 11 | Sign in as owner B, `/reports` | None of shop A's sale appears |

Why step 10 is the real idempotency proof: every operation carries a client-generated `op_id`, the
server records it in `operations` with a uniqueness constraint per shop, and a replay answers
`duplicate` instead of applying again. A second deduction would show up as on-hand 16 or two sale rows.

### Recording the result

Fill this in as you go and the numbers become the evidence for §9:

| Test | Status | Evidence |
|---|---|---|
| Admin reaches only `/admin` | NOT TESTED | |
| Owner A sees only shop A | NOT TESTED | |
| Owner B sees only shop B | NOT TESTED | |
| Manager confined to its shop | NOT TESTED | |
| Cross-shop product id rejected | NOT TESTED | |
| Offline sale persisted + survives reload | NOT TESTED | |
| Auto-sync on reconnect | NOT TESTED | |
| Re-sync creates no duplicate | NOT TESTED | |
| Stock deducted exactly once | NOT TESTED | |

---

## 9. What remains blocked on you (exact actions)

1. ~~**GitHub**~~ — **done**: pushed to `MonicaMutoni-devoloper/Idukaa`, CI run #1 green (§5).
2. **Neon:** done — `iduka-prod` exists and is fully migrated (§8.1). Two follow-ups: (i) **rotate the
   `neondb_owner` password** if a connection string was ever pasted into a chat or echoed into a
   terminal log (one was, on 31 Oct), then re-fill `apps/api/.env.production` and Render's
   `DATABASE_URL` / `DIRECT_URL` with the fresh strings; (ii) keep the pooled string for Render's
   runtime and the direct string for the Pre-Deploy migration.
3. ~~**Render**~~ — **done**: `Idukaa`, `https://idukaa-qqk2.onrender.com`, deploy `6904bec` **live**,
   13/13 live checks (§8.2). Two optional follow-ups: set **Pre-Deploy Command** to `npm run migrate`
   before the next schema change (all 9 migrations are already applied, so nothing is pending today),
   and switch the Neon strings to `?sslmode=verify-full` to silence the pg warning in the log.
4. ~~**Create the first `system_admin`**~~ — **done** 1 Nov 2026 in the Neon SQL Editor (§8.3).
   Once the web app exists, sign in with it and confirm the approval queue is reachable.
5. ~~**Vercel**~~ — **done**: project `idukaa-api`, `https://idukaa-api.vercel.app`, serving the Expo
   export with `EXPO_PUBLIC_API_URL=https://idukaa-qqk2.onrender.com` baked in (§8.4).
6. ~~**Set the Render web-origin variables**~~ — **done** (1 Nov 2026): the preflight now returns
   `allow-origin: https://idukaa-api.vercel.app` and the script passes 23/23 (§8.5). Confirm
   `COOKIE_SAMESITE=none` was included in the same save — it cannot be checked without a successful
   login, and without it every page reload asks for the password again.
7. **Option B applies on these hosts (§7):** add `COOKIE_SAMESITE=none`, keep `COOKIE_SECURE=true` —
   `vercel.app` → `onrender.com` is a cross-site request, so `Strict` would ask for the password again
   on every reload. Move to option A (custom `app.`/`api.` domains) later if you want `Strict` back.
8. **Done once (§8.5, 23/23).** Now walk the interactive half of §8, in this order: sign in as the
   administrator → submit an owner application → approve it → create a second shop → run the
   offline-sale → reload → sync → retry pass. Until that runs, "works" is limited to what a credential-less
   script can prove. **BLOCKED:** this needs a signed-in session, and no password may be pasted into
   this chat. Options: (a) you sign in and read back what each screen shows, or (b) you export the
   credentials into your own shell (`ADMIN_EMAIL=… ADMIN_PASSWORD=…` — never into a file in the repo)
   and a driver script performs the flows.
9. **Approve the visual fix before it is pushed.** The change is committed locally only. Pushing to
   `main` auto-deploys to Vercel, so the deploy is the approval. Light mode is unchanged; dark mode
   goes from unreadable hero text to legible (§8.6).

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

---

## 11. Session recovery (3 Nov 2026) — web and native

The 401 loop was three problems, not one. §7 covers the server side; this is what changed in the app:

- **One refresh, never a loop.** Concurrent 401s share a single rotation (`refreshSession()` is
  single-flight). A definitive rejection (`401`/`403`) sets `sessionExpired` and stops automatic
  refresh until the user signs in again; a transport failure instead backs off 15s and leaves the
  session marked valid. Before, every failed request fired its own refresh, so one bad cookie produced
  the refresh storm visible in the production console.
- **No more "unreachable server" for an authorization failure.** Reports, the period summary and the
  dashboard now classify the error: `401` → "Your session expired. Sign in again…", network failure →
  the existing offline message. They also reload automatically when a new token arrives.
- **The outbox is never touched.** Expiring a session only clears the in-memory token. Queued sales,
  purchases and expenses stay in SQLite/IndexedDB, bound to their user and shop, and the sync engine
  resumes (and revalidates permissions) the moment a fresh sign-in produces a token.
- **One recovery point.** The app shell shows a "Session expired — Sign in again" banner on every
  screen; signing in clears it and sync restarts on its own.
- **Refresh timeout raised** from 12s to 30s, because a Render cold start regularly exceeds 12s and the
  aborted request was what lost the rotated `Set-Cookie`. The server-side grace window makes that retry
  safe as well.
- **Service worker cache bumped** to `sms-shell-v3` so no client keeps running a bundle with the old
  refresh flow.

### Tests executed (3 Nov 2026, local)

| Suite | Result |
|---|---|
| `npm run typecheck` (all workspaces) | ✅ exit 0 |
| API integration (`TEST_DATABASE_URL=…/sms_test`) | ✅ **79 pass / 0 fail** |
| — new: cookie/CSRF policy unit tests | ✅ 8 cases (site comparison, auto SameSite, allow-list CSRF) |
| — new: concurrent refresh (`Promise.all` × 3, one token) | ✅ every caller gets a session, one live row |
| — new: replay inside the grace window | ✅ family survives, successor rotates, audited as `grace_reuse` |
| — updated: reuse with the grace window disabled | ✅ family revoked, `reuse_detected` audited |
| `npm run test:shared` | ✅ 32 pass |
| `npm run test:mobile` (i18n parity) | ✅ 5 pass |
| Browser cross-site probe (Vercel→Render shape) | ✅ login 201, refresh 201, second refresh 201 |

**Not verified:** the live deployment until this commit is pushed (Vercel and Render redeploy from
`main`); a signed-in production walkthrough still needs credentials, which are not available here.

### Live verification after the deploy (3 Nov 2026)

`main` pushed as `ee7e711`; Vercel and Render both redeployed from it.

| Check | Result |
|---|---|
| Render API healthy on the new build | ✅ `x-request-id` now on every response (new middleware) |
| CORS preflight from `https://idukaa-api.vercel.app` | ✅ 204, `allow-credentials: true`, `allow-headers: content-type,x-csrf-token` |
| `POST /auth/refresh` cross-site without a credential | ✅ 401 `refresh_invalid` — **not** 403 `csrf_failed`, i.e. the new CSRF path is live and the old one (which rejected every real browser) is gone |
| Vercel bundle carries the fix | ✅ `__common-e6a73fc1…js` contains the session-expired banner and message strings |
| `node scripts/verify-deployment.mjs` | ✅ **23/23** (first run lost one check to a Render cold-start timeout; the rerun passed) |

**Still not verified live:** a full sign-in → reload → refresh cycle against production, which needs
account credentials (none are available here). The equivalent flow was proven in a real browser
locally against the same cross-site shape (web.localhost → api.localhost: login 201, refresh 201,
second refresh 201), and the unit/integration suites cover the rest. If a production reload still
prompts for sign-in, check the Render logs for `auth.refresh.failed` — the `category` and `crossSite`
fields now say exactly which step failed.

---

## 12. Production re-check (9 Nov 2026) — public and transport only

Run against `main` at `24c19a9`, after the financial-basis changes were pushed:

| Check | Result |
|---|---|
| `node scripts/verify-deployment.mjs` | **23/23 pass** (API health, 401s, CORS, web bundle, no loopback URL) |
| `GET /reports/movements` and `GET /reports/items` without a session | **401** each; an unknown sibling route returns **404**, so the deployed API really carries the new reporting routes |
| `GET /realtime` WebSocket upgrade | **101 Switching Protocols** through Render/Cloudflare; an upgrade to another path returns **404**. Unauthenticated sockets are closed after 5 s by design |
| Production web bundle | Redeployed commit `24c19a9`: entry bundle `entry-81feadba…`, reports chunk `reports-507eb9a…` contains `localSummary`/`pendingFinancials`, and the common bundle contains `Local operational` / `Server-confirmed`. GitHub checks: CI `test` **success**, Vercel **success** |
| `GET /app/version` | serves `latest 1.0.2 (3)` — the Render `APP_*` variables still point at the older release, so installing 1.0.5 locally does not advertise it to 1.0.4 users |

**Still unverified in production:** every authenticated flow (sign-in, owner/manager reports, the two
financial bases, sync). No production credentials are held in this environment, and creating a shop
or writing test records to the live database was deliberately not done. Realtime transport is live,
but an authenticated `ready` frame and cross-device `change` delivery were not exercised against
production; that remains covered by the server and mobile test suites and must be re-checked with a
real shop account.

**Release note:** `dist/idukaa-1.0.5-android-release.apk` is local only. `APP_LATEST_VERSION=1.0.5`,
`APP_LATEST_VERSION_CODE=6` and a reachable `APP_UPDATE_URL` must be set on Render (and the APK
published) before the update banner can offer it. Do not raise the manifest to a version with no
download URL.

## 13. Offline phone fixes deployed (16 Nov 2026) — `467949c`

Pushed to `main`, so Vercel rebuilt project `idukaa-api` from `467949c`.

| Check | Result |
|---|---|
| `GET /sw.js` | **200**, `application/javascript`, `cache-control: public, max-age=0, must-revalidate` (so an installed client re-checks the worker on its next launch), body contains `idukaa-shell-v6` and the install-time `launchAssets` precache |
| `GET /` | **200**, entry bundle `entry-012e3cc3026829ae99b7b67555035935.js` — identical to the locally exported `apps/mobile/dist/index.html`, so the live site is the current tree, not a stale build |
| Shell install on the live origin (headless Chrome, fresh profile) | worker reached `activated` and controlled the page; `caches` → `["idukaa-shell-v6"]` with **10 assets and all 3 launch bundles** |
| Cold launch with the network off (`Network.emulateNetworkConditions offline`, then navigate to `/`) | `navigator.onLine === false`, the app rendered the sign-in screen, `#root` populated, **0 script loads failed** |
| `apps/mobile` test suite | typecheck clean; i18n, dashboard, reports, realtime, policy, sections, roles, sync, update, catalogue, pwa, intro, sell, period, offline and credit-repayments-offline all exit 0 |

**Before this commit** the deployed worker was `idukaa-shell-v5`, which cached the page, manifest and
icons but never the hashed bundle, and the live entry bundle was `entry-1d5ae362…` — the deployed web
app was an older build than the Android 1.1.2 APK, which is why the web app looked like it was missing
features the phone had.

**Still unverified:** signed-in flows against production (no production credentials here), and iOS
Safari itself — the shell install and offline launch above were exercised in Chrome, so an iPhone must
confirm the installed app opens with the network off. On first launch after this deploy each device
needs one online visit; the app then keeps a refresh token for later offline relaunches.

## 14. Offline screens and unsynced figures deployed (16 Nov 2026) — `34ccfeb`

Reported after §13 went live: on the iPhone web app, tapping **Sell** offline showed nothing, **Reports**
(and any screen never opened online) showed nothing offline, and a sale rung up with no network did not
move the Overview until the phone found a connection.

Cause of the blank screens: `expo export` writes **one script per screen** (`sell-<hash>.js`,
`reports-<hash>.js`, …) and `index.html` names only the three launch bundles. The v6 worker precached
exactly those, so every other route was fetched live on navigation — impossible offline. The v7 worker
precaches `/sw-assets.json`, generated after the export by `scripts/write-sw-manifest.mjs`, which lists
every exported file (59 here, 35 of them scripts).

Cause of the frozen figures: the Overview deliberately keeps the server/saved snapshot as its basis (so
one phone's rows never become the whole shop), but a queued sale is on neither the server nor the saved
copy, so nothing changed until sync. `src/services/pending-dashboard.ts` now folds the operations still in
the outbox onto the pristine snapshot: net sales, transactions, units, cash, credit and the day's trend bar
move at once; COGS is added only when this device's own stock history can price the sale, otherwise profit
is flagged provisional. Merging always starts from the untouched snapshot, so a sale can never be counted
twice.

| Check | Result |
|---|---|
| `GET /sw.js` | **200**, body contains `idukaa-shell-v7` and `precacheManifest` |
| `GET /sw-assets.json` | **200**, lists **59 files / 35 scripts**, including `sell-eb3054ab…js` and `reports-1e9fbc64…js` |
| Shell install on the live origin (headless Chrome, fresh profile, one online visit) | worker `activated` and controlling after **49 s**; `caches` → `["idukaa-shell-v7"]` with **61 entries**, including the Sell script |
| The Sell script was never requested by the page online | confirmed (`Network.requestWillBeSent` never saw it) |
| Offline `fetch` of that never-loaded script (`Network.emulateNetworkConditions offline`) | `navigator.onLine === false`, **200**, 35,836 bytes — served by the worker |
| Cold launch with the network off from the same state | app shell rendered (sign-in screen: the profile has no session), `#root` populated |
| Local static-export run of the same proof | 61 cached, Reports chunk (`reports-1e9fbc64…js`, never loaded) served offline, 68,742 bytes |
| Tests | `tsc --noEmit` exit 0; `test:dashboard` 25 pass incl. 7 new `pending-dashboard` cases (queued sale moves figures, no double count, synced/rejected/out-of-range ignored, provisional cost, credit + repayment); `test:pwa` 3 pass; `test:i18n` pass |

**Note for users:** the first online visit after this deploy downloads 59 files one at a time (~50 s
observed) before the app is fully offline-capable; leave the app open once until it finishes.

**Still unverified:** iOS Safari/WebKit itself (all proof above is Chromium), and the signed-in flows on
production.

## 15. Faster, visible first-visit install (16 Nov 2026) — `6b5aeac`

The v7 deployment fixed blank offline screens but made the first visit download all 59 exported files
one at a time, and gave no sign of when it was safe to close the app. §14 measured ~49 s for that
install on the live origin.

The v8 worker fetches six files at a time (each body stored as soon as it arrives, which is what keeps
Chromium's install from stalling on unread bodies) and posts `{ type: "idukaa-precache", done, total }`.
The app root (`_layout.tsx`) shows *Saving the app for offline use — 12 / 59* and a short *Ready offline*
when the set is complete; `src/services/precache-message.ts` validates the message, so a browser that
never sends it shows nothing rather than a false "ready".

| Check | Result |
|---|---|
| Local export, 150 ms latency / 20 Mbps, fresh profile | sequential v7 **4.3 s** → v8 **2.3 s**, 61 entries cached |
| Local export, 100 ms / 4 Mbps | **8.1 s → 6.9 s** |
| Local export, 1.5 Mbps (bandwidth-bound) | **13.4 s → 12.2 s** — bytes, not round trips, dominate here |
| Copying unchanged files from the previous cache instead of downloading | **rejected**: 12.1 s vs 2.6 s, so a plain fetch is kept |
| Live origin, fresh profile, 150 ms / 20 Mbps | worker `idukaa-shell-v8`, **61 progress messages** (`0/59` → `59/59`), install span **12.3 s**, cache 61 entries |
| Banner during that live install | seen as *Saving the app for offline use*, then *Ready offline* |
| Offline fetch of the Sell chunk the page never requested | `navigator.onLine === false`, **200**, 35,836 bytes |
| Tests | `tsc --noEmit` exit 0; `test:pwa` 4 pass (pins v8, the pool, `reportProgress`, and the message parser's rejection list); `test:i18n` pass |

**Still unverified:** iOS Safari/WebKit — including whether it delivers the worker's progress messages
during install; on WebKit the install may simply appear without the banner.

## 16. Install no longer re-downloads the launch bundle (16 Nov 2026) — `f974888`

§15's install fetched every file with `cache: "reload"`, so the ~1.6 MB `entry`/`__common` bundles were
downloaded a second time immediately after the page had fetched them; only ~0.4 MB (35 screen chunks)
is actually new work. v9 lets content-hashed files come from the browser's HTTP cache and keeps the
forced network fetch for `index.html`, `sw-assets.json`, the manifest and the icons.

| Check | Result |
|---|---|
| Local export with the same cache headers Vercel sends (`immutable` for hashed files, `must-revalidate` otherwise) | install completes with **61 entries in ~0.5–0.6 s** on both a 20 Mbps/150 ms and a 1.5 Mbps/60 ms profile — the bytes are no longer on the wire |
| Same harness before this commit, but serving everything `no-cache` (i.e. a cold HTTP cache, which is what §15's 4.3 s / 13.4 s numbers measured) | 2.3 s / 12.2 s — kept for comparison, not a production figure |
| Live origin, fresh profile, 150 ms / 20 Mbps | worker `idukaa-shell-v9`, 61 progress messages, banner *Saving the app for offline use* → *Ready offline*, 61 cached, Sell chunk served offline (**200**, 35,836 bytes) |
| Tests | `tsc --noEmit` exit 0; `test:pwa` 4 pass (pins v9 and the hashed-vs-unhashed cache rule) |

**Measured limitation:** the live span (12.3 s for v8, 14.9 s for v9) is dominated by the page's own
boot competing for the main thread while it waits on the API, so it does not isolate the worker's
install. The local figures above use production-equivalent cache headers and are the ones quoted.

## 17. Install progress without worker messages (16 Nov 2026) — `d503df4`

§15's banner was driven by the worker posting `idukaa-precache` progress. Chromium delivers that;
WebKit does not reliably deliver a message from an installing worker to the page, so an iPhone could
still show nothing while it saved the app. v10 removes that dependency: the build writes the shell
cache name into `/sw-assets.json`, and the app counts that cache's entries against the file list
(`src/services/precache-status.ts` + `precache-progress.ts`). The worker no longer posts anything.

The count is honest by construction: no manifest → no banner; a returning visitor whose cache is
already complete sees nothing; a stalled install stops the banner instead of counting for ever
(30 s to wait for a first registration, then it gives up quietly).

| Check | Result |
|---|---|
| Local export (production cache headers), fresh profile | banner at **2.5 s**, counter observed as **27 / 59**, then **Ready offline**; 61 entries cached; Sell chunk served offline (**200**, 35,836 bytes) |
| Live origin, fresh profile | worker `idukaa-shell-v10`, `sw-assets.json` names `idukaa-shell-v10`, banner at **7.2 s**, then **Ready offline**; 60 entries cached; Sell chunk served offline (**200**, 35,836 bytes) |
| Worker messages | none — `tests/pwa.test.mts` asserts the worker sends no `postMessage`, so progress cannot silently regress to a Chromium-only path |
| Tests | `tsc --noEmit` exit 0; `test:pwa` 4 pass (pins v10, the cache-aware fetch rule and the manifest/progress parsers) |

**Still unverified:** iOS Safari itself. The mechanism no longer depends on anything WebKit is known to
drop, but the banner's appearance on a real iPhone is still unconfirmed from here.

## 18. Interrupted installs resume (16 Nov 2026) — `4738d0d`

Closing the app while it was saving the 59 files left the saved ones in the cache, but the next launch
walked the whole list again. v11 skips a content-hashed file that is already in the shell cache, so a
later launch carries on from where the last one stopped. Unhashed files (`/`, `/index.html`,
`sw-assets.json`, the manifest, the icons) are still fetched every time, so a redeploy cannot leave a
stale shell behind, and a redeploy's new hashes are new URLs and are not skipped.

Verified locally with a real interruption — a minimal page registering only the worker, Chrome's whole
process tree killed (`taskkill /F /T`) part-way through, then the same profile reopened:

| Check | Result |
|---|---|
| First launch | 27 hashed files fetched, 28 entries in `idukaa-shell-v11` when the browser was killed |
| Second launch, same profile, HTTP cache cleared and disabled for the page | install completed all 59 files with **8 network fetches**; banner and "Ready offline" shown; the rest of the set was already saved by the interrupted pass |
| Live origin, fresh profile | worker `idukaa-shell-v11`, manifest naming the same cache, 61 entries, banner *Saving the app for offline use* → *Ready offline*, Sell chunk served offline (**200**, 35,836 bytes) |
| Tests | `tsc --noEmit` exit 0; `test:pwa` 4 pass (pins the skip rule: a saved hashed file is not downloaded twice) |

**Measurement caveat:** a worker's own fetches may still be answered by Chrome's HTTP cache even when
the page's cache is disabled, so the network count is a lower bound on the work avoided; the
authoritative evidence is that the second launch finished the set from a partial cache with a
single-digit number of downloads.

## 19. App-shell status in the Offline Center, cache stamped per build (16 Nov 2026) — `7d518ac`

The install banner only exists during the first visit, so a half-finished install was invisible
afterwards: the offline *data* could look current while a screen that had never been saved would still
be blank. Offline Center → Availability now reads the same count on open
(`src/services/shell-status.ts`, same manifest + cache measurement as the banner) and shows
**App screens 59 / 59** with a green badge, or an amber count and *"Not every screen is saved yet…"*.
Where the Cache API or build manifest is unavailable it shows *"Not available on this platform"*
instead of a guess.

The same commit stamps the worker's cache name with a fingerprint of the build's asset list
(`scripts/write-sw-manifest.mjs`). Without it, a deploy that changes screen chunks but not `sw.js`
never re-runs the install — installed phones would keep the previous chunk names and the screens that
were never opened would go blank again, which is exactly the bug fixed in §14.

| Check | Result |
|---|---|
| Build | `dist/sw.js` → `const CACHE = "idukaa-shell-2bb9bd99"`, `sw-assets.json` reports the same name; docs-only rebuilds keep the name and re-install nothing |
| Live origin | worker and manifest agree on **`idukaa-shell-3ed156d2`** (Vercel's build), so the changed chunks do trigger a reinstall |
| Live origin, fresh profile | cache `idukaa-shell-3ed156d2` populated with **62 entries** for 59 manifest files, the app rendered, and the Sell chunk the page never requested was served offline (**200**, 35,836 bytes) |
| Tests | `tsc --noEmit` exit 0; `test:pwa` 4 pass (cache-name stamping and the manifest reporting the stamped name are pinned); `test:i18n` 5 pass (en/rw key parity for the new strings) |

**Unverified:** the Offline Center row as rendered for a signed-in user — no production credentials
here, so it was checked by type, tests and the underlying measurement, not by opening that screen.

## 20. Offline expenses on the Overview, honest offline wording (16 Nov 2026) — `d8b88a3`, `b05d636`

Reported after §19: every screen opens offline now, but screens show *"Something went wrong / Try
again"*, and a sale or expense saved with no network does not change the Overview until it syncs.

Two distinct causes:

1. **Expenses were not in the pending merge.** `pendingFigures` covered sales, credit and purchases
   only, so a queued `expense.create` was invisible: operating expenses, expenses paid, outstanding
   expenses, operating profit, the day's chart bar and the by-category panel all stayed at the server
   snapshot until sync. They are now folded in (`src/services/pending-dashboard.ts`) and never touch
   revenue. Test: `tests/pending-dashboard.test.mts` — "a queued expense counts as money spent".
2. **A saved record could be reported as failed.** `sell.tsx` and `expense.tsx` awaited the counter
   refresh and the sync attempt *inside* the save's try block, so an offline failure after the record
   was already durable showed *"The sale could not be saved"* / *"Something went wrong"*. Those
   follow-ups are now fire-and-forget with a swallowed rejection.
3. **The error card itself.** Screens that fail their first load offline use the shared `ErrorState`,
   which always said *"Something went wrong"* with a Try again button. Offline now shows an amber
   "You are offline…" message and keeps the retry button for when the network returns.

| Check | Result |
|---|---|
| Tests | `tsc --noEmit` exit 0; `test:dashboard` **8 pass** including the new expense case (expenses add to operating expenses/paid/outstanding and the day bar, revenue unchanged); `test:pwa` 4 pass; `test:i18n` 5 pass |
| Live worker | worker and manifest agree on **`idukaa-shell-5b4a3968`** (previous build was `3ed156d2`), and `index.html` names a new entry bundle — so installed phones re-run the install and receive this code |

**Unverified:** the signed-in screens themselves (no production credentials here). The merge logic is
covered by tests; whether the phone has picked up the new bundle is visible on-device as the
"Saving the app for offline use" banner followed by "Ready offline".

---

## 21. Real e-mail: confirmation before sign-in, delivered password resets (16 Nov 2026)

Asked for: sign in with a real e-mail address, recover a forgotten password by e-mail, and only allow
an address that really exists. The reset flow (token, expiry, single use, `reset-password` screen) was
already built; **nothing was ever sent** — `requestPasswordReset` logged the link and returned it in
dev mode only. "The address exists" was never checked at all.

### What decides "it really exists"

Only the ability to read mail sent to that address. Syntax checks accept dead mailboxes and MX lookups
accept catch-all domains, so neither is used. An account is allowed to sign in once a random,
expiring, single-use link has been clicked:

| Piece | Detail |
|---|---|
| Column | `users.email_verified_at` (migration `010_email_verification.sql`) |
| Tokens | `email_verification_tokens`: SHA-256 hash only, one live link per user, 48 h default, single use, bound to the address it was issued for |
| Gate | `AuthService.login` → `403 email_not_verified` (audited as `email_unverified`), checked after suspension states so a suspended shop is not sent to an inbox |
| Resend | `POST /auth/email/resend`, 5/min, same `{ ok: true }` for unknown, confirmed and unconfirmed addresses |
| Confirm | `POST /auth/email/verify` → `{ ok, email }`; a second click, an expired link and a link for a changed address are all `verification_token_invalid` |
| Reset proves control | Completing a password reset sets `email_verified_at` — receiving that mail is the same proof |
| Unverified + forgot password | The verification link is sent instead of a reset link (a reset cannot be completed from an address nobody has proven) |
| Escape hatch | `EMAIL_VERIFICATION_REQUIRED=false` — an operator response to a broken mailbox, not a permanent setting |

Accounts that already existed are backfilled as verified at their creation time, so this deploy
cannot lock out a shop that is already trading. Every account created from now on must confirm.

### A gate that cannot be satisfied does not run

Refusing sign-in is only defensible while a confirmation can actually be delivered. With **no** sending
channel configured the gate stays off (boot log: `mail.gate_inactive`), so a fresh deploy cannot create
accounts nobody is able to use, and it arms itself the moment `MAIL_GMAIL_*` or `MAIL_SMTP_*` appears.
For the same reason `POST /auth/password/forgot` and `POST /auth/email/resend` answer
`503 mail_not_configured` instead of the usual `{ ok: true }`: "we sent you a link" when nothing can be
sent is the one answer that wastes a shop's afternoon. The 503 is returned before any account lookup, so
it is identical for every address and still reveals nothing about which accounts exist.

### Delivery

One real Gmail mailbox, sent through **Gmail's HTTPS send API** (`MAIL_GMAIL_*`), with `nodemailer`
over SMTP kept as the fallback for hosts that allow it. The task first chose a Gmail app password,
but Render's free web services have blocked outbound SMTP ports 25/465/587 since September 2025 —
that path connects and then dies on `ETIMEDOUT`. The HTTPS API runs on 443, is signed by Google (so
Gmail delivers to Gmail with SPF/DKIM passing and no domain purchase), and needs one offline OAuth
token minted once by `apps/api/tools/gmail-oauth.mjs`. Both channels send the same templates.
Sending is best-effort by design — with no credentials, or with Gmail rejecting, the API still approves
shops and still answers reset requests: the failure is logged (`MailService`, plus the boot warning
`mail.not_configured`) and recorded in the audit log (`auth.email.verification.sent` and
`auth.password.reset.sent` carry `delivered` and the reason) instead of throwing. Both templates (`src/mail/templates.ts`)
carry the full link in the text part, so the message is usable with images and buttons stripped.

### Setup on the server (exact)

1. Google Cloud console → new project → **APIs & Services → Library → Gmail API → Enable**.
2. **OAuth consent screen**: User type *External*, add the sending Gmail address as a test user.
   Publish the app (*In production*) before real use: while it is in *Testing*, Google expires every
   refresh token after 7 days. An unverified app only shows a warning during consent.
3. **Credentials → Create credentials → OAuth client ID → Desktop app**; copy the client id/secret.
4. On this machine: `cd apps/api && MAIL_GMAIL_CLIENT_ID=... MAIL_GMAIL_CLIENT_SECRET=... node tools/gmail-oauth.mjs`,
   open the printed URL as the sending mailbox, and copy the printed refresh token.
5. Render → the API service → Environment: `MAIL_GMAIL_CLIENT_ID`, `MAIL_GMAIL_CLIENT_SECRET`,
   `MAIL_GMAIL_REFRESH_TOKEN`, `MAIL_FROM=<the same Gmail address>`, `MAIL_FROM_NAME=Idukaa`,
   `APP_WEB_URL=https://idukaa-api.vercel.app`, `EMAIL_VERIFICATION_REQUIRED=true`.
6. `APP_WEB_URL` is not optional: without it, links point at `http://localhost:8081`. The API warns at
   boot (`mail.link_base_missing`) instead of failing silently, and logs `mail.channel` (or
   `mail.smtp_may_be_blocked` if only SMTP is configured on this host).
7. Gmail allows roughly 500 recipients/day for a free account — far above onboarding volume. If it is
   ever exceeded, Brevo/SendGrid/Mailgun can be added behind the same two templates.

### Client

`app/verify-email.tsx` (new) handles the link and the resend form; the sign-in screen maps
`email_not_verified` to a named message plus a "Send the confirmation link again" button that routes
there with the address prefilled. Registration and staff-invitation success texts now say the address
must be confirmed first. Keys exist in English and Kinyarwanda (`verify.*`, `login.emailUnverified`,
`login.confirmEmail`).

| Check | Result |
|---|---|
| API typecheck | `tsc --noEmit` exit 0 |
| API tests (no DB here) | 32 pass, 0 fail, 103 skipped — every PostgreSQL suite skips without `TEST_DATABASE_URL` |
| New integration suite | `tests/email-verification.integration.test.ts`: gate refuses and audits, resend has no account oracle, link confirms once and then signs in, expired/changed-address links refused, escape hatch honoured |
| Fixtures | The 18 `INSERT INTO users(...)` rows in the API suites now set `email_verified_at=now()`; the two flows that create accounts (registration approval, activation, invitation accept) mark the address confirmed in-test and say why |
| Mobile | `tsc --noEmit` exit 0; `test:i18n` 5 pass |

**Unverified:** an actual Gmail delivery — no app password exists here, and no message can be sent
from this machine. The integration suite runs in CI (`.github/workflows/ci.yml` provides PostgreSQL)
but not locally; it was not executed during this change. The first real message should be checked on a
phone before inviting shops: register a shop, approve it, and confirm the link arrives and signs in.
