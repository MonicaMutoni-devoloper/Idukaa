import "../env";
import { Pool } from "pg";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Run from apps/api (npm run migrate). Applies migrations/*.sql in name order, each in its own transaction.
// Connection: prefer DIRECT_URL (Neon's direct, non-pooling endpoint) when it is set — migrations open
// short-lived connections and transactions, which behave most predictably outside a transaction pooler.
// Runtime traffic keeps using the pooled DATABASE_URL.
async function main() {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL (or DIRECT_URL) is required"); process.exitCode = 1; return; }
  const pool = new Pool({ connectionString: url });
  const dir = join(process.cwd(), "migrations");
  await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if ((await pool.query("SELECT 1 FROM schema_migrations WHERE name=$1", [f])).rowCount) continue;
    const c = await pool.connect();
    try { await c.query("BEGIN"); await c.query(readFileSync(join(dir, f), "utf8")); await c.query("INSERT INTO schema_migrations(name) VALUES ($1)", [f]); await c.query("COMMIT"); console.log("applied", f); }
    catch (e) { await c.query("ROLLBACK"); console.error("FAILED", f, e); process.exitCode = 1; return; } finally { c.release(); }
  }
  await pool.end();
}
main();
