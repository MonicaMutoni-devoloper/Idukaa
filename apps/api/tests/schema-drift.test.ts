/**
 * A database older than the running build used to surface as an opaque
 * `500 {"error":"internal_error"}`, which is exactly how a missing `004_unit_conversion.sql` in
 * production looked for hours. These tests pin the behaviour that replaced it: a 503 that names the
 * missing object and the migration that creates it, while ordinary failures stay 500s.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Filter } from "../src/common/errors";
import { migrationHint } from "../src/db/schema-hint";

const pgError = (code: string, message: string) => Object.assign(new Error(message), { code });

/** Minimal ArgumentsHost: just enough for the filter's status().json() path. */
function handle(e: unknown) {
  const res = {
    statusCode: 0 as number,
    body: undefined as any,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
  };
  const req = { method: "POST", path: "/sync/push", headers: {}, requestId: "req-test-1" };
  const host = { switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }) } as any;
  new Filter().catch(e, host);
  return res;
}

test("a missing column is a 503 that names the migration to apply", () => {
  const res = handle(pgError("42703", 'column "purchase_unit" of relation "products" does not exist'));
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, "schema_out_of_date");
  assert.equal(res.body.migration, "004_unit_conversion.sql");
  assert.match(res.body.detail, /purchase_unit/);
  assert.equal(res.body.requestId, "req-test-1");
  // The response names schema objects only — never rows, ids or shop data.
  assert.deepEqual(Object.keys(res.body).sort(), ["detail", "error", "migration", "requestId"]);
});

test("a missing table is also a 503, with a null hint when no migration creates it", () => {
  const res = handle(pgError("42P01", 'relation "not_a_real_table" does not exist'));
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, "schema_out_of_date");
  assert.equal(res.body.migration, null);
});

test("every other database failure keeps the opaque 500 and its request id", () => {
  const res = handle(pgError("23514", "new row violates check constraint"));
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error, "internal_error");
  assert.equal(res.body.requestId, "req-test-1");
});

test("the migration hint follows the SQL, including columns added later", () => {
  assert.equal(migrationHint('column "qty_entered" of relation "sale_lines" does not exist'), "004_unit_conversion.sql");
  assert.equal(migrationHint('column "status" of relation "shops" does not exist'), "007_admin_platform.sql");
  // PostgreSQL omits the relation for some statements; a column only one migration declares is
  // still an unambiguous answer. (Seen in production as `units_per_purchase` with no relation.)
  assert.equal(migrationHint('column "units_per_purchase" does not exist'), "004_unit_conversion.sql");
  // A column declared in the original schema points at that migration, not at a later one.
  assert.equal(migrationHint('column "gross_amount" of relation "sales" does not exist'), "001_init.sql");
  assert.equal(migrationHint('column "made_up" of relation "products" does not exist'), null);
  assert.equal(migrationHint("something unrelated went wrong"), null);
});
