import type { Account, AgentSummary, FeedItem, LaunchRequest, ServerEvent } from '../../shared/contract';
import { applyEvent, getState, setFetchedFeed, setState } from './store';

export interface Transport {
  fetchFeed(id: string): Promise<FeedItem[]>;
  launch(req: LaunchRequest): Promise<AgentSummary>;
  prompt(id: string, text: string, interrupt?: boolean): Promise<{ queued: boolean }>;
  interrupt(id: string): Promise<void>;
  setMode(id: string, modeId: string): Promise<void>;
  setConfig(id: string, configId: string, value: string): Promise<void>;
  removeQueued(id: string, index: number): Promise<void>;
  resume(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  accounts(): Promise<Account[]>;
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
    prompt: (id, text, interrupt) =>
      req<{ queued: boolean }>('POST', `/api/agents/${encodeURIComponent(id)}/prompt`, interrupt ? { text, interrupt: true } : { text }),
    interrupt: (id) => req<void>('POST', `/api/agents/${encodeURIComponent(id)}/interrupt`),
    setMode: (id, modeId) => req<void>('POST', `/api/agents/${encodeURIComponent(id)}/mode`, { modeId }),
    setConfig: (id, configId, value) => req<void>('POST', `/api/agents/${encodeURIComponent(id)}/config`, { configId, value }),
    removeQueued: (id, index) => req<void>('DELETE', `/api/agents/${encodeURIComponent(id)}/queue/${index}`),
    resume: (id) => req<void>('POST', `/api/agents/${encodeURIComponent(id)}/resume`),
    remove: (id) => req<void>('DELETE', `/api/agents/${encodeURIComponent(id)}`),
    accounts: () => req<Account[]>('GET', '/api/accounts'),
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
  prompt: (id: string, text: string, interrupt?: boolean) => transport.prompt(id, text, interrupt),
  interrupt: (id: string) => transport.interrupt(id),
  setMode: (id: string, modeId: string) => transport.setMode(id, modeId),
  setConfig: (id: string, configId: string, value: string) => transport.setConfig(id, configId, value),
  removeQueued: (id: string, index: number) => transport.removeQueued(id, index),
  resume: (id: string) => transport.resume(id),
  remove: (id: string) => transport.remove(id),
  accounts: () => transport.accounts(),
  permission: (id: string, requestId: string, optionId: string) => transport.permission(id, requestId, optionId),
  stop: (id: string) => transport.stop(id),
};
