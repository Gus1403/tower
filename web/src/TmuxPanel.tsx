import { useEffect, useRef, useState } from 'react';
import type { AgentSummary } from '../../shared/contract';
import { tmuxApi, type TmuxKey } from './board/api-extra';
import { openAgent, toast } from './store';
import { KindBadge } from './ui';
import './tmux.css';

const KEYS: { key: TmuxKey; label: string; aria: string }[] = [
  { key: 'Escape', label: 'Esc', aria: 'Escape' },
  { key: 'Enter', label: 'Enter', aria: 'Enter' },
  { key: 'Up', label: '↑', aria: 'Up arrow' },
  { key: 'Down', label: '↓', aria: 'Down arrow' },
  { key: 'Tab', label: 'Tab', aria: 'Tab' },
  { key: 'C-c', label: 'Ctrl-C', aria: 'Control C' },
];

const trustKey = (id: string) => `tower.tmux.trust.${id}`;

export function TmuxPanel({ a, onNext, onPrev }: { a: AgentSummary; onNext?: () => void; onPrev?: () => void }) {
  const [screen, setScreen] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [confirm, setConfirm] = useState<null | { kind: 'send'; text: string } | { kind: 'key'; key: TmuxKey }>(null);
  const [dontAsk, setDontAsk] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);
  const stick = useRef(true);

  // poll the screen every 1.5 s while open and the page is visible
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setScreen(null);
    setErr(null);
    const tick = async () => {
      if (!alive) return;
      if (document.visibilityState === 'visible') {
        try {
          const r = await tmuxApi.screen(a.id);
          if (alive) {
            setScreen(r.text);
            setErr(null);
          }
        } catch (e) {
          if (alive) setErr((e as Error).message);
        }
      }
      if (alive) timer = setTimeout(tick, 1500);
    };
    void tick();
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        clearTimeout(timer);
        void tick();
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      alive = false;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [a.id]);

  useEffect(() => {
    const el = preRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [screen]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (confirm) setConfirm(null);
      else openAgent(null);
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [confirm]);

  const trusted = () => localStorage.getItem(trustKey(a.id)) === '1';

  const refresh = async () => {
    try {
      setScreen((await tmuxApi.screen(a.id)).text);
    } catch {
      /* next poll */
    }
  };
  const doSend = async (t: string) => {
    try {
      await tmuxApi.send(a.id, t);
      setText('');
      stick.current = true;
      void refresh();
    } catch (e) {
      toast(`Could not send: ${(e as Error).message}`);
    }
  };
  const doKey = async (key: TmuxKey) => {
    try {
      await tmuxApi.key(a.id, key);
      void refresh();
    } catch (e) {
      toast(`Could not send ${key}: ${(e as Error).message}`);
    }
  };
  const send = () => {
    const t = text.trim();
    if (!t) return;
    if (trusted()) void doSend(t);
    else setConfirm({ kind: 'send', text: t });
  };
  const key = (k: TmuxKey) => {
    if (trusted()) void doKey(k);
    else setConfirm({ kind: 'key', key: k });
  };
  const accept = () => {
    if (!confirm) return;
    if (dontAsk) localStorage.setItem(trustKey(a.id), '1');
    const c = confirm;
    setConfirm(null);
    if (c.kind === 'send') void doSend(c.text);
    else void doKey(c.key);
  };

  return (
    <aside className="panel tmux-panel" aria-label={`Live session ${a.name}`}>
      <div className="panel-head">
        <div className="panel-row">
          <KindBadge kind={a.kind} />
          <span className="panel-name">{a.name}</span>
          <span className="tmux-live" title="Live tmux session">
            <i /> Live
          </span>
          <span className="spacer" />
          {onPrev && (
            <button className="icon-btn" aria-label="Previous card (K)" title="Previous (K)" onClick={onPrev}>
              ‹
            </button>
          )}
          {onNext && (
            <button className="icon-btn" aria-label="Next card (J)" title="Next (J)" onClick={onNext}>
              ›
            </button>
          )}
          <button className="icon-btn" aria-label="Close" onClick={() => openAgent(null)}>
            ×
          </button>
        </div>
        <div className="panel-sub">
          <code>{a.cwd}</code>
        </div>
      </div>
      <pre
        ref={preRef}
        className="tmux-screen"
        aria-label="Session screen"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {screen ?? (err ? '' : 'Loading screen…')}
      </pre>
      {err && <div className="panel-error">{err}</div>}
      <div className="tmux-keys" role="group" aria-label="Keys">
        {KEYS.map((k) => (
          <button key={k.key} className="tmux-key" aria-label={k.aria} onClick={() => key(k.key)}>
            {k.label}
          </button>
        ))}
      </div>
      {confirm ? (
        <div className="tmux-confirm" role="alertdialog" aria-label="Confirm send">
          <div className="tmux-confirm-text">
            This types into a live session on eva-forge. Send?
            <code>{confirm.kind === 'send' ? confirm.text : confirm.key}</code>
          </div>
          <label className="tmux-dontask">
            <input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} /> Don’t ask again for this card
          </label>
          <div className="tmux-confirm-actions">
            <button className="btn btn-secondary btn-sm" onClick={() => setConfirm(null)}>
              Cancel
            </button>
            <button className="btn btn-primary btn-sm" onClick={accept} autoFocus>
              Send
            </button>
          </div>
        </div>
      ) : (
        <div className="composer tmux-composer">
          <input
            className="tmux-input"
            value={text}
            placeholder="Type into the session…"
            aria-label="Send to session"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button className="btn btn-primary" disabled={!text.trim()} onClick={send}>
            Send
          </button>
        </div>
      )}
    </aside>
  );
}
