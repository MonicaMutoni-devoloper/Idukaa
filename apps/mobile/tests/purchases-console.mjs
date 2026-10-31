/**
 * Focused browser check for the Reports → Purchases screen.
 *
 * Reproduces the exact navigation the dashboard's "Purchases" drill-down performs
 * (/reports?kind=purchases&from=…&to=…, i.e. WITH URL params) and asserts that:
 *   1. no React "Unexpected text node" warnings are emitted (cells must render <Text>),
 *   2. no "Maximum update depth exceeded" errors occur (the param-sync effect must be stable),
 *   3. the purchases list fetch does not repeat itself (no refetch storm),
 *   4. switching to another section and back does not restart any loop,
 *   5. the empty state still renders for a period without purchases,
 *   6. the narrow (phone-width) card layout is clean too.
 *
 * Prerequisites: API on :3000, the Expo web dev server (npm run web) or a static export
 * on :8081 with SPA fallback, Chrome installed, seeded demo data.
 *
 *   node apps/mobile/tests/purchases-console.mjs
 *
 * Read-only: unlike e2e-web.mjs it creates no records. It only reads reports.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const WEB = process.env.WEB_URL ?? "http://localhost:8081";
const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT ?? 9334);
const PASSWORD = process.env.DEMO_PASSWORD ?? "dev-password-2026";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sms-purchases-console-"));
const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`,
  "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--disable-extensions",
  "--window-size=1440,960", "about:blank",
], { stdio: "ignore" });

let ws;
const pendingCalls = new Map();
let seq = 0;
const consoleErrors = [];
let purchasesRequests = 0;

async function pageTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page;
    } catch { /* chrome not up yet */ }
    await sleep(250);
  }
  throw new Error("Chrome did not expose a debugging target");
}

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pendingCalls.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

const q = (testId) => `document.querySelector('[data-testid="${testId}"]')`;
async function waitFor(expression, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await evaluate(expression)) return;
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
const waitTest = (id, timeout) => waitFor(`!!${q(id)}`, `testID ${id}`, timeout);
const waitText = (text, timeout) => waitFor(`document.body.innerText.toLowerCase().includes(${JSON.stringify(text.toLowerCase())})`, `text "${text}"`, timeout);

async function clickTest(id) {
  const ok = await evaluate(`(()=>{const el=${q(id)}; if(!el)return false; el.scrollIntoView({block:"center"}); el.click(); return true;})()`);
  if (!ok) throw new Error(`Element not found: ${id}`);
  await sleep(150);
}
async function clickText(label) {
  const ok = await evaluate(`(()=>{const el=[...document.querySelectorAll('[role="button"]')].find(e=>e.innerText.trim()===${JSON.stringify(label)}); if(!el)return false; el.scrollIntoView({block:"center"}); el.click(); return true;})()`);
  if (!ok) throw new Error(`Button not found by text: ${label}`);
  await sleep(150);
}
async function type(id, value) {
  const ok = await evaluate(`(()=>{const el=${q(id)}; if(!el)return false; el.focus();
    const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
    const set=Object.getOwnPropertyDescriptor(proto,'value').set;
    set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input',{bubbles:true}));
    el.dispatchEvent(new Event('change',{bubbles:true}));
    return true;})()`);
  if (!ok) throw new Error(`Field not found: ${id}`);
  await sleep(120);
}
async function go(path) {
  await send("Page.navigate", { url: WEB + path });
  await sleep(1500);
}

/** Let a screen settle, then return how many new console errors / purchases fetches appeared. */
async function settle(ms) {
  const errsBefore = consoleErrors.length;
  const reqsBefore = purchasesRequests;
  await sleep(ms);
  return { newErrors: consoleErrors.slice(errsBefore), newRequests: purchasesRequests - reqsBefore };
}

const steps = [];
const step = async (name, fn) => { process.stdout.write(`\n→ ${name}\n`); await fn(); steps.push(name); console.log(`  ✓ ${name}`); };

