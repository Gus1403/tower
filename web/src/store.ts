import { useSyncExternalStore } from 'react';
import type { Account, AgentSummary, Board, Capacity, FeedItem, Note, RotationState, ServerEvent } from '../../shared/contract';

export interface Toast {
  id: number;
  text: string;
}

export interface State {
  agents: Record<string, AgentSummary>;
  capacity: Capacity[];
  accounts: Account[];
  notes: Note[];
  rotation: RotationState;
  boards: Board[]; // Wave D
  host: string;
  feeds: Record<string, FeedItem[]>;
  feedLoaded: Record<string, boolean>;
  connected: boolean;
  everConnected: boolean;
  openId: string | null;
  launchOpen: boolean;
  toasts: Toast[];
}

// Wave D: used until the server sends boards (contract defaults)
export const DEFAULT_BOARDS: Board[] = [
  {
    id: 'programs',
    name: 'Programs',
    columns: [
      { id: 'working', name: 'Working', statuses: ['needs_you', 'stuck', 'starting', 'working'] },
      { id: 'done', name: 'Done', statuses: ['done', 'stopped', 'error'] },
    ],
  },
  {
    id: 'customers',
    name: 'Customers',
    columns: [
      { id: 'handling', name: 'Handling', statuses: ['starting', 'working', 'needs_you', 'stuck'] },
      { id: 'waiting', name: 'Waiting on the customer', statuses: ['done'] },
      { id: 'asleep', name: 'Asleep', statuses: ['stopped', 'error'] },
    ],
  },
];

let state: State = {
  agents: {},
  capacity: [],
  accounts: [],
  notes: [],
  rotation: { autoRotate: true, activity: [] },
  boards: DEFAULT_BOARDS,
  host: '',
  feeds: {},
  feedLoaded: {},
  connected: false,
  everConnected: false,
  openId: null,
  launchOpen: false,
  toasts: [],
};

const listeners = new Set<() => void>();

export function getState(): State {
  return state;
}

export function setState(fn: (s: State) => State): void {
  const next = fn(state);
  if (next === state) return;
  state = next;
  listeners.forEach((l) => l());
}

export function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state), () => selector(state));
}

export function upsertFeed(list: FeedItem[] | undefined, item: FeedItem): FeedItem[] {
  const arr = list ?? [];
  const i = arr.findIndex((x) => x.id === item.id);
  if (i === -1) return [...arr, item];
  const copy = arr.slice();
  copy[i] = item;
  return copy;
}

// Demo mode (default off): for a shared screen, the owner's existing sessions can be shown as "<Kind> session N".
// Toggle in the ⋯ menu; stored in localStorage `tower.demo`.
export function demoMode(): boolean {
  try {
    return localStorage.getItem('tower.demo') === '1';
  } catch {
    return false;
  }
}
export function setDemoMode(on: boolean): void {
  try {
    localStorage.setItem('tower.demo', on ? '1' : '0');
  } catch {
    /* ignore */
  }
  location.reload();
}
const FLEET_LABEL: Record<string, string> = { devin: 'Devin', claude: 'Claude Code', codex: 'Codex' };
const fleetNums = new Map<string, number>();
function maskFleet(a: AgentSummary): AgentSummary {
  if (a.source !== 'tmux' || !demoMode()) return a;
  if (!fleetNums.has(a.id)) fleetNums.set(a.id, fleetNums.size + 1);
  return { ...a, name: `${FLEET_LABEL[a.kind] ?? a.kind} session ${fleetNums.get(a.id)}`, task: 'Existing session', customer: undefined, lastMessage: undefined };
}

export function upsertAgent(agent: AgentSummary): void {
  const a = maskFleet(agent);
  setState((s) => ({ ...s, agents: { ...s.agents, [a.id]: a } }));
}

