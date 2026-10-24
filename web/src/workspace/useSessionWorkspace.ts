// Read-only history + context of an observed session, polled while the page is visible.
// One instance per session (the caller keys its component by session id), so nothing can leak across sessions.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FeedItem, SessionWorkspace } from '../../../shared/contract';
import { api } from '../api';

const POLL_MS = 4000;
const RETRY_MS = 8000;

export interface SessionWorkspaceState {
  status: 'loading' | 'ready' | 'error';
  error?: string; // first load failed (status error) or the last refresh failed (stale)
  stale: boolean;
  available: boolean;
  reason?: string;
  items: FeedItem[];
  hasMore: boolean;
  loadingOlder: boolean;
  olderError?: string;
  context: SessionWorkspace['context'];
  updatedAt?: number;
}

const INITIAL: SessionWorkspaceState = { status: 'loading', stale: false, available: false, items: [], hasMore: false, loadingOlder: false, context: {} };

/** Upsert by id: known items update in place, new ones append in server order. */
function mergeLatest(prev: FeedItem[], latest: FeedItem[]): FeedItem[] {
  if (prev.length === 0) return latest;
  const at = new Map(prev.map((x, i) => [x.id, i]));
  const out = prev.slice();
  for (const it of latest) {
    const i = at.get(it.id);
    if (i === undefined) {
      at.set(it.id, out.length);
      out.push(it);
    } else out[i] = it;
  }
  return out;
}

export function useSessionWorkspace(id: string) {
  const [st, setSt] = useState<SessionWorkspaceState>(INITIAL);
  const alive = useRef(true);
  const inflight = useRef(false);
  const olderInflight = useRef(false);
  const cursor = useRef<{ set: boolean; before?: string }>({ set: false });
  const timer = useRef<ReturnType<typeof setTimeout>>();

  const poll = useCallback(async () => {
    if (inflight.current || !alive.current) return;
    inflight.current = true;
    clearTimeout(timer.current);
    let failed = false;
    try {
      const w = await api.workspace(id);
      if (!alive.current) return;
      const conv = w.conversation;
      // the older-page cursor comes from the first page only; later polls just refresh the newest window
      const firstPage = !cursor.current.set;
      if (firstPage) cursor.current = { set: true, before: conv.hasMore ? conv.before : undefined };
      setSt((s) => ({
        ...s,
        status: 'ready',
        error: undefined,
        stale: false,
        available: conv.available,
        reason: conv.reason,
        items: conv.available ? mergeLatest(s.items, conv.items ?? []) : s.items,
        hasMore: firstPage ? !!cursor.current.before : s.hasMore,
        context: w.context ?? {},
        updatedAt: Date.now(),
      }));
    } catch (e) {
      failed = true;
      if (!alive.current) return;
      const msg = (e as Error).message || 'Request failed';
      setSt((s) => (s.status === 'ready' ? { ...s, stale: true, error: msg } : { ...s, status: 'error', error: msg }));
    } finally {
      inflight.current = false;
      if (alive.current) timer.current = setTimeout(tick, failed ? RETRY_MS : POLL_MS);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // hidden tabs skip the request and wait for visibilitychange
  const tick = useCallback(() => {
    if (document.visibilityState === 'visible') void poll();
  }, [poll]);

  useEffect(() => {
    alive.current = true;
    void poll();
    const onVis = () => document.visibilityState === 'visible' && void poll();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      alive.current = false;
      clearTimeout(timer.current);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [poll]);

  const loadOlder = useCallback(async () => {
    const before = cursor.current.before;
    if (olderInflight.current || !before) return;
    olderInflight.current = true;
    setSt((s) => ({ ...s, loadingOlder: true, olderError: undefined }));
    try {
      const w = await api.workspace(id, before);
      if (!alive.current) return;
      const conv = w.conversation;
      cursor.current = { set: true, before: conv.hasMore ? conv.before : undefined };
      setSt((s) => {
        const have = new Set(s.items.map((x) => x.id));
        const older = (conv.items ?? []).filter((x) => !have.has(x.id));
        return { ...s, items: [...older, ...s.items], hasMore: !!cursor.current.before, loadingOlder: false };
      });
    } catch (e) {
      if (alive.current) setSt((s) => ({ ...s, loadingOlder: false, olderError: (e as Error).message || 'Request failed' }));
    } finally {
      olderInflight.current = false;
    }
  }, [id]);

  const retry = useCallback(() => {
    setSt((s) => (s.status === 'error' ? { ...s, status: 'loading', error: undefined } : s));
    void poll();
  }, [poll]);

  return { ...st, loadOlder, refresh: poll, retry };
}
