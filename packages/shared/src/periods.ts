/**
 * Reporting periods on the shop's business calendar.
 *
 * Policy (docs/FINANCE.md): the business day is the calendar day in **Africa/Kigali** (UTC+2,
 * no daylight saving), so a "day" boundary never depends on the device timezone. Weeks run
 * **Monday → Sunday**. Every range is half-open: `from` inclusive, `to` exclusive, as ISO-8601
 * UTC instants — the same convention the API uses everywhere.
 */

export interface PeriodRange { from: string; to: string }

/** UI presets; `previous` selects the immediately preceding equivalent period. */
export type PeriodPreset = "today" | "yesterday" | "week" | "month" | "year";
/** Full set supported by the reporting service, including the previous-period variants. */
export type CalendarPreset = PeriodPreset | "prevWeek" | "prevMonth" | "prevYear";

export const KIGALI_UTC_OFFSET_MS = 2 * 3_600_000;
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

const range = (fromMs: number, toMs: number): PeriodRange => ({
  from: new Date(fromMs).toISOString(),
  to: new Date(toMs).toISOString(),
});

interface KigaliParts { year: number; month: number; day: number; dow: number }

const parts = (instantMs: number): KigaliParts => {
  const d = new Date(instantMs + KIGALI_UTC_OFFSET_MS);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth(), day: d.getUTCDate(), dow: d.getUTCDay() };
};

/** Instant of the start of the Kigali calendar day containing `instantMs`. */
export function kigaliDayStart(instantMs: number): number {
  const p = parts(instantMs);
  return Date.UTC(p.year, p.month, p.day) - KIGALI_UTC_OFFSET_MS;
}

/** The Kigali business day ("YYYY-MM-DD") an instant belongs to. */
export function kigaliDay(instant: string | number): string {
  const ms = typeof instant === "number" ? instant : Date.parse(instant);
  const p = parts(ms);
  return `${p.year}-${String(p.month + 1).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Half-open range of one Kigali business day given "YYYY-MM-DD". Null for malformed input. */
export function dayRange(day: string): PeriodRange | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim());
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const start = Date.UTC(y, mo - 1, d) - KIGALI_UTC_OFFSET_MS;
  const check = new Date(start + KIGALI_UTC_OFFSET_MS);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null; // e.g. 2026-02-30
  return range(start, start + DAY_MS);
}

/** Monday 00:00 Kigali of the week containing `dayStartMs`. */
const weekStart = (dayStartMs: number): number => {
  const dow = parts(dayStartMs).dow; // 0 = Sunday
  return dayStartMs - ((dow + 6) % 7) * DAY_MS;
};

/** First instant of a Kigali calendar month. `month` is 0-based; negative/over 11 roll over. */
const monthStart = (year: number, month: number): number => Date.UTC(year, month, 1) - KIGALI_UTC_OFFSET_MS;

/**
 * Half-open range for any supported calendar preset, evaluated on the Kigali calendar at `nowMs`.
 * `previous` shifts current-period presets to the preceding equivalent period
 * (today → yesterday, this week → last week, this month → last month, this year → last year).
 */
export function presetRange(preset: CalendarPreset, nowMs: number = Date.now(), previous = false): PeriodRange {
  const dayStart = kigaliDayStart(nowMs);
  const p = parts(dayStart);

  switch (preset) {
    case "today": {
      const start = dayStart + (previous ? -1 : 0) * DAY_MS;
      return range(start, start + DAY_MS);
    }
    case "yesterday": {
      const start = dayStart + (-1 - (previous ? 1 : 0)) * DAY_MS;
      return range(start, start + DAY_MS);
    }
    case "week": {
      const start = weekStart(dayStart) - (previous ? WEEK_MS : 0);
      return range(start, start + WEEK_MS);
    }
    case "prevWeek": {
      const start = weekStart(dayStart) - WEEK_MS;
      return range(start, start + WEEK_MS);
    }
    case "month": {
      const start = monthStart(p.year, p.month - (previous ? 1 : 0));
      const end = previous ? monthStart(p.year, p.month) : monthStart(p.year, p.month + 1);
      return range(start, end);
    }
    case "prevMonth": {
      const start = monthStart(p.year, p.month - 1);
      return range(start, monthStart(p.year, p.month));
    }
    case "year": {
      const start = Date.UTC(p.year - (previous ? 1 : 0), 0, 1) - KIGALI_UTC_OFFSET_MS;
      return range(start, Date.UTC(p.year - (previous ? 1 : 0) + 1, 0, 1) - KIGALI_UTC_OFFSET_MS);
    }
    case "prevYear": {
      const start = Date.UTC(p.year - 1, 0, 1) - KIGALI_UTC_OFFSET_MS;
      return range(start, Date.UTC(p.year, 0, 1) - KIGALI_UTC_OFFSET_MS);
    }
  }
}

/** The equivalent preceding period for a UI preset (used by "previous period" navigation). */
export function previousPreset(preset: PeriodPreset, nowMs: number = Date.now()): PeriodRange {
  return presetRange(preset, nowMs, true);
}

/** Inclusive custom range of Kigali business days `fromDay`..`toDay` (YYYY-MM-DD). Null when invalid. */
export function customDayRange(fromDay: string, toDay: string): PeriodRange | null {
  const from = dayRange(fromDay);
  const to = dayRange(toDay);
  if (!from || !to || from.from >= to.from) return null;
  return { from: from.from, to: to.to };
}

/** Number of days (rounded up) a range spans — used for velocity and per-day averages. */
export function rangeDays(r: PeriodRange): number {
  const ms = Date.parse(r.to) - Date.parse(r.from);
  return Math.max(1, Math.ceil(ms / DAY_MS));
}
