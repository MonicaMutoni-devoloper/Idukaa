# Cross-platform delivery report (Android · iOS · Web/PWA · Windows)

One Expo/React Native codebase, one backend, one sync strategy. This report states exactly what was
**built and verified** and what is only **configured**.

## 1. Status at a glance

| Target | Local store | Status | Artifact |
|---|---|---|---|
| **Android (native)** | `expo-sqlite` | **Built, signed, installed and verified on the Infinix X657 — 1.0.6** | `dist/idukaa-1.0.6-android-release.apk` (48,768,604 bytes, SHA-256 `8eb64b7f1b28d9f0d42010d3d88ffd5fb68b933875e88d9f6e652e8fd47060c6`, `versionCode 7`) |
| **iOS (native)** | `expo-sqlite` | Configured only — not built (needs macOS + Apple credentials) | none — see `docs/IOS_BUILD.md` |
| **Web / PWA** | `local.web.ts` → IndexedDB | **Installed in Chrome and cold-started offline on the Infinix X657** | `expo export --platform web` output with service worker (`dist/sw.js`) |
| **Windows desktop** | IndexedDB (via the PWA) | Supported as an installable PWA | no native Windows target exists for Expo SDK 58 — see `docs/ANDROID_BUILD.md` §3 |

## 2. What is shared (nothing was rebuilt or duplicated)

The app in `apps/mobile` is the single application. Platform differences are confined to two
modules, both resolved by Metro's platform extensions — no forks, no per-platform screens:

| Concern | Native (Android/iOS) | Web / Windows |
|---|---|---|
| Local database | `src/database/local.ts` → `expo-sqlite` | `src/database/local.web.ts` → IndexedDB |
| Session tokens | `expo-secure-store` (Keystore / Keychain) | `localStorage` (see `src/services/api.ts`) |
| Keyboard | `softwareKeyboardLayoutMode: resize` | browser default |

Everything else is identical on all platforms: the outbox queue (`enqueue`, `applyResults`,
`markRetry`), backoff, `op_id` idempotency, conflict handling, shop-scoped catalogue reset
(`bindShop()` — records and queued work carry a `shop_id` and are retained), the sync engine
(`src/synchronization/engine.ts`), the API client (`src/services/api.ts`), the UI kit, theming and
localisation (rw/en).

Data safety is unchanged by this work: multi-shop isolation, pending offline transactions and the
production database were not touched, and no sample/business data was seeded.

### What the app keeps offline (and how it repairs an empty list)

The catalogue (products, suppliers, on-hand quantities) is stored in SQLite on the phone and
IndexedDB in the browser, so Stock and Sell render from the device with no network at all. Every
sale, expense, receipt and count is written to the outbox **and** to the local `records` table in one
transaction before the UI reports success, then syncs when the connection returns — idempotent by
`op_id`, so a retry can never duplicate a sale.

The pull is incremental, keyed by a cursor saved on the device. If that cursor and the local rows
ever get out of step (an interrupted first pull, a cache cleared by an older build, a shop re-bound
mid-pull), every later pull legitimately answers "nothing changed" and the phone shows an empty
catalogue while the web app shows the whole shop — retrying the same cursor can never fix it.
`needsFullRepull()` (`src/synchronization/catalogue.ts`) detects exactly that shape — no products on
the device, a cursor present, no product rows in the answer — and the engine drops the cursor once
and re-pulls from the beginning. `fullResync()` exposes the same repair as "Reload stock list" on
Stock, Sell and Sync. The outbox and saved records are never part of a pull, so this cannot lose
work.

A failed pull is no longer silent: the sync store keeps a stable code (`network`, `storage`,
`server_<status>`) and the Sync, Stock and Sell screens say what happened instead of showing what
looks like an empty shop. `storage` exists because a write that fails **on the device** must never be
reported as the server's fault: in 1.0.3 the product INSERT bound 13 values to 14 columns, SQLite
refused it at prepare time, every pull aborted, and the app blamed the server while the catalogue
stayed one row deep. The browser stores the same data as objects in IndexedDB (no SQL), so it was
unaffected — which is exactly how a phone/PC divergence appears when the fault is in the native
storage layer rather than in the API.

Verified against a real API and PostgreSQL (seeded demo shop, product created through
`/sync/push`): a full pull delivers the product with the fields the device stores
(`sellingPrice`, `onHand`, `active: true`, unit configuration), and the same pull repeated with the
returned cursor answers 0 changes — the exact state that previously left the app looking empty and
that `needsFullRepull()` now repairs.

## 3. Android build (what actually ran)

Built **locally with Gradle**, not EAS, because no Expo account/credentials are available:

```bash
cd apps/mobile/android
export JAVA_HOME='C:\Program Files\Java\jdk-17'
export ANDROID_HOME="$LOCALAPPDATA/Android/Sdk"
export EXPO_PUBLIC_API_URL='https://idukaa-qqk2.onrender.com'
export IDUKAA_CXX_STAGING='C:/x'          # Windows only, see §5
./gradlew assembleRelease --no-daemon
```

