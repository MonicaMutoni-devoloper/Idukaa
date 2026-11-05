import * as SQLite from "expo-sqlite";

/**
 * Local persistent store. Every operation is saved here in ONE SQLite transaction (with its optimistic stock delta)
 * before the UI reports success, so it survives app kills and restarts. Rows are only marked synced after the server confirms.
 * Platform note: this file is the native (Android) adapter. The web build bundles `local.web.ts`
 * (IndexedDB) instead — Metro resolves the `.web.ts` extension. See docs/OFFLINE.md.
 */
let _db: SQLite.SQLiteDatabase | null = null;
const db = async () => (_db ??= await SQLite.openDatabaseAsync("shop.db"));

export type StorageBackend = "sqlite" | "indexeddb" | "localstorage";
/** Native builds keep business data in SQLite; the web adapter overrides this. */
export const storageBackend = (): StorageBackend => "sqlite";

export type OutboxStatus = "pending" | "retry" | "synced" | "conflict" | "rejected" | "pending_approval";
export interface OutboxRow { seq: number; op_id: string; user_id: string; type: string; payload: string; deltas: string; status: OutboxStatus; attempts: number; next_attempt_at: number; message: string | null; created_at: string; synced_at?: string | null }
export interface LocalRecord { op_id: string; type: string; at: string; data: string; actor: string | null; created_at: string; status: string }

export interface LocalProduct {
  id: string; code: string; barcode: string | null; name: string; unit: string; category: string | null;
  selling_price: number; low_threshold: number; on_hand: number; pending_delta: number;
  // Unit configuration (nullable labels fall back to `unit`; factors default to 1 = simple setup).
  purchase_unit?: string | null; selling_unit?: string | null;
  units_per_purchase?: number; units_per_selling?: number;
}

export async function initDb() {
  const d = await db();
  await d.execAsync(`PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, code TEXT, barcode TEXT, name TEXT NOT NULL, category TEXT, unit TEXT, selling_price INTEGER NOT NULL DEFAULT 0, low_threshold INTEGER NOT NULL DEFAULT 0, on_hand INTEGER NOT NULL DEFAULT 0, pending_delta INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS suppliers (id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT);
    CREATE TABLE IF NOT EXISTS outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, op_id TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, deltas TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0, message TEXT, created_at TEXT NOT NULL, synced_at TEXT);
    CREATE INDEX IF NOT EXISTS outbox_status ON outbox(status, next_attempt_at);
    -- Business records saved on this device, keyed by the operation id that will sync them.
    -- The dashboard and every offline figure are calculated from THESE rows, never from a network
    -- response, so a sale, expense or delivery is reportable the moment it is saved. One row per
    -- operation means moving pending -> synced cannot be counted twice (the row is never duplicated).
    CREATE TABLE IF NOT EXISTS records (op_id TEXT PRIMARY KEY, type TEXT NOT NULL, at TEXT NOT NULL, data TEXT NOT NULL, actor TEXT, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS records_at ON records(at);`);
  // Incremental local migrations (SQLite has no ADD COLUMN IF NOT EXISTS): the unit-configuration
  // columns added with the purchase/base/selling-unit feature. No existing rows are touched.
  const cols = (await d.getAllAsync<{ name: string }>("PRAGMA table_info(products)")).map((r) => r.name);
  if (!cols.includes("purchase_unit")) await d.runAsync("ALTER TABLE products ADD COLUMN purchase_unit TEXT");
  if (!cols.includes("selling_unit")) await d.runAsync("ALTER TABLE products ADD COLUMN selling_unit TEXT");
  if (!cols.includes("units_per_purchase")) await d.runAsync("ALTER TABLE products ADD COLUMN units_per_purchase INTEGER NOT NULL DEFAULT 1");
  if (!cols.includes("units_per_selling")) await d.runAsync("ALTER TABLE products ADD COLUMN units_per_selling INTEGER NOT NULL DEFAULT 1");
}
export const kvGet = async (k: string) => (await (await db()).getFirstAsync<{ v: string }>("SELECT v FROM kv WHERE k=?", [k]))?.v ?? null;
export const kvSet = async (k: string, v: string) => { await (await db()).runAsync("INSERT INTO kv(k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", [k, v]); };

/**
 * Bind the cached catalogue to exactly one shop. Products and suppliers are per-shop data, but
 * the store itself is shared by every account that signs in on this device, so on each sign-in
 * and session restore this compares the bound shop against the signed-in user's: a different shop
 * drops the other shop's cached rows and sync checkpoints (forcing a full re-pull) while the outbox
 * is left untouched — unsynced work is never deleted. Same shop = no-op, so offline cache survives.
 */