try {
  const target = await pageTarget();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pendingCalls.has(m.id)) {
      const { resolve, reject } = pendingCalls.get(m.id); pendingCalls.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    } else if (m.method === "Runtime.exceptionThrown") {
      consoleErrors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
    } else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
      const text = m.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
      if (!/Failed to load resource|net::ERR|NetworkError/i.test(text)) consoleErrors.push(text);
    } else if (m.method === "Network.requestWillBeSent" && m.params.request.url.includes("/reports/transactions?kind=purchases")) {
      purchasesRequests++;
    }
  };
  await send("Runtime.enable"); await send("Page.enable"); await send("Network.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });

  await step("owner signs in", async () => {
    await go("/login");
    await waitTest("login-email", 90000); // first load compiles the Metro bundle — allow a cold start
    await type("login-email", "owner@demo.local");
    await type("login-password", PASSWORD);
    await clickTest("login-submit");
    await waitFor(`location.pathname !== "/login"`, "login redirect", 15000);
    await waitTest("home-action-sell");
  });

  await step("dashboard drill-down → Purchases (with from/to params) renders cleanly", async () => {
    await waitFor(`[...document.querySelectorAll('[role="button"]')].some(e=>e.innerText.trim()==="Purchases")`, "purchases drill-down button", 30000);
    await clickText("Purchases");
    await waitFor(`location.pathname === "/reports"`, "reports route", 15000);
    await waitText("Period total", 20000);
    const s = await settle(5000); // 5s of idle: a render loop or refetch storm would show here
    assert.deepEqual(s.newErrors, [], `console errors after opening Purchases:\n${s.newErrors.join("\n")}`);
    assert.ok(s.newRequests <= 1, `the purchases list was fetched ${s.newRequests} times while idle (expected ≤ 1)`);
    const text = await evaluate("document.body.innerText");
    assert.ok(text.includes("BALANCE"), "the purchases table renders its columns");
    assert.ok(text.includes("RWF") || text.includes("No transactions in this period"), "rows with amounts or the empty state are shown");
  });

  await step("switching section away and back does not restart a loop", async () => {
    await clickTest("segment-sales");
    await waitText("Receipt", 15000);
    await settle(1500);
    await clickTest("segment-purchases");
    await waitText("BALANCE", 15000);
    const s = await settle(4000);
    assert.deepEqual(s.newErrors, [], `console errors after switching back:\n${s.newErrors.join("\n")}`);
    assert.ok(s.newRequests <= 1, `the purchases list was fetched ${s.newRequests} extra times after switching back (expected ≤ 1)`);
  });

  await step("an empty period shows the empty state, still without errors", async () => {
    await go("/reports?kind=purchases&from=2000-01-01T00%3A00%3A00.000Z&to=2000-01-08T00%3A00%3A00.000Z");
    await waitText("No transactions in this period", 20000);
    const s = await settle(3000);
    assert.deepEqual(s.newErrors, [], `console errors on the empty state:\n${s.newErrors.join("\n")}`);
  });

  await step("phone-width (card layout) Purchases is clean too", async () => {
    await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await send("Page.navigate", { url: `${WEB}/reports?kind=purchases` });
    await sleep(1500);
    await waitText("Period total", 20000);
    const s = await settle(4000);
    assert.deepEqual(s.newErrors, [], `console errors at phone width:\n${s.newErrors.join("\n")}`);
    const text = await evaluate("document.body.innerText");
    assert.ok(text.includes("Balance"), "the card layout renders the balance row");
  });

  console.log(`\nAll ${steps.length} purchases-console checks passed. Total console errors captured: ${consoleErrors.length}.`);
  if (consoleErrors.length) { console.log(consoleErrors.slice(0, 10).join("\n")); process.exitCode = 1; }
} catch (err) {
  console.error(`\n✗ ${err.message}`);
  try {
    if (ws) {
      const diag = await evaluate(`JSON.stringify({ href: location.href, text: document.body.innerText.slice(0, 400) })`);
      console.error(`Page diagnostics: ${diag}`);
    }
  } catch { /* diagnostics are best effort */ }
  if (consoleErrors.length) console.error(`\nConsole errors captured:\n${consoleErrors.slice(0, 20).join("\n")}`);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch { /* already closed */ }
  chrome.kill();
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
}
