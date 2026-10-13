/**
 * Automotive Service Worker for Tesla Model 3 / Y Navigation
 * Cache Name tied directly to version: v3.9.0
 * 
 * Automotive Strategies:
 * 1. Network-First for Navigation / HTML pages (index.html):
 *    Fetches live version immediately when connected; falls back to instant cache on R / offline.
 * 2. Cache-First for static versioned assets (scripts, styles, icons).
 * 3. NEVER caches API requests (/api/*, /healthz, SSE).
 * 4. skipWaiting + clients.claim for atomic instant updates without stale caches.
 */

const CACHE_NAME = 'tesla-nav-v3.9.20';

const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/style.css?v=3.9.20',
  '/app.js?v=3.9.20',
  '/speed-limit.js?v=3.9.20',
  '/routing.js?v=3.9.20',
  '/chargers.js?v=3.9.20',
  '/traffic-signals.js?v=3.9.20',
  '/traffic.js?v=3.9.20',
  '/yandex.js?v=3.9.20',
  '/weather.js?v=3.9.20',
  '/battery.js?v=3.9.20',
  '/media-player.js?v=3.9.20',
  '/speech.js?v=3.9.20',
  '/leaflet.js',
  '/leaflet.css',
  '/qrcode.min.js',
  '/manifest.json',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_ASSETS).catch((err) => {
        console.warn('[SW] Partial precache notice:', err.message);
      });
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => {
          console.log('[SW] Purging old cache:', key);
          return caches.delete(key);
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Intercept only GET requests
  if (req.method !== 'GET') return;

  // NEVER cache API, SSE, or healthz requests
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/healthz')) {
    return;
  }

  // 1. Network-First strategy for HTML documents & navigation
  // Ensures user always gets the latest deployed index.html when online,
  // but instantly loads from cache if offline or during Tesla reverse (R) switch.
  if (req.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('.html')) {
    event.respondWith(
      fetch(req)
        .then((networkRes) => {
          if (networkRes && networkRes.status === 200) {
            const copy = networkRes.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return networkRes;
        })
        .catch(() => {
          return caches.match(req).then((cached) => cached || caches.match('/index.html'));
        })
    );
    return;
  }

  // 2. Cache-First with network fallback for versioned assets
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((networkRes) => {
        if (networkRes && networkRes.status === 200 && url.origin === location.origin) {
          const copy = networkRes.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        }
        return networkRes;
      }).catch((err) => {
        // Return null/empty if resource is unavailable
        return cached || null;
      });
    })
  );
});