export async function bindShop(shopId: string | null) {
  if (!shopId) return; // platform administrator: no shop data to scope
  const d = await db();
  if ((await d.getFirstAsync<{ v: string }>("SELECT v FROM kv WHERE k='local.shop'"))?.v === shopId) return;
  await d.withTransactionAsync(async () => {
    await d.runAsync("DELETE FROM products");
    await d.runAsync("DELETE FROM suppliers");
    await d.runAsync("DELETE FROM records"); // another shop's saved records must never be reported
    await d.runAsync("DELETE FROM kv WHERE k LIKE 'cp:%'"); // checkpoints: next pull starts from scratch for this shop
    await d.runAsync("INSERT INTO kv(k,v) VALUES ('local.shop',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", [shopId]);
  });
}

/** Persist operation + optimistic stock deltas atomically. deltas: productId -> signed milli-units. */
export async function enqueue(userId: string, opId: string, type: string, payload: unknown, deltas: Record<string, number> = {}, local?: () => Promise<unknown>, recordAt?: string) {
  const d = await db();
  const now = new Date().toISOString();
  await d.withTransactionAsync(async () => {
    await d.runAsync("INSERT INTO outbox(op_id,user_id,type,payload,deltas,created_at) VALUES (?,?,?,?,?,?)", [opId, userId, type, JSON.stringify(payload), JSON.stringify(deltas), now]);
    for (const [pid, q] of Object.entries(deltas)) await d.runAsync("UPDATE products SET pending_delta = pending_delta + ? WHERE id=?", [q, pid]);
    // The reportable record is committed in the same transaction as the outbox row: if the app dies
    // now, either both exist or neither does — a sale can never be shown as saved without being countable.
    await d.runAsync("INSERT OR IGNORE INTO records(op_id,type,at,data,actor,created_at) VALUES (?,?,?,?,NULL,?)",
      [opId, type, recordAt ?? now, JSON.stringify(payload), now]);
    await local?.();
  });
}

/** Every record saved on this device, with its sync verdict (the dashboard's only data source offline). */
export const listRecords = async () =>
  (await db()).getAllAsync<LocalRecord>(
    `SELECT r.op_id, r.type, r.at, r.data, r.actor, r.created_at, COALESCE(o.status, 'pending') AS status
       FROM records r LEFT JOIN outbox o ON o.op_id = r.op_id ORDER BY r.at, r.op_id`);
export const upsertLocalProduct = async (p: { id: string; code: string; barcode?: string | null; name: string; category?: string | null; unit: string; sellingPrice: number; lowStockThreshold: number; initialQty?: number; purchaseUnit?: string | null; sellingUnit?: string | null; unitsPerPurchase?: number; unitsPerSelling?: number }) => {
  const d = await db();
  // Conversion config is part of the local product so offline sales/receipts convert on-device
  // exactly like the server will verify them. COALESCE keeps an edit that omits the config from
  // wiping it (mirrors the server's unit_config_locked behaviour).
  await d.runAsync(`INSERT INTO products(id,code,barcode,name,category,unit,selling_price,low_threshold,pending_delta,purchase_unit,selling_unit,units_per_purchase,units_per_selling)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET code=excluded.code,barcode=excluded.barcode,name=excluded.name,category=COALESCE(excluded.category,products.category),unit=excluded.unit,
      selling_price=excluded.selling_price,low_threshold=excluded.low_threshold,
      purchase_unit=COALESCE(excluded.purchase_unit,products.purchase_unit),selling_unit=COALESCE(excluded.selling_unit,products.selling_unit),
      units_per_purchase=COALESCE(excluded.units_per_purchase,products.units_per_purchase),units_per_selling=COALESCE(excluded.units_per_selling,products.units_per_selling)`,
    [p.id, p.code, p.barcode ?? null, p.name, p.category ?? null, p.unit, p.sellingPrice, p.lowStockThreshold, p.initialQty ?? 0,
     p.purchaseUnit ?? null, p.sellingUnit ?? null, p.unitsPerPurchase ?? null, p.unitsPerSelling ?? null]);
};
export const upsertLocalSupplier = async (s: { id: string; name: string; phone?: string }) => (await db()).runAsync("INSERT INTO suppliers(id,name,phone) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name", [s.id, s.name, s.phone ?? null]);

