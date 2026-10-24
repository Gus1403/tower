import { useSyncExternalStore } from 'react';
import type { AgentSummary, Capacity, FeedItem, ServerEvent } from '../../shared/contract';

export interface Toast {
  id: number;
  text: string;
}

export interface State {
  agents: Record<string, AgentSummary>;
  capacity: Capacity[];
  host: string;
  feeds: Record<string, FeedItem[]>;
  feedLoaded: Record<string, boolean>;
  connected: boolean;
  everConnected: boolean;
  openId: string | null;
  launchOpen: boolean;
  toasts: Toast[];
}

let state: State = {
  agents: {},
  capacity: [],
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

function subscribe(l: () => void): () => void {
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

export function upsertAgent(agent: AgentSummary): void {
  setState((s) => ({ ...s, agents: { ...s.agents, [agent.id]: agent } }));
}

export function applyEvent(ev: ServerEvent): void {
  switch (ev.type) {
    case 'snapshot': {
      const agents: Record<string, AgentSummary> = {};
      for (const a of ev.state.agents) agents[a.id] = a;
      setState((s) => ({ ...s, agents, capacity: ev.state.capacity, host: ev.state.host }));
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
  }
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
