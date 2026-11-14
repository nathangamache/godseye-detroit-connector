// Service worker for the /locate shell and icons only. Never caches API calls.
// Bump on every shell change: a new name makes browsers install this worker and drop the old cache.
const CACHE = 'locate-shell-v2';
const SHELL = [
  '/locate/',
  '/locate/app.js',
  '/locate/manifest.webmanifest',
  '/locate/icon.svg',
  '/locate/icon-192.png',
  '/locate/icon-512.png',
  '/gw/static/app.css',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/locate/claim') return;
  if (e.request.mode === 'navigate' && url.pathname.startsWith('/locate')) {
    // Network first (fresh page over the tailnet), cached shell when offline.
    e.respondWith(fetch(e.request).catch(() => caches.match('/locate/')));
    return;
  }
  if (SHELL.includes(url.pathname)) {
    // Network first for the script and styles too (a cache-first app.js once outlived a page
    // update), refreshing the cached copy; the cached copy is only for offline use.
    e.respondWith(
      fetch(e.request)
        .then((r) => {
          if (r.ok) {
            const copy = r.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
          }
          return r;
        })
        .catch(() => caches.match(e.request)),
    );
  }
});
