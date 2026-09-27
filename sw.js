// Offline support. The large OpenCV engine and face model are served from the
// cache first. App files use stale-while-revalidate: they load instantly from
// the cache, and a fresh copy is fetched in the background for next time.
const VERSION = 'scan-v2';
const ENGINE = ['vendor/opencv.js', 'models/face_detection_yunet_2023mar.onnx'];
const ASSETS = [
  './',
  'index.html',
  'manifest.webmanifest',
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
  ...ENGINE,
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  const isEngine = ENGINE.some((p) => url.pathname.endsWith('/' + p));
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(req, { ignoreSearch: true });
    const refresh = fetch(req).then((res) => {
      if (res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    });
    if (hit) {
      if (!isEngine) event.waitUntil(refresh.catch(() => {}));
      return hit;
    }
    try {
      return await refresh;
    } catch (e) {
      return (await cache.match('index.html')) || Response.error();
    }
  })());
});
