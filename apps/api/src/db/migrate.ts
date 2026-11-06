import "../env";
import { Pool, type PoolClient } from "pg";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Applies migrations/*.sql in name order, each in its own transaction.
 *
 * Two callers share this one function: `npm run migrate` (manual, run from apps/api) and the API's
 * own bootstrap (automatic, see main.ts). That is deliberate — a deploy used to be able to ship
 * code that reads a column the database did not have yet, and the first write afterwards failed
 * with an opaque 500. Now the process applies pending files BEFORE it opens the port, and refuses
 * to start if one fails, so Render keeps the previous healthy instance instead of serving a broken
 * one. Set AUTO_MIGRATE=false to manage migrations entirely out of band.
 *
 * Concurrency: every runner — including two instances waking at the same moment on a free plan —
 * takes the same PostgreSQL advisory lock first, so a file is applied once and the second process
 * simply finds nothing pending.
 *
 * Connection: prefer DIRECT_URL (Neon's direct, non-pooling endpoint) when it is set — migrations
 * open short-lived connections and transactions, which behave most predictably outside a pooler.
 * Runtime traffic keeps using the pooled DATABASE_URL.
 */
const LOCK_ID = 7_316_204;

/** True from both src/db (tsx) and dist/db (compiled): apps/api/migrations either way. */
export const migrationsDir = () => join(__dirname, "..", "..", "migrations");

export type MigrationRun = { applied: string[]; failure?: { file: string; error: unknown } };

/** Files present on disk but not recorded in schema_migrations, in apply order. */
async function pending(c: PoolClient, dir: string): Promise<string[]> {
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const { rows } = await c.query<{ name: string }>("SELECT name FROM schema_migrations");
  const done = new Set(rows.map((r) => r.name));
  return files.filter((f) => !done.has(f));
}

export async function runMigrations(url: string, dir = migrationsDir()): Promise<MigrationRun> {
  const pool = new Pool({ connectionString: url, max: 1 });
  const c = await pool.connect();
  const applied: string[] = [];
  try {
    await c.query("SELECT pg_advisory_lock($1)", [LOCK_ID]);
    await c.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())");
    for (const f of await pending(c, dir)) {
      try {
        await c.query("BEGIN");
        await c.query(readFileSync(join(dir, f), "utf8"));
        await c.query("INSERT INTO schema_migrations(name) VALUES ($1)", [f]);
        await c.query("COMMIT");
        applied.push(f);
      } catch (error) {
        await c.query("ROLLBACK").catch(() => undefined);
        return { applied, failure: { file: f, error } };
      }
    }
    return { applied };
  } finally {
    await c.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]).catch(() => undefined);
    c.release();
    await pool.end();
  }
}

// CLI: `npm run migrate` from apps/api. Prints one line per applied file and exits non-zero on the
// first failure, leaving every later file untouched (never a half-migrated schema).
if (require.main === module) {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL (or DIRECT_URL) is required");
    process.exitCode = 1;
  } else {
    runMigrations(url)
      .then(({ applied, failure }) => {
        for (const f of applied) console.log("applied", f);
        if (failure) {
          console.error("FAILED", failure.file, failure.error);
          process.exitCode = 1;
        }
      })
      .catch((e) => {
        console.error("FAILED", e);
        process.exitCode = 1;
      });
  }
}
