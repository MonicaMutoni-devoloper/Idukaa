/**
 * Sending as a real Gmail mailbox over HTTPS instead of SMTP.
 *
 * Why this exists: Render's free web services block outbound traffic to the SMTP ports (25, 465,
 * 587) since September 2025, so nodemailer + a Gmail app password connects and then times out with
 * no useful error. Gmail also publishes an HTTPS send API on 443, which no host blocks — same
 * mailbox, same SPF/DKIM alignment (Google sends it), no domain needed.
 *
 * It needs three values from a Google Cloud project (see tools/gmail-oauth.mjs): an OAuth client
 * id, its secret, and a refresh token for the scope gmail.send. Access tokens are minted on demand
 * and cached here, because every send would otherwise cost an extra round trip.
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

type Creds = { clientId: string; clientSecret: string; refreshToken: string; from: string; fromName: string };

let cached: { token: string; expiresAt: number; key: string } | null = null;

const cfg = (): Creds | null => {
  const clientId = process.env.MAIL_GMAIL_CLIENT_ID ?? "";
  const clientSecret = process.env.MAIL_GMAIL_CLIENT_SECRET ?? "";
  const refreshToken = process.env.MAIL_GMAIL_REFRESH_TOKEN ?? "";
  const from = process.env.MAIL_FROM ?? process.env.MAIL_SMTP_USER ?? "";
  if (!clientId || !clientSecret || !refreshToken || !from) return null;
  return { clientId, clientSecret, refreshToken, from, fromName: process.env.MAIL_FROM_NAME ?? "Idukaa" };
};

export const gmailApiConfigured = () => !!cfg();

/** RFC 2047: a non-ASCII subject must be encoded or Gmail shows it as mojibake. */
const encodeHeader = (value: string) =>
  /^[\x20-\x7E]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;

/** The response body is the address the message is actually from — never a display name. */
const address = (from: string) => (from.includes("<") ? from : `<${from}>`);

function mime(c: Creds, msg: { to: string; subject: string; text: string; html: string }) {
  const boundary = `idukaa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n");
  return [
    `From: ${encodeHeader(c.fromName)} ${address(c.from)}`,
    `To: ${msg.to}`,
    `Subject: ${encodeHeader(msg.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}@idukaa>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    b64(msg.text),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    b64(msg.html),
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

async function accessToken(c: Creds): Promise<string> {
  const key = `${c.clientId}:${c.refreshToken}`;
  if (cached && cached.key === key && cached.expiresAt - 60_000 > Date.now()) return cached.token;
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: c.clientId,
      client_secret: c.clientSecret,
      refresh_token: c.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    // The two failures worth naming: a revoked/expired refresh token (invalid_grant) and a project
    // where the Gmail API was never enabled.
    const reason = String(body.error ?? res.status);
    throw new Error(`gmail_token_${reason}${body.error_description ? `: ${String(body.error_description).slice(0, 200)}` : ""}`);
  }
  cached = { token: body.access_token, expiresAt: Date.now() + Number(body.expires_in ?? 3600) * 1000, key };
  return cached.token;
}

/** Throws with a readable reason; the caller turns that into a logged, non-fatal failure. */
export async function sendViaGmailApi(msg: { to: string; subject: string; text: string; html: string }) {
  const c = cfg();
  if (!c) throw new Error("gmail_api_not_configured");
  const token = await accessToken(c);
  const raw = Buffer.from(mime(c, msg), "utf8").toString("base64url");
  const res = await fetch(SEND_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ raw }),
  });
  if (!res.ok) {
    const body: any = await res.json().catch(() => ({}));
    const reason = String(body?.error?.message ?? body?.error ?? res.status);
    // 401 with an unusable token: drop the cache so the next attempt mints a new one.
    if (res.status === 401) cached = null;
    throw new Error(`gmail_send_${res.status}: ${reason.slice(0, 300)}`);
  }
  return { sent: true as const, channel: "gmail-api" as const };
}
