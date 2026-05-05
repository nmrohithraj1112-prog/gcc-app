'use strict';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));

// Section display names and emoji for notification titles
const SECTION_META = {
  exec:       { label: 'Executive Snapshot',   emoji: '📊' },
  themes:     { label: 'Strategic Themes',      emoji: '🔮' },
  deals:      { label: 'Deals & Capital',       emoji: '🤝' },
  risks:      { label: 'Risks & Opportunities', emoji: '⚠️'  },
  competitor: { label: 'Market Moves',          emoji: '⚡' },
  talent:     { label: 'Talent Signals',        emoji: '👥' },
  policy:     { label: 'Policy & Regulation',   emoji: '⚖️'  },
  tech:       { label: 'Technology Signals',    emoji: '💡' },
};

self.addEventListener('push', event => {
  if (!event.data) return;

  let payload;
  try { payload = event.data.json(); } catch { return; }

  // ── Mode 1: per-section notification (sent individually per category) ─────
  if (payload.mode === 'section') {
    const meta = SECTION_META[payload.section] || { label: payload.section, emoji: '📰' };
    const title = `${meta.emoji} GCC Intel — ${meta.label}`;
    const body  = payload.headline || payload.body || 'New intelligence available.';
    const tag   = `gccintel-${payload.section}`; // unique per section → groups in tray

    event.waitUntil(
      self.registration.showNotification(title, {
        body,
        tag,
        renotify: true,
        icon: '/icon-192.png',
        badge: '/badge-72.png',
        data: { url: payload.url || '/?section=' + payload.section },
        vibrate: [100, 50, 100],
        requireInteraction: false,
        // Group all GCC Intel notifications together in the tray
        // (Chrome on Android supports this natively via tag prefix)
        actions: [
          { action: 'open',    title: 'Read Brief' },
          { action: 'dismiss', title: 'Dismiss'    },
        ],
      })
    );
    return;
  }

  // ── Mode 2: summary notification (sent after full refresh) ────────────────
  if (payload.mode === 'summary' || payload.sections) {
    const sections = payload.sections || [];
    const count    = payload.count || sections.length;
    const title    = '📋 GCC Intel — Daily Brief Ready';
    const body     = count
      ? `${count} sections updated: ${sections.map(s => (SECTION_META[s] || {}).emoji || '').join(' ')}`
      : payload.body || 'Your intelligence brief has been refreshed.';

    event.waitUntil(
      self.registration.showNotification(title, {
        body,
        tag: 'gccintel-summary',
        renotify: true,
        icon: '/icon-192.png',
        badge: '/badge-72.png',
        data: { url: payload.url || '/' },
        vibrate: [150, 75, 150, 75, 150],
        requireInteraction: false,
        actions: [
          { action: 'open',    title: 'Open Brief' },
          { action: 'dismiss', title: 'Dismiss'    },
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