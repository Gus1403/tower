/* Tower service worker: shows "agent needs you" notifications and routes clicks back to the agent. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

function show(d) {
  const id = String(d.id || '');
  return self.registration.showNotification(d.title || 'Tower', {
    body: d.body || '',
    tag: 'tower-' + id,
    renotify: true,
    requireInteraction: true,
    icon: d.icon || undefined,
    data: { id, url: d.url || '/?agent=' + encodeURIComponent(id) },
  });
}

// Page -> SW: {type:'tower-notify', id, title, body}
self.addEventListener('message', (e) => {
  const d = e.data || {};
  if (d.type === 'tower-notify') e.waitUntil(show(d));
  if (d.type === 'tower-clear' && d.id) {
    e.waitUntil(
      self.registration.getNotifications({ tag: 'tower-' + d.id }).then((ns) => ns.forEach((n) => n.close())),
    );
  }
});

// Future Web Push: server sends JSON {id, title, body}.
self.addEventListener('push', (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch {
    d = { title: 'Tower', body: e.data ? e.data.text() : '' };
  }
  e.waitUntil(show(d));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const { id, url } = e.notification.data || {};
  e.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const c = all.find((w) => new URL(w.url).origin === self.location.origin);
      if (c) {
        await c.focus().catch(() => {});
        c.postMessage({ type: 'tower-open', id });
        return;
      }
      await self.clients.openWindow(url || '/');
    })(),
  );
});
