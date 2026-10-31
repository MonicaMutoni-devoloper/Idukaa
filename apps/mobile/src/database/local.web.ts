// Web (PC/PWA) implementation of the local store. expo-sqlite 15 has no web backend, so the
// browser keeps business data in IndexedDB (durable, larger quota than localStorage) behind the
// same API as local.ts. One IndexedDB record holds the whole state, so an outbox row and its
// optimistic stock delta are committed by a single transaction: the UI never reports "saved"
// before both are durable.
//
// Migration: the previous adapter stored the same state shape under localStorage["sms.localdb.v1"].
// On first open we import it into IndexedDB and leave the old key untouched as a recovery copy.
//
// Concurrency: writes are serialized with the Web Locks API when available and re-read the latest
// state under the lock, so two tabs cannot clobber each other's queued operations. Other tabs are
// notified through BroadcastChannel and drop their read cache.
import type { LocalProduct, OutboxRow, OutboxStatus, StorageBackend } from "./local";

export type { LocalProduct, OutboxRow, OutboxStatus, StorageBackend };

interface LocalSupplier { id: string; name: string; phone?: string | null }
interface WebProduct extends LocalProduct { barcode: string | null; active: number }
interface State { kv: Record<string, string>; products: WebProduct[]; suppliers: LocalSupplier[]; outbox: OutboxRow[]; seq: number }

const IDB_NAME = "sms-local";
const IDB_STORE = "state";
const IDB_KEY = "state";
const LEGACY_KEY = "sms.localdb.v1";
const CHANNEL = "sms-local";

const empty = (): State => ({ kv: {}, products: [], suppliers: [], outbox: [], seq: 0 });
const hasIDB = typeof indexedDB !== "undefined";
const hasLS = typeof localStorage !== "undefined";

let cache: State | null = null;
let dbPromise: Promise<IDBDatabase> | null = null;
let writeChain: Promise<unknown> = Promise.resolve();

/** Which backend the current browser actually uses (shown on the Sync screen). */
export const storageBackend = (): StorageBackend => (hasIDB ? "indexeddb" : "localstorage");

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(IDB_STORE)) req.result.createObjectStore(IDB_STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("indexeddb_open_failed"));
      req.onblocked = () => reject(new Error("indexeddb_blocked"));
    });
  }
  return dbPromise;
}

async function idbRead(): Promise<State | null> {
  const db = await openDb();
  return new Promise<State | null>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
    req.onsuccess = () => resolve((req.result as State | undefined) ?? null);
    req.onerror = () => reject(req.error ?? new Error("indexeddb_read_failed"));
  });
}

async function idbWrite(s: State): Promise<void> {
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(s, IDB_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("indexeddb_write_failed"));
    tx.onabort = () => reject(tx.error ?? new Error("indexeddb_write_aborted"));
  });
}

function normalize(raw: unknown): State {
  const s = (raw ?? {}) as Partial<State>;
  return {
    kv: s.kv && typeof s.kv === "object" ? s.kv : {},
    products: Array.isArray(s.products) ? s.products : [],
    suppliers: Array.isArray(s.suppliers) ? s.suppliers : [],
    outbox: Array.isArray(s.outbox) ? s.outbox : [],
    seq: typeof s.seq === "number" ? s.seq : (Array.isArray(s.outbox) ? s.outbox.reduce((m, r) => Math.max(m, r.seq ?? 0), 0) : 0),
  };
}

function readLegacy(): State | null {
  if (!hasLS) return null;
  try { const raw = localStorage.getItem(LEGACY_KEY); return raw ? normalize(JSON.parse(raw)) : null; } catch { return null; }
}
function writeLegacy(s: State) { if (hasLS) localStorage.setItem(LEGACY_KEY, JSON.stringify(s)); }

const channel: BroadcastChannel | null = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(CHANNEL) : null;
channel?.addEventListener("message", () => { cache = null; }); // another tab changed state

