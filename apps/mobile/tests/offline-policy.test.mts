import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AUTO_MIN_INTERVAL_MS, OFFLINE_CACHE_VERSION, OFFLINE_PERIODS, cacheKeysToPrune, categoryStatus,
  periodRangeFor, policyIsStale, readPolicySnapshot, shouldAutoPrepare, summarizeOffline,
} from "../src/services/offline-policy.ts";

const NOW = Date.parse("2026-11-11T08:00:00.000Z");

test("automatic offline periods use Kigali calendar boundaries", () => {
  assert.deepEqual(OFFLINE_PERIODS, ["thisMonth", "lastMonth", "thisYear", "lastYear"]);
  assert.deepEqual(periodRangeFor("thisMonth", new Date(NOW)), {
    from: "2026-10-31T22:00:00.000Z", to: "2026-11-30T22:00:00.000Z",
  });
  assert.deepEqual(periodRangeFor("lastMonth", new Date(NOW)), {
    from: "2026-09-30T22:00:00.000Z", to: "2026-10-31T22:00:00.000Z",
  });
  assert.equal(periodRangeFor("thisYear", new Date(NOW)).to, "2026-12-31T22:00:00.000Z");
  assert.equal(periodRangeFor("lastYear", new Date(NOW)).from, "2024-12-31T22:00:00.000Z");
});

test("automatic preparation is throttled and cannot run on every 30-second poll", () => {
  const now = NOW;
  assert.equal(shouldAutoPrepare(null, now), true, "first run");
  assert.equal(shouldAutoPrepare(new Date(now - 60_000).toISOString(), now), false, "one minute ago");
  assert.equal(shouldAutoPrepare(new Date(now - AUTO_MIN_INTERVAL_MS - 1).toISOString(), now), true, "after the window");
  assert.equal(shouldAutoPrepare(new Date(now - 6 * 60_000).toISOString(), now, true), true, "a business change may refresh after 5 minutes");
  assert.equal(shouldAutoPrepare(new Date(now - 2 * 60_000).toISOString(), now, true), false);
});

test("categories never claim available without a saved copy", () => {
  const missing = categoryStatus("reports", null, NOW);
  assert.equal(missing.state, "missing");
  const fresh = categoryStatus("reports", new Date(NOW - 60_000).toISOString(), NOW);
  assert.equal(fresh.state, "available");
  const stale = categoryStatus("reports", new Date(NOW - 13 * 3_600_000).toISOString(), NOW);
  assert.equal(stale.state, "stale");
  assert.equal(categoryStatus("team", null, NOW, { forbidden: true }).state, "forbidden");
  assert.equal(categoryStatus("reports", null, NOW, { error: "network" }).state, "error");
});

test("the readiness summary requires every category to be stored", () => {
  assert.equal(summarizeOffline([
    categoryStatus("reports", new Date(NOW).toISOString(), NOW),
    categoryStatus("team", new Date(NOW).toISOString(), NOW),
  ]).ready, true);
  assert.equal(summarizeOffline([
    categoryStatus("reports", new Date(NOW).toISOString(), NOW),
    categoryStatus("team", null, NOW),
  ]).ready, false);
  assert.equal(summarizeOffline([]).ready, false);
});

test("retention removes expired entries and caps the cache without touching fresh data", () => {
  const fresh = new Date(NOW - 86_400_000).toISOString();
  const expired = new Date(NOW - 181 * 86_400_000).toISOString();
  const entries = [
    { key: "report:old", savedAt: expired },
    { key: "report:new", savedAt: fresh },
    ...Array.from({ length: 3 }, (_, i) => ({ key: `report:${i}`, savedAt: fresh })),
  ];
  const pruned = cacheKeysToPrune(entries, NOW, 180 * 86_400_000, 2);
  assert.ok(pruned.includes("report:old"));
  assert.equal(pruned.length >= 1, true);
  assert.equal(pruned.includes("report:new"), false, "newest entries survive");
});

test("a policy snapshot is versioned, shop-scoped and staleness is measurable", () => {
  const raw = JSON.stringify({
    version: 1, shopId: "shop-1", fetchedAt: "2026-11-11T07:00:00.000Z",
    maxDiscountPercent: 10, belowCostPolicy: "block", managerFinancialAccess: false,
  });
  const p = readPolicySnapshot(raw, "shop-1")!;
  assert.equal(p.maxDiscountPercent, 10);
  assert.equal(policyIsStale(p, NOW), false);
  assert.equal(policyIsStale(p, NOW + 25 * 3_600_000), true);
  assert.equal(readPolicySnapshot(raw, "shop-2"), null, "another shop cannot read it");
  assert.equal(readPolicySnapshot(JSON.stringify({ ...p, version: 2 as any }), "shop-1"), null);
  assert.equal(readPolicySnapshot(JSON.stringify({ ...p, maxDiscountPercent: 101 }), "shop-1"), null);
});

test("the cache format is versioned", () => {
  assert.equal(OFFLINE_CACHE_VERSION, 3);
});
