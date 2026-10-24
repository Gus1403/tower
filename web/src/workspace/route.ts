// Keeps the open session in the URL hash (#/board/<board>/session/<id>) so Back returns to the board
// and a reload reopens the same session. The store's openId stays the single source of truth.
import { getActiveBoard } from '../boards/activeBoard';
import { getState, openAgent, subscribe } from '../store';

const SESSION_RE = /\/session\/([A-Za-z0-9_.:-]+)$/;
const MARK = 'tower-session';

export const sessionFromHash = (): string | null => {
  const m = SESSION_RE.exec(window.location.hash);
  return m ? decodeURIComponent(m[1]) : null;
};

const boardHash = () => `#/board/${getActiveBoard()}`;
const urlWith = (hash: string) => window.location.pathname + window.location.search + hash;

let started = false;

export function initSessionRoute(): void {
  if (started) return;
  started = true;

  const initial = sessionFromHash();
  if (initial) openAgent(initial);

  let last = getState().openId;
  subscribe(() => {
    const id = getState().openId;
    if (id === last) return;
    last = id;
    const inHash = sessionFromHash();
    if (id) {
      if (inHash === id) return;
      const hash = `${boardHash()}/session/${encodeURIComponent(id)}`;
      // first open pushes one entry (Back closes it); switching sessions replaces it
      if (inHash) window.history.replaceState(window.history.state, '', urlWith(hash));
      else window.history.pushState({ [MARK]: true }, '', urlWith(hash));
    } else if (inHash) {
      if ((window.history.state as Record<string, unknown> | null)?.[MARK]) window.history.back();
      else window.history.replaceState(null, '', urlWith(boardHash()));
    }
  });

  window.addEventListener('popstate', () => {
    const id = sessionFromHash();
    if (id !== getState().openId) openAgent(id);
  });
}
