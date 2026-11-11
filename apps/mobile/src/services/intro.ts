/**
 * Brand-introduction preferences and timings.
 *
 * Kept free of React Native imports so the timing rules can be checked by the Node test suite.
 * The "seen" flag lives in the device KV store (SQLite / IndexedDB) and is deliberately NOT
 * namespaced by user, shop or session: the introduction belongs to the installation, and signing
 * in, switching shops, syncing or navigating must never replay it.
 */
export const INTRO_SEEN_KEY = "intro_seen_v1";

/** A full introduction on first launch: long enough to tell the stock story, short enough to wait. */
export const INTRO_FIRST_MS = 4400;
/** Every later launch: a branded hand-off, not a second introduction. */
export const INTRO_RETURNING_MS = 800;

/**
 * Reduced motion keeps the information on screen for the same short wait but never moves it.
 * The first-launch version therefore still gets the full reading time.
 */
export const INTRO_REDUCED_FIRST_MS = 4200;
export const INTRO_REDUCED_RETURNING_MS = 800;

export type IntroMode = "loading" | "first" | "returning" | "done";

/** The only value written once the introduction has been watched or skipped. */
export const INTRO_SEEN_VALUE = "1";

export function introDurationFor(mode: IntroMode, reduced: boolean): number {
  if (mode === "first") return reduced ? INTRO_REDUCED_FIRST_MS : INTRO_FIRST_MS;
  if (mode === "returning") return reduced ? INTRO_REDUCED_RETURNING_MS : INTRO_RETURNING_MS;
  return 0;
}
