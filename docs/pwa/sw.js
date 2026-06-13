/**
 * Unifile Service Worker
 *
 * Caches all app assets for offline use.
 * Uses a cache-first strategy for app shell, network-first for data.
 */

// CACHE_PREFIX namespaces caches per build type (e.g. "unifile-abc") so multiple
// unifile PWAs installed on the same origin (universal, abc, …) don't evict each
// other's caches.  CACHE_VERSION appends a content hash so updates supersede.
const CACHE_PREFIX  = 'unifile-uni';
const CACHE_VERSION = 'unifile-uni-52ed6c84db9f';
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
      return cache.addAll(APP_SHELL);
    }).then(() => {
      return self.skipWaiting();
    })
  );
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
