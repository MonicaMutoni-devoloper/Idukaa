/**
 * Writes dist/sw-assets.json: every static file the exported web app can ask for later.
 *
 * Why it exists: `expo export --platform web` splits the app into one chunk per screen
 * (`sell-<hash>.js`, `reports-<hash>.js`, …). `index.html` names only the three launch bundles, so a
 * service worker that precached just those could open the start screen offline and nothing else —
 * tapping Sell or Reports on a phone with no network fetched a chunk that was never saved and the
 * screen stayed blank.
 *
 * The worker cannot list a directory from the network, so the list is produced here at build time,
 * next to the files it describes. Same hashing as the export: the names change with the code.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

/** Files the worker may serve from its shell cache. Deliberately excludes the worker itself. */
const SERVABLE = /\.(js|mjs|css|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|otf|json)$/i;
/** The manifest is read to build the cache; storing it would only repeat itself. */
const SELF = "sw-assets.json";
const NEVER = new Set(["sw.js", SELF]);

/** @returns {string[]} POSIX paths from the site root, e.g. "/_expo/static/js/web/sell-<hash>.js". */
function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // no export yet: an empty manifest is honest, the shell still installs
  }
  for (const name of entries) {
    if (NEVER.has(name)) continue;
    const full = join(dir, name);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      out.push(...walk(full));
      continue;
    }
    if (!SERVABLE.test(name)) continue;
    out.push("/" + relative(dist, full).split(sep).join("/"));
  }
  return out;
}

const assets = walk(dist).sort();
/**
 * Stamp the worker's cache name with a fingerprint of this build's asset list.
 *
 * Why: the browser only re-runs a service worker's install when the worker script's bytes change. A
 * deploy that changes the app (new screen chunk hashes) but not sw.js would leave every installed
 * phone holding the previous names — the new screens unbundled and offline screens blank again. A
 * content-addressed cache name makes every asset change an update; a deploy that changes no assets
 * keeps the same name and re-installs nothing.
 *
 * The dashboard also reads `cache` from this file to show install progress by counting saved
 * entries, which works in every browser — WebKit does not reliably deliver the worker's own progress
 * messages while it installs.
 */
const stamp = createHash("sha1").update(assets.join("\n")).digest("hex").slice(0, 8);
const swPath = join(dist, "sw.js");
let sw = "";
try {
  sw = readFileSync(swPath, "utf8");
} catch {
  sw = "";
}
const stamped = `const CACHE = "idukaa-shell-${stamp}";`;
if (sw) {
  const rewritten = sw.replace(/const CACHE = "[^"]+";/, stamped);
  if (rewritten === sw && !sw.includes(stamped)) console.warn("sw-assets.json: no CACHE line found in dist/sw.js");
  sw = rewritten;
  writeFileSync(swPath, sw);
}
const cache = /const CACHE = "([^"]+)"/.exec(sw)?.[1] ?? null;
writeFileSync(join(dist, SELF), JSON.stringify({ generatedAt: new Date().toISOString(), cache, assets }, null, 0) + "\n");

const chunks = assets.filter((a) => a.endsWith(".js")).length;
console.log(`sw-assets.json: ${assets.length} files (${chunks} scripts) listed for offline use; cache idukaa-shell-${stamp}`);
if (!assets.length) console.warn("sw-assets.json: dist is empty — run this after `expo export --platform web`");
