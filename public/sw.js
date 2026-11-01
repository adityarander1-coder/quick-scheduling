// Quick Scheduling service worker — web push only (Phase 3, 2026-10-31).
// Receives push messages from the app server and shows them as system
// notifications; clicking one focuses the app (or opens it) at the
// notification's target tab. It does no caching and no fetching.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  if (event.data) {
    try { data = event.data.json(); } catch (e) { data = { title: 'Quick Scheduling', body: event.data.text() }; }
  }
  const title = data.title || 'Quick Scheduling';
  const options = {
    body: data.body || '',
    tag: data.tag || undefined,
    data: { url: data.url || '/app.html' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/app.html';
  event.waitUntil((async () => {
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url.includes('/app.html') && 'focus' in c) {
        try { await c.navigate(url); } catch (e) { /* already there is fine */ }
        return c.focus();
      }
    }
    return clients.openWindow(url);
  })());
});