Result: `BUILD SUCCESSFUL`, 615 tasks (57 executed after the synced rebuild), 2 ABIs bundled
(`arm64-v8a`, `armeabi-v7a`). The 1.0.6 build took 36m 55s because it was rebuilt from the
short-path workspace after syncing the current source.

Verified on the produced file (`aapt2` / `apksigner` / `unzip -t`):

```
package: name='rw.shop.management' versionCode='7' versionName='1.0.6'
compileSdkVersion='37'  sdkVersion:'24'  targetSdkVersion:'36'
Signer #1 certificate DN: CN=Android Debug, OU=Android, O=Unknown, ...
zip: "No errors detected in compressed data"
```

Install: `adb install -r dist/idukaa-1.0.6-android-release.apk`, or copy the file to the phone and
open it with "install unknown apps" allowed.

`npm run verify:apk -- dist/<apk>` adds two checks beyond the metadata above: every native library
and symbol must resolve for every shipped ABI (the 1.0.1 startup crash), and the bundled JavaScript
must not point at a loopback API URL (the empty-catalogue trap above).

## 4. iOS readiness

`app.json` already carries `ios.bundleIdentifier: rw.shop.management`, `buildNumber: "1"`,
`supportsTablet: true`, `userInterfaceStyle: automatic`, an `ITSAppUsesNonExemptEncryption: false`
declaration and the shared splash/icon assets, and `eas.json` defines the `ios` preview/production
profiles. **No iOS binary exists**: producing one needs macOS + Xcode 16 or an EAS account, plus an
Apple Developer Program membership. Full detail and the exact commands: `docs/IOS_BUILD.md`.

## 5. Reproducibility of the native project

`apps/mobile/android/` is generated by `expo prebuild` and git-ignored, so the required native
settings are committed as a config plugin instead of hand-edited Gradle files:

`apps/mobile/plugins/with-android-build-settings.js` (registered in `app.json`) writes, on every
prebuild:

- `compileSdk 37` (React Native 0.88 / Expo SDK 58 AAR metadata refuses anything lower),
  `targetSdk 36`, `buildTools 36.1.0`, `ndkVersion 27.1.12297006` — React Native 0.88's own NDK.
  Raising it alone rebuilds every native module against a newer libc++ than the packaged
  `libc++_shared.so`, and the app then dies at startup; see `docs/ANDROID_BUILD.md` §1–2.
- the `IDUKAA_CXX_STAGING` override for Gradle's CMake staging directory. On Windows the default
  `android/app/.cxx/...` tree overflows `MAX_PATH` (260) and `ninja` fails with
  `mkdir(...): No such file or directory`; pointing it at `C:/x` shortens those paths. This machine
  has `LongPathsEnabled=0`, so the directory cannot simply be raised.

## 6. Limitations (read before shipping)

- **The APK is signed with the local debug keystore** (`CN=Android Debug`) because no release
  keystore exists yet. It installs and runs, but it must not be published: Play requires a release
  key, and updates signed with a different key are rejected. Generate one and rebuild before any
  real distribution (`eas build` handles this automatically, or `keytool` + `signingConfigs`).
- **Physical device: offline cache, reconnect and installed PWA verified on 1.0.6; recording a new
  sale is not.** 1.0.6 installed over 1.0.5 with the existing session/SQLite data intact
  (`versionCode 7`, `firstInstallTime` unchanged). With Wi-Fi and mobile data off, after `force-stop`
  and relaunch, the downloaded current month rendered Overview (135,000 RWF / 18 sales), Inventory
  (6 products), Stock movement (32 movements), Sales and a full sale detail from cache. On reconnect
  the report switched to "Live from the server" and Sync showed 0 waiting / 0 needs review. The
  installed PWA also cold-started in standalone mode with airplane mode on and showed
  "Offline — showing the last saved figures" with the saved 10 Nov 17:23 copy. Recording a new
  offline sale remains untested on this handset because it holds a real shop's production session
  and no credentials were available to sign back in; that flow is covered by the web/API tests. The
  carrier link also drops intermittently, so a `network` code there can be the link rather than the
  app.
- **The release APK must point at the deployed API.** `apps/mobile/.env` holds
  `EXPO_PUBLIC_API_URL=http://localhost:3000` for local development; a release built with it signs in
  on a laptop but can never reach the server from a phone (empty catalogue, nothing syncing).
  `npm run verify:apk` now fails such a build, and the Gradle command above sets the URL explicitly.
- No Android emulator run, no OTA updates (`expo-updates` is not configured — every change needs a
  new build), and `build-tools 37.0.0` was unavailable from Google's CDN during this build, hence
  36.1.0 in the plugin.
- iOS: configuration only. Web/Windows: the PWA is the supported desktop story.
