// Board-side helpers for Wave B routes (tmux send/key/screen, notes CRUD/start, archive).
// Uses the same token/Authorization pattern as api.ts. In mock mode (?mock=1) nothing hits /api:
// notes live in local state, start goes through the mock launch, tmux screens are faked here.
import type { AgentKind, AgentSummary, Note } from '../../../shared/contract';
import { api, isMock } from '../api';
import { getState, patchAgentLocal, setState, upsertAgent, useStore } from '../store';

function token(): string {
  return localStorage.getItem('tower.token') ?? '';
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: {
      Authorization: `Bearer ${token()}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data as T;
}
const enc = encodeURIComponent;

// ---------- notes + archive: go through the shared transport (api.ts; mock transport in ?mock=1) ----------
const notesOf = (): Note[] => getState().notes ?? [];
const setNotes = (n: Note[]) => setState((s) => ({ ...s, notes: n }));

export function useBoardNotes(): Note[] {
  return useStore((s) => s.notes) ?? [];
}

export const notesApi = {
  async create(title: string, body: string): Promise<Note> {
    const n = await api.notes.create(title, body);
    setNotes([n, ...notesOf().filter((x) => x.id !== n.id)]);
    return n;
  },
  async update(id: string, p: Partial<Pick<Note, 'title' | 'body' | 'archived'>>): Promise<void> {
    const prev = notesOf();
    setNotes(prev.map((x) => (x.id === id ? { ...x, ...p } : x)));
    try {
      const n = await api.notes.update(id, p);
      if (n) setNotes(notesOf().map((x) => (x.id === id ? n : x)));
    } catch (e) {
      setNotes(prev);
      throw e;
    }
  },
  async remove(id: string): Promise<void> {
    const prev = notesOf();
    setNotes(prev.filter((x) => x.id !== id));
    try {
      await api.notes.remove(id);
    } catch (e) {
      setNotes(prev);
      throw e;
    }
  },
  async start(note: Note, kind: AgentKind, accountId?: string): Promise<AgentSummary> {
    const acct = accountId && accountId !== 'auto' ? accountId : undefined;
    const a = await api.notes.start(note.id, kind, acct);
    upsertAgent(a);
    return a;
  },
};

export async function setArchived(id: string, archived: boolean): Promise<void> {
  const prev = getState().agents[id]?.archived;
  patchAgentLocal(id, { archived });
  try {
    await api.archive(id, archived);
  } catch (e) {
    patchAgentLocal(id, { archived: prev });
    throw e;
  }
}

// ---------- tmux ----------
export type TmuxKey = 'Escape' | 'Enter' | 'Up' | 'Down' | 'Left' | 'Right' | 'Tab' | 'C-c';

const mockScreens = new Map<string, string[]>();
function mockScreen(id: string): string[] {
  let s = mockScreens.get(id);
  if (!s) {
    s = [
      `eva@eva-forge:~/code/eva$ claude`,
      ``,
      `╭──────────────────────────────────────────────╮`,
      `│ ✻ Welcome to Claude Code                     │`,
      `│   cwd: ~/code/eva                            │`,
      `╰──────────────────────────────────────────────╯`,
      ``,
      `> watch the canary deploy logs and tell me if p95 regresses`,
      ``,
      `⏺ Bash(koyeb service logs eva-api --tail 200)`,
      `  ⎿  12:01:04 GET /health 200 3ms`,
      `     12:01:05 POST /v1/messages 200 412ms`,
      `     12:01:07 POST /v1/messages 200 389ms`,
      ``,
      `⏺ p95 is 405 ms, in line with the previous release (398 ms). Still watching.`,
      ``,
      `────────────────────────────────────────────────`,
      `> `,
    ];
    mockScreens.set(id, s);
  }
  return s;
}

export const tmuxApi = {
  async screen(id: string): Promise<{ text: string; at: number }> {
    if (isMock) return { text: mockScreen(id).join('\n'), at: Date.now() };
    return req('GET', `/api/agents/${enc(id)}/screen`);
  },
  async send(id: string, text: string): Promise<void> {
    if (isMock) {
      const s = mockScreen(id);
      s.pop();
      s.push(`> ${text}`, '', `⏺ Got it — ${text.length > 60 ? text.slice(0, 60) + '…' : text}`, '', '────────────────────────────────────────────────', '> ');
      return;
    }
    await req('POST', `/api/agents/${enc(id)}/send`, { text });
  },
  async key(id: string, key: TmuxKey): Promise<void> {
    if (isMock) {
      const s = mockScreen(id);
      s.splice(s.length - 1, 0, `  [${key}]`);
      return;
    }
    await req('POST', `/api/agents/${enc(id)}/key`, { key });
  },
};

/** Mock only: make the first observed tmux card interactive so the TmuxPanel can be demoed. */
export function mockMakeInteractive(): void {
  if (!isMock) return;
  const a = getState().agents['t1x9'];
  if (a && a.interactive === undefined) patchAgentLocal('t1x9', { interactive: true });
}
