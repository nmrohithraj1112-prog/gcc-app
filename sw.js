'use strict';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));

self.addEventListener('push', event => {
  const d = event.data ? event.data.json() : {};
  event.waitUntil(
    self.registration.showNotification(d.title || 'GCC Intel', {
      body: d.body || 'Your daily intelligence brief is ready.',
      icon: d.icon || '',
      tag: 'gccintel-brief',
      renotify: true,
      data: { url: d.url || '/' },
      vibrate: [150, 75, 150],
      requireInteraction: false,
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const w of list) {
        if ('focus' in w) return w.focus();
      }
      return clients.openWindow(url);
    })
  );
});
