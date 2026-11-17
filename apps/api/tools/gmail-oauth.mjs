#!/usr/bin/env node
/**
 * One-time: turn a Google OAuth client into MAIL_GMAIL_* values the API can use.
 *
 *   cd apps/api
 *   node tools/gmail-oauth.mjs
 *
 * It asks for the client id, the client secret and the Gmail address you send FROM, opens the Google
 * consent page in your browser, catches the redirect on http://127.0.0.1:8080, and prints the block
 * to paste into Render. Nothing is written to disk: the refresh token is a credential, and this repo
 * is shared.
 *
 * Google Cloud side, once (https://console.cloud.google.com):
 *   1. Create a project, then enable "Gmail API" (APIs & Services > Library).
 *   2. OAuth consent screen: User type "External"; add the sending Gmail address under Audience >
 *      Test users; add the scope ".../auth/gmail.send" under Data access. Then PUBLISH the app.
 *      While it stays in "Testing", Google expires every refresh token after 7 days, and mail stops
 *      without any error the app can see coming.
 *   3. Credentials > Create credentials > OAuth client ID > type "Desktop app". Desktop clients
 *      accept a loopback redirect on any port, so there is no URI to register.
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { URL } from "node:url";

const arg = (i) => process.argv[i] ?? "";
const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = async (q, fallback) => ((await rl.question(q)) || fallback || "").trim();

console.log(`
Before this can work, in https://console.cloud.google.com for the project that will own Idukaa mail:
  * Gmail API enabled
  * OAuth consent screen: External, the sending Gmail added under Audience > Test users,
    scope .../auth/gmail.send added, and the app PUBLISHED (Testing = tokens die after 7 days)
  * Credentials > Create credentials > OAuth client ID > Desktop app
`);

const clientId = process.env.MAIL_GMAIL_CLIENT_ID || arg(2) || (await ask("OAuth client ID: "));
const clientSecret = process.env.MAIL_GMAIL_CLIENT_SECRET || arg(3) || (await ask("OAuth client secret: "));
const from = process.env.MAIL_FROM || arg(4) || (await ask("Gmail address to send from: "));
const appUrl = process.env.APP_WEB_URL || (await ask("Web app URL for links [https://idukaa-api.vercel.app]: ", "https://idukaa-api.vercel.app"));

if (!clientId.endsWith(".apps.googleusercontent.com")) {
  console.error(`\nThat does not look like a client ID — it should end in .apps.googleusercontent.com`);
  process.exit(1);
}
if (!clientSecret.startsWith("GOCSPX-")) {
  console.error(`\nThat does not look like a client secret — it should start with GOCSPX-`);
  process.exit(1);
}
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(from)) {
  console.error("\nThat does not look like an e-mail address.");
  process.exit(1);
}
rl.close();

const PORT = Number(process.env.OAUTH_PORT ?? 8080);
const redirectUri = `http://127.0.0.1:${PORT}`;
const consent = new URL("https://accounts.google.com/o/oauth2/v2/auth");
consent.searchParams.set("client_id", clientId);
consent.searchParams.set("redirect_uri", redirectUri);
consent.searchParams.set("response_type", "code");
consent.searchParams.set("scope", "https://www.googleapis.com/auth/gmail.send");
// offline + consent is the only combination that reliably returns a refresh_token.
consent.searchParams.set("access_type", "offline");
consent.searchParams.set("prompt", "consent");
consent.searchParams.set("login_hint", from);

const openBrowser = (url) => {
  const [cmd, args] =
    process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] :
    process.platform === "darwin" ? ["open", [url]] :
    ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    /* headless or locked-down machine: the printed URL is enough */
  }
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", redirectUri);
  const fail = (code, message) => {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" })
      .end("Idukaa mail setup failed. Return to the terminal for the reason.");
    console.error(`\n✗ ${message}`);
    process.exitCode = 1;
    server.close();
  };

  const denied = url.searchParams.get("error");
  if (denied) {
    const hint = denied === "access_denied"
      ? "You clicked Cancel, or this address is not listed under Audience > Test users in the OAuth consent screen."
      : `Google said: ${denied}`;
    return fail(denied, hint);
  }

  const code = url.searchParams.get("code");
  if (!code) {
    res.writeHead(200, { "content-type": "text/plain" }).end("Waiting for the Google redirect…");
    return;
  }

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code, client_id: clientId, client_secret: clientSecret,
        redirect_uri: redirectUri, grant_type: "authorization_code",
      }),
    });
    const body = await tokenRes.json();
    if (!body.refresh_token) {
      return fail("no_refresh_token",
        `Google returned no refresh token (${body.error ?? "unknown"}). Revoke this app at ` +
        `https://myaccount.google.com/permissions and run the script again — a second attempt without ` +
        `revoking returns an access token only.`);
    }
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" })
      .end("Done — the values are in your terminal. You can close this tab.");

    console.log(`
────────────────────────────────────────────────────────────────────
Signed in. Paste these into Render > your API service > Environment
(add each as its own key/value; no quotes, no trailing comments):

MAIL_GMAIL_CLIENT_ID=${clientId}
MAIL_GMAIL_CLIENT_SECRET=${clientSecret}
MAIL_GMAIL_REFRESH_TOKEN=${body.refresh_token}
MAIL_FROM=${from}
MAIL_FROM_NAME=Idukaa
APP_WEB_URL=${appUrl}
EMAIL_VERIFICATION_REQUIRED=true
────────────────────────────────────────────────────────────────────
Then: Save (the service redeploys) and check
  https://idukaa-qqk2.onrender.com/health
for "mail":"gmail-api". The first message should be a real confirmation
e-mail from ${from} to an inbox you can open.
`);
    server.close();
  } catch (e) {
    fail("exchange_failed", `Could not exchange the code: ${e}`);
  }
});

server.on("error", (e) => {
  console.error(`\nCould not listen on ${redirectUri}: ${e.code ?? e.message}` +
    (e.code === "EADDRINUSE" ? " — something else uses 8080; set OAUTH_PORT=8090 and retry." : ""));
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\nOpening Google sign-in. Sign in as ${from} and press Allow.\nIf no window opens, paste this:\n\n${consent.toString()}\n`);
  openBrowser(consent.toString());
});
