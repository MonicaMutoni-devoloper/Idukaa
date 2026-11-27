/**
 * Two real browsers on one shop: convergence, a server outage, automatic recovery, and unsynced
 * work surviving a browser restart.
 *
 *   node apps/mobile/tests/e2e-sync-two-browsers.mjs
 *
 * Prerequisites: a web export in apps/mobile/dist built with EXPO_PUBLIC_API_URL pointing at this
 * machine (ALLOW_LOCAL_API=1), a migrated DEVELOPMENT database with the demo accounts, and Chrome
 * installed. The script starts and stops the API itself, so it can take the server away mid-run —
 * which is the scenario users reported.
 *
 * It writes real records to the DEVELOPMENT database using demo accounts. Never point it at production.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createReadStream, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import assert from "node:assert/strict";

const WEB_PORT = Number(process.env.WEB_PORT ?? 8081);
const API_PORT = Number(process.env.API_PORT ?? 3000);
const WEB = `http://localhost:${WEB_PORT}`;
const API = `http://localhost:${API_PORT}`;
const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PASSWORD = process.env.DEMO_PASSWORD ?? "dev-password-2026";
const DIST = resolve("apps/mobile/dist");
const NAME = `Sync E2E ${Date.now().toString(36)}`;
const CODE = `SYN-${Date.now().toString(36).slice(-5).toUpperCase()}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ static web server */

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf",
};
function serveStatic() {
  assert.ok(existsSync(join(DIST, "index.html")), "build apps/mobile/dist first (npm run build:web -w @sms/mobile)");
  const server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? "/").split("?")[0]);
    let file = join(DIST, path);
    try { if (!statSync(file).isFile()) file = join(DIST, "index.html"); } catch { file = join(DIST, "index.html"); }
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(res);
  });
  return new Promise((ok) => server.listen(WEB_PORT, "127.0.0.1", () => ok(server)));
}

/* ------------------------------------------------------------------ API process */

