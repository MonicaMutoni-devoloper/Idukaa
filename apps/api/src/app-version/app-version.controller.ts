import { Controller, Get } from "@nestjs/common";
import { Public } from "../common/auth";

/**
 * Server-controlled update manifest, read by the app at start, on foreground and when the connection
 * returns (throttled in the app). Public on purpose: a device must be able to learn that its build
 * is too old *before* it has a usable session, and the payload contains no shop data.
 *
 * Two different things are versioned here and they must not be confused:
 *  - the native app version (`versionCode` is what Android enforces when installing a newer APK),
 *  - the API version, so an older but still supported app keeps working after a backend release.
 *
 * Values come from the environment so raising the minimum is a deploy-time decision, not a code
 * change: APP_LATEST_VERSION, APP_LATEST_VERSION_CODE, APP_MINIMUM_VERSION,
 * APP_MINIMUM_VERSION_CODE, APP_UPDATE_URL, APP_RELEASE_NOTES, APP_CRITICAL, APP_API_VERSION,
 * APP_MINIMUM_API_VERSION. A missing or malformed value falls back instead of emitting NaN.
 */
const text = (key: string, fallback: string) => process.env[key]?.trim() || fallback;
const count = (key: string, fallback: number) => {
  // An empty variable (a dashboard field left blank) must read as "not set", not as zero.
  const raw = process.env[key]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
};
const flag = (key: string, fallback: boolean) => {
  const v = process.env[key]?.trim().toLowerCase();
  return v === undefined || v === "" ? fallback : v === "1" || v === "true" || v === "yes";
};

@Public()
@Controller("app/version")
export class AppVersionController {
  @Get()
  version() {
    return {
      // Kept in step with the API's own contract so a client can refuse to talk to a future server.
      apiVersion: count("APP_API_VERSION", 1),
      minimumApiVersion: count("APP_MINIMUM_API_VERSION", 1),
      latest: {
        version: text("APP_LATEST_VERSION", "1.0.2"),
        versionCode: count("APP_LATEST_VERSION_CODE", 3),
        runtimeVersion: text("APP_RUNTIME_VERSION", "1"),
        url: text("APP_UPDATE_URL", "https://github.com/MonicaMutoni-devoloper/Idukaa/releases"),
        notes: text("APP_RELEASE_NOTES", "Startup fix for Android 10 phones (Infinix, Tecno and similar)."),
        critical: flag("APP_CRITICAL", false),
      },
      // Defaults stay low on purpose: an operator raises these once a build has been verified on
      // real devices, never the other way round.
      minimum: {
        version: text("APP_MINIMUM_VERSION", "1.0.0"),
        versionCode: count("APP_MINIMUM_VERSION_CODE", 0),
      },
      // Native and JavaScript ship together: expo-updates is not installed, so there is no OTA
      // channel and a JS-only "update" cannot exist. Reported explicitly so clients do not assume one.
      ota: { enabled: false },
    };
  }
}
