'use strict';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));

// Section display names for notification titles
const SECTION_META = {
  exec:       { label: 'Executive Snapshot'   },
  themes:     { label: 'Strategic Themes'     },
  deals:      { label: 'Deals & Capital'      },
  risks:      { label: 'Risks & Opportunities'},
  competitor: { label: 'Market Moves'         },
  talent:     { label: 'Talent Signals'       },
  policy:     { label: 'Policy & Regulation'  },
  tech:       { label: 'Technology Signals'   },
};

self.addEventListener('push', event => {
  if (!event.data) return;

  let payload;
  try { payload = event.data.json(); } catch { return; }

  // ── Mode 1: per-section notification with article content ────────────────
  if (payload.mode === 'section') {
    const meta  = SECTION_META[payload.section] || { label: payload.section };
    const title = `GCC Intel — ${meta.label}`;

    // Build readable body: headline on first line, snippet + source below
    const parts = [];
    if (payload.headline) parts.push(payload.headline);
    if (payload.snippet)  parts.push(payload.snippet + (payload.src ? ' — ' + payload.src : ''));
    else if (payload.src) parts.push(payload.src);
    const body = parts.join('\n') || 'New intelligence available.';

    event.waitUntil(
      self.registration.showNotification(title, {
        body,
        tag: `gccintel-${payload.section}`,
        renotify: true,
        icon: '/gmr-favicon.png',
        badge: '/gmr-favicon.png',
        data: { url: payload.url || '/?section=' + payload.section },
        vibrate: [100, 50, 100],
        requireInteraction: false,
        actions: [
          { action: 'open',    title: 'Read' },
          { action: 'dismiss', title: 'Dismiss' },
        ],
      })
    );
    return;
  }

  // ── Mode 3: legacy fallback (plain title/body) ────────────────────────────
  event.waitUntil(
    self.registration.showNotification(payload.title || 'GCC Intel', {
      body: payload.body || 'Your daily intelligence brief is ready.',
      tag: 'gccintel-brief',
      renotify: true,
      icon: '/icon-192.png',
      data: { url: payload.url || '/' },
      vibrate: [150, 75, 150],
      requireInteraction: false,
    })
  );
});

// ── Notification click handler ────────────────────────────────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();

  // Handle action buttons
  if (event.action === 'dismiss') return;

  const url = event.notification.data?.url || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      // Focus existing open tab if possible
      for (const w of list) {
        if (w.url.includes(self.location.origin) && 'focus' in w) {
          w.focus();
          // Navigate to section URL if different
          if (url !== '/' && w.url !== url) w.navigate?.(url);
          return;
        }
      }
      return clients.openWindow(url);
    })
  );
});

// ── Notification close handler ────────────────────────────────────────────────
self.addEventListener('notificationclose', () => {
  // Analytics hook — no-op for now
});