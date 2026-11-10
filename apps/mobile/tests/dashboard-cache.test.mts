import { test } from "node:test";
import assert from "node:assert/strict";
import {
  businessRevisionKey,
  dashboardCacheIsCurrent,
  dashboardCacheKey,
  dashboardScope,
} from "../src/services/dashboard-cache.ts";

const owner = { id: "user-owner", shopId: "shop-1", role: "owner" };
const manager = { id: "user-manager", shopId: "shop-1", role: "manager" };
const from = "2026-11-01T00:00:00.000Z";
const to = "2026-11-10T00:00:00.000Z";

test("a rotated access token cannot change dashboard identity", () => {
  // The session token is deliberately not part of scope: rotating it is authentication, not data.
  const beforeRefresh = { ...owner, accessToken: "token-before" };
  const afterRefresh = { ...owner, accessToken: "token-after" };
  assert.equal(dashboardScope(beforeRefresh), dashboardScope(afterRefresh));
  assert.equal(dashboardCacheKey(beforeRefresh, from, to), dashboardCacheKey(afterRefresh, from, to));
});

test("another user, shop or role can never read the same dashboard cache", () => {
  const base = dashboardCacheKey(owner, from, to);
  assert.notEqual(base, dashboardCacheKey(manager, from, to), "another account");
  assert.notEqual(base, dashboardCacheKey({ ...owner, shopId: "shop-2" }, from, to), "another shop");
  assert.notEqual(base, dashboardCacheKey({ ...owner, role: "manager" }, from, to), "a demoted role");
  assert.notEqual(base, dashboardCacheKey(owner, from, "2026-11-11T00:00:00.000Z"), "another period");
});

test("a saved dashboard is current only at the same successful business revision", () => {
  const entry = { version: 3, savedAt: "2026-11-09T10:00:00.000Z", revision: "42" };
  assert.equal(dashboardCacheIsCurrent(entry, "42"), true);
  assert.equal(dashboardCacheIsCurrent(entry, "43"), false, "a real business change revalidates");
  assert.equal(dashboardCacheIsCurrent(entry, null), false, "no revision known means revalidate");
  assert.equal(dashboardCacheIsCurrent({ ...entry, revision: undefined }, "42"), false, "old cache shape");
  assert.equal(dashboardCacheIsCurrent({ ...entry, version: 2 }, "42"), false, "old payload version");
  assert.equal(dashboardCacheIsCurrent({ ...entry, savedAt: "not-a-date" }, "42"), false);
  assert.equal(dashboardCacheIsCurrent(null, "42"), false);
});

test("the business revision is isolated by shop", () => {
  assert.notEqual(businessRevisionKey("shop-1"), businessRevisionKey("shop-2"));
  assert.equal(businessRevisionKey("shop-1"), businessRevisionKey("shop-1"));
  assert.equal(businessRevisionKey(null), "bizrev:none");
});
