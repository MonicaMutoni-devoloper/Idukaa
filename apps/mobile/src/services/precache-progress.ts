import { Platform } from "react-native";
import { create } from "zustand";
import { readPrecacheMessage, type PrecacheProgress } from "./precache-message";

/**
 * How much of the app the service worker has saved for offline use.
 *
 * The web build ships one script per screen, so the first visit has to store all of them before an
 * installed app can open every screen with no network. That pass takes a while, and a visit that is
 * closed half-way leaves screens unsaved — so the worker reports its progress and the app shows it.
 *
 * Only the worker drives this: nothing here is persisted, and a browser that never sends the
 * message simply shows no banner (previous behaviour), never a false "ready".
 */

export type { PrecacheProgress } from "./precache-message";

/** How long the finished banner stays up before it removes itself. */
const DONE_MS = 4000;

interface PrecacheState {
  progress: PrecacheProgress | null;
  /** Attach once, from the app root: the worker can start installing before any screen renders. */
  start: () => void;
}

let started = false;
let hideTimer: ReturnType<typeof setTimeout> | null = null;

export const usePrecacheProgress = create<PrecacheState>((set) => ({
  progress: null,

  start: () => {
    if (started) return;
    started = true;
    if (Platform.OS !== "web" || typeof navigator === "undefined") return;
    const serviceWorker = (navigator as any).serviceWorker;
    if (!serviceWorker?.addEventListener) return;

    serviceWorker.addEventListener("message", (event: MessageEvent) => {
      const progress = readPrecacheMessage(event.data);
      if (!progress) return;
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
      set({ progress });
      // A finished install is worth one short confirmation, then the banner goes away for good.
      if (progress.done >= progress.total) {
        hideTimer = setTimeout(() => { set({ progress: null }); hideTimer = null; }, DONE_MS);
      }
    });
  },
}));
