import { Platform } from "react-native";
import { create } from "zustand";

/**
 * PWA installation state.
 *
 * `beforeinstallprompt` can fire before the user reaches Settings, so the listener lives at the app
 * root (startPwaInstall). We keep the browser event only in memory: it is not serializable, not
 * sensitive, and must never be persisted. Installed/standalone detection is re-read from the
 * browser because it can change while the app is open (for example after installing from Chrome's
 * menu).
 */

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice?: Promise<{ outcome: "accepted" | "dismissed" }>;
};

type InstallOutcome = "accepted" | "dismissed" | "unavailable" | "error";

interface PwaInstallState {
  available: boolean;
  installed: boolean;
  busy: boolean;
  lastOutcome: InstallOutcome | null;
  start: () => void;
  promptInstall: () => Promise<InstallOutcome>;
  refreshInstalled: () => void;
}

let deferred: InstallPromptEvent | null = null;
let started = false;

const isWeb = () => Platform.OS === "web" && typeof window !== "undefined";
const browserWindow = () => (isWeb() ? (window as any) : null);

export const isStandalonePwa = (): boolean => {
  const w = browserWindow();
  if (!w) return false;
  try {
    return !!w.matchMedia?.("(display-mode: standalone)")?.matches || w.navigator?.standalone === true;
  } catch {
    return false;
  }
};

export const usePwaInstall = create<PwaInstallState>((set) => ({
  available: false,
  installed: false,
  busy: false,
  lastOutcome: null,

  refreshInstalled: () => {
    const installed = isStandalonePwa();
    if (installed) deferred = null;
    set({ installed, available: installed ? false : usePwaInstall.getState().available });
  },

  start: () => {
    if (started) return;
    started = true;
    const w = browserWindow();
    if (!w) return;
    set({ installed: isStandalonePwa() });

    const onPrompt = (event: Event) => {
      event.preventDefault?.();
      deferred = event as InstallPromptEvent;
      set({ available: true, installed: false });
    };
    const onInstalled = () => {
      deferred = null;
      set({ available: false, installed: true, lastOutcome: "accepted" });
    };
    const onDisplayChange = () => {
      if (isStandalonePwa()) set({ available: false, installed: true });
    };

    w.addEventListener("beforeinstallprompt", onPrompt);
    w.addEventListener("appinstalled", onInstalled);
    try {
      const media = w.matchMedia?.("(display-mode: standalone)");
      media?.addEventListener?.("change", onDisplayChange);
      media?.addListener?.(onDisplayChange); // older Chromium
    } catch {
      /* a browser without matchMedia still gets the basic prompt support */
    }
  },

  promptInstall: async () => {
    const event = deferred;
    if (!event) return "unavailable";
    set({ busy: true });
    try {
      await event.prompt();
      const choice = await event.userChoice;
      const outcome: InstallOutcome = choice?.outcome === "accepted" || choice?.outcome === "dismissed"
        ? choice.outcome : "unavailable";
      // The event can only be prompted once, whatever the user chooses.
      deferred = null;
      set({ available: false, busy: false, lastOutcome: outcome, installed: isStandalonePwa() });
      return outcome;
    } catch {
      deferred = null;
      set({ available: false, busy: false, lastOutcome: "error" });
      return "error";
    }
  },
}));
