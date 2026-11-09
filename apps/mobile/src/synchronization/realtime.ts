import { AppState } from "react-native";
import NetInfo from "@react-native-community/netinfo";
import { currentToken, ensureSession, refreshAccessToken, sessionRejected, useSession } from "../services/api";
import { API_URL } from "../services/api";
import { parseRealtimeMessage, realtimeUrl, reconnectDelay } from "./transport";

/**
 * The push half of synchronization.
 *
 * It does not download anything: a `change` frame only triggers the pass the app already runs
 * (`syncNow`), which pushes the outbox and pulls from the saved checkpoint. Everything therefore
 * still works when this channel is unavailable — the 30 s poll and the foreground/reconnect passes
 * are unchanged — and a rejected event can never leave a client with data it is not allowed to see,
 * because the pull is authorized on its own.
 *
 * Lifecycle: authenticated once per session, reconnected with jittered backoff, re-authenticated
 * with a fresh access token (the socket closes when the token expires, which is expected), dropped
 * on sign-out, and re-established on foreground/network return. A successful (re)connect always
 * runs a pass, so events missed while the socket was down are recovered by the checkpoint pull.
 */

export interface RealtimeOptions {
  /** Something visible to this shop changed: run the normal sync pass. */
  onChange: () => void;
  /** Channel state, for the subtle live indicator. */
  onStatus: (live: boolean) => void;
}

let socket: WebSocket | null = null;
let attempt = 0;
let retry: ReturnType<typeof setTimeout> | null = null;
let started = false;
let opts: RealtimeOptions | null = null;
let connecting = false;

export function startRealtime(options: RealtimeOptions) {
  opts = options;
  if (started) return;
  started = true;
  NetInfo.addEventListener((st) => {
    // `isInternetReachable` is deliberately not required: on some carriers it stays null while the
    // link works, and a refused socket costs one backoff step, not a broken app.
    if (st.isConnected) void connect();
    else dropSocket();
  });
  AppState.addEventListener("change", (s) => { if (s === "active") void connect(); });
  useSession.subscribe((s, prev) => {
    if (s.token && !prev.token) { attempt = 0; void connect(); }
    if (!s.token) { dropSocket(); if (retry) { clearTimeout(retry); retry = null; } }
  });
  void connect();
}

async function connect(): Promise<void> {
  if (!opts || socket || connecting || sessionRejected()) return;
  const user = useSession.getState().user;
  // The platform administrator has no shop scope, so there is nothing to subscribe to.
  if (!user || user.role === "system_admin" || !user.shopId) return;
  connecting = true;
  try {
    // A reloaded web tab or a backgrounded phone may have no access token yet. No token, no socket;
    // the retry below keeps this from becoming a request loop.
    if (!(await ensureSession(true))) { schedule(); return; }
    const token = currentToken();
    if (!token) { schedule(); return; }

    let ws: WebSocket;
    try { ws = new WebSocket(realtimeUrl(API_URL)); } catch { schedule(); return; }
    socket = ws;
    let opened = false;

    ws.onopen = () => {
      opened = true;
      // The token travels in the first frame, never in the URL: query strings end up in access logs,
      // browser history and proxy traces.
      try { ws.send(JSON.stringify({ type: "auth", token })); } catch { ws.close(); }
    };
    ws.onmessage = (event: { data: unknown }) => {
      const msg = parseRealtimeMessage(event.data);
      if (msg.type === "ready") {
        attempt = 0;
        opts?.onStatus(true);
        // Recover anything that happened while this device had no channel (or no network).
        opts?.onChange();
      } else if (msg.type === "change") {
        opts?.onChange();
      }
    };
    ws.onerror = () => { try { ws.close(); } catch { /* already closed */ } };
    ws.onclose = (event: { code?: number; reason?: string }) => {
      if (socket === ws) socket = null;
      opts?.onStatus(false);
      // The socket is closed by the server when its access token expires or is revoked. Rotate
      // once before reconnecting; retrying the same expired token would loop until an HTTP call
      // happened to refresh it. The reconnect stays on the normal jittered backoff: a suspension
      // or revocation that keeps answering 4001 must not become a refresh/reconnect storm.
      if (event?.code === 4001 && /token_expired|unauthorized/i.test(event.reason ?? "") && useSession.getState().user) {
        void refreshAccessToken().then(() => schedule(), () => schedule());
        return;
      }
      // A socket that never opened is an outage, not a slow response: back off like any other failure.
      if (!opened) attempt = Math.max(attempt, 1);
      schedule();
    };
  } finally {
    connecting = false;
  }
}

function schedule() {
  if (!opts || retry || sessionRejected()) return;
  const user = useSession.getState().user;
  if (!user || user.role === "system_admin") return;
  const wait = reconnectDelay(attempt++);
  retry = setTimeout(() => { retry = null; void connect(); }, wait);
}

function dropSocket() {
  opts?.onStatus(false);
  if (!socket) return;
  const ws = socket;
  socket = null;
  try { ws.close(); } catch { /* already closed */ }
}
