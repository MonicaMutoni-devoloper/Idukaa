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
   script can prove.

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
