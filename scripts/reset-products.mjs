// One-off cleanup for the dev shop "Demo Shop (dev only)":
//   1. Deactivates the test clutter (UI Test Rice *, E2E Product, Idem Product). Deactivate only:
//      stock_movements is append-only (DELETE trigger), so history must stay; the app filters
//      active=1 so they vanish from Stock/Sell/Reports. Reversible with active=true.
//   2. Tops the shop up to exactly 50 active products with distinct names and opening stock.
// Idempotent: keyed on product code; never touches existing active products.
// Usage: node scripts/reset-products.mjs [--dry]
import { readFileSync } from "node:fs";
import pg from "pg";

const DRY = process.argv.includes("--dry");
const line = readFileSync("apps/api/.env", "utf8").match(/^DATABASE_URL=(.*)$/m)[1].replace(/\r/g, "").trim();
const u = new URL(line);
const db = new pg.Client({ host: u.hostname, port: +u.port || 5432, user: u.username, password: u.password, database: u.pathname.slice(1) });
await db.connect();

const shop = (await db.query(`SELECT id FROM shops WHERE name = 'Demo Shop (dev only)'`)).rows[0];
if (!shop) throw new Error("Demo Shop (dev only) not found");
const owner = (await db.query(`SELECT id FROM users WHERE email = 'owner@demo.local'`)).rows[0];
if (!owner) throw new Error("owner@demo.local not found");

// name, code, category, unit, selling price (RWF), low threshold, opening qty, unit cost (Rwf)
const CATALOG = [
  ["Maize Flour 25kg", "MFL-25K", "Groceries", "bag", 18000, 5, 15, 14000],
  ["Rice 25kg", "RIC-25K", "Groceries", "bag", 45000, 4, 10, 36000],
  ["Sugar 1kg", "SUG-1K", "Groceries", "pcs", 1500, 10, 40, 1200],
  ["Cooking Oil 5L", "OIL-5L", "Groceries", "bottle", 12000, 6, 24, 9500],
  ["Red Beans 1kg", "BEA-1K", "Groceries", "kg", 1200, 10, 50, 900],
  ["Lentils 1kg", "LEN-1K", "Groceries", "kg", 1100, 10, 40, 850],
  ["Sorghum Flour 1kg", "SOR-1K", "Groceries", "kg", 900, 10, 40, 700],
  ["Cassava Flour 1kg", "CAS-1K", "Groceries", "kg", 1000, 10, 40, 750],
  ["Wheat Flour 1kg", "WHE-1K", "Groceries", "kg", 1300, 10, 50, 1000],
  ["Iodized Salt 500g", "SAL-500", "Groceries", "pcs", 400, 20, 60, 250],
  ["Tea Leaves 500g", "TEA-500", "Groceries", "pcs", 3500, 8, 30, 2700],
  ["Milk Powder 500g", "MPW-500", "Groceries", "pcs", 5500, 8, 30, 4300],
  ["Spaghetti 500g", "SPA-500", "Groceries", "pcs", 1200, 15, 60, 900],
  ["Canned Beans 400g", "CBN-400", "Groceries", "pcs", 1800, 12, 48, 1400],
  ["Peanut Butter 500g", "PNB-500", "Groceries", "pcs", 4000, 6, 24, 3100],
  ["Honey 500g", "HON-500", "Groceries", "jar", 6000, 5, 20, 4700],
  ["Cocoa Powder 250g", "COC-250", "Groceries", "pcs", 3000, 8, 30, 2300],
  ["Biscuit Pack", "BIS-PK", "Groceries", "pack", 800, 20, 80, 600],
  ["Bread Loaf", "BRD-LF", "Groceries", "loaf", 700, 10, 40, 500],
  ["Rice Cakes 200g", "RCK-200", "Groceries", "pcs", 900, 12, 50, 700],
  ["Drinking Water 1.5L", "WTR-15", "Beverages", "bottle", 700, 24, 96, 500],
  ["Soda 500ml", "SOD-500", "Beverages", "bottle", 800, 24, 72, 600],
  ["Fruit Juice 1L", "JUI-1L", "Beverages", "carton", 2500, 10, 40, 1900],
  ["Energy Drink 250ml", "ENR-250", "Beverages", "can", 1000, 15, 60, 750],
  ["Malt Drink 300ml", "MAL-300", "Beverages", "bottle", 900, 15, 60, 700],
  ["Bar Soap 800g", "SAP-800", "Household", "pcs", 2500, 10, 40, 1900],
  ["Laundry Powder 1kg", "LND-1K", "Household", "bag", 3000, 8, 30, 2300],
  ["Dish Soap 500ml", "DIS-500", "Household", "bottle", 1800, 12, 48, 1350],
  ["Bleach 1L", "BLT-1L", "Household", "bottle", 1500, 10, 40, 1100],
  ["Toothpaste 100ml", "TCP-100", "Personal Care", "tube", 2200, 10, 36, 1700],
  ["Toothbrush", "TOB-01", "Personal Care", "pcs", 1000, 15, 60, 700],
  ["Shampoo 400ml", "SHM-400", "Personal Care", "bottle", 5000, 6, 24, 3800],
  ["Body Lotion 400ml", "LOT-400", "Personal Care", "bottle", 4500, 6, 24, 3400],
  ["Toilet Paper 4-pack", "TPP-4P", "Household", "pack", 3000, 10, 40, 2300],
  ["Detergent Bar", "DTR-BR", "Household", "pcs", 1200, 15, 60, 900],
  ["Sanitary Pads 8-pack", "SPD-8P", "Personal Care", "pack", 2500, 10, 40, 1900],
  ["Razor Blades 5-pack", "RZR-5P", "Personal Care", "pack", 1500, 12, 50, 1100],
  ["Hand Sanitizer 250ml", "SAN-250", "Personal Care", "bottle", 2000, 8, 30, 1500],
  ["LED Bulb 9W", "LED-9W", "Electrical", "pcs", 2500, 10, 40, 1800],
  ["Batteries AA 4-pack", "BAT-4P", "Electrical", "pack", 2500, 9, 36, 1800],
  ["Phone Charger", "CHG-01", "Electrical", "pcs", 3500, 8, 30, 2500],
  ["Exercise Book 200pg", "EXB-200", "Stationery", "pcs", 800, 20, 100, 600],
  ["Ballpoint Pen", "PEN-01", "Stationery", "pcs", 200, 50, 200, 120],
  ["A4 Paper Ream", "A4M-01", "Stationery", "ream", 6000, 5, 20, 4800],
  ["Matchbox", "MTC-01", "Household", "box", 200, 30, 120, 130],
  ["Candle Pack", "CND-PK", "Household", "pack", 1500, 10, 40, 1100],
  ["Plastic Basin 20L", "BSN-20L", "Kitchen", "pcs", 2500, 8, 30, 1900],
  ["Cooking Pot 3L", "POT-3L", "Kitchen", "pcs", 12000, 4, 16, 9500],
  ["Frying Pan 26cm", "PAN-26C", "Kitchen", "pcs", 7000, 5, 20, 5500],
];

