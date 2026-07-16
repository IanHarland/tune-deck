// Tune Deck service worker — instant paint from cache, refresh in background.
//
// The app is opened from a phone home-screen icon and the Fly machine may be
// cold (scale-to-zero → ~19s to first byte). This worker serves the cached app
// shell + last-known tune list immediately so the UI paints at once, while the
// network response (fresh data, new deploy) is fetched in the background and
// stored for next time.
//
// Cache strategy by request:
//   navigations (the HTML shell)  → stale-while-revalidate
//   /assets/* (Vite hashed, immutable) → cache-first, forever
//   /api/tunes (the tune list)    → stale-while-revalidate
//   other static (icons/covers/art/audio) → cache-first
//   writes (POST/DELETE: votes, picks) → never touched, straight to network
//
// BUILD and PRECACHE are stamped in at build time by the sw-precache plugin in
// vite.config.ts — the shell alone isn't enough to boot, so its hashed JS/CSS
// must be precached too. Otherwise the shell paints from cache and then hangs on
// a ~20s bundle fetch against the cold machine; if that fetch dies, React never
// mounts and the splash sits there until a manual reload. The values below are
// the dev fallbacks; a build that fails to stamp them is an error, not a warning.
const BUILD = "dev"; /*__BUILD__*/
const PRECACHE = ["/"]; /*__PRECACHE_URLS__*/
const CACHE = `tunedeck-${BUILD}`;

self.addEventListener("install", (event) => {
  // Warm the shell AND its bundle so the next open paints and mounts with no
  // network at all. Added one by one: cache.addAll() is atomic, so a single
  // stale URL would fail the whole install and leave the app unprotected.
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => Promise.all(PRECACHE.map((u) => cache.add(u).catch(() => {}))))
      .catch(() => {}),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

// One retry. The machine is scale-to-zero, so the request that wakes it waits
// ~20s and can be dropped outright; a single unretried failure on the bundle
// means the app never boots.
function fetchRetry(request) {
  return fetch(request).catch(() => fetch(request));
}

function staleWhileRevalidate(event, request) {
  return caches.open(CACHE).then((cache) =>
    cache.match(request).then((cached) => {
      const network = fetchRetry(request)
        .then((resp) => {
          if (resp && resp.ok) cache.put(request, resp.clone());
          return resp;
        })
        .catch(() => cached || Response.error());
      // Cached wins the race (instant paint); network updates the cache. The
      // refresh needs waitUntil to outlive the response — on a cold machine it
      // runs ~20s, long enough for an otherwise-idle worker to be killed and the
      // cache to never update.
      if (cached) event.waitUntil(network);
      return cached || network;
    }),
  );
}

function cacheFirst(request) {
  return caches.open(CACHE).then((cache) =>
    cache.match(request).then((cached) => {
      if (cached) return cached;
      return fetchRetry(request).then((resp) => {
        if (resp && resp.ok) cache.put(request, resp.clone());
        return resp;
      });
    }),
  );
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return; // votes/picks/deletes → network only

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // 3rd-party → passthrough

  if (request.mode === "navigate") {
    event.respondWith(staleWhileRevalidate(event, request));
    return;
  }
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(cacheFirst(request));
    return;
  }
  if (url.pathname === "/api/tunes") {
    event.respondWith(staleWhileRevalidate(event, request));
    return;
  }
  if (/\.(png|jpg|jpeg|webp|svg|ico|m4a|woff2?)$/.test(url.pathname)) {
    event.respondWith(cacheFirst(request));
    return;
  }
  // Everything else → default network handling.
});
