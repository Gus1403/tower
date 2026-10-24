// System notifications via the service worker (works on Android Chrome, where `new Notification()` throws,
// and when the tab/phone browser is backgrounded but alive). Needs a secure context (HTTPS or localhost).
import { openAgent } from './store';

export type NeedsYou = { id: string; name: string; title: string };

let reg: ServiceWorkerRegistration | null = null;
let started = false;

export const notifySupported = (): boolean =>
  typeof window !== 'undefined' && window.isSecureContext && 'serviceWorker' in navigator && 'Notification' in window;

/** Call from a user gesture (click). Resolves to the resulting permission. */
export async function requestNotifyPermission(): Promise<NotificationPermission> {
  if (!notifySupported()) return 'denied';
  if (Notification.permission !== 'default') return Notification.permission;
  return Notification.requestPermission();
}

async function post(n: NeedsYou): Promise<void> {
  if (Notification.permission !== 'granted') return;
  const r = reg ?? (await navigator.serviceWorker.ready.catch(() => null));
  if (!r) return;
  try {
    await r.showNotification(`${n.name} needs you`, {
      body: n.title,
      tag: `tower-${n.id}`,
      requireInteraction: true,
      data: { id: n.id, url: `/?agent=${encodeURIComponent(n.id)}` },
      // @ts-expect-error renotify is valid in Chromium, missing from lib.dom
      renotify: true,
    });
  } catch {
    r.active?.postMessage({ type: 'tower-notify', id: n.id, title: `${n.name} needs you`, body: n.title });
  }
}

function clear(id: string): void {
  reg?.getNotifications({ tag: `tower-${id}` }).then((ns) => ns.forEach((x) => x.close())).catch(() => {});
}

/**
 * Registers /sw.js and notifies on each agent that newly enters needs_you.
 * Agents already waiting at startup are not re-announced. Idempotent.
 * Pass the store's `subscribe` for instant updates (otherwise it polls getNeedsYou every second).
 */
export function initNotifications(getNeedsYou: () => NeedsYou[], subscribe?: (l: () => void) => unknown): void {
  if (started) return;
  started = true;

  // Deep link from a notification that opened a fresh window: /?agent=<id>
  const u = new URL(location.href);
  const deep = u.searchParams.get('agent');
  if (deep) {
    u.searchParams.delete('agent');
    history.replaceState(null, '', u.toString());
    setTimeout(() => openAgent(deep), 0);
  }

  if (!notifySupported()) return;
  navigator.serviceWorker
    .register('/sw.js', { scope: '/' })
    .then((r) => (reg = r))
    .catch(() => {});
  navigator.serviceWorker.addEventListener('message', (e: MessageEvent) => {
    const d = e.data as { type?: string; id?: string } | null;
    if (d?.type === 'tower-open' && d.id) openAgent(d.id);
  });

  let prev: Set<string> | null = null;
  const check = () => {
    const list = getNeedsYou();
    const ids = new Set(list.map((a) => a.id));
    if (prev) {
      for (const a of list) if (!prev.has(a.id)) void post(a);
      for (const id of prev) if (!ids.has(id)) clear(id);
    }
    // Only arm once we've seen real data, so the initial snapshot isn't announced.
    if (prev || list.length || document.readyState === 'complete') prev = ids;
  };
  check();
  // Store subscription is instant; the 1s poll is the fallback (hidden tabs may throttle it to ~1/min).
  if (subscribe) subscribe(check);
  else setInterval(check, 1000);
  document.addEventListener('visibilitychange', check);
}
