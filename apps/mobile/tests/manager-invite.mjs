/**
 * End-to-end browser check of the owner → manager invitation workflow.
 *
 * Prerequisites: API on :3000, the Expo web dev server (npm run web) or a static export on :8081
 * with SPA fallback, Chrome installed, seeded demo data.
 *
 *   node apps/mobile/tests/manager-invite.mjs
 *
 * Walks the real UI like a person would:
 *   owner signs in → Team (sidebar) → Add manager → invitation link shown once (no e-mail provider)
 *   → duplicate invitation refused → /invite link opens → password policy enforced → manager sets
 *   their own password → owner signs out → new manager signs in → Team is NOT in the manager's nav
 *   → /team redirects a manager away → owner returns: invitation shows Accepted, staff shows the
 *   new manager → a second invitation can be revoked (terminal).
 *
 * NOTE: like e2e-web.mjs this writes real records to the DEVELOPMENT database (one unique manager
 * account + two invitations per run, addressed to @demo.local). Never point it at production.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const WEB = process.env.WEB_URL ?? "http://localhost:8081";
const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT ?? 9335);
const PASSWORD = process.env.DEMO_PASSWORD ?? "dev-password-2026";

const STAMP = Date.now().toString(36);
const MANAGER_EMAIL = `mgr-${STAMP}@demo.local`;
const MANAGER_NAME = `E2E Manager ${STAMP}`;
const MANAGER_PASSWORD = `Invite-${STAMP}2a`; // ≥10 chars, letter + digit
const SECOND_EMAIL = `mgr2-${STAMP}@demo.local`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sms-invite-"));
const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`,
  "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--disable-extensions",
  "--window-size=1440,960", "about:blank",
], { stdio: "ignore" });

let ws;
const pendingCalls = new Map();
let seq = 0;
const consoleErrors = [];

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
async function waitFor(expression, label, timeout = 25000) {
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
/** Exact-text button click; `last` picks the final match (dialogs render after page buttons). */
async function clickText(label, last = false) {
  const ok = await evaluate(`(()=>{const all=[...document.querySelectorAll('[role="button"],button')].filter(e=>e.innerText.trim()===${JSON.stringify(label)}); const el=${last ? "all.at(-1)" : "all[0]"}; if(!el)return false; el.scrollIntoView({block:"center"}); el.click(); return true;})()`);
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
  await send("Page.navigate", { url: path.startsWith("http") ? path : WEB + path });
  await sleep(1500);
}

async function login(email, password) {
  await go("/login");
  await waitTest("login-email", 90000); // first load compiles the Metro bundle — allow a cold start
  await type("login-email", email);
  await type("login-password", password);
  await clickTest("login-submit");
  await waitFor(`location.pathname !== "/login"`, "login redirect", 15000);
  await waitTest("home-action-sell");
}
async function logout() {
  await go("/settings");
  await waitTest("settings-signout");
  await clickTest("settings-signout");
  await clickText("Sign out", true); // confirm inside the dialog
  await waitTest("login-email", 15000);
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
    }
  };
  await send("Runtime.enable"); await send("Page.enable"); await send("Network.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });

  await step("owner signs in and Team is visible in the sidebar", async () => {
    await login("owner@demo.local", PASSWORD);
    await waitTest("nav-team", 15000);
    await clickTest("nav-team");
    await waitTest("team-screen", 15000);
    await waitText("Invite a manager", 10000);
    assert.equal(await evaluate(`${q("team-submit")}.disabled ?? true`), true, "submit stays disabled until name and e-mail are typed");
  });

  let inviteUrl = null;
  await step("owner creates a manager invitation and receives the one-time link", async () => {
    await type("team-name", MANAGER_NAME);
    await type("team-email", MANAGER_EMAIL);
    await clickTest("team-submit");
    await waitTest("team-invite-url", 20000);
    inviteUrl = (await evaluate(`${q("team-invite-url")}.innerText`)).trim();
    assert.match(inviteUrl, /\/invite\?token=.+/, "the created invitation returns an /invite link");
    await clickTest("team-done");
    await waitText(MANAGER_EMAIL, 10000);
    await waitText("Pending", 10000);
  });

  await step("a duplicate invitation for the same address is refused", async () => {
    await type("team-name", "Duplicate Try");
    await type("team-email", MANAGER_EMAIL);
    await clickTest("team-submit");
    await waitText("already pending", 15000);
    await waitText("Invite a manager", 5000); // still on the screen, form intact
  });

  await step("the invitation link enforces the password policy and creates the manager", async () => {
    await go(inviteUrl);
    await waitTest("invite-password", 60000);
    await waitText(MANAGER_EMAIL, 10000);
    await type("invite-password", "abc");
    await type("invite-confirm", "abc");
    await clickTest("invite-submit");
    await waitText("at least 10 characters", 10000);
    await type("invite-password", MANAGER_PASSWORD);
    await type("invite-confirm", MANAGER_PASSWORD);
    await clickTest("invite-submit");
    await waitTest("invite-to-login", 20000);
    await waitText("Welcome to", 10000);
  });

  await step("the new manager signs in with their own password — no Team in their nav", async () => {
    await logout();
    await login(MANAGER_EMAIL, MANAGER_PASSWORD);
    assert.equal(await evaluate(`!!${q("nav-team")}`), false, "managers never see the Team navigation");
    assert.ok((await evaluate("document.body.innerText")).includes("Reports"), "the manager still has their normal navigation");
  });

  await step("/team is refused for a manager (redirected out)", async () => {
    await go("/team");
    await waitFor(`location.pathname === "/"`, "redirect away from /team", 15000);
  });

  await step("owner returns: invitation shows Accepted and the manager is on the team", async () => {
    await logout();
    await login("owner@demo.local", PASSWORD);
    await clickTest("nav-team");
    await waitTest("team-screen", 15000);
    await waitText(MANAGER_EMAIL, 15000);
    await waitText("Accepted", 10000);
    await waitText(MANAGER_NAME, 10000);
  });

  await step("a second invitation can be revoked (terminal status)", async () => {
    await type("team-name", "Revoked Person");
    await type("team-email", SECOND_EMAIL);
    await clickTest("team-submit");
    await waitTest("team-invite-url", 20000);
    await clickTest("team-done");
    await waitFor(`[...document.querySelectorAll('[data-testid^="team-revoke-"]')].length > 0`, "revoke button", 10000);
    await evaluate(`(()=>{const el=document.querySelector('[data-testid^="team-revoke-"]'); el.scrollIntoView({block:"center"}); el.click(); return true;})()`);
    await sleep(300);
    await clickText("Revoke", true); // confirm inside the dialog (last exact match)
    await waitText("Revoked", 15000);
    await waitText("Invitation revoked", 10000);
  });

  console.log(`\nAll ${steps.length} manager-invitation checks passed. Console errors captured: ${consoleErrors.length}.`);
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
