// Offline support.
//
// App files (HTML, JS, CSS) are fetched from the network first so updates
// show up on the next open; the cached copy is only used offline or when the
// network is slow. The large OpenCV engine and face model rarely change and
// are served from the cache first.
//
// GitHub Pages lets browsers reuse files for 10 minutes, so every download
// here bypasses the browser's HTTP cache. Otherwise an update could store
// the previous version's files again.
const VERSION = 'scan-v4';
const ENGINE = ['vendor/opencv.js', 'models/face_detection_yunet_2023mar.onnx'];
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'version.json',
  'css/app.css',
  'js/app.js',
  'js/camera.js',
  'js/capture.js',
  'js/db.js',
  'js/editor.js',
  'js/exif.js',
  'js/library.js',
  'js/pipeline.js',
  'js/saver.js',
  'js/settings.js',
  'js/util.js',
  'js/worker-client.js',
  'js/worker.js',
  'js/zip.js',
  'icons/icon.svg',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-512.png',
];
const NETWORK_TIMEOUT_MS = 4000;

const fresh = (url) => fetch(url, { cache: 'no-cache', credentials: 'same-origin' });

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // Reuse the engine from an older cache instead of downloading 13 MB again.
    for (const url of ENGINE) {
      const old = await caches.match(url);
      if (old) await cache.put(url, old);
      else await cache.add(new Request(url, { cache: 'reload' }));
    }
    await cache.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  const isEngine = ENGINE.some((p) => url.pathname.endsWith('/' + p));
  event.respondWith(isEngine ? cacheFirst(req) : networkFirst(req, event));
});

async function cacheFirst(req) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(req, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

async function networkFirst(req, event) {
  const cache = await caches.open(VERSION);
  const network = fresh(req.url).then((res) => {
    if (res.ok && res.type === 'basic') {
      const copy = res.clone();
      event.waitUntil(cache.put(req, copy));
    }
    return res;
  });
  const timeout = new Promise((resolve) => setTimeout(resolve, NETWORK_TIMEOUT_MS, null));
  try {
    const res = await Promise.race([network, timeout]);
    if (res) return res;
  } catch (e) {
    // Offline: fall through to the cache.
  }
  const hit = await cache.match(req, { ignoreSearch: true });
  if (hit) return hit;
  if (req.mode === 'navigate') {
    const shell = await cache.match('index.html');
    if (shell) return shell;
  }
  // Slow network and nothing cached: keep waiting for the network.
  return network;
}
