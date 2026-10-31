import { test } from "node:test";
import assert from "node:assert/strict";
import {
  customDayRange, dayRange, kigaliDay, kigaliDayStart, presetRange, previousPreset, rangeDays,
} from "../src/periods.ts";

// 2026-03-15 is a Sunday; Kigali is UTC+2 all year (no DST).
const SUN_2026_03_15_10K = Date.UTC(2026, 2, 15, 8, 0, 0); // 10:00 Kigali

test("kigali day boundaries are UTC+2 and independent of the device timezone", () => {
  // 2026-03-15T23:30Z is already 2026-03-16 01:30 in Kigali.
  assert.equal(kigaliDay("2026-03-15T23:30:00.000Z"), "2026-03-16");
  assert.equal(kigaliDay("2026-03-15T21:59:59.999Z"), "2026-03-15");
  const start = kigaliDayStart(Date.UTC(2026, 2, 15, 22, 30));
  assert.equal(new Date(start).toISOString(), "2026-03-15T22:00:00.000Z"); // 00:00 on the 16th in Kigali
});

test("today and yesterday are exact half-open Kigali days", () => {
  const today = presetRange("today", SUN_2026_03_15_10K);
  assert.deepEqual(today, { from: "2026-03-14T22:00:00.000Z", to: "2026-03-15T22:00:00.000Z" });
  assert.equal(rangeDays(today), 1);
  const yesterday = presetRange("yesterday", SUN_2026_03_15_10K);
  assert.equal(yesterday.to, today.from);
  assert.equal(presetRange("today", SUN_2026_03_15_10K, true).to, today.from, "previous today = yesterday");
});

test("weeks run Monday to Sunday, including across a month boundary", () => {
  // Sunday 2026-03-15 → the week started Monday 2026-03-09.
  const week = presetRange("week", SUN_2026_03_15_10K);
  assert.equal(week.from, "2026-03-08T22:00:00.000Z"); // Mon 09 Mar 00:00 Kigali
  assert.equal(week.to, "2026-03-15T22:00:00.000Z");   // Mon 16 Mar 00:00 Kigali (exclusive)
  assert.equal(rangeDays(week), 7);
  const prev = previousPreset("week", SUN_2026_03_15_10K);
  assert.equal(prev.to, week.from);
  assert.equal(rangeDays(prev), 7);
});

test("month and year presets respect calendar boundaries, including leap years", () => {
  const month = presetRange("month", SUN_2026_03_15_10K);
  assert.equal(month.from, "2026-02-28T22:00:00.000Z"); // 01 Mar Kigali
  assert.equal(month.to, "2026-03-31T22:00:00.000Z");   // 01 Apr Kigali
  const prevMonth = previousPreset("month", SUN_2026_03_15_10K);
  assert.equal(prevMonth.to, month.from);
  assert.equal(prevMonth.from, "2026-01-31T22:00:00.000Z"); // 01 Feb Kigali

  // 2028 is a leap year: February has 29 days.
  const feb2028 = presetRange("month", Date.UTC(2028, 1, 10, 9));
  assert.equal(feb2028.from, "2028-01-31T22:00:00.000Z");
  assert.equal(feb2028.to, "2028-02-29T22:00:00.000Z");
  assert.equal(rangeDays(feb2028), 29);

  const year = presetRange("year", SUN_2026_03_15_10K);
  assert.equal(year.from, "2025-12-31T22:00:00.000Z");
  assert.equal(year.to, "2026-12-31T22:00:00.000Z");
  const prevYear = previousPreset("year", SUN_2026_03_15_10K);
  assert.equal(prevYear.to, year.from);
  assert.equal(prevYear.from, "2024-12-31T22:00:00.000Z");
});

test("explicit previous presets match the previous flag", () => {
  assert.deepEqual(presetRange("prevWeek", SUN_2026_03_15_10K), previousPreset("week", SUN_2026_03_15_10K));
  assert.deepEqual(presetRange("prevMonth", SUN_2026_03_15_10K), previousPreset("month", SUN_2026_03_15_10K));
  assert.deepEqual(presetRange("prevYear", SUN_2026_03_15_10K), previousPreset("year", SUN_2026_03_15_10K));
});

test("day and custom ranges are half-open, ordered and reject impossible dates", () => {
  const d = dayRange("2026-02-28")!;
  assert.equal(d.from, "2026-02-27T22:00:00.000Z");
  assert.equal(d.to, "2026-02-28T22:00:00.000Z");
  assert.equal(dayRange("2026-02-30"), null, "impossible dates are rejected");
  assert.equal(dayRange("nope"), null);

  const custom = customDayRange("2026-02-28", "2026-03-01")!; // crosses the month boundary
  assert.equal(rangeDays(custom), 2);
  assert.equal(custom.to, "2026-03-01T22:00:00.000Z");
  assert.equal(customDayRange("2026-03-01", "2026-02-28"), null, "from must be before to");
  assert.equal(customDayRange("2026-03-01", "2026-03-01"), null, "a zero-length range is rejected");
});
