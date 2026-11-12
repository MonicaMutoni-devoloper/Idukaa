import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OVERVIEW_PRESETS, defaultSelection, formatSelectionRange, isBusinessDay, monthMatrix,
  rangeSelection, selectionRange, shiftMonth, type OverviewSelection,
} from "../src/services/overview-period.ts";

// 11 November 2026, 10:00 in Africa/Kigali (UTC+2) = 08:00Z.
const NOW = new Date("2026-11-11T08:00:00.000Z");
const range = (s: OverviewSelection) => selectionRange(s, NOW);

test("every preset uses half-open Africa/Kigali calendar boundaries", () => {
  const expected: Record<string, [string, string]> = {
    today: ["2026-11-10T22:00:00.000Z", "2026-11-11T22:00:00.000Z"],
    yesterday: ["2026-11-09T22:00:00.000Z", "2026-11-10T22:00:00.000Z"],
    thisWeek: ["2026-11-08T22:00:00.000Z", "2026-11-15T22:00:00.000Z"],
    lastWeek: ["2026-11-01T22:00:00.000Z", "2026-11-08T22:00:00.000Z"],
    thisMonth: ["2026-10-31T22:00:00.000Z", "2026-11-30T22:00:00.000Z"],
    lastMonth: ["2026-09-30T22:00:00.000Z", "2026-10-31T22:00:00.000Z"],
    thisYear: ["2025-12-31T22:00:00.000Z", "2026-12-31T22:00:00.000Z"],
    lastYear: ["2024-12-31T22:00:00.000Z", "2025-12-31T22:00:00.000Z"],
  };
  for (const preset of OVERVIEW_PRESETS) {
    const r = range({ kind: "preset", preset });
    assert.deepEqual([r.from, r.to], expected[preset], preset);
  }
});

test("a single business day is exactly one Kigali day", () => {
  const r = range({ kind: "day", day: "2026-11-03" });
  assert.equal(r.from, "2026-11-02T22:00:00.000Z");
  assert.equal(r.to, "2026-11-03T22:00:00.000Z");
  assert.equal((Date.parse(r.to) - Date.parse(r.from)) / 86_400_000, 1);
});

test("custom ranges are inclusive of both selected days", () => {
  const r = range({ kind: "range", fromDay: "2026-11-02", toDay: "2026-11-04" });
  assert.equal(r.from, "2026-11-01T22:00:00.000Z");
  assert.equal(r.to, "2026-11-04T22:00:00.000Z", "end is the midnight AFTER 4 November");
  assert.equal((Date.parse(r.to) - Date.parse(r.from)) / 86_400_000, 3);
});

test("invalid days and reversed ranges are rejected, never guessed", () => {
  assert.equal(isBusinessDay("2026-02-29"), false, "2026 is not a leap year");
  assert.equal(isBusinessDay("2028-02-29"), true, "2028 is a leap year");
  assert.equal(rangeSelection("2026-11-05", "2026-11-04"), null);
  assert.equal(rangeSelection("nope", "2026-11-04"), null);
  assert.deepEqual(rangeSelection("2026-11-04", "2026-11-04"), { kind: "range", fromDay: "2026-11-04", toDay: "2026-11-04" });
});

test("month boundaries roll across years without device timezone drift", () => {
  assert.deepEqual(shiftMonth(2026, 1, -1), { year: 2025, month: 12 });
  assert.deepEqual(shiftMonth(2026, 12, 1), { year: 2027, month: 1 });
});

test("the calendar matrix is six Monday-first weeks and marks today", () => {
  const cells = monthMatrix(2026, 11, "2026-11-11");
  assert.equal(cells.length, 42);
  assert.equal(cells[0]!.day, "2026-10-26", "Monday before 1 November");
  assert.equal(cells.find((c) => c.day === "2026-11-01")!.inMonth, true);
  assert.equal(cells.find((c) => c.day === "2026-11-11")!.isToday, true);
  assert.equal(cells.filter((c) => c.inMonth).length, 30, "November has 30 days");
});

test("a leap-year February has 29 selectable days", () => {
  const cells = monthMatrix(2028, 2, "2028-02-01");
  assert.equal(cells.filter((c) => c.inMonth).length, 29);
  assert.ok(cells.some((c) => c.day === "2028-02-29"));
});

test("the readable label uses the inclusive end day and does not shift a day", () => {
  const label = formatSelectionRange({ kind: "range", fromDay: "2026-11-01", toDay: "2026-11-30" }, "en-US", NOW);
  assert.match(label, /November 1/);
  assert.match(label, /30/);
  assert.match(label, /2026/);
  assert.doesNotMatch(label, /October|December/);
});

test("defaults are role-aware and never a custom stale payload", () => {
  assert.deepEqual(defaultSelection("manager"), { kind: "preset", preset: "today" });
  assert.deepEqual(defaultSelection("owner"), { kind: "preset", preset: "thisMonth" });
  assert.deepEqual(defaultSelection(undefined), { kind: "preset", preset: "thisMonth" });
});
