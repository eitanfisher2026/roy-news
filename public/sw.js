// Bump this whenever the precache list or strategy below changes, to
// invalidate old caches on activate.
const CACHE = 'roy-news-v2';

// Only the app's OWN files — third-party CDN scripts (React, Babel,
// Firebase, Tailwind) are left to the browser's normal HTTP cache, which
// already serves them from disk on repeat visits given their long-lived
// cache headers. Caching cross-origin no-CORS scripts here would mean
// dealing with opaque responses whose success can't be verified, for a
// payload this app doesn't control the version of anyway.
const PRECACHE_URLS = ['/', '/index.html', '/styles.css', '/manifest.json'];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(PRECACHE_URLS)).catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      clients.claim(),
      caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    ])
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const isOwnStaticAsset = url.origin === self.location.origin && (
    req.url === self.location.origin + '/' ||
    url.pathname === '/index.html' ||
    url.pathname === '/styles.css' ||
    url.pathname === '/manifest.json' ||
    url.pathname.endsWith('/app.js')
  );

  if (!isOwnStaticAsset) {
    // Everything else — Firebase auth/database/functions calls, third-party
    // CDN scripts, Google Translate, etc. — goes straight to the network,
    // exactly as before. Never cached here.
    event.respondWith(fetch(req).catch(() => caches.match(req)));
    return;
  }

  // Stale-while-revalidate: serve the cached copy immediately when there is
  // one (instant on repeat visits, works offline), while always re-fetching
  // in the background to keep the cache current for the next load. app.js is
  // requested with a version query string that changes on every deploy, so a
  // cache hit only ever serves whatever version is currently live — a new
  // version is simply a cache miss the first time, fetched fresh, then cached.
  event.respondWith(
    caches.open(CACHE).then(async cache => {
      const cached = await cache.match(req);
      const network = fetch(req).then(resp => {
        if (resp && resp.ok) cache.put(req, resp.clone());
        return resp;
      }).catch(() => null);
      return cached || (await network) || fetch(req);
    })
  );
});
