// Wave D: the active board, persisted in the URL hash (#/board/<id>) and localStorage.
import { useSyncExternalStore } from 'react';

const KEY = 'tower.board';
const fromHash = (): string | null => {
  const m = /^#\/board\/([A-Za-z0-9_-]+)/.exec(window.location.hash);
  return m ? m[1] : null;
};

let active: string = fromHash() ?? localStorage.getItem(KEY) ?? 'programs';
const listeners = new Set<() => void>();

function writeHash(id: string) {
  const want = `#/board/${id}`;
  if (window.location.hash !== want) window.history.replaceState(null, '', window.location.pathname + window.location.search + want);
}

export function getActiveBoard(): string {
  return active;
}

export function setActiveBoard(id: string): void {
  writeHash(id);
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* ignore */
  }
  if (id === active) return;
  active = id;
  listeners.forEach((l) => l());
}

window.addEventListener('hashchange', () => {
  const h = fromHash();
  if (h && h !== active) setActiveBoard(h);
});

export function useActiveBoard(): string {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => active,
    () => active,
  );
}

export const boardOf = (a: { board?: string }): string => a.board ?? 'programs';
