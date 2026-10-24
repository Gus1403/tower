import type { Account, AgentKind, AgentSummary, Board, FeedItem, LaunchRequest, Note, RotationState, ServerEvent, SessionWorkspace } from '../../shared/contract';
import { applyEvent, getState, setFetchedFeed, setState } from './store';

export interface Upload {
  id: string;
  name: string;
  size: number;
}

export interface Transport {
  fetchFeed(id: string): Promise<FeedItem[]>;
  fetchWorkspace(id: string, before?: string): Promise<SessionWorkspace>;
  launch(req: LaunchRequest): Promise<AgentSummary>;
  prompt(id: string, text: string, interrupt?: boolean, attachments?: string[]): Promise<{ queued: boolean }>;
  answer(id: string, questionId: string, text: string): Promise<void>;
  move(id: string, accountId: string): Promise<AgentSummary>;
  archive(id: string, archived: boolean): Promise<void>;
  upload(file: File): Promise<Upload>;
  createNote(title: string, body: string): Promise<Note>;
  updateNote(id: string, p: { title?: string; body?: string; archived?: boolean }): Promise<Note>;
  deleteNote(id: string): Promise<void>;
  startNote(id: string, kind: AgentKind, accountId?: string): Promise<AgentSummary>;
  interrupt(id: string): Promise<void>;
  setMode(id: string, modeId: string): Promise<void>;
  setConfig(id: string, configId: string, value: string): Promise<void>;
  removeQueued(id: string, index: number): Promise<void>;
  resume(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  accounts(): Promise<Account[]>;
  clearAccount(id: string): Promise<void>;
  setExcluded(id: string, excluded: boolean): Promise<void>;
  setAutoRotate(on: boolean): Promise<RotationState>;
  permission(id: string, requestId: string, optionId: string): Promise<void>;
  stop(id: string): Promise<void>;
  // Wave D
  createBoard(name: string): Promise<Board>;
  deleteBoard(id: string): Promise<void>;
  setBoard(id: string, board: string, customer?: string): Promise<void>;
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
    fetchWorkspace: (id, before) =>
      req<SessionWorkspace>('GET', `/api/agents/${encodeURIComponent(id)}/workspace${before ? `?before=${encodeURIComponent(before)}` : ''}`),
    launch: (r) => req<AgentSummary>('POST', '/api/agents', r),
    prompt: (id, text, interrupt, attachments) =>
      req<{ queued: boolean }>('POST', `/api/agents/${encodeURIComponent(id)}/prompt`, {
        text,
        ...(interrupt ? { interrupt: true } : {}),
        ...(attachments && attachments.length ? { attachments } : {}),
      }),
    answer: (id, questionId, text) => req<void>('POST', `/api/agents/${encodeURIComponent(id)}/answer`, { questionId, text }),
    move: (id, accountId) => req<AgentSummary>('POST', `/api/agents/${encodeURIComponent(id)}/move`, { accountId }),
    archive: (id, archived) => req<void>('POST', `/api/agents/${encodeURIComponent(id)}/archive`, { archived }),
    async upload(file) {
      const res = await fetch(`/api/uploads?name=${encodeURIComponent(file.name || 'file')}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      });
      const text = await res.text();
      const data = text ? JSON.parse(text) : undefined;
      if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
      return data as Upload;
    },
    createNote: (title, body) => req<Note>('POST', '/api/notes', { title, body }),
    updateNote: (id, p) => req<Note>('PATCH', `/api/notes/${encodeURIComponent(id)}`, p),
    deleteNote: (id) => req<void>('DELETE', `/api/notes/${encodeURIComponent(id)}`),
    startNote: (id, kind, accountId) =>
      req<AgentSummary>('POST', `/api/notes/${encodeURIComponent(id)}/start`, accountId ? { kind, accountId } : { kind }),
    interrupt: (id) => req<void>('POST', `/api/agents/${encodeURIComponent(id)}/interrupt`),
    setMode: (id, modeId) => req<void>('POST', `/api/agents/${encodeURIComponent(id)}/mode`, { modeId }),
    setConfig: (id, configId, value) => req<void>('POST', `/api/agents/${encodeURIComponent(id)}/config`, { configId, value }),
    removeQueued: (id, index) => req<void>('DELETE', `/api/agents/${encodeURIComponent(id)}/queue/${index}`),
    resume: (id) => req<void>('POST', `/api/agents/${encodeURIComponent(id)}/resume`),
    remove: (id) => req<void>('DELETE', `/api/agents/${encodeURIComponent(id)}`),
    accounts: () => req<Account[]>('GET', '/api/accounts'),
    clearAccount: (id) => req<void>('POST', `/api/accounts/${encodeURIComponent(id)}/clear`),
    setExcluded: (id, excluded) => req<void>('POST', `/api/accounts/${encodeURIComponent(id)}/exclude`, { excluded }),
    setAutoRotate: (on) => req<RotationState>('POST', '/api/rotation', { autoRotate: on }),
    permission: (id, requestId, optionId) =>
      req<void>('POST', `/api/agents/${encodeURIComponent(id)}/permission`, { requestId, optionId }),
    stop: (id) => req<void>('POST', `/api/agents/${encodeURIComponent(id)}/stop`),
    createBoard: (name) => req<Board>('POST', '/api/boards', { name }),
    deleteBoard: (id) => req<void>('DELETE', `/api/boards/${encodeURIComponent(id)}`),
    setBoard: (id, board, customer) =>
      req<void>('POST', `/api/agents/${encodeURIComponent(id)}/board`, customer ? { board, customer } : { board }),
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
  workspace: (id: string, before?: string) => transport.fetchWorkspace(id, before),
  launch: (r: LaunchRequest) => transport.launch(r),
  prompt: (id: string, text: string, interrupt?: boolean, attachments?: string[]) => transport.prompt(id, text, interrupt, attachments),
  answer: (id: string, questionId: string, text: string) => transport.answer(id, questionId, text),
  move: (id: string, accountId: string) => transport.move(id, accountId),
  archive: (id: string, archived: boolean) => transport.archive(id, archived),
  upload: (file: File) => transport.upload(file),
  notes: {
    create: (title: string, body: string) => transport.createNote(title, body),
    update: (id: string, p: { title?: string; body?: string; archived?: boolean }) => transport.updateNote(id, p),
    remove: (id: string) => transport.deleteNote(id),
    start: (id: string, kind: AgentKind, accountId?: string) => transport.startNote(id, kind, accountId),
  },
  createNote: (title: string, body: string) => transport.createNote(title, body),
  updateNote: (id: string, p: { title?: string; body?: string; archived?: boolean }) => transport.updateNote(id, p),
  deleteNote: (id: string) => transport.deleteNote(id),
  startNote: (id: string, kind: AgentKind, accountId?: string) => transport.startNote(id, kind, accountId),
  interrupt: (id: string) => transport.interrupt(id),
  setMode: (id: string, modeId: string) => transport.setMode(id, modeId),
  setConfig: (id: string, configId: string, value: string) => transport.setConfig(id, configId, value),
  removeQueued: (id: string, index: number) => transport.removeQueued(id, index),
  resume: (id: string) => transport.resume(id),
  remove: (id: string) => transport.remove(id),
  accounts: () => transport.accounts(),
  clearAccount: (id: string) => transport.clearAccount(id),
  setExcluded: (id: string, excluded: boolean) => transport.setExcluded(id, excluded),
  setAutoRotate: (on: boolean) => transport.setAutoRotate(on),
  permission: (id: string, requestId: string, optionId: string) => transport.permission(id, requestId, optionId),
  stop: (id: string) => transport.stop(id),
  createBoard: (name: string) => transport.createBoard(name),
  deleteBoard: (id: string) => transport.deleteBoard(id),
  setBoard: (id: string, board: string, customer?: string) => transport.setBoard(id, board, customer),
};
