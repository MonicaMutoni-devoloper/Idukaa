/**
 * Web boot recovery.
 *
 * A browser reload can land on a cached app shell whose hashed script was removed by a newer
 * deploy, or on a service-worker cache that never finished saving. The page then has no React tree:
 * the themed body background is all that is visible, which looks like a black screen. Opening a new
 * tab fixes it because that launch gets the current shell.
 *
 * This file runs before the Expo launch scripts. If one of those scripts fails, or the root stays
 * empty, it clears the app-shell service worker caches and reloads once. A second failure shows a
 * readable retry card instead of another silent black page. Local business data is in IndexedDB /
 * localStorage, never in the shell cache, so this cannot delete sales or queued work.
 */
(function () {
  "use strict";
  var RETRY_KEY = "idukaa.boot.recovered";
  var WAIT_MS = 20000;

  function appRoot() {
    return document.getElementById("root");
  }

  function card(message) {
    var root = appRoot();
    if (!root) return;
    root.innerHTML =
      '<div style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;' +
      "padding:24px;background:#F6F8FA;color:#17252F;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif\">" +
      '<div style="max-width:420px;width:100%;background:#FFFFFF;border:1px solid #D7E3EC;border-radius:14px;padding:24px;box-shadow:0 12px 30px rgba(15,92,77,.08)">' +
      '<div style="font-size:18px;font-weight:800;letter-spacing:-.02em">Idukaa</div>' +
      '<p style="margin:10px 0 18px;font-size:14px;line-height:1.55;color:#52616B">' + message + "</p>" +
      '<button id="idukaa-boot-retry" type="button" style="width:100%;min-height:44px;border:0;border-radius:10px;' +
      'background:#0F5C4D;color:#FFFFFF;font-size:14px;font-weight:700;cursor:pointer">Reload Idukaa</button>' +
      "</div></div>";
    var button = document.getElementById("idukaa-boot-retry");
    if (button) button.onclick = function () { window.location.reload(); };
  }

  function clearShell() {
    var jobs = [];
    try {
      if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
        jobs.push(navigator.serviceWorker.getRegistrations().then(function (list) {
          return Promise.all(list.map(function (r) { return r.unregister().catch(function () {}); }));
        }));
      }
    } catch (e) {}
    try {
      if (window.caches && caches.keys) {
        jobs.push(caches.keys().then(function (keys) {
          return Promise.all(keys.map(function (key) { return caches.delete(key).catch(function () {}); }));
        }));
      }
    } catch (e) {}
    return Promise.all(jobs).catch(function () {});
  }

  function recover() {
    var already = false;
    try { already = sessionStorage.getItem(RETRY_KEY) === "1"; } catch (e) {}
    if (already) {
      card("The saved app shell is still out of date. Close this tab, open Idukaa again, and sign in if asked. Your sales and stock remain on this device.");
      return;
    }
    try { sessionStorage.setItem(RETRY_KEY, "1"); } catch (e) {}
    clearShell().then(function () { window.location.reload(); });
  }

  // A hashed launch chunk that 404s fires an error on its script element. This is the exact
  // stale-cache case: the shell names a file the current deployment no longer serves.
  window.addEventListener("error", function (event) {
    var target = event.target;
    if (!target || target.tagName !== "SCRIPT" || !target.src) return;
    if (target.src.indexOf("/_expo/static/js/") !== -1) recover();
  }, true);

  window.addEventListener("load", function () {
    window.setTimeout(function () {
      var root = appRoot();
      if (root && root.firstElementChild) {
        // The app painted. Leave the next genuine failure free to run the recovery once.
        try { sessionStorage.removeItem(RETRY_KEY); } catch (e) {}
        return;
      }
      recover();
    }, WAIT_MS);
  });
})();
