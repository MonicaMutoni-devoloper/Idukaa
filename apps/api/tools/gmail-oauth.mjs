#!/usr/bin/env node
/**
 * One-time: turn a Google OAuth client into MAIL_GMAIL_REFRESH_TOKEN.
 *
 *   cd apps/api
 *   MAIL_GMAIL_CLIENT_ID=...apps.googleusercontent.com \
 *   MAIL_GMAIL_CLIENT_SECRET=... node tools/gmail-oauth.mjs
 *
 * Prerequisites, all in https://console.cloud.google.com:
 *   1. Create (or pick) a project, then enable "Gmail API" under APIs & Services > Library.
 *   2. OAuth consent screen: User type "External", add the Gmail address you will send FROM as a
 *      test user. IMPORTANT: while the app stays in "Testing", Google expires every refresh token
 *      after 7 days. Publish the app ("In production") once you are past the first send — an
 *      unverified app only shows a warning during consent, it does not stop the token working.
 *   3. Credentials > Create credentials > OAuth client ID > type "Desktop app". Copy the client id
 *      and secret. Desktop clients accept a loopback redirect on any port, so no URI to register.
 *
 * The script listens on http://127.0.0.1:8080, prints a consent URL, waits for the code, exchanges
 * it, and prints the refresh token. Nothing here is needed at runtime: the API only uses the token.
 */
import { createServer } from "node:http";
import { URL } from "node:url";

const clientId = process.env.MAIL_GMAIL_CLIENT_ID ?? process.argv[2];
const clientSecret = process.env.MAIL_GMAIL_CLIENT_SECRET ?? process.argv[3];
if (!clientId || !clientSecret) {
  console.error("Set MAIL_GMAIL_CLIENT_ID and MAIL_GMAIL_CLIENT_SECRET (or pass them as argv).");
  process.exit(1);
}

const PORT = Number(process.env.OAUTH_PORT ?? 8080);
const redirectUri = `http://127.0.0.1:${PORT}`;
const scope = "https://www.googleapis.com/auth/gmail.send";

const consent = new URL("https://accounts.google.com/o/oauth2/v2/auth");
consent.searchParams.set("client_id", clientId);
consent.searchParams.set("redirect_uri", redirectUri);
consent.searchParams.set("response_type", "code");
consent.searchParams.set("scope", scope);
// offline + consent is the combination that actually returns a refresh_token.
consent.searchParams.set("access_type", "offline");
consent.searchParams.set("prompt", "consent");

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", redirectUri);
  if (!url.searchParams.get("code")) {
    res.writeHead(200, { "content-type": "text/plain" }).end("Waiting for the Google redirect…");
    return;
  }
  const code = url.searchParams.get("code");
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
      throw new Error(`no refresh_token in response: ${JSON.stringify(body).slice(0, 300)}`);
    }
    res.writeHead(200, { "content-type": "text/plain" })
      .end("Done — you can close this tab and return to the terminal.");
    console.log("\nAdd these to the API environment (Render > Environment):\n");
    console.log(`MAIL_GMAIL_CLIENT_ID=${clientId}`);
    console.log(`MAIL_GMAIL_CLIENT_SECRET=${clientSecret}`);
    console.log(`MAIL_GMAIL_REFRESH_TOKEN=${body.refresh_token}`);
    console.log("\nThen restart the API and check: POST /auth/email/resend works and the message arrives.");
  } catch (e) {
    res.writeHead(500, { "content-type": "text/plain" }).end(String(e));
    console.error(e);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Open this URL as the Gmail account you send FROM:\n\n${consent.toString()}\n`);
});
