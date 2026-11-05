# iOS readiness and signing requirements

**Status: configured, not built, not installable yet.** iOS binaries can only be produced on macOS
with Xcode (or by EAS Build using your Apple Developer credentials). No iOS build exists in this
repository or on EAS, and no iPhone has been used to test it.

## 1. What is already configured (reused, no duplicate code)

| Piece | Where | Platform behaviour |
|---|---|---|
| App identity | `apps/mobile/app.json` → `ios.bundleIdentifier: rw.shop.management`, `buildNumber: 1` | Same identifier namespace as Android (`rw.shop.management`) |
| Tablet support | `ios.supportsTablet: true` | iPad layout uses the same responsive breakpoints (`BREAKPOINT_WIDE = 900`) as the web/PWA build |
| Appearance | `ios.userInterfaceStyle: automatic` | Light/dark follow the iOS system setting |
| Launch screen | `expo-splash-screen` plugin (`assets/splash-icon.png`, dark variant) | Same splash as Android |
| Local storage | `src/database/local.ts` via `expo-sqlite` | Requested SQLite store; `database/index.ts` resolves `local.web.ts` only on web, so iOS gets SQLite |
| Session storage | `expo-secure-store` | Keychain-backed tokens on iOS (see `src/services/api.ts`) |
| Offline queue + sync | `src/synchronization/engine.ts` | Identical outbox, backoff, `op_id` idempotency and shop-scoped cache wipe as Android |
| Encryption declaration | `ios.infoPlist.ITSAppUsesNonExemptEncryption: false` | Avoids the export-compliance prompt on every upload (the app uses SQLite, not custom crypto) |
| Deep links | `scheme: shopmgmt` | `shopmgmt://` opens the app |
| Network | HTTPS only | ATS needs no exceptions; the production API is HTTPS |

No iOS-specific business logic, screens or sync code was added — the Expo/React Native app is the
single application, and platform differences are confined to the storage module.

## 2. What is still required before an iPhone build exists

1. **A Mac with Xcode 16+** (iOS builds cannot be produced on Windows), *or* an Expo EAS account.
2. **Apple Developer Program membership** (99 USD/year) — required for installing on a real iPhone
   (ad-hoc/internal distribution) and for TestFlight/App Store.
3. **A signing identity**: EAS generates and stores an Apple Distribution certificate and an ad-hoc
   provisioning profile when you run `eas credentials` → iOS, or manages them automatically on the
   first build if you sign in with your Apple ID.
4. **Device registration** for internal installs: each iPhone's UDID must be registered so the
   ad-hoc provisioning profile covers it (`eas device:create`).

## 3. Exact commands (to run on macOS or with an Expo account)

```bash
npm i -g eas-cli
eas login
cd apps/mobile
eas init                                             # links the project (writes extra.eas.projectId)

# API URL is compiled into the bundle; native never reads apps/mobile/.env at runtime
eas env:create EXPO_PUBLIC_API_URL=https://idukaa-qqk2.onrender.com --environment production

eas device:create                                    # register test iPhones (internal builds)
eas build --profile preview    --platform ios        # internal/ad-hoc .ipa
eas build --profile production --platform ios        # App Store .ipa / TestFlight
```

`eas.json` already defines `preview` (`distribution: internal`) and `production`
(`autoIncrement`); the iOS `buildNumber` is bumped automatically by the production profile.

## 4. Honest limitations

- **Not built, not signed, not installed.** Everything above is configuration only. Do not treat it
  as a working iOS app.
- `expo-sqlite` and `expo-secure-store` are standard Expo modules with iOS support, but their
  behaviour on iOS was **not exercised** in this work; the offline test suite was run on web
  (IndexedDB) and the APK was produced for Android only.
- Push notifications, background sync (`BGTaskScheduler`) and iOS-specific keyboard avoidance were
  **not** implemented; the app syncs while it is open and in the foreground, on every platform.
- App Store review will additionally need: a privacy policy URL, screenshots, and a support URL.
