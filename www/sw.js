const CACHE_NAME = 'kotonoha-ko-ota-v17';
const ASSETS = [
  './',
  './index.html',
  './vocab-expansion.js?v=2.5.4',
  './textbook-dialogues.js?v=2.5.4',
  './learning-memory.js?v=2.5.4',
  './scene-images.js?v=2.5.4',
  './ai-engine.js?v=2.5.4',
  './manifest.json',
  './images/scenes/day01_cafe.jpg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Network-first with HTTP cache revalidation for same-origin GET assets (never intercepts external AI API calls)
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  let url;
  try { url = new URL(event.request.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request, { cache: 'no-cache' })
      .then((resp) => {
        if (resp && resp.ok && resp.status === 200) {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone)).catch(() => {});
        }
        return resp;
      })
      .catch(() =>
        caches.match(event.request).then((cached) => {
          if (cached) return cached;
          if (event.request.mode === 'navigate') return caches.match('./index.html');
          return Response.error();
        })
      )
  );
});
