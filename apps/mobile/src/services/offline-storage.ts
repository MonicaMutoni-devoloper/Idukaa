import { kvDelete, kvGet, kvSet, storageUsage, type StorageUsageSnapshot } from "../database";
import {
  classifyCacheKey, isArchiveMonth, planRetention, readRetentionSettings, shiftMonth, storageLevel,
  type CacheEntry, type RetentionPlan, type RetentionSettings, type StorageLevel,
} from "./offline-retention";

const retentionKey = (shopId: string) => `offline.retention:v1:${shopId}`;
const archiveMarker = (shopId: string, userId: string, month: string) => `offline.archive:${shopId}:${userId}:${month}`;
const archiveFloorKey = (shopId: string, userId: string) => `offline.archive.floor:${shopId}:${userId}`;

export interface StorageOverview {
  usage: StorageUsageSnapshot;
  entries: CacheEntry[];
  /** Full-month archive markers for this user. */
  markers: Map<string, string>;
  downloadedBytes: number;
  reportsBytes: number;
  saleDetailBytes: number;
  archiveBytes: number;
  otherCacheBytes: number;
  businessBytes: number;
  pendingBytes: number;
  totalKvBytes: number;
  level: StorageLevel;
}

export async function readRetention(shopId: string): Promise<RetentionSettings> {
  return readRetentionSettings(await kvGet(retentionKey(shopId)).catch(() => null));
}

export async function saveRetention(shopId: string, settings: RetentionSettings): Promise<void> {
  await kvSet(retentionKey(shopId), JSON.stringify({
    version: 1, mode: settings.mode, limitMb: settings.limitMb, wifiOnly: settings.wifiOnly,
  }));
}

/** Oldest month automatic preparation should still try to download after a cleanup. */
export async function readArchiveFloor(shopId: string, userId: string): Promise<string | null> {
  const raw = await kvGet(archiveFloorKey(shopId, userId)).catch(() => null);
  return raw && /^\d{4}-\d{2}$/.test(raw) ? raw : null;
}

/** Explicitly offer older history again after a cleanup or a policy change. */
export async function clearArchiveFloor(shopId: string, userId: string): Promise<void> {
  await kvDelete(archiveFloorKey(shopId, userId)).catch(() => undefined);
}

export async function measureOfflineStorage(shopId: string, userId: string): Promise<StorageOverview> {
  const [usage, settings] = await Promise.all([storageUsage(), readRetention(shopId)]);
  const entries: CacheEntry[] = [];
  const markers = new Map<string, string>();
  let totalKvBytes = 0;
  let reportsBytes = 0;
  let saleDetailBytes = 0;
  let downloadedBytes = 0;
  let archiveBytes = 0;

  for (const row of usage.kvEntries) {
    totalKvBytes += row.bytes;
    const entry = classifyCacheKey(row.key, shopId, {
      savedAt: row.savedAt, lastAccessAt: row.lastAccessAt, period: row.period,
    });
    if (!entry) continue;
    entry.bytes = row.bytes;
    entries.push(entry);
    if (entry.kind === "report" || entry.kind === "dashboard" || entry.kind === "profitability") {
      reportsBytes += row.bytes;
    }
    if (entry.kind === "saleDetail") saleDetailBytes += row.bytes;
    if (entry.kind === "report" || entry.kind === "dashboard" || entry.kind === "profitability" || entry.kind === "saleDetail") {
      downloadedBytes += row.bytes;
      if (isArchiveMonth(entry.period)) archiveBytes += row.bytes;
    }
    if (entry.kind === "archiveMarker" && entry.markerMonth && entry.shopId === shopId && row.key.split(":")[3] === userId) {
      markers.set(entry.markerMonth, row.key);
    }
  }

  return {
    usage, entries, markers,
    downloadedBytes, reportsBytes, saleDetailBytes, archiveBytes,
    // Every KV byte not spent on downloaded reports is cache/preferences/small snapshots.
    otherCacheBytes: Math.max(0, totalKvBytes - downloadedBytes),
    businessBytes: usage.recordsBytes + usage.productsBytes + usage.suppliersBytes + Math.max(0, usage.outboxBytes - usage.pendingOutboxBytes),
    pendingBytes: usage.pendingOutboxBytes,
    totalKvBytes,
    level: storageLevel(downloadedBytes, settings.limitMb, usage.availableBytes),
  };
}

export interface CleanupPreview extends RetentionPlan {
  months: string[];
}

export function previewCleanup(overview: StorageOverview, settings: RetentionSettings, now = Date.now()): CleanupPreview {
  const plan = planRetention({ entries: overview.entries, settings, now, availableBytes: overview.usage.availableBytes });
  const months = [...new Set(plan.remove.map((e) => e.period).filter((m): m is string => !!m))].sort().reverse();
  return { ...plan, months };
}

export interface CleanupResult {
  removedKeys: number;
  bytesFreed: number;
  months: string[];
}

/**
 * Remove only entries selected by the retention plan. Archive markers are deleted FIRST so a
 * crash midway causes a safe re-download instead of leaving a month marked available without its
 * cache. Records, products and every outbox row are never passed to this function.
 */
export async function runCacheCleanup(
  shopId: string,
  userId: string,
  settings: RetentionSettings,
  now = Date.now(),
): Promise<CleanupResult> {
  const overview = await measureOfflineStorage(shopId, userId);
  const plan = previewCleanup(overview, settings, now);
  if (!plan.remove.length) return { removedKeys: 0, bytesFreed: 0, months: [] };

  const removedKeys = new Set(plan.remove.map((e) => e.key));
  const remainingPeriods = new Set(overview.entries
    .filter((e) => (e.kind === "report" || e.kind === "dashboard" || e.kind === "profitability" || e.kind === "saleDetail")
      && e.period && !removedKeys.has(e.key))
    .map((e) => e.period as string));
  const fullyRemoved = plan.months.filter((month) => !remainingPeriods.has(month));

  for (const month of plan.months) {
    await kvDelete(overview.markers.get(month) ?? archiveMarker(shopId, userId, month)).catch(() => undefined);
  }
  for (const entry of plan.remove) await kvDelete(entry.key);
  // Do not immediately fill the space we just freed. The Offline Center offers an explicit
  // "download older history" action that clears this floor. Only a fully removed month raises
  // the floor; a partially removed month keeps its marker deleted so the next run re-downloads it.
  const newestRemoved = fullyRemoved[0];
  const nextMonth = newestRemoved ? shiftMonth(newestRemoved, 1) : null;
  if (nextMonth) await kvSet(archiveFloorKey(shopId, userId), nextMonth).catch(() => undefined);
  return { removedKeys: plan.remove.length, bytesFreed: plan.bytesFreed, months: fullyRemoved };
}

export { archiveFloorKey, archiveMarker, retentionKey };
