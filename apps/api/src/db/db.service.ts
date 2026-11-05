import { types } from "pg";
types.setTypeParser(20, (v) => Number(v)); // BIGINT -> number (RWF and milli-units stay far below 2^53)
import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { Pool, PoolClient } from "pg";

/**
 * A Neon/Render connection can be dropped while idle (pooler restart, instance wake-up). Those are
 * transient: one retry on a fresh pool connection succeeds, where before the caller saw a 500 on a
 * perfectly healthy database. Only read-only statements are retried, so a write is never replayed.
 */
const TRANSIENT = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|Connection terminated|terminating connection|timeout exceeded when trying to connect|Client has encountered a connection error/i;
const TRANSIENT_CODES = new Set(["57P01", "57P02", "57P03", "08000", "08001", "08003", "08004", "08006", "53300"]);
const isTransient = (e: unknown) => {
  const err = e as { code?: string; message?: string };
  return !!err && (TRANSIENT_CODES.has(String(err.code ?? "")) || TRANSIENT.test(String(err.message ?? "")));
};
const isReadOnly = (sql: string) => /^\s*(select|with)\b/i.test(sql);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

@Injectable()
export class Db implements OnModuleDestroy {
  readonly pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
  async query<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
    try {
      return (await this.pool.query(text, params)).rows as T[];
    } catch (e) {
      if (!isReadOnly(text) || !isTransient(e)) throw e;
      await sleep(120);
      console.warn(JSON.stringify({ t: new Date().toISOString(), evt: "db.retry", code: (e as any)?.code ?? null }));
      return (await this.pool.query(text, params)).rows as T[];
    }
  }
  /** Run fn inside one transaction (ledger + financial rows commit or roll back together). */
  async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try { await c.query("BEGIN"); const r = await fn(c); await c.query("COMMIT"); return r; }
    catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
  }
  onModuleDestroy() { return this.pool.end(); }
}
