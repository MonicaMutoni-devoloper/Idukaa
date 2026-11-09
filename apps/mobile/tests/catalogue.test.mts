/**
 * Catalogue self-heal tests. Runs on Node 24 with built-in TypeScript type stripping:
 *   npm run test:catalogue -w @sms/mobile
 *
 * The rule these pin down is the difference between "this shop has no products" and "this device
 * never received the product list" — the second one is a stale incremental cursor, and retrying the
 * same cursor can never fix it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { needsFullRepull, syncFailureCode } from "../src/synchronization/catalogue.ts";

test("a cursor that answers 'nothing new' while the device holds no products forces a re-pull", () => {
  assert.equal(needsFullRepull({ productCount: 0, hasCheckpoint: true, productChanges: 0 }), true);
});

test("a genuine empty shop (no cursor yet) is not 'repaired' — the first pull is already full", () => {
  assert.equal(needsFullRepull({ productCount: 0, hasCheckpoint: false, productChanges: 0 }), false);
});

test("a device that already has products is left alone", () => {
  assert.equal(needsFullRepull({ productCount: 1, hasCheckpoint: true, productChanges: 0 }), false);
  assert.equal(needsFullRepull({ productCount: 12, hasCheckpoint: true, productChanges: 0 }), false);
});

test("a response that actually carries products is never treated as stale", () => {
  assert.equal(needsFullRepull({ productCount: 0, hasCheckpoint: true, productChanges: 5 }), false);
});

test("failures keep a stable, translatable code instead of leaking an HTTP status as prose", () => {
  const network = Object.assign(new Error("offline"), { name: "NetworkError" });
  assert.equal(syncFailureCode(network), "network");
  assert.equal(syncFailureCode(new Error("boom"), 503), "server_503");
  assert.equal(syncFailureCode(new Error("boom"), 500), "server_500");
  assert.equal(syncFailureCode(new Error("boom")), "unexpected");
});

test("a failed local write is reported as a storage problem, never as the server's fault", () => {
  // Exactly what expo-sqlite raises when a statement's placeholders do not match its columns.
  const sqlite = Object.assign(new Error("Error code 1: 13 values for 14 columns"), {
    name: "Error", code: "ERR_INTERNAL_SQLITE_ERROR",
  });
  assert.equal(syncFailureCode(sqlite), "storage");
  assert.equal(syncFailureCode(new Error("values for 13 columns")), "storage");
  // An API status still wins: a 500 from the server is never blamed on the device.
  assert.equal(syncFailureCode(sqlite, 500), "server_500");
});

/**
 * Every INSERT in the native store must bind exactly as many values as it declares columns.
 * A single missing `?` makes SQLite fail at prepare time, which silently broke the whole product
 * pull on Android (the web adapter has no SQL, so only the phone lost its catalogue).
 */
test("every INSERT in the native store matches its column count", () => {
  const source = readFileSync(new URL("../src/database/local.ts", import.meta.url), "utf8");
  const inserts = [...source.matchAll(/INSERT\s+(?:OR\s+\w+\s+)?INTO\s+(\w+)\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/g)];
  assert.ok(inserts.length >= 5, `expected the store's INSERT statements, found ${inserts.length}`);
  for (const [, table, columns, values] of inserts) {
    const cols = columns.split(",").map((c) => c.trim()).filter(Boolean).length;
    const vals = values.split(",").map((v) => v.trim()).filter(Boolean).length;
    assert.equal(vals, cols, `${table}: ${cols} columns but ${vals} values — a placeholder is missing or extra`);
  }
});
