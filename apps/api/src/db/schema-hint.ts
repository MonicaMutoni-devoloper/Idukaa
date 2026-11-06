import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Best-effort link between PostgreSQL's "does not exist" error and the migration file that creates
 * the object. It turns a schema-drift 503 from `column "purchase_unit" of relation "products"` into
 * "apply 004_unit_conversion.sql" — the value an operator actually needs.
 *
 * Derived from the migration SQL itself (CREATE TABLE / ALTER TABLE ... ADD COLUMN) rather than a
 * hand-kept table, so a new migration is understood the moment it lands. Read once per process and
 * cached; every failure path returns null instead of throwing, because this runs inside the error
 * filter and must never turn one failure into another.
 */
/** PostgreSQL error codes that mean the database is behind the code, not that the request was wrong. */
export const SCHEMA_ERROR_CODES = new Set(["42703", "42P01", "42883", "42702"]);

let cache: Map<string, string> | null = null;

/** src/db (tsx) and dist/db (compiled) both resolve to apps/api/migrations. */
const dir = () => join(__dirname, "..", "..", "migrations");

const CREATE_TABLE = /CREATE TABLE (?:IF NOT EXISTS )?"?(\w+)"?\s*\(([\s\S]*?)\)\s*;/gi;
const ADD_COLUMN = /ALTER TABLE (?:IF EXISTS )?"?(\w+)"?\s+ADD COLUMN (?:IF NOT EXISTS )?"?(\w+)"?/gi;
// `name type` pairs inside a CREATE TABLE body. Only used to answer "which migration creates this
// column"; a stray CHECK/UNIQUE never collides with a real table.column key.
const COLUMN_DEF = /(\w+)\s+(?:uuid|text|bigint|int|integer|smallint|boolean|char|varchar|numeric|real|double precision|jsonb|json|timestamptz|timestamp|date|serial|bigserial|bytea)\b/gi;

function index(): Map<string, string> | null {
  if (cache) return cache;
  try {
    const map = new Map<string, string>();
    for (const file of readdirSync(dir()).filter((f) => f.endsWith(".sql")).sort()) {
      const sql = readFileSync(join(dir(), file), "utf8");
      // First file to create an object wins: that is the migration an operator must apply.
      for (const m of sql.matchAll(CREATE_TABLE)) {
        const table = m[1]!;
        if (!map.has(table)) map.set(table, file);
        for (const col of (m[2] ?? "").matchAll(COLUMN_DEF)) map.set(`${table}.${col[1]}`, map.get(`${table}.${col[1]}`) ?? file);
      }
      for (const m of sql.matchAll(ADD_COLUMN)) if (!map.has(`${m[1]}.${m[2]}`)) map.set(`${m[1]}.${m[2]}`, file);
    }
    cache = map;
    return map;
  } catch {
    return null;
  }
}

/** Migration file that would create the missing object, or null when it cannot be identified. */
export function migrationHint(message: string): string | null {
  const map = index();
  if (!map) return null;
  const column = /column "([^"]+)" of relation "([^"]+)"/.exec(message);
  if (column) return map.get(`${column[2]}.${column[1]}`) ?? null;
  const relation = /(?:relation|table|sequence|type) "([^"]+)"/.exec(message);
  return relation ? map.get(relation[1]!) ?? null : null;
}
