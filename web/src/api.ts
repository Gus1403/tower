import type { AgentSummary, FeedItem, LaunchRequest, ServerEvent } from '../../shared/contract';
import { applyEvent, getState, setFetchedFeed, setState } from './store';

export interface Transport {
  fetchFeed(id: string): Promise<FeedItem[]>;
  launch(req: LaunchRequest): Promise<AgentSummary>;
  prompt(id: string, text: string): Promise<void>;
  permission(id: string, requestId: string, optionId: string): Promise<void>;
  stop(id: string): Promise<void>;
  connect(onEvent: (ev: ServerEvent) => void, onStatus: (connected: boolean) => void): void;
}

// ---- token handling ----
function readToken(): string {
  const url = new URL(window.location.href);
  const t = url.searchParams.get('token');
  if (t) {
    localStorage.setItem('tower.token', t);
    url.searchParams.delete('token');
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
  }
  return localStorage.getItem('tower.token') ?? '';
}

export const isMock = new URLSearchParams(window.location.search).get('mock') === '1';

function realTransport(): Transport {
  const token = readToken();
  async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : undefined;
    if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
    return data as T;
  }
  return {
    fetchFeed: (id) => req<FeedItem[]>('GET', `/api/agents/${encodeURIComponent(id)}/feed`),
    launch: (r) => req<AgentSummary>('POST', '/api/agents', r),
    prompt: (id, text) => req<void>('POST', `/api/agents/${encodeURIComponent(id)}/prompt`, { text }),
    permission: (id, requestId, optionId) =>
      req<void>('POST', `/api/agents/${encodeURIComponent(id)}/permission`, { requestId, optionId }),
    stop: (id) => req<void>('POST', `/api/agents/${encodeURIComponent(id)}/stop`),
    connect(onEvent, onStatus) {
      let attempt = 0;
      const open = () => {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(`${proto}//${location.host}/api/ws?token=${encodeURIComponent(token)}`);
        ws.onopen = () => {
          attempt = 0;
          onStatus(true);
        };
        ws.onmessage = (m) => {
          try {
            onEvent(JSON.parse(String(m.data)) as ServerEvent);
          } catch {
            /* ignore malformed frame */
          }
        };
        ws.onclose = () => {
          onStatus(false);
          const delay = Math.min(10000, 500 * 2 ** attempt++);
          setTimeout(open, delay);
        };
        ws.onerror = () => ws.close();
      };
      open();
    },
  };
}

let transport: Transport;

export async function initTransport(): Promise<void> {
  if (isMock) {
    const { mockTransport } = await import('./mock');
    transport = mockTransport();
  } else {
    transport = realTransport();
  }
  let wasConnected = false;
  transport.connect(
    (ev) => {
      applyEvent(ev);
      // after a reconnect snapshot, refresh the open feed so nothing is missed
      if (ev.type === 'snapshot' && wasConnected) {
        const id = getState().openId;
        if (id) void loadFeed(id, true);
      }
    },
    (connected) => {
      if (connected && getState().everConnected) wasConnected = true;
      setState((s) => ({ ...s, connected, everConnected: s.everConnected || connected }));
    },
  );
}

const inflight = new Set<string>();
export async function loadFeed(id: string, force = false): Promise<void> {
  if (inflight.has(id) || (!force && getState().feedLoaded[id])) return;
  inflight.add(id);
  try {
    setFetchedFeed(id, await transport.fetchFeed(id));
  } catch {
    setState((s) => ({ ...s, feedLoaded: { ...s.feedLoaded, [id]: true } }));
  } finally {
    inflight.delete(id);
  }
}

export const api = {
  launch: (r: LaunchRequest) => transport.launch(r),
  prompt: (id: string, text: string) => transport.prompt(id, text),
  permission: (id: string, requestId: string, optionId: string) => transport.permission(id, requestId, optionId),
  stop: (id: string) => transport.stop(id),
};
