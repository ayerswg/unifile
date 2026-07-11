/**
 * Unifile Service Worker
 *
 * Caches all app assets for offline use.
 * Uses a cache-first strategy for app shell, network-first for data.
 */

// CACHE_PREFIX namespaces caches per build type (e.g. "unifile-abc") so multiple
// unifile PWAs installed on the same origin (markdown, abc, …) don't evict each
// other's caches.  CACHE_VERSION appends a content hash so updates supersede.
const CACHE_PREFIX  = 'unifile-md';
const CACHE_VERSION = 'unifile-md-80b850f8b75f';
const APP_SHELL = [
  './',
  './index.html',
  './app.js',
  './app.css',
  './manifest.json'
];

// ---------------------------------------------------------------------------
// Install – pre-cache the app shell
// ---------------------------------------------------------------------------

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(cache => {
      // `cache: 'reload'` bypasses the HTTP cache so a new worker never precaches
      // a STALE shell asset.  Without this, an "update" could reload without
      // bumping the version: the new worker would cache the old app.js that the
      // browser/CDN still had cached, so nothing actually changed on reload.
      return cache.addAll(APP_SHELL.map(path => new Request(path, { cache: 'reload' })));
    }).then(() => {
      return self.skipWaiting();
    })
  );
});

// Allow the page to force an immediately-waiting worker to activate (used by the
// in-app "Update" button so the swap doesn't wait for all tabs to close).
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

// ---------------------------------------------------------------------------
// Activate – delete old caches
// ---------------------------------------------------------------------------

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys
          // Only prune stale caches for THIS build type — leave other unifile
          // PWAs' caches (different prefix) intact.
          .filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_VERSION)
          .map(key => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

// ---------------------------------------------------------------------------
// Fetch – cache-first for app shell assets
// ---------------------------------------------------------------------------

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Only handle same-origin requests
  if (url.origin !== location.origin) return;

  // Skip non-GET requests
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;

      return fetch(event.request).then(response => {
        // Cache successful responses for app assets
        if (response.ok && APP_SHELL.some(path => url.pathname.endsWith(path.replace('./', '')))) {
          const responseClone = response.clone();
          caches.open(CACHE_VERSION).then(cache => {
            cache.put(event.request, responseClone);
          });
        }
        return response;
      }).catch(() => {
        // Return a basic offline page if available
        return caches.match('./index.html');
      });
    })
  );
});
