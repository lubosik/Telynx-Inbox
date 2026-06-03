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

// ── Web Push ──────────────────────────────────────────────────────────────────

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch {}

  const title = data.title || 'Vici SMS';
  const options = {
    body: data.body || '',
    icon: data.icon || '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: data.url || '/' },
    requireInteraction: true,
    vibrate: [200, 100, 200]
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(wins => {
      if (wins.length > 0) {
        // App is already open — navigate it to the thread URL then focus
        return wins[0].navigate(targetUrl).then(client => client.focus());
      }
      // App is closed — open it at the thread URL
      return clients.openWindow(targetUrl);
    })
  );
});
