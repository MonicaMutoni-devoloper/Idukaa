#!/usr/bin/env node
/**
 * Post-deploy verification for the Idukaa deployment (docs/PRODUCTION_DEPLOYMENT_STATUS.md §8).
 * Machine-checkable half only — everything that needs a signed-in user stays manual, because the
 * script holds no credentials.
 *
 *   node scripts/verify-deployment.mjs --api=https://<api>.onrender.com --web=https://<web>.vercel.app
 *
 * Flags:
 *   --api=URL     run the API checks (skipped when omitted)
 *   --web=URL     run the frontend checks (skipped when omitted)
 *   --allow-http  permit http:// targets (local smoke tests only; never for production)
 *
 * Exit code: 0 all checks passed, 1 at least one failed, 2 usage error.
 * Makes no writes: GET, one OPTIONS preflight, and one POST /auth/login with deliberately wrong
 * credentials — nothing is created, updated or deleted.
 */
const args = process.argv.slice(2);
const value = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3).trim() : "";
};
const api = value("api").replace(/\/+$/, "");
const web = value("web").replace(/\/+$/, "");
const allowHttp = args.includes("--allow-http");

if (!api && !web) {
  console.error("usage: node scripts/verify-deployment.mjs --api=https://<api> [--web=https://<web>] [--allow-http]");
  process.exit(2);
}
for (const [name, url] of [["--api", api], ["--web", web]]) {
  if (url && !/^https?:\/\//.test(url)) {
    console.error(`${name} must be an absolute http(s) URL`);
    process.exit(2);
  }
  if (url && !allowHttp && !url.startsWith("https://")) {
    console.error(`${name} is not HTTPS (${url}). Use --allow-http only for a local smoke test.`);
    process.exit(2);
  }
}

const results = [];
function record(ok, label, detail = "") {
  results.push({ ok, label });
  const mark = ok ? "PASS" : "FAIL";
  console.log(`${mark}  ${label}${detail ? `  [${detail}]` : ""}`);
  return ok;
}

const TIMEOUT_MS = 15_000;
async function request(url, init = {}) {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "manual" });
    return { res, error: null };
  } catch (error) {
    return { res: null, error: error?.name === "TimeoutError" ? "timeout" : error?.message ?? String(error) };
  }
}
const header = (res, name) => (res?.headers.get(name) ?? "").trim();

