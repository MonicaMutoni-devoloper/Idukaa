/**
 * Sync recovery rules. Runs on Node 24 with built-in TypeScript type stripping:
 *   npm run test:sync -w @sms/mobile
 *
 * These pin the two decisions that made a failure impossible to act on: how long to wait before
 * trying again, and what the app is allowed to call the failure. A stale "the server could not
 * answer" hid a timeout, a throttle and an expired session behind one sentence.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { RETRY_BASE_MS, RETRY_MAX_MS, nextStreak, retryDelay } from "../src/synchronization/backoff.ts";
import { syncFailureCode } from "../src/synchronization/catalogue.ts";

const mid = () => 0.5; // 0.8 + 0.5 * 0.4 = 1.0, so the base schedule is exact

test("the retry schedule doubles from two seconds and never passes its ceiling", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 20].map((n) => retryDelay(n, mid)),
    [2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000],
  );
  assert.equal(retryDelay(0, mid), RETRY_BASE_MS, "an attempt below one still waits the base delay");
  assert.equal(retryDelay(-3, mid), RETRY_BASE_MS);
});

test("jitter stays inside ±20 % and never exceeds the ceiling", () => {
  for (const attempt of [1, 2, 3, 4, 5, 6]) {
    const base = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempt - 1));
    assert.equal(retryDelay(attempt, () => 0), Math.round(base * 0.8));
    assert.equal(retryDelay(attempt, () => 1), Math.min(RETRY_MAX_MS, Math.round(base * 1.2)));
  }
});

test("the schedule never shrinks as failures pile up", () => {
  let previous = 0;
  for (let attempt = 1; attempt <= 12; attempt++) {
    const delay = retryDelay(attempt, mid);
    assert.ok(delay >= previous, `attempt ${attempt} waits at least as long as the one before`);
    previous = delay;
  }
});

test("one clean pass resets the streak, a failure grows it, an approval wait does not", () => {
  assert.equal(nextStreak(0, "failed"), 1);
  assert.equal(nextStreak(4, "failed"), 5);
  assert.equal(nextStreak(5, "ok"), 0, "recovery is immediate once the server answers");
  assert.equal(nextStreak(3, "incomplete"), 3, "waiting for an owner's decision is not an outage");
});

test("each HTTP status is reported as the cause the user can act on", () => {
  assert.equal(syncFailureCode({}, 401), "auth");
  assert.equal(syncFailureCode({}, 403), "auth");
  assert.equal(syncFailureCode({}, 408), "timeout");
  assert.equal(syncFailureCode({}, 429), "rate_limited");
  assert.equal(syncFailureCode({}, 502), "unavailable");
  assert.equal(syncFailureCode({}, 503), "unavailable");
  assert.equal(syncFailureCode({}, 500), "server_500", "an answered 500 is ours to fix, not a cold start");
  assert.equal(syncFailureCode({}, 400), "server_400");
  assert.equal(syncFailureCode({}, 409), "server_409");
});

test("transport and device failures are not reported as a server problem", () => {
  const network = Object.assign(new Error("network_unavailable"), { name: "NetworkError" });
  const timeout = Object.assign(new Error("timeout"), { name: "NetworkError" });
  assert.equal(syncFailureCode(network), "network");
  assert.equal(syncFailureCode(timeout), "timeout");
  assert.equal(syncFailureCode(Object.assign(new Error("The quota has been exceeded."), { name: "QuotaExceededError" })), "storage");
  assert.equal(syncFailureCode({ code: "ERR_INTERNAL_SQLITE_ERROR", message: "13 values for 14 columns" }), "storage");
  assert.equal(syncFailureCode(new Error("something else")), "unexpected");
});
