import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describeProgress, readPrecacheManifest } from "../src/services/precache-status.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const pngSize = (p: string) => {
  const b = readFileSync(join(root, p));
  assert.equal(b.toString("ascii", 1, 4), "PNG");
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
};

test("Idukaa manifest is installable and correctly branded", () => {
  const m = JSON.parse(read("public/manifest.json"));
  assert.equal(m.name, "Idukaa");
  assert.equal(m.short_name, "Idukaa");
  assert.equal(m.id, "/");
  assert.equal(m.start_url, "/");
  assert.equal(m.scope, "/");
  assert.equal(m.display, "standalone");
  assert.equal(m.theme_color, "#0F5C4D");
  assert.match(m.background_color, /^#[0-9A-Fa-f]{6}$/);

  const icons = new Map(m.icons.map((i: any) => [`${i.sizes}:${i.purpose}`, i.src]));
  assert.equal(icons.get("192x192:any"), "/icon-192.png");
  assert.equal(icons.get("512x512:any"), "/icon-512.png");
  assert.ok(icons.get("512x512:maskable"), "a maskable 512 icon is required for Android");
  assert.deepEqual(pngSize("public/icon-192.png"), { width: 192, height: 192 });
  assert.deepEqual(pngSize("public/icon-512.png"), { width: 512, height: 512 });
  assert.deepEqual(pngSize("public/icon-maskable-512.png"), { width: 512, height: 512 });
});

test("the service worker caches only the shell and never API responses", () => {
  const sw = read("public/sw.js");
  assert.match(sw, /const CACHE = "idukaa-shell-v11"/);
  assert.match(sw, /"\/manifest\.json"/);
  assert.match(sw, /"\/icon-maskable-512\.png"/);
  // One online visit must be enough: install saves the bundle the exported launch page names, and
  // then every other file the export produced (the web build splits one script per screen).
  assert.match(sw, /launchAssets\(html\)/, "install must precache the scripts/styles the shell needs");
  assert.match(sw, /const MANIFEST = "\/sw-assets\.json"/, "the build-time asset list must be precached");
  assert.match(sw, /await precacheManifest\(c\)/, "install must save the per-screen chunks, not only the launch bundle");
  // ~60 files one after another made the first visit slow; a few at a time, with each body stored
  // before its slot is reused, keeps the install short without the stall of unread bodies.
  assert.match(sw, /const PRECACHE_CONCURRENCY = (\d+)/, "the manifest pass must be bounded-but-parallel");
  assert.ok(Number(/const PRECACHE_CONCURRENCY = (\d+)/.exec(sw)![1]) > 1);
  assert.match(sw, /await pool\(urls, PRECACHE_CONCURRENCY/, "assets are fetched through the pool");
  // Progress is counted from the cache by the page, because WebKit drops a worker's messages while
  // it installs; the worker therefore needs no messaging of its own.
  assert.doesNotMatch(sw, /postMessage/, "progress must not depend on worker messages alone");
  // Bodies must be stored as they arrive, never held unread, or Chromium's install never finishes.
  assert.match(sw, /if \(res\.ok\) await c\.put\(cacheKeyOf\(key\), res\)/, "each body is stored immediately");
  // The launch bundle was being downloaded a second time; a hashed name cannot be stale.
  assert.match(sw, /cache: hashed \? "default" : "reload"/,
    "hashed assets may come from the HTTP cache, unhashed ones may not");
  // An install cut short must resume, not start the whole list again.
  assert.match(sw, /if \(hashed && \(await saved\(key\)\)\) return true;/,
    "a saved hashed file must not be downloaded a second time");
  assert.match(sw, /ignoreVary: true/, "a saved asset must be found again even if Vary differs");
  assert.match(sw, /const fallback = await saved\(url\.pathname\)/, "a failed asset fetch must fall back to the saved copy");
  for (const prefix of ["/auth", "/sync", "/reports", "/sales", "/purchases"]) {
    assert.ok(sw.includes(`"${prefix}"`), `${prefix} must be excluded from the shell cache`);
  }
  assert.match(sw, /if \(isApiPath\(url\.pathname\)\) return;/);
  assert.match(sw, /if \(req\.headers\.get\("authorization"\)\) return;/);
  assert.match(sw, /await saved\("\/"\)/, "a navigation must fall back to the cached shell");
  // A launch may not wait on a hanging network: the cached shell answers after a bounded delay.
  assert.match(sw, /const NAV_TIMEOUT_MS = \d+;/);
  assert.match(sw, /setTimeout\(/, "the navigation path must be time-bounded");
});

test("install progress is read from the saved entries, never guessed", () => {
  const manifest = { cache: "idukaa-shell-v10", assets: ["/a.js", "/b.js", "/c.js"] };
  assert.deepEqual(readPrecacheManifest(manifest), { cache: "idukaa-shell-v10", total: 3 });
  for (const bad of [null, undefined, [], {}, { assets: ["/a.js"] }, { cache: "c", assets: [] }, { cache: "", assets: ["/a.js"] }]) {
    assert.equal(readPrecacheManifest(bad), null, `${JSON.stringify(bad)} must not start a banner`);
  }
  assert.deepEqual(describeProgress(1, 3), { done: 1, total: 3 });
  // The shell page, icons and launch bundle are saved before the manifest pass, so 61 of 59 is normal.
  assert.deepEqual(describeProgress(61, 59), { done: 59, total: 59 });
  assert.deepEqual(describeProgress(0, 59), { done: 0, total: 59 });
  for (const bad of [["12", 59], [Number.NaN, 59], [1, 0], [1, "59"], [null, 59]]) {
    assert.equal(describeProgress(bad[0], bad[1]), null, `${JSON.stringify(bad)} must be ignored`);
  }
});

test("both web HTML entry points register the worker and use Idukaa metadata", () => {
  for (const file of ["public/index.html", "app/+html.tsx"]) {
    const html = read(file);
    assert.match(html, /manifest\.json/, `${file} must link the manifest`);
    assert.match(html, /serviceWorker/, `${file} must register the service worker`);
    assert.match(html, /#0F5C4D|Idukaa/, `${file} must carry Idukaa branding`);
  }
});
