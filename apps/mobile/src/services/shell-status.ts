import { Platform } from "react-native";
import { describeProgress, readPrecacheManifest, type PrecacheProgress } from "./precache-status";

/**
 * How many of the app's own files are saved for offline use, read on demand.
 *
 * The install banner in the app root only exists while the first visit is saving. This is the same
 * measurement taken later, so Settings → Offline Center can answer "is the app itself ready?" weeks
 * after installation, when the offline *data* (reports, months) may be current but a half-finished
 * install would still leave a screen blank.
 */
export const readShellStatus = async (): Promise<PrecacheProgress | null> => {
  if (Platform.OS !== "web" || typeof caches === "undefined" || typeof fetch !== "function") return null;
  try {
    const response = await fetch("/sw-assets.json", { cache: "no-store" });
    if (!response.ok) return null;
    const manifest = readPrecacheManifest(await response.json());
    if (!manifest) return null;
    const cached = await caches.open(manifest.cache);
    return describeProgress((await cached.keys()).length, manifest.total);
  } catch {
    // No Cache API, storage blocked, or an app served without the build manifest: report "unknown".
    return null;
  }
};
