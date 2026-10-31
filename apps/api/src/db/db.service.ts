import { types } from "pg";
types.setTypeParser(20, (v) => Number(v)); // BIGINT -> number (RWF and milli-units stay far below 2^53)
import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { Pool, PoolClient } from "pg";

@Injectable()
export class Db implements OnModuleDestroy {
  readonly pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
  query<T = any>(text: string, params: unknown[] = []) { return this.pool.query(text, params).then(r => r.rows as T[]); }
  /** Run fn inside one transaction (ledger + financial rows commit or roll back together). */
  async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try { await c.query("BEGIN"); const r = await fn(c); await c.query("COMMIT"); return r; }
    catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
  }
  onModuleDestroy() { return this.pool.end(); }
}
