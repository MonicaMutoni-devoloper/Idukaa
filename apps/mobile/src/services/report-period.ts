import { kigaliDay, presetRange } from "@sms/shared";

/**
 * Reporting periods for the analytics screens.
 *
 * Every range is half-open `[from, to)` on the Africa/Kigali business calendar, exactly like the
 * API (`presetRange` in @sms/shared), so the client and server never disagree about which day a
 * 00:30 sale belongs to. `lastMonth` is the one extra preset the reports overview offers; it maps
 * to the shared `prevMonth` calendar range rather than being recalculated here.
 */
export type ReportPeriod = "today" | "yesterday" | "week" | "month" | "lastMonth" | "year";

export const REPORT_PERIODS: ReportPeriod[] = ["today", "yesterday", "week", "month", "lastMonth", "year"];

export const periodLabelKey = (p: ReportPeriod) =>
  p === "lastMonth" ? ("common.lastMonth" as const) : (`common.${p}` as const);

export function periodRange(p: ReportPeriod, now = new Date()): { from: string; to: string } {
  return presetRange(p === "lastMonth" ? "prevMonth" : p, now.getTime());
}

/** The equally long range immediately before `from`…`to`, used for comparisons. */
export function previousRange(from: string, to: string): { from: string; to: string } {
  const span = Date.parse(to) - Date.parse(from);
  return { from: new Date(Date.parse(from) - span).toISOString(), to: from };
}

export type BucketMode = "day" | "week" | "month";

/**
 * Bucket size for a trend chart: days for short ranges, weeks for a few months, months for a year
 * or more. The thresholds match the dashboard's own SQL bucketing so both screens plot the same
 * buckets for the same period.
 */
export function bucketModeFor(from: string, to: string): BucketMode {
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  return days > 400 ? "month" : days > 62 ? "week" : "day";
}

/** Kigali bucket key a timestamp belongs to: `YYYY-MM-DD` (day/week start) or `YYYY-MM-01`. */
export function bucketKey(iso: string, mode: BucketMode): string {
  const day = kigaliDay(iso);
  if (mode === "day") return day;
  if (mode === "month") return `${day.slice(0, 7)}-01`;
  const [y, m, d] = day.split("-").map(Number);
  const back = (new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay() + 6) % 7; // Monday-start weeks
  return new Date(Date.UTC(y!, m! - 1, d!) - back * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Every bucket in the range, in order, including empty ones. A trend line over three days must show
 * all three, not only the days that had sales — but a bucket with no records is a real zero, not a
 * substitute for unknown data.
 */
export function bucketKeys(from: string, to: string, mode: BucketMode): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const end = Date.parse(to);
  // Ranges are Kigali midnights, so stepping 24h never drifts (Rwanda has no daylight saving).
  for (let t = Date.parse(from); t < end; t += 86_400_000) {
    const key = bucketKey(new Date(t).toISOString(), mode);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}
