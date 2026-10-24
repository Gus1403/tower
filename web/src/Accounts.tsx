import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Account, AgentKind } from '../../shared/contract';
import { toast, useStore } from './store';
import './accounts.css';

export const ACCOUNT_KINDS: AgentKind[] = ['devin', 'claude', 'codex'];
const KIND_NAME: Record<AgentKind, string> = { devin: 'Devin', claude: 'Claude Code', codex: 'Codex' };
const ADD_HELP: Record<AgentKind, { text: string; cmd: string }> = {
  devin: { text: 'Log in another Devin seat', cmd: 'devin auth login' },
  claude: { text: 'Create a new home, then log in', cmd: 'CLAUDE_CONFIG_DIR=~/.claude-N claude /login' },
  codex: { text: 'Create a new home, then log in', cmd: 'CODEX_HOME=~/.codex-N codex login' },
};

// Works whether or not the store already carries `accounts` (U1 adds it concurrently).
export function useAccounts(): Account[] {
  return useStore((s) => (s as unknown as { accounts?: Account[] }).accounts) ?? EMPTY;
}
const EMPTY: Account[] = [];

// ---------- tiny local store for the panel ----------
type Filter = AgentKind | 'all' | null;
let filter: Filter = null;
const subs = new Set<() => void>();
export function openAccounts(f: AgentKind | 'all') {
  filter = f;
  subs.forEach((l) => l());
}
function closeAccounts() {
  filter = null;
  subs.forEach((l) => l());
}
function useFilter(): Filter {
  return useSyncExternalStore(
    (l) => (subs.add(l), () => subs.delete(l)),
    () => filter,
  );
}

async function copy(text: string) {
  try {
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
    else {
      const t = document.createElement('textarea');
      t.value = text;
      t.style.position = 'fixed';
      t.style.opacity = '0';
      document.body.appendChild(t);
      t.select();
      document.execCommand('copy');
      t.remove();
    }
    toast('Copied');
  } catch {
    toast('Could not copy');
  }
}

function CmdBox({ cmd }: { cmd: string }) {
  return (
    <div className="acc-cmd">
      <code>{cmd}</code>
      <button className="acc-copy" onClick={() => void copy(cmd)}>
        Copy
      </button>
    </div>
  );
}

function AccountRow({ a }: { a: Account }) {
  const state = a.loggedIn === true ? 'on' : a.loggedIn === false ? 'off' : 'unknown';
  return (
    <div className={`acc-row acc-${state}`}>
      <div className="acc-line">
        <span className={`acc-dot acc-dot-${state}`} />
        <span className="acc-label">{a.label}</span>
        {a.plan && <span className="acc-plan">{a.plan}</span>}
        <span className="acc-spacer" />
        {a.running > 0 && <span className="acc-running">{a.running} running</span>}
      </div>
      {state !== 'on' && <div className="acc-state">{state === 'off' ? 'Not logged in' : 'Login state unknown'}</div>}
      {a.usedPct !== undefined && (
        <div className="acc-usage" title={`${Math.round(a.usedPct)}% used`}>
          <span className="acc-bar">
            <span style={{ width: `${Math.min(100, Math.max(0, a.usedPct))}%` }} className={a.usedPct > 80 ? 'hot' : ''} />
          </span>
          <span className="acc-pct">{Math.round(a.usedPct)}%</span>
        </div>
      )}
      {a.detail && a.detail !== 'Not logged in' && <div className="acc-detail">{a.detail}</div>}
      {state !== 'on' && <CmdBox cmd={a.loginCommand} />}
    </div>
  );
}

