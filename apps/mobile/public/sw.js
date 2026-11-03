// App-shell cache only. Business data lives in the local database, NOT in this cache.
// Authentication and business API responses are never cached, even when the API is deployed on the
// same origin as the web app: their paths are excluded explicitly and authorized requests are skipped.
// v3: purge the shell/assets cached before the cross-site auth fix so no client keeps running a
// bundle whose refresh flow was replaced.
const CACHE = "sms-shell-v3";
const SHELL = ["/", "/manifest.json", "/icon-192.png", "/icon-512.png"];

// Every REST prefix used by the API. A response from any of these is always fetched live.
const API_PREFIXES = ["/auth", "/sync", "/reports", "/notifications", "/audit", "/sales", "/purchases", "/shop", "/admin", "/health"];
const isApiPath = (path) => API_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
const isStaticAsset = (path) =>
  path.startsWith("/_expo/") || path.startsWith("/assets/") || /\.(js|mjs|css|png|jpe?g|gif|svg|webp|ico|woff2?|json)$/i.test(path);

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => undefined));
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
    e.respondWith(fetch(req).catch(() => caches.match("/")));
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
