/**
 * Focused browser check for the new offline/PWA surface.
 *
 * Prerequisites: API on :3000, static export on :8081 (SPA fallback), Chrome, demo data seeded.
 * It installs the app shell, saves a report cache, then reloads with every API request blocked and
 * proves the report opens from IndexedDB. It also asks Chrome for the manifest/installability verdict.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const WEB = process.env.WEB_URL ?? "http://localhost:8081";
const API = process.env.API_URL ?? "http://localhost:3000";
const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT ?? 9444);
const PASSWORD = process.env.DEMO_PASSWORD ?? "dev-password-2026";
const EMAIL = process.env.DEMO_EMAIL ?? "owner@demo.local";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "idukaa-pwa-"));
const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`,
  "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--disable-extensions",
  "--window-size=1440,960", "about:blank",
], { stdio: "ignore" });

let ws; let seq = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq; pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
const q = (id) => `document.querySelector('[data-testid="${id}"]')`;
async function waitFor(expression, label, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await evaluate(expression)) return;
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
const waitTest = (id, timeout) => waitFor(`!!${q(id)}`, `testID ${id}`, timeout);
const waitText = (text, timeout) => waitFor(`document.body.innerText.toLowerCase().includes(${JSON.stringify(text.toLowerCase())})`, `text "${text}"`, timeout);
const type = async (id, value) => {
  const ok = await evaluate(`(()=>{const el=${q(id)}; if(!el)return false; el.focus();
    const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto,'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input',{bubbles:true}));
    el.dispatchEvent(new Event('change',{bubbles:true}));
    return true;})()`);
  if (!ok) throw new Error(`Field not found: ${id}`);
};
const click = async (id) => {
  const ok = await evaluate(`(()=>{const el=${q(id)}; if(!el)return false; el.scrollIntoView({block:"center"}); el.click(); return true;})()`);
  if (!ok) throw new Error(`Element not found: ${id}`);
  await sleep(200);
};
async function target() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page;
    } catch { /* not ready */ }
    await sleep(250);
  }
  throw new Error("Chrome did not expose a debugging target");
}

try {
  const page = await target();
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    }
  };
  await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable");

  await send("Page.navigate", { url: `${WEB}/login` });
  await waitTest("login-email", 30000);
  await type("login-email", EMAIL);
  await type("login-password", PASSWORD);
  await click("login-submit");
  await waitFor(`location.pathname !== "/login"`, "login redirect", 30000);
  await waitTest("nav-home", 30000);
  console.log("  signed in");

  // Let the worker take control of this client, then ask Chrome for its installability verdict.
  await evaluate(`navigator.serviceWorker.ready.then(()=>true)`);
  await send("Page.reload");
  await waitTest("nav-home", 30000);
  const sw = await evaluate(`navigator.serviceWorker.ready.then(r=>({scope:r.scope,controlled:!!navigator.serviceWorker.controller}))`);
  assert.equal(sw.scope, `${WEB}/`);
  assert.equal(sw.controlled, true, "the app shell is controlled by the service worker");

  const manifest = await send("Page.getAppManifest");
  assert.ok(manifest.url?.endsWith("/manifest.json"), "the manifest is linked");
  assert.deepEqual(manifest.errors ?? [], [], "the manifest has no parse errors");
  const data = JSON.parse(manifest.data);
  assert.equal(data.name, "Idukaa");
  assert.equal(data.display, "standalone");
  const installability = await send("Page.getInstallabilityErrors").catch(() => ({ installabilityErrors: [] }));
  const installErrors = (installability.installabilityErrors ?? []).map((e) => e.errorId);
  assert.equal(installErrors.includes("manifest-missing-suitable-icon"), false, `Chrome has a suitable icon (${installErrors.join(", ")})`);
  assert.equal(installErrors.includes("not-in-main-frame"), false);
  console.log(`  manifest: ${data.name}, installability: ${installErrors.length ? installErrors.join(", ") : "no blocking errors"}`);

  await send("Page.navigate", { url: `${WEB}/settings` });
  await waitTest("pwa-install-card", 30000);
  console.log("  settings install card rendered");
  await waitTest("pwa-install-help", 30000);
  await click("pwa-install-help");
  await waitText("Install Idukaa on this phone", 10000);
  assert.ok((await evaluate("document.body.innerText")).includes("Add to Home screen"), "manual installation instructions are present");
  await evaluate(`[...document.querySelectorAll('[role="button"]')].find(e=>e.innerText.trim()==='Close')?.click()`);

  // Save the current month/year reports, wait for the durable status, and prove the records landed.
  await click("offline-download");
  await waitText("Ready offline", 120000);
  console.log("  offline download complete");
  const saved = await evaluate(`new Promise((resolve,reject)=>{const r=indexedDB.open('sms-local');r.onerror=()=>reject('idb');r.onsuccess=()=>{const s=r.result.transaction('state','readonly').objectStore('state');const g=s.get('state');g.onsuccess=()=>{const kv=g.result?.kv??{};const keys=Object.keys(kv);resolve({count:keys.filter(x=>x.startsWith('report:v2:')||x.startsWith('dashboard:v3:')).length,status:keys.find(x=>x.startsWith('offline.data:'))??null,bytes:keys.reduce((n,k)=>n+kv[k].length,0)});};};})`);
  assert.equal(typeof saved.status, "string", "the offline download wrote its durable status");
  assert.ok(saved.count >= 2, `saved offline cache entries found: ${JSON.stringify(saved)}`);
  console.log(`  offline cache: ${saved.count} dashboard/report entries, ${Math.round(saved.bytes / 1024)}KB`);

  // Offline restart: every API call is blocked, so only the app shell and IndexedDB can answer.
  await send("Network.setBlockedURLs", { urls: [`${API}/*`] });
  await send("Page.navigate", { url: `${WEB}/reports` });
  await waitTest("report-open-sales", 40000);
  console.log("  reports shell loaded offline");
  await click("report-open-sales");
  await waitTest("reports-export", 40000);
  await waitText("Saved copy", 20000);
  console.log("  cached report rendered with the API blocked");
  const text = await evaluate("document.body.innerText");
  assert.ok(!/something went wrong|could not be loaded and has no saved copy/i.test(text), "the cached report renders instead of an error");
  assert.ok(/sales overview/i.test(text), "the sales report is available without the API");
  assert.equal(await evaluate(`!!${q("dash-loading")}`), false);
  await send("Network.setBlockedURLs", { urls: [] });

  console.log("\n── result ──");
  console.log("PWA install/offline check passed");
} finally {
  try { ws?.close(); } catch { /* already closed */ }
  chrome.kill();
  await new Promise((resolve) => { chrome.once("exit", resolve); setTimeout(resolve, 4000); });
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* Windows may still hold the profile briefly */ }
}
