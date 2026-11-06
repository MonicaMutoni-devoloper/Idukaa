/**
 * Translation safety net. Runs on Node 24 with built-in TypeScript type stripping:
 *   npm run test:i18n -w @sms/mobile
 * A missing or empty key can therefore never silently break a screen.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { en } from "../src/localization/en.ts";
import { rw } from "../src/localization/rw.ts";


const keys = Object.keys(en) as (keyof typeof en)[];
const placeholders = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(",");

test("English and Kinyarwanda have identical keys", () => {
  assert.deepEqual(Object.keys(rw).sort(), keys.slice().sort());
});

test("no translation is empty or whitespace", () => {
  for (const k of keys) {
    assert.equal(typeof en[k], "string", `en.${k} is a string`);
    assert.ok(en[k].trim().length > 0, `en.${k} is not empty`);
    assert.ok(rw[k].trim().length > 0, `rw.${k} is not empty`);
  }
});

test("placeholders match between languages", () => {
  for (const k of keys) assert.equal(placeholders(rw[k]), placeholders(en[k]), `placeholders in ${k}`);
});

/** Keys where the Kinyarwanda value is intentionally identical (a loanword, a symbol, a code, a brand). */
const IDENTICAL_BY_DESIGN = new Set(["stock.barcode", "receive.equals", "app.name"]);

test("no Kinyarwanda string is a copy of the English one", () => {
  for (const k of keys) {
    if (IDENTICAL_BY_DESIGN.has(k)) continue;
    assert.notEqual(rw[k], en[k], `rw.${k} is still the English text`);
  }
});

test("security, recovery and notification wording is translated", () => {
  const namespaces = ["login.", "forgot.", "reset.", "security.", "notifications.", "notif.", "nav.security", "nav.notifications", "settings.accountSecurity"];
  for (const k of keys) {
    if (!namespaces.some((p) => k.startsWith(p))) continue;
    assert.ok(/[a-z]/.test(rw[k]), `rw.${k} has letters`);
    assert.notEqual(rw[k], en[k], `rw.${k} must not be the English text`);
  }
});
