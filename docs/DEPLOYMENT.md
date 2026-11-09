# Deployment

**API**: Node 20+ container/VM + managed PostgreSQL 15+. Set `DATABASE_URL`, `JWT_SECRET` (≥48 random
chars), `JWT_EXPIRES_IN` (default `15m`), `REFRESH_TOKEN_TTL_DAYS`, `TOTP_ENCRYPTION_KEY` (32 bytes
base64 or 64 hex — required for 2FA), `PASSWORD_RESET_URL`, `PASSWORD_RESET_DEV_MODE=false`,
`COOKIE_SECURE=true`, `CORS_ORIGINS` (the exact PWA origin) and `PORT`. Pending migrations are applied
by the API itself before it opens the port (tracked in `schema_migrations`, serialized by a PostgreSQL
advisory lock, `DIRECT_URL` preferred), so new code can never serve an older schema; a migration that
fails stops that instance from starting. Set `AUTO_MIGRATE=false` to run `npm run migrate` out of band
instead. Terminate TLS at a reverse proxy (nginx/Caddy) and
forward `X-Forwarded-Proto: https` (`trust proxy` is enabled). Put monitoring on `GET /admin/health`
(admin token).

**Same site requirement**: the web refresh cookie is `SameSite=Strict`, so serve the web app and the API
from the same registrable domain (for example `app.example.rw` and `api.example.rw`, or the API under
`app.example.rw/api` with a proxy). A cross-site API cannot use the cookie flow.

**Mobile update manifest**: `GET /app/version` (public, no session needed) tells an installed app what
the current build is and whether its own build is still supported. It is configured from the
environment, not from code: `APP_LATEST_VERSION` (default `1.0.2`), `APP_LATEST_VERSION_CODE` (`3`),
`APP_MINIMUM_VERSION` (`1.0.0`), `APP_MINIMUM_VERSION_CODE` (`0`), `APP_UPDATE_URL` (where users
download the new APK), `APP_RELEASE_NOTES`, `APP_CRITICAL`, `APP_API_VERSION` (`1`) and
`APP_MINIMUM_API_VERSION` (`1`). An empty variable reads as “not set”, never as zero. Raise the
minimum **only after** the new build has been verified on real devices: clients above the minimum keep
working, so a backend release never strands a shop mid-shift. There is no OTA channel —
`expo-updates` is not installed — so the manifest reports `ota.enabled: false` and points at a signed
APK instead of pretending a JavaScript download can replace native code.

**Web/PWA**: `npm run build:web -w @sms/mobile`, host `apps/mobile/dist` as static files over HTTPS
(service workers and the install prompt require HTTPS) with a single-page fallback to `index.html`.
Set `EXPO_PUBLIC_API_URL` at build time. The export ships `manifest.json` (name, icons, start URL,
standalone, theme/background colours) and `sw.js`; the service worker caches the app shell only and never
caches authentication or API responses.

**Install instructions (Chrome/Edge)**: open the HTTPS URL → address-bar **Install app** (or menu →
“Install Shop Management”) → launch from the Start menu. Firefox/Safari users can keep using the site in a
tab; iOS Safari uses Share → “Add to Home Screen”. After installing, check sign-in, reload (the access
token is refreshed from the HttpOnly cookie), sign-out, offline shell and reconnect + sync.

**Android**: build a signed APK/AAB locally with Gradle (see `docs/ANDROID_BUILD.md`) or with
`eas build -p android`. Set `EXPO_PUBLIC_API_URL` to your HTTPS API before building — it is compiled
into the bundle. Tokens are stored in the platform keystore through SecureStore. Before publishing,
run `npm run verify:apk -- <file.apk>`: it fails if a required native library is missing or if any
packaged `.so` references a symbol the packaged runtime cannot supply (the `libworklets.so` startup
crash on Android 10 was exactly that).

**Password-reset e-mail**: this repository has no e-mail/SMS provider. Until one is integrated, leave
`PASSWORD_RESET_DEV_MODE=false` in production: reset requests answer generically but no message is
delivered. Configure a provider and send `PASSWORD_RESET_URL?token=…` (30-minute link) before relying on
self-service recovery. Never enable dev mode in production — it is ignored when `NODE_ENV=production`, but
do not rely on that alone.

**Operational maintenance**: periodically delete expired rows
(`refresh_sessions`, `password_reset_tokens`, `two_factor_challenges`) and take backups of the database
and `TOTP_ENCRYPTION_KEY` (losing the key breaks 2FA for enrolled users).

**First production data**: create the first shop and users with a one-off script or `POST /admin/shops` +
`POST /admin/users` after creating a `system_admin` directly in SQL with a bcrypt hash.
