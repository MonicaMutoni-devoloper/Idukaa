import { test } from "node:test";
import assert from "node:assert/strict";
import { monthRangeFor } from "../src/services/offline-policy.ts";
import {
  classifyCacheKey, formatBytes, planRetention, readRetentionSettings, retentionKeepFrom,
  shiftMonth, storageLevel, type CacheEntry, type RetentionSettings,
} from "../src/services/offline-retention.ts";

const NOW = Date.parse("2026-11-11T08:00:00.000Z");
const month = (key: string) => monthRangeFor(key)!;
const base: RetentionSettings = { version: 1, mode: "auto", limitMb: 10, wifiOnly: false };

function entry(key: string, bytes = 1_000_000, parsed?: any): CacheEntry {
  const e = classifyCacheKey(key, "shop-1", parsed);
  assert.ok(e, `expected ${key} to classify`);
  return { ...e!, bytes };
}

test("cache keys are parsed around ISO timestamps, not split on their colons", () => {
  const jan = month("2024-01");
  const report = entry(`report:v2:shop-1:analytics:sales:${jan.from}:${jan.to}:operational`);
  assert.equal(report.kind, "report");
  assert.equal(report.shopId, "shop-1");
  assert.equal(report.period, "2024-01");
  assert.equal(report.fullMonth, true);

  const dashboard = entry(`dashboard:v3:shop-1:user-1:owner:${jan.from}:${jan.to}`);
  assert.equal(dashboard.kind, "dashboard");
  assert.equal(dashboard.period, "2024-01");

  const profit = entry(`profitability:shop-1:user-1:${jan.from}:${jan.to}`);
  assert.equal(profit.kind, "profitability");
  assert.equal(profit.period, "2024-01");

  const sale = entry("sale:shop-1:sale-1", 500, { period: "2024-01" });
  assert.equal(sale.kind, "saleDetail");
  assert.equal(sale.period, "2024-01");

  assert.equal(classifyCacheKey(`report:v2:shop-2:analytics:sales:${jan.from}:${jan.to}:operational`, "shop-1"), null);
});

test("retention settings fall back safely and explain the month floor", () => {
  assert.deepEqual(readRetentionSettings(null), { version: 1, mode: "auto", limitMb: 250, wifiOnly: false });
  assert.equal(readRetentionSettings(JSON.stringify({ version: 1, mode: "months12", limitMb: 99999 })).limitMb, 250);
  assert.equal(readRetentionSettings(JSON.stringify({ version: 9, mode: "recent" })).mode, "auto");
  assert.equal(retentionKeepFrom({ ...base, mode: "recent" }, NOW), "2026-09");
  assert.equal(retentionKeepFrom({ ...base, mode: "months12" }, NOW), "2025-12");
  assert.equal(retentionKeepFrom({ ...base, mode: "months24" }, NOW), "2024-12");
  assert.equal(retentionKeepFrom(base, NOW), null);
  assert.equal(shiftMonth("2026-01", -1), "2025-12");
  assert.equal(shiftMonth("2026-12", 1), "2027-01");
});

test("recent policy removes old downloads but protects current periods", () => {
  const current = month("2026-11");
  const previous = month("2026-10");
  const thisYear = { from: "2026-01-01T00:00:00.000Z", to: "2027-01-01T00:00:00.000Z" };
  const old = month("2024-01");
  const entries = [
    entry(`report:v2:shop-1:analytics:sales:${current.from}:${current.to}:operational`, 10),
    entry(`report:v2:shop-1:analytics:sales:${previous.from}:${previous.to}:operational`, 10),
    entry(`report:v2:shop-1:analytics:financial:${thisYear.from}:${thisYear.to}:financial`, 10),
    entry(`report:v2:shop-1:analytics:sales:${old.from}:${old.to}:operational`, 10),
    entry("sale:shop-1:sale-old", 10, { period: "2024-01" }),
  ];
  const plan = planRetention({ entries, settings: { ...base, mode: "recent" }, now: NOW });
  assert.equal(plan.remove.some((e) => e.period === "2026-11"), false);
  assert.equal(plan.remove.some((e) => e.period === "2026-10"), false);
  assert.equal(plan.remove.some((e) => e.kind === "report" && e.period === "2024-01"), true);
  assert.equal(plan.remove.some((e) => e.kind === "saleDetail"), true);
});

test("twelve-month policy keeps the last twelve months of detail", () => {
  const keep = month("2025-12");
  const drop = month("2025-11");
  const entries = [
    entry(`report:v2:shop-1:analytics:sales:${keep.from}:${keep.to}:operational`, 10),
    entry(`report:v2:shop-1:analytics:sales:${drop.from}:${drop.to}:operational`, 10),
  ];
  const plan = planRetention({ entries, settings: { ...base, mode: "months12" }, now: NOW });
  assert.equal(plan.remove.some((e) => e.period === "2025-12"), false);
  assert.equal(plan.remove.some((e) => e.period === "2025-11"), true);
});

test("automatic cleanup waits below the limit and removes oldest safe data above it", () => {
  const current = month("2026-11");
  const old = month("2024-01");
  const older = month("2023-01");
  const entries = [
    entry(`report:v2:shop-1:analytics:sales:${current.from}:${current.to}:operational`, 8_000_000),
    entry(`report:v2:shop-1:analytics:sales:${old.from}:${old.to}:operational`, 8_000_000),
    entry(`report:v2:shop-1:analytics:sales:${older.from}:${older.to}:operational`, 8_000_000),
  ];
  const under = planRetention({ entries, settings: { ...base, limitMb: 100 }, now: NOW });
  assert.equal(under.remove.length, 0);

  const over = planRetention({ entries, settings: { ...base, limitMb: 10 }, now: NOW });
  assert.equal(over.remove.some((e) => e.period === "2026-11"), false, "current month stays");
  assert.equal(over.remove.some((e) => e.period === "2023-01"), true, "oldest goes first");
});

test("cleanup never targets operational snapshots or malformed keys", () => {
  const jan = month("2024-01");
  const entries = [
    entry(`offline.team:shop-1`, 100),
    entry(`offline:archive:shop-1:user-1:2024-01`, 2),
    entry(`report:v2:shop-1:analytics:sales:${jan.from}:${jan.to}:operational`, 10),
  ];
  const plan = planRetention({ entries, settings: { ...base, mode: "recent" }, now: NOW });
  assert.equal(plan.remove.some((e) => e.kind === "otherCache" || e.kind === "archiveMarker"), false);
  assert.equal(plan.remove.some((e) => e.kind === "report"), true);
});

test("storage levels and byte formatting are honest", () => {
  assert.equal(storageLevel(10, 100, null), "normal");
  assert.equal(storageLevel(80 * 1024 * 1024, 100, null), "warning");
  assert.equal(storageLevel(96 * 1024 * 1024, 100, null), "critical");
  assert.equal(storageLevel(1, 100, 50 * 1024 * 1024), "critical");
  assert.equal(formatBytes(null), "—");
  assert.equal(formatBytes(500), "500 B");
  assert.equal(formatBytes(2048), "2 KB");
  assert.equal(formatBytes(5 * 1024 * 1024), "5.0 MB");
});
