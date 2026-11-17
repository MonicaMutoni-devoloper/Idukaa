import { HttpException, HttpStatus, Injectable, Logger } from "@nestjs/common";

/**
 * How many wrong passwords one address may present before it is made to wait, and for how long.
 *
 * This exists because the per-IP throttle alone is the wrong shape for a shop. Five employees on the
 * same Wi-Fi leave the building through one address, so an 8/min IP limit punishes the honest shop
 * and not the attacker, who can rent addresses. Counting failures per ACCOUNT instead lets the IP
 * limit be raised for a busy counter while a single address still cannot be guessed at.
 *
 * Deliberately in-process (no table, no migration): the cost of losing the counters on a restart is
 * that a patient attacker gets a fresh ten guesses, and the alternative — a write on every failed
 * login — turns a password-guessing attempt into database load.
 */
const WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 10;
const LOCK_MS = 15 * 60_000;
/** Backstop against an attacker rotating addresses to grow the map without bound. */
const MAX_TRACKED = 5_000;

type Entry = { failures: number; first: number; lockedUntil: number };

@Injectable()
export class LoginLockout {
  private readonly log = new Logger("auth");
  private readonly entries = new Map<string, Entry>();

  /** Addresses are compared case-insensitively, the same way the login lookup compares them. */
  private key(email: string) {
    return email.trim().toLowerCase();
  }

  /** Seconds the caller must wait, or 0 if it may try now. */
  retryAfterSeconds(email: string): number {
    const k = this.key(email);
    const e = this.entries.get(k);
    if (!e) return 0;
    const now = Date.now();
    if (e.lockedUntil > now) return Math.ceil((e.lockedUntil - now) / 1000);
    if (now - e.first > WINDOW_MS) this.entries.delete(k);
    return 0;
  }

  /** Throws 429 with the wait in the body so the client can say "try again in N minutes". */
  assertAllowed(email: string) {
    const wait = this.retryAfterSeconds(email);
    if (wait > 0) {
      throw new HttpException(
        { statusCode: HttpStatus.TOO_MANY_REQUESTS, message: "too_many_attempts", retryAfterSeconds: wait },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /** One more wrong password. The tenth inside the window locks the address, not the IP. */
  fail(email: string) {
    const k = this.key(email);
    const now = Date.now();
    const e = this.entries.get(k);
    if (!e || now - e.first > WINDOW_MS) {
      this.entries.set(k, { failures: 1, first: now, lockedUntil: 0 });
      this.prune(now);
      return;
    }
    e.failures += 1;
    if (e.failures >= MAX_FAILURES) {
      e.failures = 0;
      e.first = now;
      e.lockedUntil = now + LOCK_MS;
      // No address in the log: the line is here to show the lockout working, not to leak identities.
      this.log.warn("login.locked_out after repeated failures");
    }
  }

  /** A correct password clears the count, so a forgotten capital letter never becomes a lockout. */
  succeed(email: string) {
    this.entries.delete(this.key(email));
  }

  private prune(now: number) {
    if (this.entries.size <= MAX_TRACKED) return;
    for (const [k, e] of this.entries) {
      if (e.lockedUntil <= now && now - e.first > WINDOW_MS) this.entries.delete(k);
    }
    // Still full of live entries: drop the oldest half rather than grow without limit.
    if (this.entries.size > MAX_TRACKED) {
      const oldest = [...this.entries.entries()].sort((a, b) => a[1].first - b[1].first);
      for (const [k] of oldest.slice(0, Math.ceil(oldest.length / 2))) this.entries.delete(k);
    }
  }
}
