import { useEffect, useRef, useState } from 'react';
import type { AgentSummary } from '../../../shared/contract';
import { tmuxApi } from '../board/api-extra';
import { ago } from '../ui';
import { useNow } from '../store';

const POLL_MS = 1500;
const WRAP_KEY = 'tower.terminal.wrap';

function readWrap(): boolean {
  try {
    const v = localStorage.getItem(WRAP_KEY);
    if (v === '1' || v === '0') return v === '1';
  } catch {
    /* ignore */
  }
  return window.matchMedia('(max-width: 767px)').matches;
}

/** Live screen of an interactive tmux session. View only: the pane is captured as-is and never resized. */
export function Terminal({ a, nudge }: { a: AgentSummary; nudge: number }) {
  const [screen, setScreen] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [at, setAt] = useState<number | null>(null);
  const [wrap, setWrap] = useState(readWrap);
  const preRef = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  const fetchNow = useRef<() => void>(() => {});
  const now = useNow();

  useEffect(() => {
    let alive = true;
    let busy = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (!alive || busy) return;
      clearTimeout(timer);
      if (document.visibilityState === 'visible') {
        busy = true;
        try {
          const r = await tmuxApi.screen(a.id);
          if (alive) {
            setScreen(r.text);
            setAt(r.at || Date.now());
            setErr(null);
          }
        } catch (e) {
          if (alive) setErr((e as Error).message || 'Could not read the screen');
        } finally {
          busy = false;
        }
      }
      if (alive) timer = setTimeout(tick, POLL_MS);
    };
    fetchNow.current = () => void tick();
    void tick();
    const onVis = () => document.visibilityState === 'visible' && void tick();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      alive = false;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [a.id]);

  // a send or key press asks for a fresh screen right away
  useEffect(() => {
    if (nudge) fetchNow.current();
  }, [nudge]);

  useEffect(() => {
    const el = preRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [screen, wrap]);

  const toggleWrap = () => {
    setWrap((w) => {
      try {
        localStorage.setItem(WRAP_KEY, w ? '0' : '1');
      } catch {
        /* ignore */
      }
      return !w;
    });
  };

  return (
    <div className="ws-term">
      <div className="ws-term-bar">
        <span className="ws-term-meta" aria-live="polite">
          {err && screen !== null ? 'Screen not refreshing · retrying' : at ? `Updated ${ago(now - at)} ago` : 'Connecting to the screen…'}
        </span>
        <span className="spacer" />
        <button className="ws-chip" aria-pressed={wrap} onClick={toggleWrap} title={wrap ? 'Show lines at their original width' : 'Wrap long lines'}>
          {wrap ? 'Wrapped' : 'Original width'}
        </button>
      </div>
      <pre
        ref={preRef}
        className={`tmux-screen ws-screen ${wrap ? 'wrap' : ''}`}
        aria-label="Session screen"
        tabIndex={0}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {screen ?? (err ? '' : 'Loading screen…')}
      </pre>
      {err && (
        <div className="panel-error ws-term-err" role="alert">
          {screen === null ? `Could not read the screen: ${err}` : `Last refresh failed: ${err}`}
        </div>
      )}
    </div>
  );
}