let api = null;
function startApi() {
  api = spawn(process.execPath, ["dist/main.js"], {
    cwd: resolve("apps/api"),
    env: { ...process.env, PORT: String(API_PORT), AUTO_MIGRATE: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  api.stdout.on("data", () => {});
  api.stderr.on("data", () => {});
}
async function apiUp(timeout = 60_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { if ((await fetch(`${API}/health`, { signal: AbortSignal.timeout(2000) })).ok) return; } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error("the API did not become healthy");
}
async function stopApi() {
  if (!api) return;
  const child = api; api = null;
  child.kill();
  const end = Date.now() + 15_000;
  while (Date.now() < end) {
    try { await fetch(`${API}/health`, { signal: AbortSignal.timeout(1000) }); } catch { return; }
    await sleep(200);
  }
  throw new Error("the API did not stop");
}

/* ------------------------------------------------------------------ one Chrome instance */

class Browser {
  constructor(label, port) {
    this.label = label;
    this.port = port;
    this.profile = mkdtempSync(join(tmpdir(), `sms-e2e-${label}-`));
    this.pending = new Map();
    this.seq = 0;
  }
  async open() {
    this.chrome = spawn(CHROME, [
      "--headless=new", `--remote-debugging-port=${this.port}`, `--user-data-dir=${this.profile}`,
      "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--disable-extensions",
      "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows", "--window-size=1440,960", "about:blank",
    ], { stdio: "ignore" });
    const target = await this.pageTarget();
    await new Promise((ok, fail) => {
      this.ws = new WebSocket(target.webSocketDebuggerUrl);
      this.ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
        }
      };
      this.ws.onopen = ok;
      this.ws.onerror = () => fail(new Error(`${this.label}: CDP socket failed`));
    });
    await this.send("Page.enable"); await this.send("Runtime.enable"); await this.send("Network.enable");
  }
  async pageTarget() {
    for (let i = 0; i < 80; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${this.port}/json/list`)).json();
        const page = list.find((t) => t.type === "page");
        if (page) return page;
      } catch { /* chrome not up */ }
      await sleep(250);
    }
    throw new Error(`${this.label}: Chrome did not expose a debugging target`);
  }
  send(method, params = {}) {
    return new Promise((resolvePromise, reject) => {
      const id = ++this.seq;
      this.pending.set(id, { resolve: resolvePromise, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
  q(id) { return `document.querySelector('[data-testid="${id}"]')`; }
  async waitFor(expression, label, timeout = 25_000) {
    const end = Date.now() + timeout; let last = null;
    while (Date.now() < end) {
      try { if (await this.evaluate(expression)) return; } catch (e) { last = e; }
      await sleep(200);
    }
    throw new Error(`${this.label}: timed out waiting for ${label}${last ? ` (${last.message})` : ""}`);
  }
  waitTest(id, timeout) { return this.waitFor(`!!${this.q(id)}`, `testID ${id}`, timeout); }
  async waitText(text, timeout) {
    try {
      await this.waitFor(`document.body.innerText.toLowerCase().includes(${JSON.stringify(text.toLowerCase())})`, `text "${text}"`, timeout);
    } catch (e) {
      const body = await this.evaluate("document.body.innerText.slice(0,600)").catch(() => "<unavailable>");
      throw new Error(`${e.message}\n--- page text ---\n${body}`);
    }
  }
  async clickTest(id) {
    await this.waitTest(id);
    const ok = await this.evaluate(`(()=>{const el=${this.q(id)}; if(!el)return false; el.scrollIntoView({block:"center"}); el.click(); return true;})()`);
    assert.ok(ok, `${this.label}: element ${id} not found`);
    await sleep(150);
  }
  async type(id, value) {
    await this.waitTest(id);
    const ok = await this.evaluate(`(()=>{const el=${this.q(id)}; if(!el)return false; el.focus();
      const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto,'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));
      return true;})()`);
    assert.ok(ok, `${this.label}: field ${id} not found`);
    await sleep(120);
  }
  async go(path) { await this.send("Page.navigate", { url: WEB + path }); await sleep(1800); }
  /**
   * Put the product in the cart. Tapping a tile opens the quick-add sheet (quantity in selling
   * units), and the cart line only exists after "Add to cart"; the tile can also re-render while
   * the filtered list settles, so the tap is retried.
   */
  async addToCart(qty) {
    await this.clickTest("nav-sell");
    await this.type("sell-search", NAME);
    for (let attempt = 0; attempt < 6; attempt++) {
      await this.waitFor(`[...document.querySelectorAll('[data-testid^="sell-product-"]')].some(e=>e.innerText.includes(${JSON.stringify(NAME)}))`, "product tile");
      await this.evaluate(`(()=>{const el=[...document.querySelectorAll('[data-testid^="sell-product-"]')].find(e=>e.innerText.includes(${JSON.stringify(NAME)})); if(!el)return false; el.scrollIntoView({block:"center"}); el.click(); return true;})()`);
      for (let i = 0; i < 12; i++) {
        if (await this.evaluate(`!!${this.q("sell-quick-qty")}`)) break;
        await sleep(200);
      }
      if (await this.evaluate(`!!${this.q("sell-quick-qty")}`)) break;
    }
    await this.waitTest("sell-quick-qty");
    await this.type("sell-quick-qty", qty);
    await this.clickTest("sell-quick-add");
    await this.waitTest("sell-qty-0");
  }
  /** API requests only: the page itself must keep working from IndexedDB. */
  blockApi(block) { return this.send("Network.setBlockedURLs", { urls: block ? [`${API}/*`] : [] }); }

  async login(email) {
    await this.go("/login");
    await this.type("login-email", email);
    await this.type("login-password", PASSWORD);
    await this.clickTest("login-submit");
    await this.waitFor(`location.pathname !== "/login"`, "login redirect", 30_000);
    await this.waitTest("nav-home", 30_000);
  }
  /** Queued work this device still has to send. */
  outboxPending() {
    return this.evaluate(`new Promise((resolve,reject)=>{const r=indexedDB.open('sms-local');r.onerror=()=>reject('idb');
      r.onsuccess=()=>{const db=r.result;const g=db.transaction('state','readonly').objectStore('state').get('state');
      g.onsuccess=()=>resolve((g.result?.outbox??[]).filter(o=>o.status==='pending'||o.status==='retry').length);};})`);
  }
  /** The settled on-hand this device holds for the product, as the app would show it. */
  localOnHand() {
    return this.evaluate(`new Promise((resolve,reject)=>{const r=indexedDB.open('sms-local');r.onerror=()=>reject('idb');
      r.onsuccess=()=>{const db=r.result;const g=db.transaction('state','readonly').objectStore('state').get('state');
      g.onsuccess=()=>{const p=(g.result?.products??[]).find(x=>x.name===${JSON.stringify(NAME)});resolve(p?Number(p.on_hand):null);};};})`);
  }
  async close() {
    try { this.ws?.close(); } catch { /* already closed */ }
    try { this.chrome?.kill(); } catch { /* already gone */ }
    await sleep(300);
  }
}

/* ------------------------------------------------------------------ server-side truth */

let token = null;
async function apiToken() {
  if (token) return token;
  const r = await fetch(`${API}/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "manager@demo.local", password: PASSWORD }),
  });
  const body = await r.json();
  assert.ok(body.token, `API sign-in failed (${r.status})`);
  token = body.token;
  return token;
}
async function serverProduct() {
  const r = await fetch(`${API}/sync/pull`, { headers: { Authorization: `Bearer ${await apiToken()}` } });
  const body = await r.json();
  return body.changes.find((c) => c.entity === "product" && c.data.name === NAME)?.data ?? null;
}
async function waitServerOnHand(expected, label, timeout = 30_000) {
  const end = Date.now() + timeout;
  let seen = null;
  while (Date.now() < end) {
    seen = (await serverProduct())?.onHand ?? null;
    if (Number(seen) === expected) return;
    await sleep(400);
  }
  throw new Error(`${label}: expected server on-hand ${expected}, server has ${seen}`);
}

/* ------------------------------------------------------------------ the scenarios */

const started = Date.now();
const step = async (title, fn) => {
  const at = ((Date.now() - started) / 1000).toFixed(1);
  process.stdout.write(`\n▶ [${at}s] ${title}\n`);
  await fn();
  process.stdout.write(`✔ ${title}\n`);
};

let web = null;
const A = new Browser("a", 9333);
const B = new Browser("b", 9334);

try {
  await step("the API and the web app are running", async () => {
    web = await serveStatic();
    startApi();
    await apiUp();
  });

  await step("two independent browsers sign in to the same shop", async () => {
    await A.open(); await B.open();
    await A.login("owner@demo.local");
    await B.login("manager@demo.local");
    // Independent browsers, not two tabs: separate profiles mean separate IndexedDB and cookies.
    assert.notEqual(A.profile, B.profile);
  });

  await step("work created in browser A reaches browser B", async () => {
    await A.clickTest("nav-stock");
    await A.clickTest("stock-add-toggle");
    await A.waitTest("stock-name");
    await A.type("stock-name", NAME);
    await A.type("stock-code", CODE);
    await A.type("stock-qty", "20");
    await A.type("stock-cost", "700");
    await A.type("stock-price", "1000");
    await A.type("stock-low", "2");
    await A.clickTest("stock-save-product");
    await A.waitText("Product saved", 15_000);
    // The stock form is in base units: 20 selling units are 20 000 here (the app's own convention).
    await waitServerOnHand(20000, "product creation");

    // B learns about it the normal way: its own authorised pull, on opening the stock screen.
    await B.clickTest("nav-stock");
    await B.waitText(NAME, 30_000);
    const end = Date.now() + 30_000;
    while (Date.now() < end && (await B.localOnHand()) !== 20000) await sleep(400);
    assert.equal(await B.localOnHand(), 20000, "browser B received the product and its stock");
  });

  await step("a sale in A is counted once and converges in B", async () => {
    await A.addToCart("2");
    await A.clickTest("sell-save");
    await A.waitText("Sale saved", 15_000);
    await waitServerOnHand(18000, "online sale");

    const end = Date.now() + 40_000;
    while (Date.now() < end && (await B.localOnHand()) !== 18000) await sleep(500);
    assert.equal(await B.localOnHand(), 18000, "browser B reconciled to the server figure");
  });

  await step("the server goes away: A keeps the sale, reports the cause, and deletes nothing", async () => {
    await stopApi();
    await A.addToCart("1");
    await A.clickTest("sell-save");
    await A.waitText("Sale saved", 15_000);

    const queued = await A.outboxPending();
    assert.ok(queued >= 1, `the sale is queued, found ${queued}`);
    // A manual attempt must actually try, then say the server could not be reached — and keep the work.
    await A.go("/sync");
    await A.clickTest("sync-now");
    await A.waitText("last sync attempt failed", 30_000);
    assert.ok((await A.outboxPending()) >= 1, "a failed attempt never drops the queued sale");
    await A.waitTest("sync-pending-count");
    assert.ok(Number(await A.evaluate(`${A.q("sync-pending-count")}.innerText`)) >= 1, "the pending count is still shown");
  });

  await step("closing and reopening the browser keeps unsynced work", async () => {
    await A.close();
    await A.open();
    await A.go("/");
    await A.waitTest("nav-home", 45_000);
    assert.ok((await A.outboxPending()) >= 1, "the queued sale survived the browser restart");
  });

  await step("the server returns and A recovers by itself", async () => {
    startApi();
    await apiUp();
    token = null; // the previous process is gone; use a fresh sign-in against the new one
    // No button press: the engine's own backoff must bring the queue back.
    const end = Date.now() + 150_000;
    let queued = -1;
    while (Date.now() < end) {
      queued = await A.outboxPending();
      if (queued === 0) break;
      await sleep(1000);
    }
    assert.equal(queued, 0, "the queue drained without a manual retry");
    // Both sales counted exactly once: 20 000 − 2 000 (online) − 1 000 (offline, retried) = 17 000.
    await waitServerOnHand(17000, "recovery");
  });

  await step("B converges on the recovered sale without duplicating it", async () => {
    const end = Date.now() + 60_000;
    while (Date.now() < end && (await B.localOnHand()) !== 17000) {
      await B.go("/stock"); await B.waitText(NAME, 20_000); await sleep(1000);
    }
    assert.equal(await B.localOnHand(), 17000, "browser B shows the server-confirmed figure");
    await waitServerOnHand(17000, "convergence");
  });

  process.stdout.write("\nAll two-browser sync scenarios passed.\n");
} finally {
  await A.close();
  await B.close();
  if (api) { try { api.kill(); } catch { /* stopped */ } }
  try { web?.close(); } catch { /* closed */ }
  try { rmSync(A.profile, { recursive: true, force: true }); } catch { /* windows lock */ }
  try { rmSync(B.profile, { recursive: true, force: true }); } catch { /* windows lock */ }
}
