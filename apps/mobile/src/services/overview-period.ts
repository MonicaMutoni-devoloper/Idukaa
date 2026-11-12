import { dayRange, kigaliDay, presetRange, type PeriodRange } from "@sms/shared";

/**
 * Overview period selection on the Africa/Kigali business calendar.
 *
 * One selection is the single source of truth for every Overview request and calculation. The
 * helpers are pure and UTC-based so Node tests and the web build agree with Android: a selected
 * day is a Kigali calendar day, never a device-local midnight that could shift across UTC.
 */
export type OverviewPreset =
  | "today" | "yesterday"
  | "thisWeek" | "lastWeek"
  | "thisMonth" | "lastMonth"
  | "thisYear" | "lastYear";

export type OverviewSelection =
  | { kind: "preset"; preset: OverviewPreset }
  | { kind: "day"; day: string }
  | { kind: "range"; fromDay: string; toDay: string };

export const OVERVIEW_PRESETS: OverviewPreset[] = [
  "today", "yesterday", "thisWeek", "lastWeek", "thisMonth", "lastMonth", "thisYear", "lastYear",
];

const SHARED_PRESET: Record<OverviewPreset, "today" | "yesterday" | "week" | "prevWeek" | "month" | "prevMonth" | "year" | "prevYear"> = {
  today: "today",
  yesterday: "yesterday",
  thisWeek: "week",
  lastWeek: "prevWeek",
  thisMonth: "month",
  lastMonth: "prevMonth",
  thisYear: "year",
  lastYear: "prevYear",
};

export const OVERVIEW_PRESET_LABEL: Record<OverviewPreset, string> = {
  today: "common.today",
  yesterday: "common.yesterday",
  thisWeek: "common.week",
  lastWeek: "common.lastWeek",
  thisMonth: "common.month",
  lastMonth: "common.lastMonth",
  thisYear: "common.year",
  lastYear: "common.lastYear",
};

export function presetSelectionRange(preset: OverviewPreset, now = new Date()): PeriodRange {
  return presetRange(SHARED_PRESET[preset], now.getTime());
}

/** Validate a `YYYY-MM-DD` Kigali business day. */
export function isBusinessDay(day: string): boolean {
  return !!dayRange(day);
}

export function daySelection(day: string): OverviewSelection {
  return { kind: "day", day };
}

export function rangeSelection(fromDay: string, toDay: string): OverviewSelection | null {
  if (!isBusinessDay(fromDay) || !isBusinessDay(toDay)) return null;
  if (fromDay > toDay) return null;
  return { kind: "range", fromDay, toDay };
}

/** Half-open [from, to) range for a selection. Invalid input falls back to today, never stale data. */
export function selectionRange(selection: OverviewSelection, now = new Date()): PeriodRange {
  if (selection.kind === "preset") return presetSelectionRange(selection.preset, now);
  if (selection.kind === "day") {
    const r = dayRange(selection.day);
    return r ?? presetSelectionRange("today", now);
  }
  const from = dayRange(selection.fromDay);
  const to = dayRange(selection.toDay);
  if (!from || !to || from.from > to.from) return presetSelectionRange("today", now);
  return { from: from.from, to: to.to };
}

/** The inclusive business days represented by a selection, for the calendar draft. */
export function selectionDays(selection: OverviewSelection, now = new Date()): { fromDay: string; toDay: string } {
  const r = selectionRange(selection, now);
  return { fromDay: kigaliDay(r.from), toDay: kigaliDay(Date.parse(r.to) - 1) };
}

export function defaultSelection(role: "owner" | "manager" | "system_admin" | undefined): OverviewSelection {
  return { kind: "preset", preset: role === "manager" ? "today" : "thisMonth" };
}

/** Human-readable range, using the same inclusive end day the API range describes. */
export function formatSelectionRange(selection: OverviewSelection, locale?: string, now = new Date()): string {
  const r = selectionRange(selection, now);
  const fromDay = kigaliDay(r.from);
  const toDay = kigaliDay(Date.parse(r.to) - 1);
  const from = dayParts(fromDay);
  const to = dayParts(toDay);
  const fmt = (y: number, m: number, d: number, withYear: boolean) =>
    new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(locale, {
      day: "numeric", month: "long", ...(withYear ? { year: "numeric" as const } : {}), timeZone: "UTC",
    });
  if (from.y === to.y && from.m === to.m && from.d === to.d) return fmt(from.y, from.m, from.d, true);
  if (from.y === to.y && from.m === to.m) return `${fmt(from.y, from.m, from.d, false)} – ${fmt(to.y, to.m, to.d, true)}`;
  return `${fmt(from.y, from.m, from.d, true)} – ${fmt(to.y, to.m, to.d, true)}`;
}

function dayParts(day: string): { y: number; m: number; d: number } {
  const [y, m, d] = day.split("-").map(Number);
  return { y: y!, m: m!, d: d! };
}

export function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const d = new Date(Date.UTC(year, month - 1 + delta, 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

export interface CalendarCell {
  day: string;
  inMonth: boolean;
  isToday: boolean;
}

/**
 * Six Monday-first weeks for a calendar month. Leading/trailing days come from the adjacent
 * months so the grid never jumps when a month starts mid-week. UTC date arithmetic is deliberate:
 * `Date.UTC` has no DST, so every cell is exactly one Kigali calendar day.
 */
export function monthMatrix(year: number, month: number, today = kigaliDay(Date.now())): CalendarCell[] {
  const first = Date.UTC(year, month - 1, 1);
  const firstDow = (new Date(first).getUTCDay() + 6) % 7; // Monday = 0
  const start = first - firstDow * 86_400_000;
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start + i * 86_400_000);
    const key = d.toISOString().slice(0, 10);
    return { day: key, inMonth: d.getUTCMonth() === month - 1, isToday: key === today };
  });
}

export function monthOfDay(day: string): { year: number; month: number } {
  const p = dayParts(day);
  return { year: p.y, month: p.m };
}

export function todaySelection(now = new Date()): OverviewSelection {
  return { kind: "day", day: kigaliDay(now.getTime()) };
}
