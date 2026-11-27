const CACHE_NAME = 'kotonoha-ko-ota-v14';
const ASSETS = [
  './',
  './index.html',
  './vocab-expansion.js',
  './textbook-dialogues.js',
  './learning-memory.js',
  './scene-images.js',
  './ai-engine.js',
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

// Network-first strategy for same-origin GET assets only (never intercepts external AI API calls)
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  let url;
  try { url = new URL(event.request.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request)
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
