/**
 * Pure helpers for the real-time channel, kept free of React Native imports so plain Node can test
 * them (the same pattern as `failure.ts` and `catalogue.ts`).
 */

/** `https://api.example.com/` → `wss://api.example.com/realtime`; `http://` → `ws://`. */
export function realtimeUrl(base: string): string {
  const ws = base.replace(/^https:/i, "wss:").replace(/^http:/i, "ws:").replace(/\/+$/, "");
  return `${ws}/realtime`;
}

/**
 * Reconnection backoff: 1s, 2s, 4s … capped at 30s, ±25 % jitter so a shop full of devices does not
 * reconnect in lockstep after an API restart. `random` is injectable so the schedule is testable.
 */
export function reconnectDelay(attempt: number, random: () => number = Math.random): number {
  const step = Math.max(0, Math.min(attempt, 5));
  const base = Math.min(30_000, 1_000 * 2 ** step);
  // The jitter must never push a delay past the ceiling (at 30 s, +25 % would be 37.5 s).
  return Math.min(30_000, Math.round(base * (0.75 + random() * 0.5)));
}

export type RealtimeMessage =
  | { type: "ready"; shopId: string | null; at?: string }
  | { type: "change"; entities: string[]; at?: string }
  | { type: "pong" }
  | { type: "unknown" };

/**
 * Parse one server frame. Anything unexpected is `unknown` and ignored: a malformed message must
 * never take the connection state down with it.
 */
export function parseRealtimeMessage(raw: unknown): RealtimeMessage {
  let msg: any;
  try { msg = typeof raw === "string" ? JSON.parse(raw) : null; } catch { return { type: "unknown" }; }
  if (!msg || typeof msg !== "object") return { type: "unknown" };
  if (msg.type === "ready") return { type: "ready", shopId: typeof msg.shopId === "string" ? msg.shopId : null, at: msg.at };
  if (msg.type === "change") {
    const entities = Array.isArray(msg.entities) ? msg.entities.filter((e: unknown): e is string => typeof e === "string") : [];
    return { type: "change", entities, at: msg.at };
  }
  if (msg.type === "pong") return { type: "pong" };
  return { type: "unknown" };
}
