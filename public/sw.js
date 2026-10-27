// Derelict Watch service worker.
//  * App shell: pre-cached, served cache-first so the app opens offline.
//  * Map tiles: network-first, falling back to whatever tiles were seen before.
//  * Supabase API/storage: never cached here (the offline queue lives in
//    IndexedDB and is handled by the page).
//  * Background Sync: when the browser fires 'sync-reports', open pages are
//    asked to flush their outbox.

const VERSION = 'dw-v1.0.0';
const SHELL_CACHE = `${VERSION}-shell`;
const TILE_CACHE = 'dw-tiles';
const TILE_LIMIT = 400;

const SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'manifest.webmanifest',
  'lib/api.js',
  'lib/banding.js',
  'lib/image.js',
  'lib/queue.js',
  'lib/validation.js',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'vendor/leaflet/leaflet.js',
  'vendor/leaflet/leaflet.css',
  'vendor/leaflet/images/marker-icon.png',
  'vendor/leaflet/images/marker-icon-2x.png',
  'vendor/leaflet/images/marker-shadow.png',
  'vendor/leaflet/images/layers.png',
  'vendor/leaflet/images/layers-2x.png',
  'vendor/markercluster/leaflet.markercluster.js',
  'vendor/markercluster/MarkerCluster.css',
  'vendor/markercluster/MarkerCluster.Default.css',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await cache.addAll(SHELL);
    // config.js is optional (absent in demo mode) so it is cached best-effort.
    try {
      const res = await fetch('config.js', { cache: 'no-store' });
      if (res.ok) await cache.put('config.js', res);
    } catch { /* offline install or no config */ }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.endsWith('-shell') && k !== SHELL_CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

async function trimCache(name, max) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.hostname === 'tile.openstreetmap.org') {
    event.respondWith((async () => {
      const cache = await caches.open(TILE_CACHE);
      try {
        const res = await fetch(req);
        if (res.ok || res.type === 'opaque') {
          cache.put(req, res.clone());
          trimCache(TILE_CACHE, TILE_LIMIT);
        }
        return res;
      } catch {
        return (await cache.match(req)) || Response.error();
      }
    })());
    return;
  }

  if (url.origin !== self.location.origin) return; // Supabase etc.: straight to network

  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(req);
      } catch {
        const cache = await caches.open(SHELL_CACHE);
        return (await cache.match('index.html')) || Response.error();
      }
    })());
    return;
  }

  // config.js: network first so a newly added config is picked up.
  if (url.pathname.endsWith('/config.js')) {
    event.respondWith(fetch(req).then(async (res) => {
      if (res.ok) (await caches.open(SHELL_CACHE)).put(req, res.clone());
      return res;
    }).catch(async () => (await caches.match(req)) || new Response('', { headers: { 'Content-Type': 'text/javascript' } })));
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(req, { ignoreSearch: true });
    return cached || fetch(req);
  })());
});

self.addEventListener('sync', (event) => {
  if (event.tag !== 'sync-reports') return;
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window' });
    for (const client of clients) client.postMessage({ type: 'sync-reports' });
  })());
});
