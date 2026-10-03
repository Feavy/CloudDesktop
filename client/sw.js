const CACHE_NAME = 'clouddesktop-v2';
const PRECACHE = [
  '/',
  '/desktop',
  '/css/desktop.css',
  '/css/notifications.css',
  '/js/desktop.js',
  '/js/notifications.js',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-192.svg',
  '/icon-512.svg',
  '/img/firefox.svg',
  '/img/chrome.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Network-first for the API and the VNC WebSocket; never cache the RFB stream
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/websockify')) return;
  // Cache-first for static assets
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});