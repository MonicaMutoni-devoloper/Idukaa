/**
 * The per-account login lockout.
 *
 * The interesting failures are not "does it count": they are (a) a correct password must clear the
 * count, or a single typo followed by a success leaves the account one mistake from a lockout, and
 * (b) the lock must end on its own, because nobody is on duty to unlock an employee's account at
 * 07:30. Both are asserted with an injected clock rather than by sleeping for fifteen minutes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { LoginLockout } from "../src/auth/login-lockout.service";

/** The service reads Date.now(); replace it so the fifteen-minute window is testable in a millisecond. */
function withClock(start: number, fn: (advance: (ms: number) => void) => Promise<void> | void) {
  const real = Date.now;
  let now = start;
  Date.now = () => now;
  try {
    return fn((ms) => { now += ms; });
  } finally {
    // Callers await inside the try, so restore only after their promise settles.
    void Promise.resolve().then(() => { Date.now = real; });
  }
}

test("a locked address is refused with the wait in the body, and the lock expires by itself", async () => {
  await withClock(1_000_000, (advance) => {
    const lock = new LoginLockout();
    for (let i = 0; i < 10; i++) lock.fail("Kelly@Example.com");

    // Eleven attempts, not ten: the tenth locks, so the next one is the first refusal.
    assert.ok(lock.retryAfterSeconds("kelly@example.com") > 0);
    assert.throws(() => lock.assertAllowed("kelly@example.com"), (e: any) => {
      assert.equal(e.getStatus(), 429);
      assert.equal(e.getResponse().message, "too_many_attempts");
      assert.ok(e.getResponse().retryAfterSeconds > 0);
      return true;
    });

    // A different employee behind the same IP is untouched — this is the whole point of per-account.
    assert.equal(lock.retryAfterSeconds("someone.else@example.com"), 0);
    lock.assertAllowed("someone.else@example.com");

    advance(15 * 60_000 + 1);
    assert.equal(lock.retryAfterSeconds("kelly@example.com"), 0);
    lock.assertAllowed("kelly@example.com");
  });
});

test("a correct password clears earlier failures instead of leaving the account one typo from a lock", async () => {
  await withClock(2_000_000, () => {
    const lock = new LoginLockout();
    for (let i = 0; i < 9; i++) lock.fail("owner@example.com");
    lock.succeed("owner@example.com");
    // Nine more would have been nineteen: without the reset this single typo would lock the account.
    for (let i = 0; i < 9; i++) lock.fail("owner@example.com");
    assert.equal(lock.retryAfterSeconds("owner@example.com"), 0);
  });
});

test("nine wrong passwords are not a lockout, and failures spread over time do not add up", async () => {
  await withClock(3_000_000, (advance) => {
    const lock = new LoginLockout();
    for (let i = 0; i < 9; i++) lock.fail("staff@example.com");
    assert.equal(lock.retryAfterSeconds("staff@example.com"), 0);

    // Two failures, a long gap, then nine more: the window restarts rather than accumulating.
    advance(16 * 60_000);
    for (let i = 0; i < 9; i++) lock.fail("staff@example.com");
    assert.equal(lock.retryAfterSeconds("staff@example.com"), 0);
  });
});