export const dueOps = async (userId: string, limit = 50) => (await db()).getAllAsync<OutboxRow>("SELECT * FROM outbox WHERE user_id=? AND status IN ('pending','retry') AND next_attempt_at<=? ORDER BY seq LIMIT ?", [userId, Date.now(), limit]);
export const listOutbox = async (userId: string) => (await db()).getAllAsync<OutboxRow>("SELECT * FROM outbox WHERE user_id=? ORDER BY seq DESC LIMIT 200", [userId]);
export const outboxCounts = async (userId: string) => {
  const rows = await (await db()).getAllAsync<{ status: string; n: number }>("SELECT status, COUNT(*) n FROM outbox WHERE user_id=? GROUP BY status", [userId]);
  const g = (s: string) => rows.find(r => r.status === s)?.n ?? 0;
  return { pending: g("pending") + g("retry"), issues: g("conflict") + g("rejected"), awaitingApproval: g("pending_approval") };
};

/** Apply server verdicts. Whatever the verdict, the optimistic delta is released (server on_hand is canonical on next pull). */
export async function applyResults(results: { opId: string; status: string; message?: string }[]) {
  const d = await db();
  await d.withTransactionAsync(async () => {
    for (const r of results) {
      const row = await d.getFirstAsync<OutboxRow>("SELECT deltas FROM outbox WHERE op_id=?", [r.opId]); if (!row) continue;
      for (const [pid, q] of Object.entries(JSON.parse(row.deltas) as Record<string, number>)) await d.runAsync("UPDATE products SET pending_delta = pending_delta - ? WHERE id=?", [q, pid]);
      const st = r.status === "applied" || r.status === "duplicate" ? "synced" : r.status;
      await d.runAsync("UPDATE outbox SET status=?, message=?, deltas='{}', synced_at=? WHERE op_id=?", [st, r.message ?? null, new Date().toISOString(), r.opId]);
    }
  });
}
export async function markRetry(opIds: string[], message: string) {
  const d = await db();
  await d.withTransactionAsync(async () => {
    for (const id of opIds) {
      const r = await d.getFirstAsync<{ attempts: number }>("SELECT attempts FROM outbox WHERE op_id=?", [id]); const n = (r?.attempts ?? 0) + 1;
      const delay = Math.min(5000 * 2 ** n, 15 * 60_000) * (0.8 + Math.random() * 0.4); // exponential backoff + jitter
      await d.runAsync("UPDATE outbox SET status='retry', attempts=?, next_attempt_at=?, message=? WHERE op_id=?", [n, Date.now() + delay, message, id]);
    }
  });
}
export const retryNow = async (userId: string) => (await db()).runAsync("UPDATE outbox SET next_attempt_at=0 WHERE user_id=? AND status='retry'", [userId]);

export async function applyPull(changes: { entity: string; id: string; data: any }[]) {
  const d = await db();
  await d.withTransactionAsync(async () => {
    for (const c of changes) {
      if (c.entity === "product") { const p = c.data; await d.runAsync("INSERT INTO products(id,code,barcode,name,category,unit,selling_price,low_threshold,on_hand,active,purchase_unit,selling_unit,units_per_purchase,units_per_selling) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET code=excluded.code,barcode=excluded.barcode,name=excluded.name,category=excluded.category,unit=excluded.unit,selling_price=excluded.selling_price,low_threshold=excluded.low_threshold,on_hand=excluded.on_hand,active=excluded.active,purchase_unit=excluded.purchase_unit,selling_unit=excluded.selling_unit,units_per_purchase=excluded.units_per_purchase,units_per_selling=excluded.units_per_selling", [p.id, p.code, p.barcode ?? null, p.name, p.category ?? null, p.unit, p.sellingPrice, p.lowStockThreshold, p.onHand, p.active ? 1 : 0, p.purchaseUnit ?? null, p.sellingUnit ?? null, p.unitsPerPurchase ?? 1, p.unitsPerSelling ?? 1]); }
      if (c.entity === "supplier") await d.runAsync("INSERT INTO suppliers(id,name,phone) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, phone=excluded.phone", [c.data.id, c.data.name, c.data.phone ?? null]);
    }
  });
}
export const listProducts = async (q = "") => (await db()).getAllAsync<LocalProduct>("SELECT * FROM products WHERE active=1 AND (name LIKE ? OR code LIKE ? OR COALESCE(barcode,'') LIKE ?) ORDER BY name LIMIT 300", [`%${q}%`, `%${q}%`, `%${q}%`]);
export const listSuppliers = async () => (await db()).getAllAsync<{ id: string; name: string }>("SELECT id,name FROM suppliers ORDER BY name");
