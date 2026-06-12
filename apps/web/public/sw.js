/* Inventar Maschine – Service Worker (O1).
 *
 * Bewusst handgeschrieben statt Build-Plugin: keine Abhaengigkeit vom
 * Next-Build, klar nachvollziehbares Verhalten (Stabilitaet vor Magie).
 *
 * Strategie:
 * - Statische Next-Assets (/_next/static, immutable): Cache First.
 * - Navigationen (HTML): Network First mit 3,5-s-Timeout, Fallback auf die
 *   zuletzt gecachte Version der Route, sonst /offline.html.
 * - API-Aufrufe und alle Nicht-GETs werden NIE angefasst (IndexedDB-Outbox
 *   und Sync-Engine sind dafuer zustaendig).
 */
const VERSION = "v1";
const STATIC_CACHE = `inventar-static-${VERSION}`;
const PAGE_CACHE = `inventar-pages-${VERSION}`;
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(PAGE_CACHE).then((cache) => cache.add(OFFLINE_URL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("inventar-") && !key.endsWith(`-${VERSION}`))
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

function isApiRequest(url) {
  // Gleiche Origin: nur /_next, Seiten und public-Dateien cachen.
  // Fremde Origin (API auf :8000) immer durchreichen.
  return self.location.origin !== url.origin;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (isApiRequest(url)) return;

  // Unveraenderliche Build-Assets: Cache First.
  if (url.pathname.startsWith("/_next/static/") || url.pathname === "/manifest.json") {
    event.respondWith(
      caches.open(STATIC_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok) cache.put(request, response.clone());
        return response;
      })
    );
    return;
  }

  // Seiten-Navigationen: Network First (frisch wenn moeglich), Cache-Fallback.
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        const cache = await caches.open(PAGE_CACHE);
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 3500);
          const response = await fetch(request, { signal: controller.signal });
          clearTimeout(timer);
          if (response.ok) cache.put(request, response.clone());
          return response;
        } catch {
          const cached = await cache.match(request, { ignoreSearch: false });
          if (cached) return cached;
          const offline = await cache.match(OFFLINE_URL);
          return offline || Response.error();
        }
      })()
    );
  }
});
