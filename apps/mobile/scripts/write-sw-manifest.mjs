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
import { readdirSync, statSync, writeFileSync } from "node:fs";
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
writeFileSync(join(dist, SELF), JSON.stringify({ generatedAt: new Date().toISOString(), assets }, null, 0) + "\n");

const chunks = assets.filter((a) => a.endsWith(".js")).length;
console.log(`sw-assets.json: ${assets.length} files (${chunks} scripts) listed for offline use`);
if (!assets.length) console.warn("sw-assets.json: dist is empty — run this after `expo export --platform web`");
