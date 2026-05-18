const CACHE = 'vici-v1';
const SHELL = ['/', '/styles.css', '/manifest.json'];
self.addEventListener('install', e =>
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL).catch(() => {}))));
self.addEventListener('activate', e =>
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))));
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  if (e.request.url.includes('/api/') || e.request.url.includes('/webhook')) return;
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
