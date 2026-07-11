// Noor service worker
// Strategy:
//  - App shell (this HTML, manifest, icons): cache-first, updated in background
//  - Quran text API (api.alquran.cloud): stale-while-revalidate (serve cache instantly, refresh in background)
//  - Recitation audio (mp3 files): cache-first, cached permanently once fetched (verses never change)

const SHELL_CACHE = "noor-shell-v1";
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
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
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

  // App shell: cache-first
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(event.request).then((cached) => cached || fetch(event.request))
    );
  }
});
