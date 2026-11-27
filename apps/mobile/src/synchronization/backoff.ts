/**
 * When the next automatic sync attempt happens after a failed pass.
 *
 * The engine used to rely on its 30-second poll and the per-operation retry timestamp, so a server
 * that was asleep, restarting, or briefly refusing woke the app up at a fixed rate with no regard
 * for how many times it had already failed: a Render cold start could be hit repeatedly by every
 * device at once, and a shop with ten phones made it worse. Retrying after 2s, 4s, 8s … (capped,
 * with jitter so devices do not return in lockstep) recovers quickly from a blip while backing off
 * from a real outage.
 *
 * Kept free of React Native and database imports so the schedule is testable on plain Node.
 */

/** The first retry is quick: most failures are a dropped packet or a cold start already waking. */
export const RETRY_BASE_MS = 2_000;
/** A device that has failed this many times is waiting for an outage, not a blip. */
export const RETRY_MAX_MS = 60_000;

/**
 * Delay before attempt `attempt` (1 = the first retry after a failure).
 * `random` is injectable so the schedule and its bounds are testable.
 */
export function retryDelay(attempt: number, random: () => number = Math.random): number {
  const step = Math.max(1, Math.min(Math.floor(attempt), 6));
  const base = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (step - 1));
  // ±20 % jitter, never past the ceiling (at 60 s, +20 % would be 72 s).
  return Math.min(RETRY_MAX_MS, Math.round(base * (0.8 + random() * 0.4)));
}

/** How a pass ended, which decides whether the next one is immediate, delayed or not needed. */
export type PassOutcome = "ok" | "failed" | "incomplete";

/**
 * The failure streak after a pass.
 *  - A clean pass resets it, so recovery is instant the moment the server is back.
 *  - A failure counts even if a later part of the pass succeeded: the queue is still not moving.
 *  - "incomplete" (the server answered, but the queue was not fully pushed) keeps the streak but
 *    must not grow it — there may be nothing to wait for but an approval, not an outage.
 */
export function nextStreak(current: number, outcome: PassOutcome): number {
  if (outcome === "ok") return 0;
  if (outcome === "failed") return current + 1;
  return current;
}
