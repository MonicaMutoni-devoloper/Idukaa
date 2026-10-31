import * as Crypto from "expo-crypto";
import { formatQty, parseQty, presetRange as calendarRange } from "@sms/shared";

export const uuid = () => Crypto.randomUUID();
export type Preset = "today" | "yesterday" | "week" | "month" | "year";
export type Range = { from: string; to: string };

const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

/**
 * Reporting periods on the shop's business calendar (docs/FINANCE.md): Africa/Kigali days,
 * Monday–Sunday weeks, calendar months and years — the SAME definition the API uses for its
 * monthly charts and snapshots, so the client and server never disagree about a period.
 */
export function presetRange(p: Preset, now = new Date()): Range {
  return calendarRange(p, now.getTime());
}

/** Back-compatible helper used by Reports. */
export function rangeFor(p: Preset) { return presetRange(p); }

/** "YYYY-MM-DD" -> local midnight. Returns null for impossible or malformed dates. */
export function dayToDate(day: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
  return d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]) ? d : null;
}

/** Inclusive custom range in local time; `toDay` is inclusive (end = the next midnight). */
export function customRange(fromDay: string, toDay: string): Range | null {
  const from = dayToDate(fromDay); const to = dayToDate(toDay);
  if (!from || !to || from > to) return null;
  return { from: from.toISOString(), to: addDays(to, 1).toISOString() };
}

export const todayDay = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
export const addDaysToDay = (day: string, n: number) => {
  const d = dayToDate(day) ?? new Date();
  const x = addDays(d, n);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
};

/** Whole-number parser for RWF amounts. Returns null if invalid. */
export const parseRwf = (s: string): number | null => (/^\d{1,12}$/.test(s.trim()) ? Number(s.trim()) : null);
export const qtyOrNull = (s: string): number | null => { try { const q = parseQty(s.replace(",", ".")); return q > 0 ? q : null; } catch { return null; } };
export { formatQty };
