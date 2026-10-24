import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Account, ActivityEntry, AgentKind } from '../../shared/contract';
import { api } from './api';
import { patchRotationLocal, toast, useNow, useRotation, useStore } from './store';
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

type AccStatus = NonNullable<Account['status']>;
export function accountStatus(a: Account): AccStatus {
  if (a.status) return a.status;
  if (a.loggedIn === false) return 'logged_out';
  if (a.excluded) return 'excluded';
  return 'ok';
}
const ORDER: Record<AccStatus, number> = { ok: 0, exhausted: 1, excluded: 2, logged_out: 3 };
function sortAccounts(list: Account[]): Account[] {
  return [...list].sort((x, y) => {
    const d = ORDER[accountStatus(x)] - ORDER[accountStatus(y)];
    if (d) return d;
    if (accountStatus(x) === 'exhausted') return (x.resetAt ?? Infinity) - (y.resetAt ?? Infinity);
    return 0;
  });
}
const STATUS_TEXT: Record<AccStatus, string> = { ok: 'Available', exhausted: 'At limit', excluded: 'Excluded', logged_out: 'Logged out' };

function dur(ms: number): string {
  const m = Math.max(1, Math.ceil(ms / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}
function rel(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function AccountRow({ a, now }: { a: Account; now: number }) {
  const st = accountStatus(a);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, fail: string) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast(`${fail}: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  const excluded = !!a.excluded || st === 'excluded';
  return (
    <div className={`acc-row acc-st-${st}`} data-account={a.id}>
      <div className="acc-line">
        <span className="acc-label">{a.label}</span>
        {a.plan && <span className="acc-plan">{a.plan}</span>}
        <span className="acc-spacer" />
        <span className={`acc-badge acc-badge-${st}`}>
          <i />
          {STATUS_TEXT[st]}
        </span>
      </div>
      {a.usedPct !== undefined && st !== 'logged_out' && (
        <div className="acc-usage" title={`${Math.round(a.usedPct)}% used`}>
          <span className="acc-bar">
            <span style={{ width: `${Math.min(100, Math.max(0, a.usedPct))}%` }} className={a.usedPct > 80 ? 'hot' : ''} />
          </span>
          <span className="acc-pct">{Math.round(a.usedPct)}%</span>
        </div>
      )}
      {st === 'logged_out' && <CmdBox cmd={a.loginCommand} />}
      {(st !== 'logged_out' || excluded) && (
      <div className="acc-foot">
        <span className="acc-meta">
          {st === 'exhausted' && a.resetAt !== undefined && (
            <span className="acc-reset">{a.resetAt > now ? `back in ${dur(a.resetAt - now)}` : 'back any moment'}</span>
          )}
          {st === 'exhausted' && a.resetAt !== undefined && a.running > 0 && <span className="acc-sep">·</span>}
          {a.running > 0 && <span className="acc-running">{a.running} running</span>}
        </span>
        <span className="acc-spacer" />
        {st === 'exhausted' && (
          <button className="acc-act" disabled={busy} onClick={() => void run(() => api.clearAccount(a.id), 'Could not clear')}>
            Clear
          </button>
        )}
        <button
          className="acc-act"
          disabled={busy}
          onClick={() => void run(() => api.setExcluded(a.id, !excluded), excluded ? 'Could not include' : 'Could not exclude')}
        >
          {excluded ? 'Include' : 'Exclude'}
        </button>
      </div>
      )}
    </div>
  );
}

function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className={`acc-switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)}>
      <span />
    </button>
  );
}

function AutoRotate() {
  const { autoRotate } = useRotation();
  const set = async (on: boolean) => {
    patchRotationLocal({ autoRotate: on });
    try {
      await api.setAutoRotate(on);
    } catch (e) {
      patchRotationLocal({ autoRotate: !on });
      toast(`Could not change auto-rotate: ${(e as Error).message}`);
    }
  };
  return (
    <div className="acc-rotate">
      <div className="acc-rotate-line">
        <span className="acc-rotate-title">Auto-rotate</span>
        <span className="acc-spacer" />
        <Switch on={autoRotate} onChange={(v) => void set(v)} label="Auto-rotate" />
      </div>
      <div className="acc-rotate-help">When an account hits its limit, Tower moves the agent to the next available account.</div>
    </div>
  );
}

const ACT_ICON: Record<ActivityEntry['kind'], string> = {
  limit_hit: '!',
  moved: '→',
  cleared: '✓',
  excluded: '−',
  included: '+',
  no_account: '×',
};

function Activity({ entries, now }: { entries: ActivityEntry[]; now: number }) {
  return (
    <section className="acc-activity">
      <div className="acc-group-head">Activity</div>
      {entries.length === 0 ? (
        <div className="acc-empty">No limit events yet</div>
      ) : (
        <ul className="acc-act-list">
          {entries.slice(0, 50).map((e) => (
            <li key={e.id} className={`acc-act-item act-${e.kind}`}>
              <span className="acc-act-icon" aria-hidden="true">
                {ACT_ICON[e.kind]}
              </span>
              <span className="acc-act-text">{e.text}</span>
              <span className="acc-act-time">{rel(now - e.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function AccountsPanel() {
  const f = useFilter();
  const accounts = useAccounts();
  const rotation = useRotation();
  const now = useNow();
  useEffect(() => {
    if (!f) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && closeAccounts();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [f]);
  if (!f) return null;
  const kinds = f === 'all' ? ACCOUNT_KINDS : [f];
  const kindOf = new Map(accounts.map((a) => [a.id, a.kind]));
  const activity = f === 'all' ? rotation.activity : rotation.activity.filter((e) => !e.accountId || !kindOf.has(e.accountId) || kindOf.get(e.accountId) === f);
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
          <AutoRotate />
          {kinds.map((k) => {
            const list = sortAccounts(accounts.filter((a) => a.kind === k));
            const avail = list.filter((a) => accountStatus(a) === 'ok').length;
            return (
              <section key={k} className="acc-group">
                <div className="acc-group-head">
                  <span className={`cap-dot kind-dot-${k}`} />
                  {KIND_NAME[k]}
                  <span className="acc-spacer" />
                  {list.length > 0 && (
                    <span className="acc-count">
                      {avail} of {list.length} available
                    </span>
                  )}
                </div>
                {list.length === 0 && <div className="acc-empty">No accounts found</div>}
                {list.map((a) => (
                  <AccountRow key={a.id} a={a} now={now} />
                ))}
                <details className="acc-add">
                  <summary>+ Add an account</summary>
                  <div className="acc-add-text">{ADD_HELP[k].text}</div>
                  <CmdBox cmd={ADD_HELP[k].cmd} />
                </details>
              </section>
            );
          })}
          <Activity entries={activity} now={now} />
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
