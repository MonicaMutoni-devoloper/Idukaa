/**
 * Brand-introduction preferences and timings.
 *
 * Kept free of React Native imports so the timing rules can be checked by the Node test suite.
 * The "seen" flag lives in the device KV store (SQLite / IndexedDB) and is deliberately NOT
 * namespaced by user, shop or session: the introduction belongs to the installation, and signing
 * in, switching shops, syncing or navigating must never replay it.
 */
export const INTRO_SEEN_KEY = "intro_seen_v1";

/**
 * First launch: three two-and-a-half second business scenes plus a short hand-off. Every caption
 * stays readable for more than two seconds, which the old 4.4 second version did not allow.
 */
export const INTRO_FIRST_MS = 8000;
/** Every later launch: a branded hand-off, not a second introduction. */
export const INTRO_RETURNING_MS = 850;

/**
 * Reduced motion keeps the information on screen for the same reading time but never moves it.
 * The first-launch version therefore still gets the full three-stage summary.
 */
export const INTRO_REDUCED_FIRST_MS = 8000;
export const INTRO_REDUCED_RETURNING_MS = 850;

/** Stage boundaries in milliseconds: stock in, inventory, sale, final hand-off, end. */
export const INTRO_STAGE_MS = [0, 2500, 5000, 7500, 8000] as const;

export type IntroMode = "loading" | "first" | "returning" | "done";

/** The only value written once the introduction has been watched or skipped. */
export const INTRO_SEEN_VALUE = "1";

/** Build-time flag: only a development/test build may offer the preview link. */
export const INTRO_PREVIEW_ENABLED = process.env.EXPO_PUBLIC_INTRO_PREVIEW === "1";

/**
 * A preview must be requested explicitly with `?intro=preview` (web) or
 * `shopmgmt:///?intro=preview` (Android). It never clears or rewrites the completion flag.
 */
export function isIntroPreviewUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  return /(?:[?&])intro=preview(?:&|$)/i.test(url) || /intro-preview/i.test(url);
}

export function introDurationFor(mode: IntroMode, reduced: boolean): number {
  if (mode === "first") return reduced ? INTRO_REDUCED_FIRST_MS : INTRO_FIRST_MS;
  if (mode === "returning") return reduced ? INTRO_REDUCED_RETURNING_MS : INTRO_RETURNING_MS;
  return 0;
}
