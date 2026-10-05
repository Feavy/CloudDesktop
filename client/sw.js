// ============================================================================
//  Pass-through service worker
//  ----------------------------
//  Browsers only offer the PWA install prompt when the manifest is paired
//  with a service worker, so this one exists to satisfy that check — nothing
//  more. It never caches and never answers from cache: the ?cv= stamping on
//  the asset URLs plus the server's Cache-Control headers are this app's
//  single caching story, and the VNC traffic it must not touch already rides
//  a WebSocket, not a fetch.
//
//  The stamped version below makes every deployment a new byte content, so
//  the browser sees an update on its next /sw.js check (the script is served
//  no-cache) and replaces the worker; skipWaiting + clients.claim applies it
//  without waiting for every tab to close.
// ============================================================================
const VERSION = '%CACHE_VERSION%';

self.addEventListener('install', () => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

// The presence of a fetch listener is what the installability check looks
// for. Not calling respondWith() keeps every request on its default network
// path — the pass-through behaviour.
self.addEventListener('fetch', () => {});
