// Noor service worker
// Strategy:
//  - App shell (HTML, manifest, icons, narrations.json): network-first,
//    falling back to cache only when offline. Every push you deploy goes
//    live for users automatically the next time they open the app while
//    online — there's no version number to remember to bump. The cache
//    here exists purely as an offline safety net, not as the source of
//    truth.
//  - Quran text API (api.alquran.cloud): stale-while-revalidate (serve
//    cache instantly, refresh in background)
//  - Recitation + narration audio (mp3 files): cache-first, permanent
//    once fetched (a given verse's audio never changes, so there's
//    nothing to go stale)

const SHELL_CACHE = "noor-shell";
const API_CACHE = "noor-api-v1";
const AUDIO_CACHE = "noor-audio-v1";

const SHELL_FILES = [
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./narrations.json"
];

self.addEventListener("install", (event) => {
  // Pre-warm the cache so the app can still launch offline immediately
  // after being installed, before it's ever been opened online. This is
  // just a head start — the fetch handler below is what actually keeps
  // things fresh from here on.
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Cache names only need to change if you deliberately want to force a
  // full purge (e.g. a major restructure). Routine content updates don't
  // require touching this — the network-first fetch handler below keeps
  // itself current on its own.
  const keep = [SHELL_CACHE, API_CACHE, AUDIO_CACHE];
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => !keep.includes(k)).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

function isAudio(url) {
  return url.pathname.endsWith(".mp3") || url.hostname.includes("mp3quran") || url.hostname.includes("alquran.cloud") && url.pathname.includes("audio");
}
function isApi(url) {
  return url.hostname === "api.alquran.cloud";
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Audio: cache-first, permanent (ayah audio never changes)
  if (isAudio(url) || url.pathname.match(/\.mp3$/)) {
    event.respondWith(
      caches.open(AUDIO_CACHE).then((cache) =>
        cache.match(event.request).then((cached) => {
          if (cached) return cached;
          return fetch(event.request).then((res) => {
            if (res.ok) cache.put(event.request, res.clone());
            return res;
          }).catch(() => cached);
        })
      )
    );
    return;
  }

  // Quran text API: stale-while-revalidate
  if (isApi(url)) {
    event.respondWith(
      caches.open(API_CACHE).then((cache) =>
        cache.match(event.request).then((cached) => {
          const fetchPromise = fetch(event.request).then((res) => {
            if (res.ok) cache.put(event.request, res.clone());
            return res;
          }).catch(() => cached);
          return cached || fetchPromise;
        })
      )
    );
    return;
  }

  // App shell and any other same-origin file: network-first. Try the
  // network so users always get whatever you most recently deployed;
  // only fall back to the cached copy if the network request fails
  // (i.e. actually offline). Every successful fetch refreshes the cache
  // for the next offline use, automatically, with no version bump.
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(event.request).then((res) => {
        if (res.ok) {
          caches.open(SHELL_CACHE).then((cache) => cache.put(event.request, res.clone()));
        }
        return res;
      }).catch(() => caches.match(event.request))
    );
  }
});