const target = 50;

// --- 1. deactivate the test clutter -------------------
const junk = await db.query(
  `UPDATE products SET active = false, updated_at = now()
   WHERE shop_id = $1 AND active AND (name LIKE 'UI Test Rice %' OR name IN ('E2E Product', 'Idem Product'))
   RETURNING name`,
  [shop.id],
);
console.log(`deactivated test products: ${junk.rowCount}`);

// --- 2. top up to the target count --------------------
const active = async () => (await db.query(`SELECT count(*)::int n FROM products WHERE shop_id=$1 AND active`, [shop.id])).rows[0].n;
let have = await active();
console.log(`active products now: ${have}`);

const missing = CATALOG.filter(([, code]) => code !== "skol").length; // keyed insert below
if (!DRY) {
  for (const [name, code, category, unit, price, low, qty, cost] of CATALOG) {
    const cur = (await db.query(`SELECT id, active FROM products WHERE shop_id=$1 AND code=$2`, [shop.id, code])).rows[0];
    if (cur) continue;
    const id = (await db.query(`SELECT gen_random_uuid() id`)).rows[0].id;
    await db.query(
      `INSERT INTO products(id,shop_id,code,name,category,unit,selling_price,low_stock_threshold,active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true)`,
      [id, shop.id, code, name, category, unit, price, low],
    );
    await db.query(
      `INSERT INTO stock_movements(shop_id,product_id,type,qty,unit_cost,source_type,source_id,user_id,reason,occurred_at)
       VALUES ($1,$2,'opening',$3,$4,'product',$2,$5,'opening stock', now())`,
      [shop.id, id, qty, cost, owner.id],
    );
    console.log(`  + ${name} (${code}) opening ${qty}`);
  }
}

have = await active();
console.log(`active products final: ${have} (target ${target})`);

const list = await db.query(
  `SELECT p.name, p.code, p.unit, p.selling_price,
     COALESCE((SELECT sum(m.qty) FROM stock_movements m WHERE m.product_id=p.id),0)::int AS on_hand
   FROM products p WHERE p.shop_id=$1 AND p.active ORDER BY p.name`,
  [shop.id],
);
console.log(`\nACTIVE PRODUCTS (${list.rowCount}):`);
for (const r of list.rows) console.log(`  ${r.name} | ${r.code} | ${r.on_hand} ${r.unit} | ${r.selling_price} RWF`);

await db.end();