async function readState(): Promise<State> {
  if (cache) return cache;
  if (!hasIDB) return (cache = readLegacy() ?? empty());
  const stored = await idbRead();
  if (stored) return (cache = normalize(stored));
  const legacy = readLegacy(); // one-time import from the previous web adapter
  const initial = legacy ?? empty();
  await idbWrite(initial);
  return (cache = initial);
}

async function persist(s: State) {
  if (hasIDB) await idbWrite(s);
  else writeLegacy(s);
  cache = s;
  channel?.postMessage("changed");
}

/** Serialize a read-modify-write so concurrent tabs and screens cannot lose each other's rows. */
function mutate<T>(fn: (s: State) => T): Promise<T> {
  const run = async (): Promise<T> => {
    const work = async () => {
      cache = null; // re-read under the lock: another tab may have written
      const s = await readState();
      const result = fn(s);
      await persist(s);
      return result;
    };
    const locks = typeof navigator !== "undefined" ? (navigator as any).locks : undefined;
    return locks?.request ? (locks.request("sms-local-write", work) as Promise<T>) : work();
  };
  const p = writeChain.then(run, run);
  writeChain = p.catch(() => undefined);
  return p;
}

export async function initDb() {
  await readState();
  if (!hasIDB) writeLegacy(cache ?? empty()); // make sure a fresh store exists
}

export const kvGet = async (k: string) => (await readState()).kv[k] ?? null;
export const kvSet = async (k: string, v: string) => mutate((s) => { s.kv[k] = v; });

/**
 * Bind the cached catalogue to exactly one shop (web counterpart of local.ts#bindShop).
 * Products and suppliers are per-shop data, but the IndexedDB store is shared by every account
 * that signs in on this browser. On sign-in/session restore a different shop drops the previous
 * shop's cached rows and sync checkpoints (forcing a full re-pull); the outbox is never touched.
 * Same shop = no-op, so the offline cache survives reloads and connectivity loss.
 */
export async function bindShop(shopId: string | null) {
  if (!shopId) return; // platform administrator: no shop data to scope
  if ((await kvGet("local.shop")) === shopId) return;
  await mutate((s) => {
    if (s.kv["local.shop"] === shopId) return; // another tab may have bound it already
    s.products = [];
    s.suppliers = [];
    for (const k of Object.keys(s.kv)) if (k.startsWith("cp:")) delete s.kv[k]; // full re-pull
    s.kv["local.shop"] = shopId;
  });
}

/** Persist operation + optimistic stock deltas atomically. deltas: productId -> signed milli-units. */
export async function enqueue(userId: string, opId: string, type: string, payload: unknown, deltas: Record<string, number> = {}, local?: () => Promise<unknown>) {
  await mutate((s) => {
    s.seq += 1;
    s.outbox.push({
      seq: s.seq, op_id: opId, user_id: userId, type, payload: JSON.stringify(payload), deltas: JSON.stringify(deltas),
      status: "pending", attempts: 0, next_attempt_at: 0, message: null, created_at: new Date().toISOString(), synced_at: null,
    });
    for (const [pid, q] of Object.entries(deltas)) { const p = s.products.find((p) => p.id === pid); if (p) p.pending_delta += q; }
  });
  await local?.();
}

export async function upsertLocalProduct(p: { id: string; code: string; barcode?: string | null; name: string; unit: string; sellingPrice: number; lowStockThreshold: number; initialQty?: number }) {
  await mutate((s) => {
    const ex = s.products.find((x) => x.id === p.id);
    if (ex) { ex.code = p.code; ex.barcode = p.barcode ?? null; ex.name = p.name; ex.unit = p.unit; ex.selling_price = p.sellingPrice; ex.low_threshold = p.lowStockThreshold; }
    // Opening stock is shown optimistically through pending_delta; the matching delta on the
    // product.upsert operation is released when the server verdict arrives.
    else s.products.push({ id: p.id, code: p.code, barcode: p.barcode ?? null, name: p.name, category: null, unit: p.unit, selling_price: p.sellingPrice, low_threshold: p.lowStockThreshold, on_hand: 0, pending_delta: p.initialQty ?? 0, active: 1 });
  });
}

