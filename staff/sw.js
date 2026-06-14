/* TAC Desk — staff service worker: PWA shell + web push */
const CACHE = 'tacdesk-v1';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['./'])).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.pathname.startsWith('/api/')) return; // live data, never cached
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then((res) => { const c = res.clone(); caches.open(CACHE).then((x) => x.put(req, c)); return res; })
      .catch(() => caches.match(req).then((h) => h || caches.match('./'))));
    return;
  }
  e.respondWith(caches.match(req).then((hit) => {
    const refresh = fetch(req).then((res) => { if (res && res.ok) { const c = res.clone(); caches.open(CACHE).then((x) => x.put(req, c)); } return res; }).catch(() => hit);
    return hit || refresh;
  }));
});

self.addEventListener('push', (e) => {
  let data = { title: 'TAC Desk', body: 'New activity', url: '/staff/' };
  try { if (e.data) data = { ...data, ...e.data.json() }; } catch {}
  e.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    icon: '../icons/icon-192.png',
    badge: '../icons/icon-192.png',
    tag: data.tag || 'tac-desk',
    renotify: true,
    vibrate: [80, 40, 80],
    data: { url: data.url || '/staff/' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || '/staff/';
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
    for (const w of wins) { if (w.url.includes('/staff') && 'focus' in w) return w.focus(); }
    return clients.openWindow(target);
  }));
});
