# Android build preparation (native targets)

**Status: prepared, not built.** `apps/mobile/eas.json` and `app.json` → `android.versionCode` were
added on 31 Oct 2026. No APK/AAB exists yet — that needs your Expo account (see §4).
Prepared after the web/API deployment work, as agreed; nothing here changes app behaviour.

## 1. What can be built

| Target | Supported? | How |
|---|---|---|
| **Android APK** (sideload / internal testing) | **Yes** | `eas build --profile preview` (`buildType: "apk"`) |
| **Android AAB** (Google Play) | **Yes** | `eas build --profile production` (`buildType: "app-bundle"`, `autoIncrement` bumps `versionCode`) |
| **Windows native package** | **No — not with this stack** | See §3 |

The Expo project is intact: SDK 58, `expo-sqlite`, `expo-secure-store`, `expo-router`, and a committed
`android/` Gradle project. A web build succeeding proves nothing about native packages — nothing has
been compiled for Android yet.

## 2. ⚠ One decision needed before the first build: application id

Two different package names exist in the repository right now:

- `apps/mobile/app.json` → `android.package`: **`rw.shop.management`** (what Expo/EAS uses)
- `android/app/build.gradle` → `applicationId`: **`com.shopmanagementsystem`** (stale committed
  prebuild output, also the Kotlin path `com/shopmanagementsystem/`)

No release has ever shipped (only `debug.keystore` exists), so **nothing on any phone constrains
this choice** — but pick once, because changing it later makes the new APK a *different app* instead
of an update.

- **Recommended:** keep `rw.shop.management`, and regenerate the native folder so both agree:
  ```bash
  cd apps/mobile && npx expo prebuild --platform android --clean
  ```
  (`--clean` deletes and recreates `android/` — confirm before running; it must not be done while
  you have local-only edits in that folder.)
- **Or** change `android.package` in `apps/mobile/app.json` to `com.shopmanagementsystem` to match
  the existing Gradle project, and never run `--clean` prebuild.

## 3. Windows

**The web app running in Windows is not a Windows application.** This repo has no Windows target:
Expo/React Native does not ship one for this SDK, and `react-native-windows` does not support
React Native 0.88 / Expo SDK 58. Realistic options, in order of effort:

1. **Installable PWA** (already built and documented): serve the web export over HTTPS, use
   Chrome/Edge → **Install app** → Start-menu launcher, works offline via the service worker. This is
   the supported Windows story today — see `docs/DEPLOYMENT.md`.
2. **Desktop shell** (future task): wrap the built web bundle in Tauri or Electron and point
   `EXPO_PUBLIC_API_URL` at the production API. Requires its own packaging/signing work.
3. Do **not** assume a Windows `.exe` exists because `npm run build:web` succeeded.

## 4. Exact commands to produce the first build

```bash
npm i -g eas-cli
eas login                                  # your Expo account (never shared in chat)
cd apps/mobile
eas init                                   # links this project to EAS; writes extra.eas.projectId into app.json
```

Set the build-time API URL for the native app (it is baked into the bundle — native does not read
`apps/mobile/.env` at runtime):

```bash
eas env:create EXPO_PUBLIC_API_URL=https://<your-render-api-domain>.onrender.com --environment production
```

Then:

```bash
eas build --profile preview    --platform android     # APK  -> internal distribution link
eas build --profile production --platform android     # AAB  -> Google Play
```

Signing/credentials: `eas build` prompts for an upload keystore and stores it in EAS
(**Manage credentials → Android**). Download and keep a backup of the keystore + password: losing it
means users can never receive an update of the same app. `.gitignore` excludes `*.keystore`,
`*.p12`, `*.pem`, `*.key` and `*.jks`, so a keystore can never be committed here.

## 5. SQLite and offline on each target

| Target | Local store | Outbox/queue | Notes |
|---|---|---|---|
| Android (native) | **expo-sqlite** (`src/database/local.ts`) | same `enqueue`/`applyResults`/`markRetry` logic | Full offline: writes are durable in SQLite before the UI reports success; survives app kill/restart |
| Web / Windows PWA | **IndexedDB** (`src/database/local.web.ts`) | same API, one atomic record per mutation | Durable across reloads; clearing site data deletes unsynced work |
| Windows native | not applicable | — | use the PWA or a desktop shell (§3) |

**No offline changes are required for Android** — the queue, backoff, idempotency (`op_id`),
conflict handling and shop-scoped `bindShop()` cache wipe are platform-independent and already
covered by the API suite and the 19-scenario browser E2E run.

## 6. Install and update story

- **Internal testing (APK):** `eas build --profile preview` gives a QR/link; install by allowing
  unknown sources. Each new `versionCode` supersedes the previous install (same `applicationId`).
- **Google Play (AAB):** upload to an internal/closed testing track; Play handles delivery and
  staged rollouts. `autoIncrement` raises `versionCode` per build.
- **In-app updates:** **EAS Update is not configured** (no `runtimeVersion`/`updates` config and no
  channel set). Until it is, every fix needs a new build. JS-only changes could later be OTA-patched
  by adding `expo-updates` — record as a follow-up, do not enable it silently.
- **Environment:** the native build must be rebuilt whenever the API URL changes, because
  `EXPO_PUBLIC_API_URL` is compiled in.

## 7. Checklist before shipping to real phones

1. Decide the package id (§2) and regenerate or align the Gradle project.
2. `eas init`, set `EXPO_PUBLIC_API_URL` for the production environment.
3. Build the preview APK, install it on a physical device, and run the offline test:
   sign in → airplane mode → record a sale → force-stop the app → reopen → the sale is still there
   → reconnect → sync → sync again → no duplicates, stock correct.
4. Confirm the API base URL in the built app is the production API, never `localhost`.
5. Only then upload the AAB to Play.
