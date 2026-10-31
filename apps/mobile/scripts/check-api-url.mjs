#!/usr/bin/env node
/**
 * Build-time guard for `npm run build:web` (Vercel runs the same script through vercel.json).
 *
 * `expo export` inlines EXPO_PUBLIC_API_URL into the bundle through Metro. When it is missing,
 * resolveApiUrl() in src/services/api.ts falls back to "http://localhost:3000" on web — the export
 * still succeeds, but every deployed browser would call the visitor's own machine. Fail the build
 * instead of shipping that.
 *
 * Escape hatch: ALLOW_LOCAL_API=1 for deliberate LAN/loopback exports (e.g. testing on a phone
 * against a PC inside the same network).
 */
const raw = process.env.EXPO_PUBLIC_API_URL;
const allowLocal = process.env.ALLOW_LOCAL_API === "1";
const problems = [];

if (!raw || !raw.trim()) {
  problems.push("EXPO_PUBLIC_API_URL is not set");
} else {
  const value = raw.trim();
  if (value !== raw) problems.push("EXPO_PUBLIC_API_URL has leading or trailing whitespace");

  let url = null;
  try {
    url = new URL(value);
  } catch {
    problems.push(`EXPO_PUBLIC_API_URL is not a valid absolute URL: ${value}`);
  }

  if (url) {
    const host = url.hostname.toLowerCase();
    const loopback = host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "0.0.0.0" || host === "[::1]" || host === "::1";
    if (loopback && !allowLocal) {
      problems.push(`EXPO_PUBLIC_API_URL points at this machine (${host}) — a deployed browser would call its own localhost`);
    } else if (url.protocol !== "https:" && !allowLocal) {
      problems.push(`EXPO_PUBLIC_API_URL must use https:// (got ${url.protocol}) — the web app is served over HTTPS and calls a plaintext API would be blocked as mixed content`);
    }
    if (value.endsWith("/")) {
      problems.push(`EXPO_PUBLIC_API_URL must not end with a trailing slash: ${value}`);
    } else if (url.pathname !== "/" || url.search || url.hash) {
      problems.push("EXPO_PUBLIC_API_URL must be an origin only — no path, query string or hash (the client appends request paths itself)");
    }
  }
}

if (problems.length) {
  console.error(
    "\nWeb export blocked — the production API URL is not usable:\n" +
      problems.map((p) => `  - ${p}`).join("\n") +
      "\n\nSet it for the build, for example:\n" +
      "  EXPO_PUBLIC_API_URL=https://your-api.onrender.com npm run build:web -w @sms/mobile\n" +
      "On Vercel it comes from Project -> Settings -> Environment Variables (Production and Preview).\n" +
      "Intentional LAN or loopback export: ALLOW_LOCAL_API=1.\n",
  );
  process.exit(1);
}

console.log(`web export: EXPO_PUBLIC_API_URL = ${raw.trim()} (inlined into the bundle)`);
