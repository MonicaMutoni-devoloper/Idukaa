/**
 * The update manifest is what lets an installed build learn that it is behind. It is public and
 * must stay safe to call without a session, must never emit NaN from a bad env value, and must not
 * quietly force updates: the minimum stays at the floor until an operator raises it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { AppVersionController } from "../src/app-version/app-version.controller";

const controller = new AppVersionController();
const withEnv = (vars: Record<string, string>, fn: () => void) => {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { fn(); } finally {
    for (const [k, v] of Object.entries(before)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
};

test("the manifest names the latest build, its download destination and the API contract", () => {
  withEnv({ APP_LATEST_VERSION: "", APP_LATEST_VERSION_CODE: "", APP_MINIMUM_VERSION: "", APP_MINIMUM_VERSION_CODE: "", APP_UPDATE_URL: "", APP_RELEASE_NOTES: "", APP_CRITICAL: "" }, () => {
    const m = controller.version();
    assert.equal(m.latest.version, "1.0.2");
    assert.equal(m.latest.versionCode, 3);
    assert.match(m.latest.url, /^https:\/\//);
    assert.equal(typeof m.latest.runtimeVersion, "string");
    assert.equal(m.apiVersion, 1);
    assert.equal(m.minimumApiVersion, 1);
    // Nothing is forced until an operator publishes a higher floor.
    assert.equal(m.minimum.version, "1.0.0");
    assert.equal(m.minimum.versionCode, 0);
    // No OTA channel exists, and the manifest says so instead of implying one.
    assert.equal(m.ota.enabled, false);
  });
});

test("a deployment can raise the minimum version without shipping code", () => {
  withEnv({ APP_MINIMUM_VERSION: "1.0.2", APP_MINIMUM_VERSION_CODE: "3", APP_LATEST_VERSION: "1.1.0", APP_LATEST_VERSION_CODE: "4", APP_CRITICAL: "true" }, () => {
    const m = controller.version();
    assert.deepEqual(m.minimum, { version: "1.0.2", versionCode: 3 });
    assert.equal(m.latest.version, "1.1.0");
    assert.equal(m.latest.versionCode, 4);
    assert.equal(m.latest.critical, true);
  });
});

test("malformed numeric configuration falls back instead of emitting NaN", () => {
  withEnv({ APP_LATEST_VERSION_CODE: "not-a-number", APP_MINIMUM_VERSION_CODE: "-4", APP_API_VERSION: "" }, () => {
    const m = controller.version();
    assert.equal(m.latest.versionCode, 3);
    assert.equal(m.minimum.versionCode, 0);
    assert.equal(m.apiVersion, 1);
    assert.ok(Number.isFinite(m.latest.versionCode) && Number.isFinite(m.minimum.versionCode));
  });
});
