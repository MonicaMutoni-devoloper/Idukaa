import test from "node:test";
import assert from "node:assert/strict";
import { parseRealtimeMessage, realtimeUrl, reconnectDelay } from "../src/synchronization/transport.ts";

test("the real-time endpoint follows the API scheme and host", () => {
  assert.equal(realtimeUrl("https://idukaa.example.com"), "wss://idukaa.example.com/realtime");
  assert.equal(realtimeUrl("http://localhost:3000"), "ws://localhost:3000/realtime");
  assert.equal(realtimeUrl("https://api.example.com/"), "wss://api.example.com/realtime", "trailing slashes never double up");
  assert.equal(realtimeUrl("http://192.168.1.10:3000"), "ws://192.168.1.10:3000/realtime");
});

test("reconnection backs off exponentially and stops growing at the cap", () => {
  const fixed = () => 0.5; // no jitter, so the schedule itself is visible
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 40].map((n) => reconnectDelay(n, fixed)),
    [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
});

test("reconnection jitter stays within ±25 % and under the ceiling", () => {
  assert.equal(reconnectDelay(0, () => 0), 750);
  assert.equal(reconnectDelay(0, () => 1), 1_250);
  for (let attempt = 0; attempt < 12; attempt++) {
    for (const r of [0, 0.25, 0.5, 0.75, 1]) {
      const d = reconnectDelay(attempt, () => r);
      assert.ok(d >= 750 && d <= 30_000, `attempt ${attempt}: ${d}ms outside bounds`);
    }
  }
  // A negative or absurd attempt number must not produce Infinity or a negative delay.
  assert.equal(reconnectDelay(-3, () => 0.5), 1_000);
});

test("server frames are read without trusting their shape", () => {
  assert.deepEqual(parseRealtimeMessage('{"type":"ready","shopId":"shop-1"}'), { type: "ready", shopId: "shop-1", at: undefined });
  assert.deepEqual(parseRealtimeMessage('{"type":"change","entities":["sale.create",3,"expense.create"]}'),
    { type: "change", entities: ["sale.create", "expense.create"], at: undefined });
  assert.deepEqual(parseRealtimeMessage('{"type":"pong"}'), { type: "pong" });
  assert.deepEqual(parseRealtimeMessage("not json"), { type: "unknown" });
  assert.deepEqual(parseRealtimeMessage('{"type":"change"}'), { type: "change", entities: [], at: undefined });
  assert.deepEqual(parseRealtimeMessage(null), { type: "unknown" });
});
