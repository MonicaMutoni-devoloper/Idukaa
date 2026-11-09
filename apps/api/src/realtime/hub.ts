import type { Server as HttpServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";

/**
 * Server → client push channel.
 *
 * It carries no shop data. A message only says "this shop changed", and every client answers by
 * running the sync pass it already owns (push outbox, then incremental pull from its checkpoint).
 * That keeps one source of truth for data, authorization (every pull is re-authorized by
 * AuthGuard), and offline recovery — a missed WebSocket message costs one poll interval, never a
 * record.
 *
 * A socket is authorized exactly like an HTTP request: the JWT is verified, the user row is
 * re-read (active, account_status, token_version) and the shop is joined from that row, never
 * from the client. Two shops can therefore never share a room, even if a bug sent the wrong id.
 */
export interface RealtimeIdentity { id: string; role: string; shopId: string | null }

export interface RealtimeDeps {
  /** Same checks as AuthGuard, resolved from the token; null means "refuse this socket". */
  verify: (token: string) => Promise<RealtimeIdentity | null>;
  log?: (evt: string, data: Record<string, unknown>) => void;
}

type Client = WebSocket & { authed?: boolean; shopId?: string; userId?: string; alive?: boolean };

const PATH = "/realtime";
/** A browser tab or phone that connects must authenticate within this window. */
const AUTH_TIMEOUT_MS = 5_000;
/** Idle detection: ping every 25 s, drop a socket that missed one full round. */
const HEARTBEAT_MS = 25_000;

let wss: WebSocketServer | null = null;
const rooms = new Map<string, Set<Client>>();

export function attachRealtime(http: HttpServer, deps: RealtimeDeps): WebSocketServer {
  if (wss) return wss;
  const server = new WebSocketServer({ noServer: true, maxPayload: 4_096 });
  wss = server;

  // `ws` upgrades any path unless this is filtered, and a Nest HTTP server has no other upgrade
  // consumer, so every other upgrade is refused explicitly instead of dangling.
  http.on("upgrade", (req, socket, head) => {
    let pathname = "";
    try { pathname = new URL(req.url ?? "/", "http://localhost").pathname; } catch { pathname = ""; }
    if (pathname !== PATH) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    server.handleUpgrade(req, socket, head, (ws) => server.emit("connection", ws, req));
  });

  server.on("connection", (raw) => {
    const ws = raw as Client;
    ws.alive = true;
    ws.on("pong", () => { ws.alive = true; });
    const authTimer = setTimeout(() => { if (!ws.authed) ws.close(4001, "auth_timeout"); }, AUTH_TIMEOUT_MS);

    ws.on("message", (data) => {
      void (async () => {
        let msg: { type?: unknown; token?: unknown };
        try { msg = JSON.parse(String(data)); } catch { return; }
        if (msg?.type === "ping") {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "pong", at: new Date().toISOString() }));
          return;
        }
        // Only the first message may authenticate; a later one cannot re-scope the socket.
        if (msg?.type !== "auth" || ws.authed) return;
        const token = typeof msg.token === "string" ? msg.token : "";
        const who = token ? await deps.verify(token).catch(() => null) : null;
        if (!who || !who.shopId) { ws.close(4001, "unauthorized"); return; }
        clearTimeout(authTimer);
        ws.authed = true;
        ws.shopId = who.shopId;
        ws.userId = who.id;
        const room = rooms.get(who.shopId) ?? new Set<Client>();
        room.add(ws);
        rooms.set(who.shopId, room);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ready", shopId: who.shopId, at: new Date().toISOString() }));
        // Never the token, never shop data: only who opened a channel and how many are open.
        deps.log?.("realtime.open", { userId: who.id, shopId: who.shopId, clients: room.size });
      })().catch(() => { try { ws.close(1011, "internal"); } catch { /* already closed */ } });
    });

    ws.on("close", () => {
      clearTimeout(authTimer);
      const shop = ws.shopId;
      if (!shop) return;
      const room = rooms.get(shop);
      room?.delete(ws);
      if (room && room.size === 0) rooms.delete(shop);
    });
    ws.on("error", () => ws.terminate());
  });

  const beat = setInterval(() => {
    for (const room of rooms.values()) {
      for (const ws of room) {
        if (ws.alive === false) { ws.terminate(); continue; }
        ws.alive = false;
        try { ws.ping(); } catch { ws.terminate(); }
      }
    }
  }, HEARTBEAT_MS);
  beat.unref?.();
  server.on("close", () => clearInterval(beat));
  return server;
}

/**
 * Tell everyone signed in to this shop that something they can see changed.
 * Returns how many sockets were notified (0 when nobody is connected — the clients' own poll and
 * their reconnect-time pull cover that case).
 */
export function emitShopChange(shopId: string | null | undefined, entities: string[]): number {
  if (!shopId || !wss) return 0;
  const payload = JSON.stringify({
    type: "change", shopId, entities: [...new Set(entities.filter(Boolean))], at: new Date().toISOString(),
  });
  let sent = 0;
  for (const ws of rooms.get(shopId) ?? []) {
    if (ws.authed && ws.readyState === WebSocket.OPEN) { ws.send(payload); sent++; }
  }
  return sent;
}

/** Diagnostic snapshot for logs/health; never exposes identities beyond counts. */
export function realtimeStats() {
  let clients = 0;
  for (const room of rooms.values()) clients += room.size;
  return { clients, shops: rooms.size };
}
