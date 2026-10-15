// Celadon Inventory — Service Worker
// Network-first for the app shell so deployments show up immediately.
// Cache is only used as an offline fallback, never as the primary source.
// Google Sheets (Apps Script) requests always go live, never cached.

const CACHE_NAME = 'cela-app-v17'; // bump this string on any future SW change to force a clean cache
const APP_SHELL = [
  './',
  './index.html',
  './inventory.css',
  './inventory.js',
  './brand/dreagle-mark.png',
  './brand/ayi/ayi.png',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting(); // activate the new SW immediately, don't wait for old tabs to close
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim(); // take control of already-open tabs right away
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never touch Google Apps Script requests — always go live, never cached
  if (url.hostname.includes('script.google.com')) {
    return;
  }

  // Only handle our own same-origin GET requests
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }

  // Network-first: always try to fetch the latest version. Only fall back
  // to the cached copy if the network request fails (e.g. offline). This is
  // what makes new deployments show up right away instead of being stuck
  // behind a stale cache.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true }))
  );
});
