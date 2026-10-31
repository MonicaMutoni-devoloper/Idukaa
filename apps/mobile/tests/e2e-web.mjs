/**
 * Real browser end-to-end check of the web app against a running API.
 *
 * Prerequisites: API on :3000, a static export of the web app served on :8081 with SPA fallback
 * (`npx serve apps/mobile/dist -l 8081 --single`), Chrome installed, demo data seeded.
 *
 *   node apps/mobile/tests/e2e-web.mjs
 *
 * It writes real records to the DEVELOPMENT database using demo accounts. Never point it at production.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { randomUUID as uuid } from "node:crypto";

const WEB = process.env.WEB_URL ?? "http://localhost:8081";
const API = process.env.API_URL ?? "http://localhost:3000";
const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT ?? 9333);
const PASSWORD = process.env.DEMO_PASSWORD ?? "dev-password-2026";
const PRODUCT = `UI Test Rice ${Date.now().toString(36)}`;
const CODE = `UIT-${Date.now().toString(36).slice(-5).toUpperCase()}`;
const BARCODE = `B${Date.now().toString(36).toUpperCase()}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sms-e2e-"));
const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`,
  "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--disable-extensions",
  "--window-size=1440,960", "about:blank",
], { stdio: "ignore" });

let ws;
const pendingCalls = new Map();
const consoleErrors = [];
let seq = 0;

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
  await sleep(120);
}
async function clickText(label, last = false) {
  const ok = await evaluate(`(()=>{const all=[...document.querySelectorAll('[role="button"]')].filter(e=>e.innerText.trim()===${JSON.stringify(label)}); const el=${last ? "all.at(-1)" : "all[0]"}; if(!el)return false; el.scrollIntoView({block:"center"}); el.click(); return true;})()`);
  if (!ok) throw new Error(`Button not found by text: ${label}`);
  await sleep(120);
}
/** React Native Web renders Switch as an input inside a wrapper; click the input itself. */
async function toggleSwitch(id) {
  const ok = await evaluate(`(()=>{const el=${q(id)}; if(!el)return false; const input=el.tagName==='INPUT'?el:el.querySelector('input'); (input??el).click(); return true;})()`);
  if (!ok) throw new Error(`Switch not found: ${id}`);
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
async function clickContaining(prefix, text) {
  const ok = await evaluate(`(()=>{const el=[...document.querySelectorAll('[data-testid^="${prefix}"]')].find(e=>e.innerText.includes(${JSON.stringify(text)})); if(!el)return false; el.scrollIntoView({block:"center"}); el.click(); return true;})()`);
  if (!ok) throw new Error(`No ${prefix} containing "${text}"`);
  await sleep(150);
}
async function go(path) {
  await send("Page.navigate", { url: WEB + path });
  await sleep(1500);
}
/**
 * The web app keeps only a short-lived access token in memory; the refresh token is an HttpOnly cookie.
 * These API calls therefore sign in separately instead of reading a token from localStorage.
 */
let apiToken = null;
let currentEmail = null;
async function token() {
  if (apiToken) return apiToken;
  const r = await fetch(`${API}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: currentEmail, password: PASSWORD }) });
  const body = await r.json();
  assert.ok(body.token, `API sign-in for ${currentEmail} returned a token`);
  apiToken = body.token;
  return apiToken;
}
async function api(path, tk) {
  const r = await fetch(API + path, { headers: tk ? { Authorization: `Bearer ${tk}` } : {} });
  const body = await r.text();
  return { status: r.status, body: body ? JSON.parse(body) : null };
}
async function serverProduct(name) {
  const tk = await token();
  const { body } = await api("/sync/pull", tk);
  return body.changes.find((c) => c.entity === "product" && c.data.name === name)?.data;
}
async function waitStock(expected, label) {
  const end = Date.now() + 25000;
  while (Date.now() < end) {
    const p = await serverProduct(PRODUCT);
    if (p && Number(p.onHand) === expected) return;
    await sleep(500);
  }
  const p = await serverProduct(PRODUCT);
  throw new Error(`${label}: expected on-hand ${expected}, server has ${p?.onHand}`);
}
/** Waits until the local queue has no pending/retry operations, so local pending deltas have settled. */
async function waitOutboxDrained(label, timeout = 20000) {
  const end = Date.now() + timeout;
  let pending = -1;
  while (Date.now() < end) {
    pending = await evaluate(`new Promise((resolve,reject)=>{const r=indexedDB.open('sms-local');r.onerror=()=>reject('idb');r.onsuccess=()=>{const db=r.result;const g=db.transaction('state','readonly').objectStore('state').get('state');g.onsuccess=()=>resolve((g.result?.outbox??[]).filter(o=>o.status==='pending'||o.status==='retry').length);};})`);
    if (pending === 0) return;
    await sleep(400);
  }
  throw new Error(`${label}: ${pending} operations still queued locally`);
}
async function login(email) {
  currentEmail = email; apiToken = null;
  await go("/login");
  await waitTest("login-email");
  await type("login-email", email);
  await type("login-password", PASSWORD);
  // Password visibility: the value survives the toggle, and the field is concealed again afterwards.
  await clickTest("login-password-toggle");
  assert.equal(await evaluate(`${q("login-password")}.type`), "text", "the password can be revealed");
  assert.equal(await evaluate(`${q("login-password")}.value`), PASSWORD, "revealing does not change the value");
  await clickTest("login-password-toggle");
  assert.equal(await evaluate(`${q("login-password")}.type`), "password", "the password is concealed again");
  await clickTest("login-submit");
  // Sign-in deliberately allows only 8 attempts per minute per IP (asserted by the security
  // suite). A long end-to-end run with several sign-outs can legitimately reach that ceiling,
  // so if the form is still on /login once it settles, wait out the sliding window and retry
  // once instead of failing the flow for a real anti-brute-force control.
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && (await evaluate("location.pathname")) === "/login") await sleep(250);
  if ((await evaluate("location.pathname")) === "/login") {
    await sleep(61000);
    await clickTest("login-submit");
  }
  await waitFor(`location.pathname !== "/login"`, "login redirect", 15000);
}
async function logout() {
  await go("/settings");
  await waitTest("settings-signout");
  await clickTest("settings-signout");
  await clickText("Sign out", true); // confirm inside the dialog
  await waitTest("login-email", 15000);
}
/**
 * Sign-in deliberately allows only 8 attempts per minute per address (asserted by the security
 * suite). A long end-to-end run mixing UI and API sign-ins can reach that ceiling at any of its
 * sign-in points; the only visible symptom is the form's generic error. When that is what
 * happened, wait out the sliding window and submit once more so the flow under test still runs.
 */
async function retrySubmitIfThrottled(expectedText) {
  await sleep(2500);
  const txt = await evaluate("document.body.innerText");
  if (txt.includes("Something went wrong") && !txt.includes(expectedText)) {
    await sleep(61000);
    await clickTest("login-submit");
  }
}

const steps = [];
const step = async (name, fn) => { process.stdout.write(`\n→ ${name}\n`); await fn(); steps.push(name); console.log(`  ✓ ${name}`); };
const ALL_TIME = `from=2000-01-01T00%3A00%3A00.000Z&to=2100-01-01T00%3A00%3A00.000Z`;
let voidSaleId = null;
let managerName = "Demo Manager";
/** Registration journey (set by the registration steps below). */
let REG_EMAIL = null, REJ_EMAIL = null, REG_SHOP = null;

/** Newest posted sale in this shop, used to prove voiding through the UI. */
async function newestPostedSale(tk) {
  const r = await api(`/reports/transactions?kind=sales&${ALL_TIME}`, tk);
  assert.equal(r.status, 200, "transaction list is available to a manager");
  return r.body.find((row) => row.status === "posted") ?? null;
}

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
    }
  };
  await send("Runtime.enable"); await send("Page.enable"); await send("Network.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });

  await step("manager signs in", async () => {
    await login("manager@demo.local");
    await waitTest("home-action-sell");
  });

  await step("stock: add a product together with its initial stock", async () => {
    await clickTest("nav-stock");
    await waitTest("stock-add-toggle");
    await clickTest("stock-add-toggle");
    await waitTest("stock-code");
    await type("stock-name", PRODUCT);
    await type("stock-code", CODE);
    await type("stock-barcode", BARCODE);
    await type("stock-qty", "20");
    await type("stock-cost", "900");
    await type("stock-price", "1200");
    await type("stock-low", "5");
    // The form calculates the order's total cost and margin while typing: 20 × 900 = 18,000 RWF.
    await waitTest("stock-calc-total", 10000);
    assert.equal(await evaluate(`${q("stock-calc-total")}.innerText`), "18,000 RWF", "total stock cost is calculated live");
    assert.equal(await evaluate(`${q("stock-calc-profit")}.innerText`), "300 RWF", "profit per unit is calculated live");
    assert.equal(await evaluate(`${q("stock-calc-margin")}.innerText`), "25%", "gross margin is calculated live");
    await clickTest("stock-save-product");
    await waitText("Product saved", 10000);
    await waitStock(20000, "product creation");
    const created = await serverProduct(PRODUCT);
    assert.equal(created?.barcode, BARCODE, "the barcode entered on the product form reached the server");
  });

  await step("stock: required fields are validated before anything is saved", async () => {
    await clickTest("stock-add-toggle"); // open the form again (the previous save closed it)
    await waitTest("stock-name", 10000);
    await clickTest("stock-save-product");
    await waitText("Enter the product name", 10000);
    const productsBefore = (await api("/sync/pull", await token())).body.changes.filter((c) => c.entity === "product").length;
    await type("stock-name", "Must not be created");
    await type("stock-qty", "0");
    await type("stock-cost", "100");
    await type("stock-price", "0");
    await clickTest("stock-save-product");
    await waitText("quantity greater than zero", 10000);
    const productsAfter = (await api("/sync/pull", await token())).body.changes.filter((c) => c.entity === "product").length;
    assert.equal(productsAfter, productsBefore, "an invalid form never reaches the server");
    await clickTest("stock-add-toggle"); // cancel the form
  });

  await step("sell: one sale reduces server stock", async () => {
    await clickTest("nav-sell");
    await waitTest("sell-search");
    await type("sell-search", BARCODE); // a scanned or typed barcode must find the product
    await waitFor(`[...document.querySelectorAll('[data-testid^="sell-product-"]')].some(e=>e.innerText.includes(${JSON.stringify(PRODUCT)}))`, "product tile by barcode");
    await type("sell-search", PRODUCT);
    await waitFor(`[...document.querySelectorAll('[data-testid^="sell-product-"]')].some(e=>e.innerText.includes(${JSON.stringify(PRODUCT)}))`, "product tile");
    await clickContaining("sell-product-", PRODUCT);
    await waitTest("sell-qty-0");
    await type("sell-qty-0", "2");
    await clickTest("segment-momo");
    await clickTest("sell-save");
    await waitText("Sale saved", 10000);
    await waitStock(18000, "sale");
    const receipt = await evaluate(`${q("sell-saved-method")}.innerText`);
    assert.match(receipt, /Mobile money/i, "the receipt shows the selected payment method");
    const latest = await newestPostedSale(await token());
    assert.ok(latest, "the sale is listed for the cashier");
    assert.equal(latest.payment_method, "momo", "the server stored the mobile-money payment method");
  });

  await step("offline: a sale is saved locally, survives reload, then syncs", async () => {
    await send("Network.setBlockedURLs", { urls: [`${API}/*`] });
    await clickTest("nav-sell");
    await waitTest("sell-search");
    await type("sell-search", PRODUCT);
    await waitFor(`[...document.querySelectorAll('[data-testid^="sell-product-"]')].some(e=>e.innerText.includes(${JSON.stringify(PRODUCT)}))`, "product tile");
    await clickContaining("sell-product-", PRODUCT);
    await type("sell-qty-0", "1");
    await clickTest("sell-save");
    await waitText("Sale saved", 10000);
    await sleep(1500);

    await send("Page.reload");
    await waitTest("nav-home", 20000); // app restarts from IndexedDB with the session intact
    const pending = await evaluate(`new Promise((resolve,reject)=>{const r=indexedDB.open('sms-local');r.onerror=()=>reject('idb');r.onsuccess=()=>{const db=r.result;const g=db.transaction('state','readonly').objectStore('state').get('state');g.onsuccess=()=>resolve((g.result?.outbox??[]).filter(o=>o.status==='pending'||o.status==='retry').length);};})`);
    assert.ok(pending >= 1, `queued operation should survive reload, found ${pending}`);
    await clickTest("nav-sync");
    await waitText("Waiting to sync", 10000);

    await send("Network.setBlockedURLs", { urls: [] });
    await waitTest("sync-now");
    await clickTest("sync-now");
    await waitStock(17000, "offline sale after reconnect");
    await waitFor(`!document.body.innerText.includes("Waiting to sync")`, "queue drained", 20000);
    voidSaleId = (await newestPostedSale(await token()))?.id ?? null;
    assert.ok(voidSaleId, "the offline sale can be identified for the void check");
  });

  await step("offline: a product created with no network syncs once, without duplicate stock", async () => {
    const offCode = `OFF-${Date.now().toString(36).slice(-5).toUpperCase()}`;
    const offName = `Offline Product ${Date.now().toString(36)}`;
    await send("Network.setBlockedURLs", { urls: [`${API}/*`] });
    await clickTest("nav-stock");
    await waitTest("stock-add-toggle", 20000);
    await clickTest("stock-add-toggle");
    await waitTest("stock-name");
    await type("stock-name", offName);
    await type("stock-code", offCode);
    await type("stock-qty", "7");
    await type("stock-cost", "100");
    await type("stock-price", "150");
    await type("stock-low", "1");
    await clickTest("stock-save-product");
    await waitText("Product saved", 10000);
    await type("stock-search", offCode);
    await waitFor(`document.body.innerText.includes(${JSON.stringify(offName)})`, "product listed locally while offline");

    // The queue and the product survive a full reload (nothing is lost when the tab closes).
    await send("Page.reload");
    await waitTest("nav-home", 20000);
    await clickTest("nav-stock");
    await waitTest("stock-search", 20000);
    await type("stock-search", offCode);
    await waitFor(`document.body.innerText.includes(${JSON.stringify(offName)})`, "queued product survives the reload");

    await send("Network.setBlockedURLs", { urls: [] });
    await clickTest("nav-sync");
    await waitTest("sync-now");
    await clickTest("sync-now");
    await waitFor(`!document.body.innerText.includes("Waiting to sync")`, "queue drained", 25000);

    let created = null;
    const end = Date.now() + 20000;
    while (Date.now() < end && !created) { created = await serverProduct(offName); if (!created) await sleep(400); }
    assert.ok(created, "the offline product reached the server");
    assert.equal(created.code, offCode, "the code entered offline reached the server");
    assert.equal(Number(created.onHand), 7000, "its initial stock is registered exactly once (7 units, never doubled)");
  });

  await step("stock: below-cost pricing needs a reason and updates the product price", async () => {
    const before = Number((await serverProduct(PRODUCT)).onHand);
    await clickTest("nav-stock");
    await waitTest(`stock-add-stock-${CODE}`, 15000);
    await clickTest(`stock-add-stock-${CODE}`);
    await waitTest("stock-qty-received");
    await type("stock-qty-received", "1");
    await type("stock-unit-cost", "1000");
    await type("stock-selling-price", "800");
    await waitTest("stock-below-reason", 10000); // below-cost pricing asks for a reason immediately
    await type("stock-below-reason", "Clearing slow-moving stock");
    await clickTest("stock-save-stock");
    await waitText("Stock received", 10000);
    await waitStock(before + 1000, "below-cost purchase received");
    const p = await serverProduct(PRODUCT);
    assert.equal(Number(p.sellingPrice), 800, "the selling price entered on the receipt becomes the product price");
  });

  await step("stock: add stock to the existing product and edit its details", async () => {
    // Local pending deltas must have settled, otherwise the dialog's optimistic figure and the
    // server figure legitimately differ for a moment.
    await waitOutboxDrained("stock add step");
    const before = Number((await serverProduct(PRODUCT)).onHand);
    await clickTest("nav-stock");
    await waitTest(`stock-add-stock-${CODE}`, 15000);
    await clickTest(`stock-add-stock-${CODE}`);
    await waitTest("stock-qty-received");
    await type("stock-qty-received", "20");
    await type("stock-unit-cost", "900");
    await type("stock-selling-price", "1300");
    // Assert the arithmetic on the dialog's own figures: it refreshes "current stock" from the server,
    // so this stays true even when another operation changed the shelf between steps.
    await waitTest("stock-preview-current", 15000);
    const currentText = await evaluate(`${q("stock-preview-current")}.innerText`);
    const afterText = await evaluate(`${q("stock-preview-after")}.innerText`);
    assert.equal(Number.parseFloat(afterText) - Number.parseFloat(currentText), 20,
      `the dialog shows previous stock + received = new stock (${currentText} → ${afterText})`);
    assert.equal(Number.parseFloat(currentText) * 1000, before,
      "the dialog's current stock matches the confirmed server figure");
    await clickTest("stock-save-stock");
    await waitText("Stock received", 10000);
    await waitStock(before + 20000, "stock added to the existing product");

    // The same product was updated, not duplicated.
    const products = (await api("/sync/pull", await token())).body.changes.filter((c) => c.entity === "product" && c.data.code === CODE);
    assert.equal(products.length, 1, "receiving stock never creates a second product record");

    // Editing details must not move stock.
    await clickTest(`stock-edit-${CODE}`);
    await waitTest("stock-edit-price");
    await type("stock-edit-price", "1400");
    await clickTest("stock-save-product-edit");
    await waitText("Product details saved", 10000);
    const end = Date.now() + 20000;
    while (Date.now() < end && Number((await serverProduct(PRODUCT))?.sellingPrice) !== 1400) await sleep(400);
    const edited = await serverProduct(PRODUCT);
    assert.equal(Number(edited.sellingPrice), 1400, "the edited price reached the server");
    assert.equal(Number(edited.onHand), before + 20000, "editing details does not change stock");
  });

  await step("sales: a manager sees sales, products sold and a sale's items", async () => {
    await clickTest("nav-reports");
    await waitText("Period total", 15000);

    await clickTest("segment-items");
    await waitText(PRODUCT, 15000);
    const itemsText = await evaluate("document.body.innerText");
    assert.ok(itemsText.includes("Products sold"), "managers get the products-sold view");

    await clickTest("segment-sales");
    const latest = await newestPostedSale(await token());
    assert.ok(latest, "a posted sale is listed for the manager");
    await waitTest(`sale-open-${latest.id}`, 15000);
    await clickTest(`sale-open-${latest.id}`);
    await waitText("Sale details", 15000);
    const detail = await evaluate("document.body.innerText");
    assert.ok(detail.includes(PRODUCT), "the sale dialog lists the product that was sold");
    await clickText("Close", true);
  });

  await step("settings: profile, security and password visibility", async () => {
    await clickTest("nav-settings");
    await waitTest("settings-name", 15000);
    await waitTest("settings-current-password", 15000);

    await clickTest("settings-current-password-toggle");
    assert.equal(await evaluate(`${q("settings-current-password")}.type`), "text", "settings can reveal the password");
    await clickTest("settings-current-password-toggle");
    assert.equal(await evaluate(`${q("settings-current-password")}.type`), "password", "settings conceals it again");

    const me = (await api("/auth/me", await token())).body;
    managerName = me.name;
    await type("settings-name", "Manager Renamed");
    await clickTest("settings-save-name");
    await waitText("Name saved", 10000);
    assert.equal((await api("/auth/me", await token())).body.name, "Manager Renamed", "the display name is persisted");
    await type("settings-name", me.name);
    await clickTest("settings-save-name");
    await waitText("Name saved", 10000);
    assert.equal((await api("/auth/me", await token())).body.name, me.name, "and can be restored");

    // The short-lived access token survives a reload only by re-exchanging the HttpOnly refresh cookie.
    await send("Page.reload");
    await waitTest("nav-home", 20000);
    assert.equal((await api("/auth/me", await token())).status, 200, "the refreshed session still works after a reload");
  });

  await step("notifications: preferences are saved to the account and the inbox renders", async () => {
    await clickTest("nav-notifications");
    await waitTest("pref-lowStock", 15000);
    await waitTest("pref-security", 15000);
    const before = (await api("/notifications/preferences", await token())).body;
    await toggleSwitch("pref-lowStock");
    await waitText("Notification preferences saved", 10000);
    const after = (await api("/notifications/preferences", await token())).body;
    assert.equal(after.lowStock, !before.lowStock, "the toggle is persisted by the API");
    assert.equal(after.security, true, "security notifications are always on");
    await toggleSwitch("pref-lowStock");
    await waitText("Notification preferences saved", 10000);
    const restored = (await api("/notifications/preferences", await token())).body;
    assert.equal(restored.lowStock, before.lowStock, "and can be restored");
    await clickTest("notifications-mark-read");
  });

  await step("security: two-step verification status and session controls render", async () => {
    await clickTest("nav-security");
    await waitTest("security-logout-all", 15000);
    const text = await evaluate("document.body.innerText");
    assert.ok(/two-step verification/i.test(text), "the 2FA card is shown");
    const status = await api("/auth/2fa", await token());
    assert.equal(status.status, 200);
    assert.equal(typeof status.body.enabled, "boolean");
    assert.equal("secret" in status.body, false, "no TOTP secret is ever returned");
  });

  await step("manager requests an adjustment (owner approval pending)", async () => {
    const tk = await token();
    const p = await serverProduct(PRODUCT);
    const op = { opId: uuid(), deviceId: "e2e", createdAt: new Date().toISOString(), type: "adjustment.request",
      payload: { adjustmentId: uuid(), productId: p.id, qty: -1000, reason: "damage", note: "E2E damaged bag" } };
    const r = await fetch(`${API}/sync/push`, { method: "POST", headers: { Authorization: `Bearer ${tk}`, "Content-Type": "application/json" }, body: JSON.stringify({ operations: [op] }) });
    const body = await r.json();
    assert.equal(body.results[0].status, "pending_approval");
  });

  await step("owner: dashboard, sale void, report drill-down, approval and shop policy", async () => {
    await logout();
    await login("owner@demo.local");
    await waitTest("kpi-netSales");
    const dash = (await evaluate("document.body.innerText")).toLowerCase();
    for (const label of ["net sales", "gross profit", "operating profit", "cash collected"]) assert.ok(dash.includes(label), `dashboard shows ${label}`);

    // Drill-down from the dashboard opens the same period's transactions in Reports.
    await clickText("Sales");
    await waitText("Period total", 15000);
    await waitText(managerName, 15000); // cashier column proves a sale row is listed

    await clickTest("nav-reports");
    await waitText("Period total", 15000);
    await waitTest("reports-export", 15000);

    // Void the sale recorded in this run; stock must come back and the reason must be kept.
    const tkSales = await token();
    assert.ok(voidSaleId, "a posted sale is available to void");
    const beforeVoid = Number((await serverProduct(PRODUCT)).onHand);
    await waitTest(`sale-open-${voidSaleId}`, 15000);
    await clickTest(`sale-open-${voidSaleId}`);
    await waitText("Sale details", 15000);
    await waitTest(`void-${voidSaleId}`, 15000);
    await clickTest(`void-${voidSaleId}`);
    await type("reports-void-reason", "E2E duplicate check");
    await clickText("Void sale", true);
    await waitText("Sale voided", 15000);
    await waitStock(beforeVoid + 1000, "voided sale returns its stock");
    const after = await api(`/reports/transactions?kind=sales&${ALL_TIME}`, tkSales);
    assert.equal(after.body.find((row) => row.id === voidSaleId)?.status, "reversed", "the voided sale stays visible and is marked reversed");

    await clickTest("nav-approvals");
    await waitFor(`!!document.querySelector('[data-testid^="reason-"]')`, "adjustment queue", 15000);
    // Identify this run's adjustment by product id through the API; older pending items may exist.
    const tk = await token();
    const p = await serverProduct(PRODUCT);
    const before = Number(p.onHand);
    const list = await api("/audit/adjustments/pending", tk);
    const adj = list.body.find((a) => a.product_id === p.id);
    assert.ok(adj, "adjustment for this product is queued");
    await waitTest(`approve-${adj.id}`, 15000);
    await type(`reason-${adj.id}`, "Confirmed damaged bag in the back room");
    await clickTest(`approve-${adj.id}`);
    await waitText("Adjustment approved", 15000);
    await waitStock(before - 1000, "approved adjustment");

    // Owner-controlled policy is saved through the API and shown in Settings.
    await clickTest("nav-settings");
    await waitTest("policy-manager-finance", 15000);
    await clickTest("policy-save");
    await waitText("Shop policy saved", 15000);
  });

  await step("admin: separate area, no tenant financial access", async () => {
    await logout();
    await login("admin@demo.local");
    await waitText("Account access is separate from shop data", 20000);
    await waitTest("admin-stat-shops");
    const adminText = await evaluate("document.body.innerText");
    assert.ok(!adminText.includes("Net sales"), "admin overview exposes no sales metrics");
    const tk = await token();
    const denied = await api("/reports/summary?from=2026-01-01T00:00:00.000Z&to=2026-01-02T00:00:00.000Z", tk);
    assert.equal(denied.status, 403, "admin is refused shop reports");
    await clickTest("nav-admin-users");
    await waitText("owner@demo.local", 15000);

    // Create a disposable account, then revoke it (newest row is first).
    const tempEmail = `e2e-${Date.now().toString(36)}@demo.local`;
    await type("admin-user-name", "E2E Temp Manager");
    await type("admin-user-email", tempEmail);
    await type("admin-user-password", "temp-password-123");
    await clickTest("admin-user-create");
    await waitText("Created", 15000);
    await waitText(tempEmail, 15000);
    await clickText("Revoke");
    await clickText("Revoke", true);
    await waitText("Access revoked", 15000);

    await clickTest("nav-admin-health");
    await waitText("Database time", 15000);
  });

  await step("sign-in is the first screen; Create a Shop opens only on request", async () => {
    await logout();
    await go("/");
    await waitTest("login-email", 15000);
    assert.equal(await evaluate("location.pathname"), "/login", "an unauthenticated visit lands on Sign In");
    assert.equal(await evaluate(`!!document.querySelector('[data-testid="reg-username"]')`), false,
      "the registration form never opens by itself");

    await clickTest("login-create-shop");
    await waitTest("reg-username");
    // Exactly the five required fields (the visibility toggle is a button, not an input).
    assert.equal(await evaluate(`document.querySelectorAll('input').length`), 5, "the form asks for exactly five fields");
    for (const id of ["reg-username", "reg-shop", "reg-email", "reg-password", "reg-phone", "reg-submit", "reg-signin"]) {
      assert.ok(await evaluate(`!!document.querySelector('[data-testid="${id}"]')`), `${id} is present`);
    }

    // The Sign In link returns to the existing login page without submitting anything.
    await clickTest("reg-signin");
    await waitTest("login-email", 15000);
    assert.equal(await evaluate(`!!document.querySelector('[data-testid="reg-username"]')`), false, "back on Sign In");
  });

  await step("registration submits pending applications; sign-in stays blocked with the pending message", async () => {
    const stamp = Date.now().toString(36);
    REG_EMAIL = `e2e-reg-${stamp}@demo.local`;
    REJ_EMAIL = `e2e-rej-${stamp}@demo.local`;
    REG_SHOP = `E2E Reg Mart ${stamp}`;

    await clickTest("login-create-shop");
    await waitTest("reg-username");
    await type("reg-username", "E2E Reg Owner");
    await type("reg-shop", REG_SHOP);
    await type("reg-email", REG_EMAIL);
    await type("reg-password", PASSWORD);
    await type("reg-phone", "+250788123456");
    await clickTest("reg-submit");
    await waitTest("reg-done", 20000);
    await waitText("awaiting administrator approval", 15000);
    await clickTest("reg-goto-login");
    await waitTest("login-email", 15000);

    // A second application, used below to prove the rejected message.
    await clickTest("login-create-shop");
    await waitTest("reg-username");
    await type("reg-username", "E2E Rejected Owner");
    await type("reg-shop", `E2E Rejected Mart ${stamp}`);
    await type("reg-email", REJ_EMAIL);
    await type("reg-password", PASSWORD);
    await type("reg-phone", "+250788123999");
    await clickTest("reg-submit");
    await waitTest("reg-done", 20000);
    await clickTest("reg-goto-login");
    await waitTest("login-email", 15000);

    // Pending applicant: the named message, still on Sign In, no session.
    await type("login-email", REG_EMAIL);
    await type("login-password", PASSWORD);
    await clickTest("login-submit");
    await retrySubmitIfThrottled("awaiting administrator approval");
    await waitText("Your shop registration is awaiting administrator approval.", 15000);
    assert.equal(await evaluate("location.pathname"), "/login", "a pending applicant never reaches the dashboard");
    assert.equal(await evaluate(`${q("login-email")}.value`), REG_EMAIL, "the form stays usable");
  });

  await step("administrator decides in the admin area; the approved owner signs in to their own shop", async () => {
    await login("admin@demo.local");
    await waitTest("nav-admin-applications", 20000);
    await clickTest("nav-admin-applications");
    await waitFor(`[...document.querySelectorAll('[data-testid^="app-card-"]')].some(e=>e.innerText.includes(${JSON.stringify(REG_EMAIL)}))`, "the pending application card", 20000);

    const clickInCard = (email, prefix) => evaluate(`(()=>{
      const card=[...document.querySelectorAll('[data-testid^="app-card-"]')].find(e=>e.innerText.includes(${JSON.stringify(email)}));
      if(!card) return false;
      const btn=card.querySelector('[data-testid^="${prefix}"]');
      if(!btn) return false;
      btn.scrollIntoView({block:"center"}); btn.click(); return true;})()`);

    // The complete request-information loop: the administrator asks, the applicant answers from
    // the public status page (fed by the status token saved at registration), then review continues.
    assert.ok(await clickInCard(REG_EMAIL, "app-request-"), "request-information button for the pending application");
    await waitTest("app-info-message", 15000);
    await type("app-info-message", "Please confirm the shop location and attach the trading licence");
    await clickTest("app-info-confirm");
    await waitText("Information requested", 15000);

    // Sign-in names the new state — only to whoever proves the registration password…
    await logout();
    await type("login-email", REG_EMAIL);
    await type("login-password", PASSWORD);
    await clickTest("login-submit");
    await retrySubmitIfThrottled("needs more information");
    await waitText("needs more information", 15000);

    // …and the status page, reached from the login screen, shows the message and takes the reply.
    await clickTest("login-track");
    await waitTest("track-respond", 20000);
    await type("track-reply", "The shop is behind the Kigali market; licence number 12345");
    await clickTest("track-respond");
    await waitText("back under review", 15000);

    // Back to the administrator: the file is pending again and can be approved.
    await login("admin@demo.local");
    await waitTest("nav-admin-applications", 20000);
    await clickTest("nav-admin-applications");
    await waitFor(`[...document.querySelectorAll('[data-testid^="app-card-"]')].some(e=>e.innerText.includes(${JSON.stringify(REG_EMAIL)}))`, "the pending application card", 20000);

    assert.ok(await clickInCard(REG_EMAIL, "app-approve-"), "approve button for the pending application");
    await waitText("Application approved", 15000);

    // Reject the second application through the same screen, with a required reason.
    assert.ok(await clickInCard(REJ_EMAIL, "app-reject-"), "reject button for the second application");
    await waitTest("app-reason", 15000);
    await type("app-reason", "Not enough documents for this application");
    await clickTest("app-reject-confirm");
    await waitText("Application rejected", 15000);

    // The approved owner signs in with the registration credentials and gets their own shop.
    await logout();
    await login(REG_EMAIL);
    await waitTest("home-action-sell", 20000);
    const me = await api("/auth/me", await token());
    assert.equal(me.body.role, "owner", "the applicant became the owner");
    assert.equal(me.body.shopName, REG_SHOP, "the owner's session carries their own shop");

    // The rejected applicant sees the rejection message and no session.
    await logout();
    await type("login-email", REJ_EMAIL);
    await type("login-password", PASSWORD);
    await clickTest("login-submit");
    await retrySubmitIfThrottled("Your shop registration was rejected.");
    await waitText("Your shop registration was rejected.", 15000);
    assert.equal(await evaluate("location.pathname"), "/login", "a rejected applicant never reaches the dashboard");

    // End signed in as the approved owner so the phone sweep below can sign out normally.
    // (Via the shared login() helper, which also waits out the sign-in rate limit if hit.)
    await login(REG_EMAIL);
    await waitTest("home-action-sell", 20000);

    // Shop-scoped local cache (bindShop): this browser held the demo shop's catalogue during the
    // sessions above. The new owner's stock must show none of it — their shop starts empty.
    await clickTest("nav-stock");
    await waitTest("stock-search", 15000);
    assert.equal(await evaluate(`!!document.querySelector('[data-testid="stock-edit-PEN-01"]')`), false,
      "no other shop's products leak into the new owner's stock");
    assert.ok(!(await evaluate("document.body.innerText")).includes("Ballpoint Pen"),
      "no foreign catalogue rows render on the new owner's stock screen");
  });

  await step("phone layout: tab bar and no horizontal overflow on every manager screen", async () => {
    await logout();
    await login("manager@demo.local");
    await waitTest("home-action-sell");

    // Back on the demo shop: the wipe on the account switch is followed by a full re-pull, so
    // the shop's own catalogue reappears (cache rebinding must not lose the right data).
    await clickTest("nav-stock");
    await waitTest("stock-edit-PEN-01", 20000);
    await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    for (const path of ["/", "/sell", "/stock", "/expense", "/sync", "/settings", "/notifications", "/security", "/more"]) {
      await go(path);
      await waitTest("tab-home", 20000);
      assert.ok(await evaluate("document.body.innerText.trim().length > 20"), `${path} renders content`);
      const overflow = await evaluate("document.documentElement.scrollWidth - window.innerWidth");
      assert.ok(overflow <= 1, `${path} has no horizontal overflow on a phone, got ${overflow}px`);
    }
    await send("Emulation.clearDeviceMetricsOverride");
  });

  console.log("\n── result ──");
  console.log(`${steps.length} scenarios passed`);
  if (consoleErrors.length) {
    console.log("\nBrowser console errors:");
    for (const e of consoleErrors) console.log(" -", e.split("\n")[0]);
    throw new Error("Browser reported runtime errors");
  }
  console.log("No runtime errors captured.");
} catch (e) {
  console.error("\nE2E FAILED:", e.message);
  try {
    const where = await evaluate("location.pathname");
    const body = await evaluate("document.body.innerText.slice(0,500)");
    const ids = await evaluate(`JSON.stringify([...document.querySelectorAll('[data-testid]')].map(e=>e.getAttribute('data-testid')).slice(0,60))`);
    const width = await evaluate("window.innerWidth");
    console.error(`URL: ${where} (innerWidth ${width})`);
    console.error(`TESTIDS: ${ids}`);
    console.error(`BODY: ${body}`);
    console.error(`MODAL: ${await evaluate("document.body.innerText.slice(-700)")}`);
    const outbox = await evaluate(`new Promise((resolve)=>{const r=indexedDB.open('sms-local');r.onerror=()=>resolve('idb-error');r.onsuccess=()=>{const db=r.result;const g=db.transaction('state','readonly').objectStore('state').get('state');g.onsuccess=()=>resolve(JSON.stringify((g.result?.outbox??[]).map(o=>({type:o.type,status:o.status,attempts:o.attempts,message:o.message,next:o.next_attempt_at}))));};})`);
    console.error(`OUTBOX: ${outbox}`);
  } catch { /* page gone */ }
  if (consoleErrors.length) for (const err of consoleErrors) console.error(" -", err.split("\n").slice(0, 3).join(" | "));
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch {}
  chrome.kill();
  await sleep(500);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
