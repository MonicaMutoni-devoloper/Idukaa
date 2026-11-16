import { Platform } from "react-native";
import { create } from "zustand";
import { describeProgress, readPrecacheManifest, type PrecacheProgress } from "./precache-status";

/**
 * How much of the app the service worker has saved for offline use.
 *
 * The web build ships one script per screen, so the first visit has to store all of them before an
 * installed app can open every screen with no network. The app therefore reads the shell cache's
 * entry count against `/sw-assets.json` — the same list the worker installs from. Counting is used
 * rather than the worker's own progress messages because WebKit does not reliably deliver those
 * while installing, and an iPhone showing nothing is exactly the problem this solves.
 *
 * Nothing is persisted and nothing is guessed: with no manifest, or no install running, no banner
 * appears at all.
 */

export type { PrecacheProgress } from "./precache-status";

const POLL_MS = 500;
/** A finish confirmation stays up this long, then removes itself. */
const DONE_MS = 4000;
/** A first visit registers its worker a moment after load; stop waiting quietly after this. */
const WAIT_FOR_INSTALL_MS = 30000;
/** Give up quietly if an install never reports anything (storage blocked, worker refused). */
const GIVE_UP_MS = 6 * 60 * 1000;

interface PrecacheState {
  progress: PrecacheProgress | null;
  /** Attach once, from the app root: the worker can start installing before any screen renders. */
  start: () => void;
}

let started = false;
let hideTimer: ReturnType<typeof setTimeout> | null = null;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const installingNow = async (): Promise<boolean> => {
  try {
    const reg = await (navigator as any).serviceWorker?.getRegistration?.();
    return !!(reg?.installing || reg?.waiting);
  } catch {
    return false;
  }
};

const countSaved = async (cache: string): Promise<number> => {
  try {
    const opened = await caches.open(cache);
    return (await opened.keys()).length;
  } catch {
    return 0;
  }
};

export const usePrecacheProgress = create<PrecacheState>((set) => ({
  progress: null,

  start: () => {
    if (started) return;
    started = true;
    if (Platform.OS !== "web" || typeof navigator === "undefined" || typeof caches === "undefined") return;

    void (async () => {
      let manifest = null;
      try {
        manifest = readPrecacheManifest(await (await fetch("/sw-assets.json", { cache: "no-store" })).json());
      } catch {
        return; // no build manifest: the app simply shows no install banner
      }
      if (!manifest) return;

      const began = Date.now();
      const initial = await countSaved(manifest.cache);
      let shown = false;
      let lastSaved = initial;

      while (Date.now() - began < GIVE_UP_MS) {
        const saved = await countSaved(manifest.cache);
        const installing = await installingNow();
        const progress = describeProgress(saved, manifest.total);

        // A finished install that was never watched (a returning visitor) must not flash a banner.
        if (installing || saved > initial) shown = true;
        if (!shown) {
          // The worker is registered a moment after the page loads; wait for it, but not for ever.
          if (Date.now() - began > WAIT_FOR_INSTALL_MS) return;
          await sleep(POLL_MS);
          continue;
        }

        if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
        if (progress) set({ progress });

        if (progress && progress.done >= progress.total && !installing) {
          hideTimer = setTimeout(() => { set({ progress: null }); hideTimer = null; }, DONE_MS);
          return;
        }
        // A stalled install (worker stopped, storage full) must not leave a banner counting for ever.
        if (!installing && saved === lastSaved) return;
        lastSaved = saved;
        await sleep(POLL_MS);
      }
      if (!shown) set({ progress: null });
    })();
  },
}));