export function applyEvent(ev: ServerEvent): void {
  switch (ev.type) {
    case 'snapshot': {
      const agents: Record<string, AgentSummary> = {};
      for (const a of ev.state.agents) agents[a.id] = maskFleet(a);
      setState((s) => ({ ...s, agents, capacity: ev.state.capacity, accounts: ev.state.accounts ?? [], notes: ev.state.notes ?? s.notes, rotation: ev.state.rotation ?? s.rotation, boards: ev.state.boards?.length ? ev.state.boards : s.boards, host: ev.state.host }));
      return;
    }
    case 'agent':
      upsertAgent(ev.agent);
      return;
    case 'feed':
      setState((s) => ({
        ...s,
        feeds: { ...s.feeds, [ev.agentId]: upsertFeed(s.feeds[ev.agentId], ev.item) },
      }));
      return;
    case 'capacity':
      setState((s) => ({ ...s, capacity: ev.capacity }));
      return;
    case 'accounts':
      setState((s) => ({ ...s, accounts: ev.accounts }));
      return;
    case 'agent_removed':
      removeAgentLocal(ev.agentId);
      return;
    case 'notes':
      setState((s) => ({ ...s, notes: ev.notes }));
      return;
    case 'rotation':
      setState((s) => ({ ...s, rotation: ev.rotation }));
      return;
    case 'boards':
      setState((s) => ({ ...s, boards: ev.boards }));
      return;
  }
}

export function removeAgentLocal(id: string): void {
  setState((s) => {
    if (!s.agents[id]) return s;
    const agents = { ...s.agents };
    delete agents[id];
    const feeds = { ...s.feeds };
    delete feeds[id];
    return { ...s, agents, feeds, openId: s.openId === id ? null : s.openId };
  });
}

/** Optimistically patch an agent summary (the next server 'agent' event wins). */
export function patchAgentLocal(id: string, p: Partial<AgentSummary>): void {
  setState((s) => (s.agents[id] ? { ...s, agents: { ...s.agents, [id]: { ...s.agents[id], ...p } } } : s));
}

export const selectAccounts = (s: State): Account[] => s.accounts;
export function useAccounts(): Account[] {
  return useStore(selectAccounts);
}

export const selectRotation = (s: State): RotationState => s.rotation;
export function useRotation(): RotationState {
  return useStore(selectRotation);
}
/** Optimistically patch rotation (the next server 'rotation' event wins). */
export function patchRotationLocal(p: Partial<RotationState>): void {
  setState((s) => ({ ...s, rotation: { ...s.rotation, ...p } }));
}

export const selectNotes = (s: State): Note[] => s.notes;
export function useNotes(): Note[] {
  return useStore(selectNotes);
}
/** Optimistically upsert / drop a note (the next server 'notes' event wins). */
export function upsertNoteLocal(n: Note): void {
  setState((s) => {
    const i = s.notes.findIndex((x) => x.id === n.id);
    const notes = i === -1 ? [...s.notes, n] : s.notes.map((x) => (x.id === n.id ? n : x));
    return { ...s, notes };
  });
}
export function removeNoteLocal(id: string): void {
  setState((s) => ({ ...s, notes: s.notes.filter((x) => x.id !== id) }));
}

/** Merge a fetched full feed with any live items that arrived meanwhile (live ones win). */
export function setFetchedFeed(agentId: string, fetched: FeedItem[]): void {
  setState((s) => {
    let merged = fetched;
    for (const live of s.feeds[agentId] ?? []) merged = upsertFeed(merged, live);
    return {
      ...s,
      feeds: { ...s.feeds, [agentId]: merged },
      feedLoaded: { ...s.feedLoaded, [agentId]: true },
    };
  });
}

let toastSeq = 1;
export function toast(text: string): void {
  const id = toastSeq++;
  setState((s) => ({ ...s, toasts: [...s.toasts, { id, text }] }));
  setTimeout(() => setState((s) => ({ ...s, toasts: s.toasts.filter((t) => t.id !== id) })), 4200);
}

export function openAgent(id: string | null): void {
  setState((s) => (s.openId === id ? s : { ...s, openId: id }));
}

export function setLaunchOpen(open: boolean): void {
  setState((s) => ({ ...s, launchOpen: open }));
}

// A single 1s ticker shared by every "Xs ago" label.
let now = Date.now();
const tickListeners = new Set<() => void>();
setInterval(() => {
  now = Date.now();
  tickListeners.forEach((l) => l());
}, 1000);
export function useNow(): number {
  return useSyncExternalStore(
    (l) => {
      tickListeners.add(l);
      return () => tickListeners.delete(l);
    },
    () => now,
    () => now,
  );
}