async function checkApi(base) {
  console.log(`\nAPI  ${base}`);

  const health = await request(`${base}/health`);
  if (!health.res) {
    record(false, "GET /health reachable", health.error);
    return;
  }
  const body = await health.res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    /* non-JSON body is itself a finding below */
  }
  record(health.res.status === 200, "GET /health returns 200", `status ${health.res.status}`);
  record(
    parsed?.status === "ok" && parsed?.db === "ok",
    "health reports database connectivity",
    parsed ? `db=${parsed.db}` : body.slice(0, 60),
  );
  record(!!header(health.res, "x-content-type-options"), "helmet: X-Content-Type-Options", header(health.res, "x-content-type-options") || "missing");
  record(!!header(health.res, "content-security-policy"), "helmet: Content-Security-Policy", header(health.res, "content-security-policy") ? "present" : "missing");
  if (base.startsWith("https://")) {
    record(!!header(health.res, "strict-transport-security"), "helmet: Strict-Transport-Security", header(health.res, "strict-transport-security") || "missing");
  }
  record(!/postgres(ql)?:\/\//i.test(body), "health body leaks no database URL", "");

  for (const path of ["/sync/pull", "/reports/summary", "/shop/settings", "/notifications", "/admin/health"]) {
    const r = await request(`${base}${path}`);
    record(
      !!r.res && (r.res.status === 401 || r.res.status === 403),
      `unauthenticated GET ${path} rejected`,
      r.res ? `status ${r.res.status}` : r.error,
    );
  }

  const login = await request(`${base}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "verify-probe@example.invalid", password: "deliberately-wrong-1" }),
  });
  record(
    !!login.res && [400, 401, 403, 429].includes(login.res.status),
    "wrong credentials rejected",
    login.res ? `status ${login.res.status}` : login.error,
  );
  record(!/sms_rt=/.test(header(login.res, "set-cookie")), "no refresh cookie issued for a failed login", "");

  if (web) {
    const preflight = await request(`${base}/auth/login`, {
      method: "OPTIONS",
      headers: {
        origin: web,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    record(
      header(preflight.res, "access-control-allow-origin") === web,
      "CORS allow-list contains the web origin",
      `${preflight.res ? `status ${preflight.res.status}` : preflight.error}; allow-origin=${header(preflight.res, "access-control-allow-origin") || "none"}`,
    );
    record(
      header(preflight.res, "access-control-allow-credentials").toLowerCase() === "true",
      "CORS allows credentials (refresh cookie)",
      header(preflight.res, "access-control-allow-credentials") || "missing",
    );

    const foreign = "https://not-allowed.invalid";
    const rejected = await request(`${base}/auth/login`, {
      method: "OPTIONS",
      headers: { origin: foreign, "access-control-request-method": "POST" },
    });
    record(
      header(rejected.res, "access-control-allow-origin") !== foreign,
      "CORS rejects an origin that is not on the allow-list",
      `allow-origin=${header(rejected.res, "access-control-allow-origin") || "none"}`,
    );
  }
}

async function checkWeb(base, apiBase) {
  console.log(`\nWEB  ${base}`);

  const home = await request(`${base}/`);
  if (!home.res) {
    record(false, "GET / reachable", home.error);
    return;
  }
  const html = await home.res.text();
  record(home.res.status === 200 && /text\/html/i.test(header(home.res, "content-type")), "web root serves HTML", `status ${home.res.status}`);
  if (base.startsWith("https://")) {
    record(!!header(home.res, "strict-transport-security"), "HSTS header on the web origin", header(home.res, "strict-transport-security") || "missing");
  }

  const deep = await request(`${base}/inventory/products`);
  const deepHtml = deep.res ? await deep.res.text() : "";
  record(
    !!deep.res && deep.res.status === 200 && /text\/html/i.test(header(deep.res, "content-type")) && /<div id="root"|<script/i.test(deepHtml),
    "SPA fallback serves the app for a deep route",
    deep.res ? `status ${deep.res.status}` : deep.error,
  );

  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+\.js)"/gi)].map((m) => m[1]);
  record(scripts.length > 0, "index.html references the JS bundle", `${scripts.length} script tag(s)`);

  let bundle = "";
  for (const src of scripts.slice(0, 6)) {
    const url = new URL(src, `${base}/`).toString();
    const r = await request(url);
    if (r.res?.ok) bundle += await r.res.text();
  }
  record(bundle.length > 0, "bundle downloaded", `${Math.round(bundle.length / 1024)} KB`);

  if (apiBase && bundle) {
    const host = new URL(apiBase).host;
    record(bundle.includes(host), `bundle is built against the deployed API (${host})`, "");
    const localhostFallback = /localhost:3000|127\.0\.0\.1:3000/.test(bundle);
    record(!localhostFallback, "bundle contains no localhost API fallback", localhostFallback ? "found localhost:3000" : "");
  }
}

try {
  if (api) await checkApi(api);
  if (web) await checkWeb(web, api);
} catch (error) {
  record(false, "verification harness", error?.message ?? String(error));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log("failed:");
  for (const f of failed) console.log(`  - ${f.label}`);
}
console.log("\nStill manual (needs accounts, cannot be scripted without credentials): owner registration +\nadmin approval, manager login, product/stock/sale entry, two-shop isolation, reports, offline sync\nand retry. See §8 of docs/PRODUCTION_DEPLOYMENT_STATUS.md.");
process.exit(failed.length ? 1 : 0);
