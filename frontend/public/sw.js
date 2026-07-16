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
// Bump CACHE on any change here to drop the old cache on activate.
const CACHE = "tunedeck-v4";

self.addEventListener("install", (event) => {
  // Warm the shell so the very first repeat-open paints instantly.
  event.waitUntil(
    caches.open(CACHE).then((c) => c.add("/")).catch(() => {}),
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

function staleWhileRevalidate(request) {
  return caches.open(CACHE).then((cache) =>
    cache.match(request).then((cached) => {
      const network = fetch(request)
        .then((resp) => {
          if (resp && resp.ok) cache.put(request, resp.clone());
          return resp;
        })
        .catch(() => cached);
      // Cached wins the race (instant paint); network updates the cache.
      return cached || network;
    }),
  );
}

function cacheFirst(request) {
  return caches.open(CACHE).then((cache) =>
    cache.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((resp) => {
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
    event.respondWith(staleWhileRevalidate(request));
    return;
  }
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(cacheFirst(request));
    return;
  }
  if (url.pathname === "/api/tunes") {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }
  if (/\.(png|jpg|jpeg|webp|svg|ico|m4a|woff2?)$/.test(url.pathname)) {
    event.respondWith(cacheFirst(request));
    return;
  }
  // Everything else → default network handling.
});
