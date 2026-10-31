// Removes the automated-test sales ("UI Test Rice *", "E2E Product", "Idem Product" only) from the
// dev database so net sales shows only real + demo sales.
//
// The stock ledger is append-only (DELETE trigger), so history is never erased — it is COMPENSATED:
//   - posted test sale  -> a sale_return is appended at sold_at + 1s, exactly reversing the sale's
//     stock and COGS effect at that point in the replay;
//   - reversed (voided) test sale -> the void already posted its sale_return (source_id = sale id),
//     so no compensation is added (never double-return);
// then sale_lines, the sale row and its operation row are deleted (these tables are not
// append-only), and an audit_log entry records the cleanup (audit_log only allows INSERT).
// Usage: node scripts/clean-test-sales.mjs [--dry]
import { readFileSync } from "node:fs";
import pg from "pg";

const DRY = process.argv.includes("--dry");
const TEST_PRODUCT = `(p.name LIKE 'UI Test Rice %' OR p.name IN ('E2E Product','Idem Product'))`;

const line = readFileSync("apps/api/.env", "utf8").match(/^DATABASE_URL=(.*)$/m)[1].replace(/\r/g, "").trim();
const u = new URL(line);
const db = new pg.Client({ host: u.hostname, port: +u.port || 5432, user: u.username, password: u.password, database: u.pathname.slice(1) });
await db.connect();

const shop = (await db.query(`SELECT id FROM shops WHERE name = 'Demo Shop (dev only)'`)).rows[0];
const actor = (await db.query(`SELECT id FROM users WHERE email='owner@demo.local'`)).rows[0];

const targets = await db.query(`
  SELECT s.id, s.op_id, s.status, s.sold_at, s.gross_amount
  FROM sales s
  WHERE EXISTS (SELECT 1 FROM sale_lines sl JOIN products p ON p.id=sl.product_id WHERE sl.sale_id=s.id AND ${TEST_PRODUCT})
    AND NOT EXISTS (SELECT 1 FROM sale_lines sl JOIN products p ON p.id=sl.product_id WHERE sl.sale_id=s.id
                    AND NOT (${TEST_PRODUCT}))
  ORDER BY s.sold_at`);

console.log(`test-only sales found: ${targets.rowCount}`);
const byDay = {};
for (const s of targets.rows) {
  const day = s.sold_at.toISOString().slice(0, 10);
  byDay[day] = (byDay[day] ?? 0) + 1;
}
console.log("by day:", JSON.stringify(byDay));

let compensated = 0, alreadyReturned = 0, removed = 0;

for (const s of targets.rows) {
  const { rows: lines } = await db.query(`SELECT product_id, qty FROM sale_lines WHERE sale_id=$1`, [s.id]);
  if (s.status === "posted") {
    const { rows: existing } = await db.query(
      `SELECT 1 FROM stock_movements WHERE source_id=$1 AND type='sale_return' LIMIT 1`, [s.id]);
    if (existing.length) { alreadyReturned++; }
    else if (!DRY) {
      const at = new Date(new Date(s.sold_at).getTime() + 1000).toISOString(); // right after the sale: exact reversal
      for (const l of lines) {
        await db.query(
          `INSERT INTO stock_movements(shop_id,product_id,type,qty,unit_cost,source_type,source_id,user_id,reason,occurred_at)
           VALUES ($1,$2,'sale_return',$3,NULL,'sale_void',$4,$5,$6,$7)`,
          [shop.id, l.product_id, l.qty, s.id, actor.id, "removed test data (automated e2e run)", at]);
      }
      compensated++;
    }
  } else {
    alreadyReturned++; // void already posted its sale_return
  }
  if (!DRY) {
    await db.query(`DELETE FROM sale_lines WHERE sale_id=$1`, [s.id]);
    await db.query(`DELETE FROM sales WHERE id=$1`, [s.id]);
    if (s.op_id) await db.query(`DELETE FROM operations WHERE op_id=$1`, [s.op_id]);
    await db.query(
      `INSERT INTO audit_log(shop_id,actor_id,action,entity,entity_id,old_value,reason)
       VALUES ($1,$2,'data.cleanup','sale',$3,$4,'automated test data removed from dev database')`,
      [shop.id, actor.id, s.id, JSON.stringify({ soldAt: s.sold_at, grossAmount: Number(s.gross_amount), status: s.status })]);
  }
  removed++;
}
console.log(`${DRY ? "[dry] " : ""}compensated (posted): ${compensated}, already reversed by void: ${alreadyReturned}, sales removed: ${removed}`);

// ---- verification ----
const after = await db.query(`
  SELECT count(*)::int n FROM sales s
  WHERE EXISTS (SELECT 1 FROM sale_lines sl JOIN products p ON p.id=sl.product_id WHERE sl.sale_id=s.id AND ${TEST_PRODUCT})
    AND NOT EXISTS (SELECT 1 FROM sale_lines sl JOIN products p ON p.id=sl.product_id WHERE sl.sale_id=s.id
                    AND NOT (${TEST_PRODUCT}))`);
console.log("test-only sales remaining:", after.rows[0].n);

const orphans = await db.query(
  `SELECT (SELECT count(*)::int FROM sale_lines sl LEFT JOIN sales s ON s.id=sl.sale_id WHERE s.id IS NULL) AS orphan_lines,
          (SELECT count(*)::int FROM sales s LEFT JOIN operations o ON o.op_id=s.op_id WHERE o.op_id IS NULL) AS missing_ops`);
console.log("orphan sale_lines:", orphans.rows[0].orphan_lines, "| sales without operation:", orphans.rows[0].missing_ops);

const neg = await db.query(
  `SELECT count(*)::int n FROM (SELECT product_id, sum(qty) q FROM stock_movements WHERE shop_id=$1 GROUP BY 1 HAVING sum(qty) < 0) x`, [shop.id]);
console.log("products with negative stock:", neg.rows[0].n);

const byDay2 = await db.query(
  `SELECT to_char(sold_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS sale_day, count(*)::int n, sum(gross_amount)::int gross
   FROM sales WHERE shop_id=$1 AND sold_at >= now() - interval '14 days' GROUP BY 1 ORDER BY 1`, [shop.id]);
console.log("sales in the last 14 days (must be demo only):");
for (const r of byDay2.rows) console.log(`  ${r.sale_day} | ${r.n} sales | ${r.gross} RWF`);

await db.end();
