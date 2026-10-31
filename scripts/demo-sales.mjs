// Demo data for the dev shop "Demo Shop (dev only)":
//   1. Repairs quantities to the system's milli-unit scale (x1000): corrects low-stock thresholds
//      and appends the missing part of each product's opening stock (the ledger is append-only, so
//      corrections are posted as further 'opening' movements, never UPDATEd).
//   2. Creates realistic sales on each of the last 14 days INCLUDING TODAY through the real
//      /sync/push path as the manager role, using each product's real selling price and opening
//      cost, so profit reports (gross margin, COGS, profitability) measure real money.
// Idempotent: operation ids are derived deterministically, a re-run reports "duplicate" not new rows.
// Usage: node scripts/demo-sales.mjs
import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";

const API = process.env.API_URL ?? "http://localhost:3000";
const EMAIL = "manager@demo.local";
const PASSWORD = process.env.DEMO_PASSWORD ?? "dev-password-2026";
const DAYS = 14;

// code, unit cost (RWF), opening qty (units), low-stock threshold (units) — same catalog as reset-products
const CATALOG = {
  "MFL-25K": [14000, 15, 5], "RIC-25K": [36000, 10, 4], "SUG-1K": [1200, 40, 10], "OIL-5L": [9500, 24, 6],
  "BEA-1K": [900, 50, 10], "LEN-1K": [850, 40, 10], "SOR-1K": [700, 40, 10], "CAS-1K": [750, 40, 10],
  "WHE-1K": [1000, 50, 10], "SAL-500": [250, 60, 20], "TEA-500": [2700, 30, 8], "MPW-500": [4300, 30, 8],
  "SPA-500": [900, 60, 15], "CBN-400": [1400, 48, 12], "PNB-500": [3100, 24, 6], "HON-500": [4700, 20, 5],
  "COC-250": [2300, 30, 8], "BIS-PK": [600, 80, 20], "BRD-LF": [500, 40, 10], "RCK-200": [700, 50, 12],
  "WTR-15": [500, 96, 24], "SOD-500": [600, 72, 24], "JUI-1L": [1900, 40, 10], "ENR-250": [750, 60, 15],
  "MAL-300": [700, 60, 15], "SAP-800": [1900, 40, 10], "LND-1K": [2300, 30, 8], "DIS-500": [1350, 48, 12],
  "BLT-1L": [1100, 40, 10], "TCP-100": [1700, 36, 10], "TOB-01": [700, 60, 15], "SHM-400": [3800, 24, 6],
  "LOT-400": [3400, 24, 6], "TPP-4P": [2300, 40, 10], "DTR-BR": [900, 60, 15], "SPD-8P": [1900, 40, 10],
  "RZR-5P": [1100, 50, 12], "SAN-250": [1500, 30, 8], "LED-9W": [1800, 40, 10], "BAT-4P": [1800, 36, 9],
  "CHG-01": [2500, 30, 8], "EXB-200": [600, 100, 20], "PEN-01": [120, 200, 50], "A4M-01": [4800, 20, 5],
  "MTC-01": [130, 120, 30], "CND-PK": [1100, 40, 10], "BSN-20L": [1900, 30, 8], "POT-3L": [9500, 16, 4],
  "PAN-26C": [5500, 20, 5],
};

const line = readFileSync("apps/api/.env", "utf8").match(/^DATABASE_URL=(.*)$/m)[1].replace(/\r/g, "").trim();
const u = new URL(line);
const db = new pg.Client({ host: u.hostname, port: +u.port || 5432, user: u.username, password: u.password, database: u.pathname.slice(1) });
await db.connect();

const shop = (await db.query(`SELECT id FROM shops WHERE name = 'Demo Shop (dev only)'`)).rows[0];
if (!shop) throw new Error("Demo Shop (dev only) not found");
const manager = (await db.query(`SELECT id FROM users WHERE email = $1`, [EMAIL])).rows[0];
if (!manager) throw new Error(EMAIL + " not found");