export function AccountsPanel() {
  const f = useFilter();
  const accounts = useAccounts();
  useEffect(() => {
    if (!f) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && closeAccounts();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [f]);
  if (!f) return null;
  const kinds = f === 'all' ? ACCOUNT_KINDS : [f];
  return (
    <div className="acc-scrim" onMouseDown={(e) => e.target === e.currentTarget && closeAccounts()}>
      <aside className="acc-panel" role="dialog" aria-label="Accounts">
        <div className="acc-grip" />
        <div className="acc-head">
          <h2>{f === 'all' ? 'Accounts' : KIND_NAME[f]}</h2>
          {f !== 'all' && (
            <button className="acc-all" onClick={() => openAccounts('all')}>
              All accounts
            </button>
          )}
          <span className="acc-spacer" />
          <button className="icon-btn" onClick={closeAccounts} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="acc-body">
          {kinds.map((k) => {
            const list = accounts.filter((a) => a.kind === k);
            return (
              <section key={k} className="acc-group">
                <div className="acc-group-head">
                  <span className={`cap-dot kind-dot-${k}`} />
                  {KIND_NAME[k]}
                  <span className="acc-count">{list.filter((a) => a.loggedIn).length}/{list.length}</span>
                </div>
                {list.length === 0 && <div className="acc-empty">No accounts found</div>}
                {list.map((a) => (
                  <AccountRow key={a.id} a={a} />
                ))}
                <details className="acc-add">
                  <summary>+ Add an account</summary>
                  <div className="acc-add-text">{ADD_HELP[k].text}</div>
                  <CmdBox cmd={ADD_HELP[k].cmd} />
                </details>
              </section>
            );
          })}
        </div>
      </aside>
    </div>
  );
}

// ---------- attention alerts ----------
const MUTE_KEY = 'tower.mute';
let muted = (() => {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
})();
const muteSubs = new Set<() => void>();
export function useMuted(): [boolean, () => void] {
  const m = useSyncExternalStore(
    (l) => (muteSubs.add(l), () => muteSubs.delete(l)),
    () => muted,
  );
  return [
    m,
    () => {
      muted = !muted;
      try {
        localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
      } catch {}
      muteSubs.forEach((l) => l());
    },
  ];
}

let audio: AudioContext | null = null;
function beep() {
  if (muted) return;
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    audio = audio ?? new Ctx();
    const t = audio.currentTime;
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(880, t);
    o.frequency.exponentialRampToValueAtTime(660, t + 0.18);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.08, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    o.connect(g).connect(audio.destination);
    o.start(t);
    o.stop(t + 0.4);
  } catch {}
}

let baseIcon: string | null = null;
function setFavicon(n: number) {
  let link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  if (baseIcon === null) baseIcon = link.href || '';
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d');
  if (!x) return;
  x.fillStyle = '#111';
  x.beginPath();
  x.roundRect?.(0, 0, 64, 64, 16);
  if (!x.roundRect) x.rect(0, 0, 64, 64);
  x.fill();
  x.strokeStyle = '#fff';
  x.lineWidth = 4;
  x.lineJoin = 'round';
  x.beginPath();
  x.moveTo(23, 51); x.lineTo(41, 51); x.lineTo(38, 28); x.lineTo(26, 28); x.closePath();
  x.moveTo(27, 28); x.lineTo(27, 20); x.lineTo(37, 20); x.lineTo(37, 28);
  x.moveTo(32, 20); x.lineTo(32, 12);
  x.stroke();
  if (n > 0) {
    x.fillStyle = '#d97706';
    x.beginPath();
    x.arc(50, 14, 13, 0, Math.PI * 2);
    x.fill();
  }
  link.href = c.toDataURL('image/png');
}

export const canNotify = typeof window !== 'undefined' && window.isSecureContext && 'Notification' in window;

export function useAttentionAlerts() {
  const agents = useStore((s) => s.agents);
  const needing = useMemo(() => Object.values(agents).filter((a) => a.status === 'needs_you'), [agents]);
  const prev = useRef<Set<string> | null>(null);
  const baseTitle = useRef(document.title.replace(/^\(\d+\)\s/, ''));
  const n = needing.length;
  useEffect(() => {
    document.title = (n > 0 ? `(${n}) ` : '') + baseTitle.current;
    setFavicon(n);
  }, [n]);
  useEffect(() => {
    const ids = new Set(needing.map((a) => a.id));
    if (prev.current) {
      const fresh = needing.filter((a) => !prev.current!.has(a.id));
      if (fresh.length) {
        beep();
        if (canNotify && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
          for (const a of fresh) {
            try {
              new Notification(`${a.name} needs you`, { body: a.pendingPermission?.title ?? a.lastMessage ?? '', tag: `tower-${a.id}` });
            } catch {}
          }
        }
      }
    }
    prev.current = ids;
  }, [needing]);
}

export function AlertControls() {
  const [m, toggle] = useMuted();
  const [perm, setPerm] = useState(canNotify ? Notification.permission : 'denied');
  return (
    <>
      {canNotify && perm === 'default' && (
        <button className="acc-tb" onClick={() => void Notification.requestPermission().then(setPerm)} title="Enable notifications">
          <span className="acc-tb-long">Enable notifications</span>
          <span className="acc-tb-short">Notify</span>
        </button>
      )}
      <button className="icon-btn acc-mute" onClick={toggle} aria-label={m ? 'Unmute alerts' : 'Mute alerts'} title={m ? 'Sound off' : 'Sound on'}>
        <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3 6h2.5L9 3v10L5.5 10H3z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
          {m ? (
            <path d="M11 6l3 4M14 6l-3 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          ) : (
            <path d="M11 5.5a3.5 3.5 0 0 1 0 5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          )}
        </svg>
      </button>
    </>
  );
}
