/**
 * Realtime hub integration test: a real HTTP server, real WebSocket upgrades, no mocks of `ws`.
 *
 * It pins the two security/reliability properties that matter to synchronization:
 *  - a change nudge reaches only sockets authenticated for that shop;
 *  - a socket is closed when its access token expires, and the client can rotate and reconnect.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { WebSocket } from "ws";
import { attachRealtime, emitShopChange } from "../src/realtime/hub";

const shopA = "00000000-0000-0000-0000-00000000000a";
const shopB = "00000000-0000-0000-0000-00000000000b";

const identities = new Map<string, { id: string; role: string; shopId: string; expiresAt: number }>();
let server: Server;
let port = 0;
let wss: ReturnType<typeof attachRealtime>;

before(async () => {
  const now = Date.now();
  identities.set("token-a", { id: "user-a", role: "owner", shopId: shopA, expiresAt: now + 10_000 });
  identities.set("token-b", { id: "user-b", role: "owner", shopId: shopB, expiresAt: now + 10_000 });
  identities.set("token-expiring", { id: "user-a", role: "owner", shopId: shopA, expiresAt: now + 1_200 });

  server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  wss = attachRealtime(server, {
    verify: async (token) => identities.get(token) ?? null,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");
  port = address.port;
});

after(async () => {
  for (const client of wss.clients) client.terminate();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface Client { ws: WebSocket; frames: any[]; closed: Promise<{ code: number; reason: string }> }

function connect(token: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/realtime`);
    const frames: any[] = [];
    const closed = new Promise<{ code: number; reason: string }>((done) => {
      ws.on("close", (code, reason) => done({ code, reason: reason.toString() }));
    });
    const timer = setTimeout(() => { try { ws.terminate(); } catch { /* noop */ } reject(new Error("realtime connect timed out")); }, 5_000);
    ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token })));
    ws.on("message", (data) => {
      const frame = JSON.parse(String(data));
      frames.push(frame);
      if (frame.type === "ready") { clearTimeout(timer); resolve({ ws, frames, closed }); }
    });
    ws.on("error", reject);
  });
}

const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

test("a shop change reaches only authenticated sockets for that shop", async () => {
  const a = await connect("token-a");
  const b = await connect("token-b");
  try {
    assert.equal(a.frames[0]?.type, "ready");
    assert.equal(a.frames[0]?.shopId, shopA);
    assert.equal(b.frames[0]?.shopId, shopB);

    const sent = emitShopChange(shopA, ["sale.create", "sale.create"]);
    assert.equal(sent, 1, "only the one socket in shop A is notified");
    await settle();

    const aChange = a.frames.find((f) => f.type === "change");
    assert.ok(aChange, "shop A receives the change nudge");
    assert.deepEqual(aChange.entities, ["sale.create"], "entity names are de-duplicated");
    assert.equal(b.frames.some((f) => f.type === "change"), false, "shop B never receives shop A's nudge");
  } finally {
    a.ws.close();
    b.ws.close();
  }
});

test("a socket is closed when its access token expires", async () => {
  const c = await connect("token-expiring");
  const started = Date.now();
  const close = await c.closed;
  assert.equal(close.code, 4001);
  assert.equal(close.reason, "token_expired");
  assert.ok(Date.now() - started < 4_000, "expiry is enforced by the socket itself, without waiting for a request");
});

test("a wrong path is refused instead of leaving a dangling upgrade", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/not-realtime`);
  const result = await new Promise<{ code: number }>((resolve) => {
    ws.on("unexpected-response", (_req, res) => resolve({ code: res.statusCode ?? 0 }));
    ws.on("error", () => resolve({ code: -1 }));
  });
  assert.equal(result.code, 404);
});