// ---- 1. repair milli-unit scale ------------------------------------------
console.log("== repairing milli-unit scale ==");
for (const [code, [cost, qtyUnits, lowUnits]] of Object.entries(CATALOG)) {
  const { rows: [p] } = await db.query(`SELECT id, low_stock_threshold FROM products WHERE shop_id=$1 AND code=$2`, [shop.id, code]);
  if (!p) continue;
  if (Number(p.low_stock_threshold) !== lowUnits * 1000) {
    await db.query(`UPDATE products SET low_stock_threshold=$2, updated_at=now() WHERE id=$1`, [p.id, lowUnits * 1000]);
  }
  const { rows: [{ n }] } = await db.query(
    `SELECT COALESCE(sum(qty),0)::int n FROM stock_movements WHERE product_id=$1 AND type='opening'`, [p.id]);
  const target = qtyUnits * 1000;
  if (n < target) {
    await db.query(
      `INSERT INTO stock_movements(shop_id,product_id,type,qty,unit_cost,source_type,source_id,user_id,reason,occurred_at)
       VALUES ($1,$2,'opening',$3,$4,'product',$2,$5,'opening stock', now())`,
      [shop.id, p.id, target - n, cost, manager.id]);
    console.log(`  ${code}: opening ${n} -> ${target} milli`);
  }
}

// ---- 1b. backdate the cost basis -----------------------------------------
// Sales are backdated, so the opening value must exist BEFORE them for the moving-average
// replay to compute COGS. The ledger is append-only, so per product we append a full opening at
// T0 (before every sale) and an equal-and-opposite supplier_return right after the latest
// movement: on-hand is unchanged, but value/COGS land in the right periods. supplier_return is
// excluded from stock-loss value by the valuation policy, so no phantom losses are reported.
console.log("== backdating cost basis ==");
const T0 = "2026-09-01T00:00:00.000Z";
const MARK_A = "cost basis backdated";
const MARK_B = "cost basis correction";
const afterAll = new Date(Date.now() + 30_000).toISOString();
for (const [code, [cost, qtyUnits]] of Object.entries(CATALOG)) {
  const { rows: [p] } = await db.query(`SELECT id FROM products WHERE shop_id=$1 AND code=$2`, [shop.id, code]);
  if (!p) continue;
  const target = qtyUnits * 1000;
  const has = async (m) => (await db.query(`SELECT 1 FROM stock_movements WHERE product_id=$1 AND reason=$2 LIMIT 1`, [p.id, m])).rows.length > 0;
  if (!(await has(MARK_A))) await db.query(
    `INSERT INTO stock_movements(shop_id,product_id,type,qty,unit_cost,source_type,source_id,user_id,reason,occurred_at)
     VALUES ($1,$2,'opening',$3,$4,'product',$2,$5,$6,$7)`,
    [shop.id, p.id, target, cost, manager.id, MARK_A, T0]);
  if (!(await has(MARK_B))) await db.query(
    `INSERT INTO stock_movements(shop_id,product_id,type,qty,unit_cost,source_type,source_id,user_id,reason,occurred_at)
     VALUES ($1,$2,'supplier_return',$3,NULL,'product',$2,$4,$5,$6)`,
    [shop.id, p.id, -target, manager.id, MARK_B, afterAll]);
}
console.log(`cost basis backdated for ${Object.keys(CATALOG).length} products (opening at ${T0})`);

// ---- 2. demo sales --------------------------------------------------------
console.log("== planning demo sales ==");
const { rows: products } = await db.query(
  `SELECT p.id, p.code, p.name, p.unit, p.selling_price,
     COALESCE((SELECT sum(m.qty) FROM stock_movements m WHERE m.product_id=p.id),0)::bigint AS on_hand
   FROM products p WHERE p.shop_id=$1 AND p.active ORDER BY p.code`, [shop.id]);

// budget: never sell more than 40% of current stock, so everything stays well in stock
const budget = new Map(products.map((p) => [p.id, Math.floor((Number(p.on_hand) * 0.4) / 1000) * 1000]));

let seed = 20261029;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