export async function upsertLocalSupplier(x: { id: string; name: string; phone?: string }) {
  await mutate((s) => {
    const ex = s.suppliers.find((v) => v.id === x.id);
    if (ex) ex.name = x.name; else s.suppliers.push({ id: x.id, name: x.name, phone: x.phone ?? null });
  });
}

export const dueOps = async (userId: string, limit = 50) =>
  (await readState()).outbox
    .filter((r) => r.user_id === userId && (r.status === "pending" || r.status === "retry") && r.next_attempt_at <= Date.now())
    .sort((a, b) => a.seq - b.seq)
    .slice(0, limit)
    .map((r) => ({ ...r }));

export const listOutbox = async (userId: string) =>
  (await readState()).outbox.filter((r) => r.user_id === userId).sort((a, b) => b.seq - a.seq).slice(0, 200).map((r) => ({ ...r }));

export const outboxCounts = async (userId: string) => {
  const rows = (await readState()).outbox.filter((r) => r.user_id === userId);
  const g = (s: string) => rows.filter((r) => r.status === s).length;
  return { pending: g("pending") + g("retry"), issues: g("conflict") + g("rejected"), awaitingApproval: g("pending_approval") };
};

/** Apply server verdicts. Whatever the verdict, the optimistic delta is released (server on_hand is canonical on next pull). */
export async function applyResults(results: { opId: string; status: string; message?: string }[]) {
  await mutate((s) => {
    for (const r of results) {
      const row = s.outbox.find((x) => x.op_id === r.opId); if (!row) continue;
      for (const [pid, q] of Object.entries(JSON.parse(row.deltas) as Record<string, number>)) { const p = s.products.find((p) => p.id === pid); if (p) p.pending_delta -= q; }
      row.status = (r.status === "applied" || r.status === "duplicate" ? "synced" : r.status) as OutboxStatus;
      row.message = r.message ?? null;
      row.deltas = "{}";
      row.synced_at = new Date().toISOString();
    }
  });
}

export async function markRetry(opIds: string[], message: string) {
  const now = Date.now();
  await mutate((s) => {
    for (const id of opIds) {
      const r = s.outbox.find((x) => x.op_id === id); if (!r) continue;
      r.attempts += 1;
      const delay = Math.min(5000 * 2 ** r.attempts, 15 * 60_000) * (0.8 + Math.random() * 0.4); // exponential backoff + jitter
      r.status = "retry"; r.next_attempt_at = now + delay; r.message = message;
    }
  });
}

export const retryNow = async (userId: string) =>
  mutate((s) => { for (const r of s.outbox) if (r.user_id === userId && r.status === "retry") r.next_attempt_at = 0; });

export async function applyPull(changes: { entity: string; id: string; data: any }[]) {
  await mutate((s) => {
    for (const c of changes) {
      if (c.entity === "product") {
        const p = c.data; const ex = s.products.find((x) => x.id === p.id);
        const row: WebProduct = { id: p.id, code: p.code, barcode: p.barcode ?? null, name: p.name, category: p.category ?? null, unit: p.unit, selling_price: p.sellingPrice, low_threshold: p.lowStockThreshold, on_hand: p.onHand, active: p.active ? 1 : 0, pending_delta: ex?.pending_delta ?? 0 };
        if (ex) Object.assign(ex, row); else s.products.push(row);
      }
      if (c.entity === "supplier") {
        const ex = s.suppliers.find((x) => x.id === c.data.id);
        if (ex) { ex.name = c.data.name; ex.phone = c.data.phone ?? null; } else s.suppliers.push({ id: c.data.id, name: c.data.name, phone: c.data.phone ?? null });
      }
    }
  });
}

export const listProducts = async (q = "") => {
  const needle = q.trim().toLowerCase();
  return (await readState()).products
    .filter((p) => p.active === 1 && (p.name.toLowerCase().includes(needle) || (p.code ?? "").toLowerCase().includes(needle) || (p.barcode ?? "").toLowerCase().includes(needle)))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 300);
};

export const listSuppliers = async () =>
  (await readState()).suppliers.map((s) => ({ id: s.id, name: s.name })).sort((a, b) => a.name.localeCompare(b.name));
