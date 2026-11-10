// App-shell cache only. Business data lives in the local database, NOT in this cache.
// Authentication and business API responses are never cached, even when the API is deployed on the
// same origin as the web app: their paths are excluded explicitly and authorized requests are skipped.
// v4: Idukaa manifest/theme and the maskable icon. Bumping the cache removes the old branded shell
// on activate, so an installed app cannot keep opening an outdated name or theme.
const CACHE = "idukaa-shell-v4";
const SHELL = ["/", "/manifest.json", "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png"];

// Every REST prefix used by the API. A response from any of these is always fetched live.
const API_PREFIXES = ["/auth", "/sync", "/reports", "/notifications", "/audit", "/sales", "/purchases", "/shop", "/admin", "/health"];
const isApiPath = (path) => API_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
const isStaticAsset = (path) =>
  path.startsWith("/_expo/") || path.startsWith("/assets/") || /\.(js|mjs|css|png|jpe?g|gif|svg|webp|ico|woff2?|json)$/i.test(path);

self.addEventListener("install", (e) => {
  self.skipWaiting();
  // Cache each shell asset independently: one 404 must not make the whole installation unusable.
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map(async (url) => {
    try {
      const res = await fetch(url, { cache: "reload" });
      if (res.ok) await c.put(url, res);
    } catch { /* keep the other offline assets */ }
  }))).catch(() => undefined));
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

  // Client-side routes: always try the network, fall back to the cached shell when offline.
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).catch(async () => (await caches.match("/")) || new Response(
      "<!doctype html><meta name=\"viewport\" content=\"width=device-width\">" +
      "<title>Idukaa</title><body style=\"font-family:system-ui;padding:24px\">" +
      "<h1>Idukaa</h1><p>Open Idukaa once with internet to save the application for offline use.</p>",
      { headers: { "Content-Type": "text/html; charset=utf-8" } },
    )));
    return;
  }

  if (!isStaticAsset(url.pathname)) return;
  e.respondWith(
    caches.match(req).then((hit) =>
      hit || fetch(req).then((res) => {
        if (res.ok && res.type === "basic") { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      }),
    ),
  );
});
