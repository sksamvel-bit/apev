/**
 * Automotive Service Worker for Tesla Model 3 / Y Navigation
 * Cache Name tied directly to the app version (see CACHE_NAME below)
 * 
 * Automotive Strategies:
 * 1. Network-First for Navigation / HTML pages (index.html):
 *    Fetches live version immediately when connected; falls back to instant cache on R / offline.
 * 2. Cache-First for static versioned assets (scripts, styles, icons).
 * 3. NEVER caches API requests (/api/*, /healthz, SSE).
 * 4. skipWaiting + clients.claim for atomic instant updates without stale caches.
 */

const CACHE_NAME = 'tesla-nav-v3.10.75';
const NAV_TIMEOUT_MS = 3000;   // a sleeping Render server: show the cached page after 3 s

const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/style.css?v=3.10.75',
  '/app.js?v=3.10.75',
  '/speed-limit.js?v=3.10.75',
  '/speed-cameras.js?v=3.10.75',
  '/devices-panel.js?v=3.10.75',
  '/routing.js?v=3.10.75',
  '/chargers.js?v=3.10.75',
  '/charger-list.js?v=3.10.75',
  '/search.js?v=3.10.75',
  '/tesla-style.js?v=3.10.75',
  '/traffic-signals.js?v=3.10.75',
  '/traffic.js?v=3.10.75',
  '/gmap.js?v=3.10.75',
  '/weather.js?v=3.10.75',
  '/battery.js?v=3.10.75',
  '/turn-audio.js?v=3.10.75',
  '/speech.js?v=3.10.75',
  '/maplibre-gl.js?v=3.10.75',
  '/map-gl.js?v=3.10.75',
  '/maplibre-gl.css?v=3.10.75',
  '/qrcode.min.js',
  '/sim-drive.js?v=3.10.75',
  '/manifest.json',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png'
];

// v3.10.75: the app page is precached only when it really is the app. A signed-out install used to store the PIN page as "/",
// and with the 3 s fallback (v3.10.65) a slow server then showed that PIN form to a device that was signed in.
const PRECACHE_PAGES = ['/', '/index.html'];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      const assets = cache.addAll(PRECACHE_ASSETS.filter((u) => !PRECACHE_PAGES.includes(u))).catch((err) => {
        console.warn('[SW] Partial precache notice:', err.message);
      });
      const pages = Promise.all(PRECACHE_PAGES.map((u) => fetch(u, { credentials: 'same-origin' }).then((res) => {
        if (res && res.status === 200 && !res.headers.get('X-Pin-Page')) return cache.put(u, res);
      }).catch(() => {})));
      return Promise.all([assets, pages]);
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

  // Cross-origin (map style, vector/raster tiles, fonts, Overpass...): let the browser handle it natively.
  // Routing hundreds of tile requests per minute through the service worker only adds latency and memory.
  if (url.origin !== location.origin) return;

  // 1. Network-First strategy for HTML documents & navigation
  // Ensures user always gets the latest deployed index.html when online,
  // but instantly loads from cache if offline or during Tesla reverse (R) switch.
  // v3.10.75 (audit H3): Render's free server sleeps after 15 idle minutes and needs ~30-60 s to wake. A page that waits for
  // the network shows a blank screen all that time, so after NAV_TIMEOUT_MS the cached page is shown and the network answer
  // (when it comes) only refreshes the cache. With nothing cached the page still waits for the network.
  if (req.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('.html')) {
    const network = fetch(req).then((networkRes) => {
      // the PIN page (signed out) is never cached as the app page
      if (networkRes && networkRes.status === 200 && !networkRes.headers.get('X-Pin-Page')) {
        const copy = networkRes.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
      }
      return networkRes;
    });
    const cachedPage = () => caches.match(req).then((cached) => cached || caches.match('/index.html'));
    event.respondWith(new Promise((resolve) => {
      let done = false;
      const finish = (res) => { if (!done && res) { done = true; resolve(res); } };
      const timer = setTimeout(() => { cachedPage().then(finish); }, NAV_TIMEOUT_MS);
      network.then((res) => { clearTimeout(timer); finish(res); })
        .catch(() => { clearTimeout(timer); cachedPage().then((c) => finish(c || Response.error())); });
    }));
    event.waitUntil(network.catch(() => {}));
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