const uuidFrom = (ns, key) => { // deterministic uuid so a re-run is a no-op (duplicate op)
  const h = createHash("sha1").update(ns + key).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

const now = new Date();
const kigaliToday = new Date(now.getTime() + 2 * 3600_000); // Africa/Kigali = UTC+2
const methods = ["cash", "momo", "cash", "bank", "cash"];
const ops = [];
const perDay = new Map();

for (let d = DAYS - 1; d >= 0; d--) {
  const day = new Date(Date.UTC(kigaliToday.getUTCFullYear(), kigaliToday.getUTCMonth(), kigaliToday.getUTCDate() - d));
  const salesToday = 2 + (d % 2 === 0 ? 1 : 0); // 2–3 sales per day
  for (let s = 0; s < salesToday; s++) {
    const key = `${day.toISOString().slice(0, 10)}#${s}`;
    const saleId = uuidFrom("sale:", key);
    const lines = [];
    const lineCount = 1 + Math.floor(rnd() * 3);
    for (let l = 0; l < lineCount; l++) {
      const usable = products.filter((p) => (budget.get(p.id) ?? 0) >= 1000);
      if (!usable.length) break;
      const p = pick(usable);
      const units = 1 + Math.floor(rnd() * 3); // 1–3 units
      const qtyMilli = Math.min(units * 1000, budget.get(p.id));
      budget.set(p.id, budget.get(p.id) - qtyMilli);
      lines.push({ productId: p.id, qty: qtyMilli, unitPrice: Number(p.selling_price) });
    }
    if (!lines.length) continue;
    const gross = lines.reduce((a, l) => a + Math.round((l.qty * l.unitPrice) / 1000), 0);
    // daytime in Kigali (UTC hour 8..16 -> local 10..18); today's sales are clamped into the past
    let soldAt = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 8 + Math.floor(rnd() * 8), Math.floor(rnd() * 60)));
    if (d === 0) {
      const latest = now.getTime() - 45 * 60_000;
      if (soldAt.getTime() > latest) soldAt = new Date(latest - Math.floor(rnd() * 120) * 60_000);
    }
    ops.push({
      opId: uuidFrom("op:", key), deviceId: "demo-sales-script", createdAt: new Date().toISOString(),
      type: "sale.create",
      payload: { saleId, soldAt: soldAt.toISOString(), discount: 0, amountPaid: gross,
        paymentMethod: methods[Math.floor(rnd() * methods.length)], lines },
    });
    const dayKey = day.toISOString().slice(0, 10);
    const agg = perDay.get(dayKey) ?? { sales: 0, gross: 0 };
    agg.sales += 1; agg.gross += gross; perDay.set(dayKey, agg);
  }
}

// ---- 3. push through the real API ----------------------------------------
console.log(`== pushing ${ops.length} sale operations to ${API} ==`);
const login = await fetch(`${API}/auth/login`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
if (!login.ok) throw new Error(`login failed: ${login.status} ${await login.text()}`);
const { token } = await login.json();

let applied = 0, duplicate = 0, failed = 0;
for (let i = 0; i < ops.length; i += 50) {
  const chunk = ops.slice(i, i + 50);
  const r = await fetch(`${API}/sync/push`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ operations: chunk }),
  });
  if (!r.ok) throw new Error(`push failed: ${r.status} ${await r.text()}`);
  const { results } = await r.json();
  for (const res of results) {
    if (res.status === "applied") applied++;
    else if (res.status === "duplicate") duplicate++;
    else { failed++; console.log(`  ! ${res.status}: ${res.message}`); }
  }
}
console.log(`applied: ${applied}, duplicate (already there): ${duplicate}, failed: ${failed}`);

// ---- 4. verification ------------------------------------------------------
console.log("\n== sales by day (dev DB) ==");
const byDay = await db.query(
  `SELECT to_char(sold_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, count(*)::int sales, sum(gross_amount)::int gross
   FROM sales WHERE shop_id=$1 AND sold_at >= now() - interval '${DAYS} days'
   GROUP BY 1 ORDER BY 1`, [shop.id]);
for (const r of byDay.rows) console.log(`  ${r.day} | ${r.sales} sales | ${r.gross} RWF`);

const neg = await db.query(
  `SELECT count(*)::int n FROM (SELECT product_id, sum(qty) q FROM stock_movements WHERE shop_id=$1 GROUP BY 1 HAVING sum(qty) < 0) x`, [shop.id]);
console.log(`products with negative stock: ${neg.rows[0].n}`);

const active = await db.query(`SELECT count(*)::int n FROM products WHERE shop_id=$1 AND active`, [shop.id]);
console.log(`active products: ${active.rows[0].n}`);

await db.end();
