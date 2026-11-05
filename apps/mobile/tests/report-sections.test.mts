/**
 * The dashboard's "incomplete report" path. Runs on Node 24 with built-in TypeScript type stripping:
 *   npm run test:sections -w @sms/mobile
 *
 * Why this exists: the owner saw "1 parts of this report could not be loaded from the server" and had
 * no way to know WHICH part, while the empty card behind it looked exactly like "no sales this
 * period". These tests pin the two guarantees that fix that:
 *   - every section name the API can send has a real label in both dictionaries (so nothing is
 *     unnamed, and a new server section cannot ship as a bare `product_totals` string);
 *   - the banner text names the section and says the figures are missing, never that they are zero.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { en } from "../src/localization/en.ts";
import { rw } from "../src/localization/rw.ts";
import { SECTION_LABELS, degradedList, sectionKey, sectionLabel } from "../src/services/report-sections.ts";

/** Exactly the names `ReportsController.section()` can push into `degraded`, in API order. */
const SERVER_SECTIONS = [
  "open_purchases", "payables", "issues", "trend", "trend_expenses", "monthly_sales",
  "monthly_returns", "monthly_expenses", "product_profitability", "product_totals",
  "activity", "expenses_by_category", "staff_activity",
];

const fill = (template: string, list: string) => template.replace("{list}", list);
const label = (name: string) => {
  const k = sectionKey(name);
  return k ? en[k] : sectionLabel(name);
};

test("every section the API can degrade is labelled, in both languages", () => {
  assert.deepEqual(Object.keys(SECTION_LABELS).sort(), [...SERVER_SECTIONS].sort(),
    "an unlabelled server section would show as a raw key in the banner");
  for (const name of SERVER_SECTIONS) {
    const k = sectionKey(name)!;
    assert.ok(k, `${name} has a key`);
    assert.ok(en[k]?.trim().length > 0, `en.${k} is not empty`);
    assert.ok(rw[k]?.trim().length > 0, `rw.${k} is not empty`);
    assert.notEqual(rw[k], en[k], `rw.${k} is translated, not copied from English`);
  }
  const keys = SERVER_SECTIONS.map((n) => sectionKey(n));
  assert.equal(new Set(keys).size, keys.length, "two sections never share a label");
});

test("a section this build does not know is still named, never `undefined`", () => {
  assert.equal(sectionKey("some_future_panel"), null);
  assert.equal(sectionLabel("some_future_panel"), "some future panel");
  assert.equal(sectionLabel(""), "unknown section");
  assert.ok(!label("some_future_panel").includes("undefined"));
});

test("the banner names the failed section and says the figures are missing, not zero", () => {
  const text = fill(en["dash.degraded"], [label("product_profitability")]);
  assert.match(text, /product profitability and margins/i, "the owner is told WHICH part failed");
  assert.match(text, /missing, not zero/i, "missing figures are never presented as zero");
  assert.ok(!text.includes("{list}"), "the placeholder is substituted");
  assert.ok(!text.includes("{n}"), "no leftover count placeholder from the old wording");

  // The Kinyarwanda banner says the same thing, with the same substituted list.
  const rwText = fill(rw["dash.degraded"], [label("product_profitability")].map((l) => l).join(", "));
  assert.ok(!rwText.includes("{list}"));
  assert.match(rwText, /iraboze/);
});

test("the unavailable-panel text does not claim there were no sales", () => {
  assert.ok(!/no sales/i.test(en["dash.sectionUnavailable"]));
  assert.match(en["dash.sectionUnavailable"], /missing, not zero/i);
  assert.ok(!/nta.*gurisha/i.test(rw["dash.sectionUnavailable"]), "the Kinyarwanda text does not say 'nothing was sold'");
});

test("a payload is normalised: absent, malformed and duplicated entries are dropped", () => {
  assert.deepEqual(degradedList(undefined), [], "a payload cached by an older build has no field");
  assert.deepEqual(degradedList(null), []);
  assert.deepEqual(degradedList("product_profitability" as unknown), [], "a string is not a list");
  assert.deepEqual(degradedList([1, null, "", "  ", {}, "activity"]), ["activity"]);
  assert.deepEqual(degradedList(["activity", "activity", " payables "]), ["activity", "payables"],
    "the same panel is never counted twice");
});
