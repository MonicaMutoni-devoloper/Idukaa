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

let cache: { byObject: Map<string, string>; byColumn: Map<string, string | null> } | null = null;

/** src/db (tsx) and dist/db (compiled) both resolve to apps/api/migrations. */
const dir = () => join(__dirname, "..", "..", "migrations");

const CREATE_TABLE = /CREATE TABLE (?:IF NOT EXISTS )?"?(\w+)"?\s*\(([\s\S]*?)\)\s*;/gi;
// One statement at a time, then every ADD COLUMN inside it: `ALTER TABLE products ADD COLUMN a text,
// ADD COLUMN b integer` declares two columns, and the second has no second ALTER TABLE in front of it.
const ALTER_TABLE = /ALTER TABLE (?:IF EXISTS )?"?(\w+)"?([\s\S]*?);/gi;
const ADD_COLUMN = /ADD COLUMN (?:IF NOT EXISTS )?"?(\w+)"?/gi;
// `name type` pairs inside a CREATE TABLE body. Only used to answer "which migration creates this
// column"; a stray CHECK/UNIQUE never collides with a real table.column key.
const COLUMN_DEF = /(\w+)\s+(?:uuid|text|bigint|int|integer|smallint|boolean|char|varchar|numeric|real|double precision|jsonb|json|timestamptz|timestamp|date|serial|bigserial|bytea)\b/gi;

function index(): { byObject: Map<string, string>; byColumn: Map<string, string | null> } | null {
  if (cache) return cache;
  try {
    const byObject = new Map<string, string>();
    // column name -> creating migration, or null when two migrations each declare it (ambiguous).
    const byColumn = new Map<string, string | null>();
    const claim = (table: string, column: string, file: string) => {
      const key = `${table}.${column}`;
      if (!byObject.has(key)) byObject.set(key, file);
      if (!byColumn.has(column)) byColumn.set(column, file);
      else if (byColumn.get(column) !== file) byColumn.set(column, null);
    };
    for (const file of readdirSync(dir()).filter((f) => f.endsWith(".sql")).sort()) {
      const sql = readFileSync(join(dir(), file), "utf8");
      // First file to create an object wins: that is the migration an operator must apply.
      for (const m of sql.matchAll(CREATE_TABLE)) {
        const table = m[1]!;
        if (!byObject.has(table)) byObject.set(table, file);
        for (const col of (m[2] ?? "").matchAll(COLUMN_DEF)) claim(table, col[1]!, file);
      }
      for (const m of sql.matchAll(ALTER_TABLE)) {
        for (const col of (m[2] ?? "").matchAll(ADD_COLUMN)) claim(m[1]!, col[1]!, file);
      }
    }
    cache = { byObject, byColumn };
    return cache;
  } catch {
    return null;
  }
}

/** Migration file that would create the missing object, or null when it cannot be identified. */
export function migrationHint(message: string): string | null {
  const idx = index();
  if (!idx) return null;
  const column = /column "([^"]+)" of relation "([^"]+)"/.exec(message);
  // A named relation is authoritative: if it does not declare the column, say nothing rather than
  // pointing at another table's migration.
  if (column) return idx.byObject.get(`${column[2]}.${column[1]}`) ?? null;
  // Some PostgreSQL messages omit the relation (`column "units_per_purchase" does not exist`, e.g.
  // for a derived table or a RETURNING list). A column declared by exactly one migration is still
  // an unambiguous answer; one declared by two is not, and gets no guess.
  const bare = /column "([^"]+)" does not exist/.exec(message);
  if (bare) return idx.byColumn.get(bare[1]!) ?? null;
  const relation = /(?:relation|table|sequence|type) "([^"]+)"/.exec(message);
  return relation ? idx.byObject.get(relation[1]!) ?? null : null;
}
