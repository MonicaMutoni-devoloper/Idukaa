/**
 * Update policy tests. Runs on Node 24 with built-in TypeScript type stripping:
 *   npm run test:update -w @sms/mobile
 *
 * These pin the decisions that must never regress: an outdated build is told so, a current build is
 * left alone, a malformed manifest blocks nothing, and automatic checks stay throttled.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { apiCompatible, compareVersions, decideUpdate, isOlderThan, parseVersion, shouldCheck } from "../src/services/app-update.ts";

const manifest = (overrides = {}) => ({
  apiVersion: 1,
  minimumApiVersion: 1,
  latest: { version: "1.0.2", versionCode: 3, runtimeVersion: "1", url: "https://example.test/app.apk", notes: "Startup fix", critical: false },
  minimum: { version: "1.0.0", versionCode: 0 },
  ...overrides,
});

test("versions compare numerically, not as strings", () => {
  assert.equal(compareVersions("1.0.10", "1.0.9"), 1);
  assert.equal(compareVersions("1.0.2", "1.0.2"), 0);
  assert.equal(compareVersions("v1.1", "1.0.9"), 1);
  assert.deepEqual(parseVersion(" v1.2.3-beta.4 "), [1, 2, 3]);
  assert.deepEqual(parseVersion("not-a-version"), []);
  // Unparseable input is "unknown", never "newer" or "older".
  assert.equal(compareVersions("abc", "1.0.0"), 0);
});

test("an installed build older than the published one is offered the update", () => {
  assert.deepEqual(decideUpdate({ version: "1.0.1", versionCode: 2 }, manifest()), {
    kind: "optional",
    latest: manifest().latest,
  });
});

test("an installed build at or above the published one is left alone", () => {
  assert.deepEqual(decideUpdate({ version: "1.0.2", versionCode: 3 }, manifest()), { kind: "up-to-date" });
  assert.deepEqual(decideUpdate({ version: "1.1.0", versionCode: 9 }, manifest()), { kind: "up-to-date" });
});

test("a raised minimum turns the same update into a required one", () => {
  const strict = manifest({ minimum: { version: "1.0.2", versionCode: 3 } });
  assert.equal(decideUpdate({ version: "1.0.1", versionCode: 2 }, strict).kind, "required");
  // versionCode is what Android enforces: a build whose dotted version looks current but whose code
  // is lower is still behind.
  assert.equal(decideUpdate({ version: "1.0.2", versionCode: 2 }, strict).kind, "required");
});

test("a manifest without a usable latest entry, or without a download URL, prompts nothing", () => {
  assert.deepEqual(decideUpdate({ version: "1.0.0", versionCode: 1 }, null), { kind: "up-to-date" });
  assert.deepEqual(decideUpdate({ version: "1.0.0", versionCode: 1 }, { latest: {} }), { kind: "up-to-date" });
  assert.deepEqual(
    decideUpdate({ version: "1.0.0", versionCode: 1 }, manifest({ latest: { version: "1.0.2", versionCode: 3 } })),
    { kind: "up-to-date" },
  );
});

test("isOlderThan prefers versionCode and falls back to the dotted version", () => {
  assert.equal(isOlderThan({ version: "9.9.9", versionCode: 2 }, { versionCode: 3 }), true);
  assert.equal(isOlderThan({ version: "1.0.0", versionCode: 0 }, { version: "1.0.2" }), true);
  assert.equal(isOlderThan({ version: "1.0.2", versionCode: 0 }, { version: "1.0.2" }), false);
  assert.equal(isOlderThan({ version: "1.0.0", versionCode: 1 }, undefined), false);
});

test("automatic checks are throttled, manual ones are not the policy's business", () => {
  const now = 1_700_000_000_000;
  assert.equal(shouldCheck(now, null), true, "never checked");
  assert.equal(shouldCheck(now, now - 60_000), false, "a foreground bounce must not re-check");
  assert.equal(shouldCheck(now, now - 6 * 60 * 60 * 1000), true, "after the interval it may check again");
  assert.equal(shouldCheck(now, now + 5_000), true, "a clock that moved backwards must not silence it");
});

test("the API version gate only refuses a client the server actually declared too old", () => {
  assert.equal(apiCompatible(1, manifest()), true);
  assert.equal(apiCompatible(1, manifest({ minimumApiVersion: 2 })), false);
  assert.equal(apiCompatible(1, undefined), true, "no manifest means nothing to enforce");
  assert.equal(apiCompatible(1, manifest({ minimumApiVersion: 0 })), true);
});
