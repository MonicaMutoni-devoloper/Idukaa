// App-shell cache only. Business data lives in the local database, NOT in this cache.
// Authentication and business API responses are never cached, even when the API is deployed on the
// same origin as the web app: their paths are excluded explicitly and authorized requests are skipped.
// v6: install saves the launch page AND the hashed bundle it names, so one online visit is enough for
// an installed app to open offline (the first page load is not controlled by this worker yet, so the
// bundle would otherwise never be saved). Saved assets are also matched by URL, ignoring Vary
// headers, because WebKit can repeat a request with different headers and miss its own shell.
// Bumping the cache removes the old shell on activate, so an installed app cannot keep opening an
// outdated name or theme.
const CACHE = "idukaa-shell-v6";
const SHELL = ["/", "/index.html", "/manifest.json", "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png"];
// How long a launch may wait for the network before the saved shell is used instead. A phone whose
// Wi-Fi is connected but has no internet keeps the request open until the platform gives up, which
// made an installed app sit on a blank screen for many seconds before the cached shell appeared.
const NAV_TIMEOUT_MS = 3000;

// Every REST prefix used by the API. A response from any of these is always fetched live.
const API_PREFIXES = ["/auth", "/sync", "/reports", "/notifications", "/audit", "/sales", "/purchases", "/shop", "/admin", "/health"];
const isApiPath = (path) => API_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
const isStaticAsset = (path) =>
  path.startsWith("/_expo/") || path.startsWith("/assets/") || /\.(js|mjs|css|png|jpe?g|gif|svg|webp|ico|woff2?|json)$/i.test(path);
/** One key per asset path: a query string or a differing request header must not hide a saved copy. */
const cacheKeyOf = (path) => path.split("?")[0].split("#")[0];

const openCache = () => caches.open(CACHE);
const saved = async (key) => {
  try { return (await (await openCache()).match(cacheKeyOf(key), { ignoreVary: true })) || null; } catch { return null; }
};
const save = async (key, res) => {
  if (!res || !res.ok) return;
  try { await (await openCache()).put(cacheKeyOf(key), res.clone()); } catch { /* storage full: keep serving */ }
};

/** The hashed scripts/styles the exported launch page needs before it can render anything. */
async function launchAssets(html) {
  const found = new Set();
  const re = /(?:src|href)\s*=\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1];
    if (!raw.startsWith("/") || raw.startsWith("//")) continue;
    const path = cacheKeyOf(raw);
    if (isStaticAsset(path)) found.add(path);
  }
  return [...found];
}

/**
 * Download one asset and store it immediately. Deliberately sequential: holding several unread
 * response bodies at once stalls the install event in Chromium, which left the worker stuck in
 * "installing" for ever — and an app that never finishes installing has no shell offline.
 */
async function fetchAndSave(c, key) {
  try {
    const res = await fetch(key, { cache: "reload" });
    if (res.ok) await c.put(cacheKeyOf(key), res);
    return res.ok;
  } catch {
    return false; // one 404/offline asset must not make the whole installation unusable
  }
}

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil((async () => {
    const c = await openCache();
    for (const url of SHELL) await fetchAndSave(c, url);
    // The launch page names the hashed bundle; save it too, or an offline launch has nothing to
    // boot. Read it back from the cache so the stored body is already complete.
    let html = null;
    for (const url of ["/", "/index.html"]) {
      const hit = await saved(url);
      if (!hit) continue;
      try { html = await hit.text(); break; } catch { /* try the next copy */ }
    }
    if (html) for (const url of await launchAssets(html)) await fetchAndSave(c, url);
  })().catch(() => undefined));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;          // API on another origin, or a third party
  if (isApiPath(url.pathname)) return;                 // never cache auth or business data
  if (req.headers.get("authorization")) return;        // never cache an authorized response

  // Client-side routes: always try the network, but never wait on it indefinitely — a fresh
  // response is preferred, the cached shell answers after NAV_TIMEOUT_MS or the first failure.
  if (req.mode === "navigate") {
    e.respondWith((async () => {
      const savedShell = async () => (await saved("/")) || new Response(
        "<!doctype html><meta name=\"viewport\" content=\"width=device-width\">" +
        "<title>Idukaa</title><body style=\"font-family:system-ui;padding:24px\">" +
        "<h1>Idukaa</h1><p>Open Idukaa once with internet to save the application for offline use.</p>",
        { headers: { "Content-Type": "text/html; charset=utf-8" } },
      );
      let timer;
      const timedOut = new Promise((resolve) => {
        timer = setTimeout(() => { savedShell().then(resolve); }, NAV_TIMEOUT_MS);
      });
      try {
        return await Promise.race([fetch(req), timedOut]);
      } catch {
        return await savedShell();
      } finally {
        clearTimeout(timer);
      }
    })());
    return;
  }

  if (!isStaticAsset(url.pathname)) return;
  e.respondWith((async () => {
    const hit = await saved(url.pathname);
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok && res.type === "basic") await save(url.pathname, res);
      return res;
    } catch (err) {
      const fallback = await saved(url.pathname);
      if (fallback) return fallback;
      throw err;
    }
  })());
});
