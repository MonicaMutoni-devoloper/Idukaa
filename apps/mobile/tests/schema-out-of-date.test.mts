/**
 * Retry-message tests for the sync screen. Runs on Node 24 with built-in TypeScript type stripping:
 *   npm run test:sync -w @sms/mobile
 *
 * These pin the one failure the user cannot fix from the app: a server whose database is older than
 * its code. It must never reach the screen as a bare `server_503`, and ordinary failures must not be
 * mislabelled as a schema problem.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { failureMessage, schemaOutOfDate } from "../src/synchronization/failure.ts";

test("a schema_out_of_date 503 keeps the migration the server named", () => {
  const body = { error: "schema_out_of_date", requestId: "req-1", detail: 'column "purchase_unit" of relation "products" does not exist', migration: "004_unit_conversion.sql" };
  assert.equal(failureMessage(503, body), "schema_out_of_date:004_unit_conversion.sql");
  assert.deepEqual(schemaOutOfDate("schema_out_of_date:004_unit_conversion.sql"), { migration: "004_unit_conversion.sql" });
});

test("a schema_out_of_date 503 without a known migration still reads as schema drift", () => {
  assert.equal(failureMessage(503, { error: "schema_out_of_date", migration: null }), "schema_out_of_date");
  assert.equal(failureMessage(503, { error: "schema_out_of_date", migration: "   " }), "schema_out_of_date");
  assert.deepEqual(schemaOutOfDate("schema_out_of_date"), { migration: null });
});

test("every other failure keeps the existing server_<status> code", () => {
  assert.equal(failureMessage(500, { error: "internal_error", requestId: "req-2" }), "server_500");
  assert.equal(failureMessage(503, { error: "unavailable" }), "server_503");
  assert.equal(failureMessage(400, { error: "validation_failed" }), "server_400");
  assert.equal(failureMessage(409, null), "server_409");
});

test("ordinary retry messages are not mistaken for schema drift", () => {
  for (const m of [null, undefined, "", "network", "server_503", "rejected: not enough stock", "conflict"]) {
    assert.equal(schemaOutOfDate(m), null, `message ${JSON.stringify(m)} must not read as schema drift`);
  }
});
