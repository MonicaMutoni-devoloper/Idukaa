import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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
  assert.match(sw, /const CACHE = "idukaa-shell-v5"/);
  assert.match(sw, /"\/manifest\.json"/);
  assert.match(sw, /"\/icon-maskable-512\.png"/);
  for (const prefix of ["/auth", "/sync", "/reports", "/sales", "/purchases"]) {
    assert.ok(sw.includes(`"${prefix}"`), `${prefix} must be excluded from the shell cache`);
  }
  assert.match(sw, /if \(isApiPath\(url\.pathname\)\) return;/);
  assert.match(sw, /if \(req\.headers\.get\("authorization"\)\) return;/);
  assert.match(sw, /caches\.match\("\/"\)/, "a navigation must fall back to the cached shell");
  // A launch may not wait on a hanging network: the cached shell answers after a bounded delay.
  assert.match(sw, /const NAV_TIMEOUT_MS = \d+;/);
  assert.match(sw, /setTimeout\(/, "the navigation path must be time-bounded");
});

test("both web HTML entry points register the worker and use Idukaa metadata", () => {
  for (const file of ["public/index.html", "app/+html.tsx"]) {
    const html = read(file);
    assert.match(html, /manifest\.json/, `${file} must link the manifest`);
    assert.match(html, /serviceWorker/, `${file} must register the service worker`);
    assert.match(html, /#0F5C4D|Idukaa/, `${file} must carry Idukaa branding`);
  }
});
