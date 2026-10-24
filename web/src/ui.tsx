import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AgentKind, AgentStatus, AgentSummary, PermissionOption, PermissionRequest } from '../../shared/contract';
import { api } from './api';
import { getState, openAgent, setLaunchOpen, toast, upsertAgent, useNow, useStore } from './store';
import { canNotify, openAccounts, useAccounts, useMuted } from './Accounts';
import { QuestionCard } from './Questions';

/** Row 32: one shared list of agent kinds for every dialog. */
export const KINDS: AgentKind[] = ['devin', 'claude', 'codex'];
export const KIND_LABEL: Record<AgentKind, string> = { devin: 'Devin', claude: 'Claude Code', codex: 'Codex' };
const KIND_SHORT: Record<AgentKind, string> = { devin: 'Devin', claude: 'Claude', codex: 'Codex' };
export const STATUS_LABEL: Record<AgentStatus, string> = {
  starting: 'Starting',
  working: 'Working',
  needs_you: 'Needs you',
  stuck: 'Stuck',
  done: 'Done',
  error: 'Error',
  stopped: 'Stopped',
  observed: 'Live session', // row 33
};

export function ago(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function TowerGlyph({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect width="24" height="24" rx="6" fill="#2563eb" />
      <path d="M8.5 19h7l-1.2-8.5h-4.6z M10 10.5V7.5h4v3 M12 7.5V4.5" stroke="#fff" strokeWidth="1.6" fill="none" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function KindBadge({ kind }: { kind: AgentKind }) {
  return (
    <span className={`kind kind-${kind}`} title={KIND_LABEL[kind]}>
      <i />
      <span className="kind-long">{KIND_LABEL[kind]}</span>
      <span className="kind-short">{KIND_SHORT[kind]}</span>
    </span>
  );
}

export function StatusPill({ status }: { status: AgentStatus }) {
  return (
    <span className={`status status-${status}`}>
      <i />
      {STATUS_LABEL[status]}
    </span>
  );
}

// ---------- actions ----------
export async function resolvePermission(agent: AgentSummary, req: PermissionRequest, opt: PermissionOption) {
  // optimistic: drop from inbox now, restore on failure
  const prev = getState().agents[agent.id];
  if (prev) upsertAgent({ ...prev, pendingPermission: undefined, status: opt.kind.startsWith('reject') ? prev.status : 'working' });
  try {
    await api.permission(agent.id, req.requestId, opt.optionId);
  } catch (e) {
    const cur = getState().agents[agent.id];
    if (prev && cur && !cur.pendingPermission) upsertAgent({ ...cur, pendingPermission: prev.pendingPermission, status: prev.status });
    toast(`Could not send “${opt.name}”: ${(e as Error).message}`);
  }
}

function sortOptions(opts: PermissionOption[]) {
  const order = { reject_always: 0, reject_once: 1, allow_always: 2, allow_once: 3 };
  return [...opts].sort((a, b) => order[a.kind] - order[b.kind]);
}

export function PermissionButtons({ agent, req }: { agent: AgentSummary; req: PermissionRequest }) {
  return (
    <div className="perm-actions">
      {sortOptions(req.options).map((o) => (
        <button
          key={o.optionId}
          className={o.kind === 'allow_once' ? 'btn btn-primary' : 'btn btn-secondary'}
          onClick={(e) => {
            e.stopPropagation();
            void resolvePermission(agent, req, o);
          }}
        >
          {o.name}
        </button>
      ))}
    </div>
  );
}

// ---------- theme ----------
type Theme = 'system' | 'light' | 'dark';
const THEME_KEY = 'tower.theme';
function readTheme(): Theme {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}
function applyTheme(t: Theme) {
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}
if (typeof document !== 'undefined') applyTheme(readTheme());

function setThemePref(t: Theme) {
  try {
    if (t === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, t);
  } catch {}
  applyTheme(t);
}

/** Decided: mute + theme (System/Light/Dark radios, row 36) + Enable notifications live in one ⋯ menu. */
export function SettingsMenu() {
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [muted, toggleMute] = useMuted();
  const [perm, setPerm] = useState(canNotify ? Notification.permission : 'denied');
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !(e.target as HTMLElement).closest('.settings') && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', esc);
    };
  }, [open]);
  return (
    <div className="settings">
      <button className="icon-btn settings-btn" aria-label="Settings" aria-haspopup="menu" aria-expanded={open} title="Settings" onClick={() => setOpen((v) => !v)}>
        ⋯
      </button>
      {open && (
        <div className="menu settings-menu" role="menu">
          <button role="menuitemcheckbox" aria-checked={!muted} className="menu-row acc-mute" aria-label={muted ? 'Unmute alerts' : 'Mute alerts'} onClick={toggleMute}>
            <span className="menu-check">{muted ? '' : '✓'}</span>
            Sound alerts
          </button>
          {canNotify && perm === 'default' && (
            <button role="menuitem" className="menu-row" onClick={() => void Notification.requestPermission().then(setPerm)}>
              <span className="menu-check" />
              Enable notifications
            </button>
          )}
          <div className="menu-sep" />
          <div className="menu-label">Theme</div>
          {(['system', 'light', 'dark'] as Theme[]).map((t) => (
            <button
              key={t}
              role="menuitemradio"
              aria-checked={theme === t}
              className="menu-row theme-opt"
              data-theme-opt={t}
              onClick={() => {
                setThemePref(t);
                setTheme(t);
              }}
            >
              <span className="menu-check">{theme === t ? '●' : ''}</span>
              {t === 'system' ? 'System' : t === 'light' ? 'Light' : 'Dark'}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- top bar ----------
/** Decided: ONE Accounts button; a dot flags a problem (an account at its limit, or a kind with no logged-in account). */
function AccountsButton() {
  const accounts = useAccounts();
  const capacity = useStore((s) => s.capacity);
  const problem = useMemo(() => {
    if (accounts.some((a) => a.status === 'exhausted')) return 'An account is at its limit';
    for (const c of capacity) {
      const mine = accounts.filter((a) => a.kind === c.kind);
      if (c.available && mine.length > 0 && !mine.some((a) => a.loggedIn)) return `${c.label}: no logged-in account`;
    }
    return '';
  }, [accounts, capacity]);
  return (
    <button className="btn btn-secondary accounts-btn cap-all" onClick={() => openAccounts('all')} title={problem || 'Accounts'}>
      Accounts
      {problem && <span className="problem-dot" aria-label={problem} />}
    </button>
  );
}

export function TopBar({ search, tabs }: { search?: ReactNode; tabs?: ReactNode } = {}) {
  return (
    <header className="topbar">
      <div className="brand">
        <TowerGlyph />
        <span className="wordmark">Tower</span>
      </div>
      <div className="topbar-tabs">{tabs}</div>
      <div className="spacer" />
      {search}
      <AccountsButton />
      <SettingsMenu />
      <button className="btn btn-primary new-btn" onClick={() => setLaunchOpen(true)}>
        <span className="plus">+</span>
        <span className="new-label">New agent</span>
      </button>
    </header>
  );
}

// ---------- inbox ----------
/** Decided + rows 2/3/13/19/38: ONE "Needs you (N)" strip, and ONE merged section (permissions + questions) right under it. */
export function Inbox() {
  const agents = useStore((s) => s.agents);
  const launchOpen = useStore((s) => s.launchOpen);
  const ref = useRef<HTMLElement>(null);
  const pending = useMemo(
    () =>
      Object.values(agents)
        .filter((a) => a.pendingPermission)
        .sort((a, b) => a.pendingPermission!.createdAt - b.pendingPermission!.createdAt),
    [agents],
  );
  const questions = useMemo(
    () =>
      Object.values(agents)
        .filter((a) => !a.archived)
        .flatMap((a) => (a.questions ?? []).map((q) => ({ a, q })))
        .sort((x, y) => x.q.createdAt - y.q.createdAt),
    [agents],
  );

  const first = pending[0];
  const onKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || launchOpen || !first) return;
      // row 38: Enter allows only when the inbox has focus; ⌘Enter allows from anywhere outside a text field
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.tagName === 'BUTTON' || t.isContentEditable)) return;
      const inInbox = !!ref.current && ref.current.contains(document.activeElement);
      if (!inInbox && !e.metaKey) return;
      const opt = first.pendingPermission!.options.find((o) => o.kind === 'allow_once');
      if (!opt) return;
      e.preventDefault();
      void resolvePermission(first, first.pendingPermission!, opt);
    },
    [first, launchOpen],
  );
  useEffect(() => {
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onKey]);

  // row 3: the strip lists only what needs the owner; "finished" is a toast, not a strip item
  const needs = useMemo(
    () =>
      Object.values(agents)
        .filter((a) => a.source !== 'tmux' && !a.archived && (a.pendingPermission || a.status === 'needs_you' || a.status === 'stuck' || a.status === 'error'))
        .sort((a, b) => rank(a) - rank(b) || b.lastActivityAt - a.lastActivityAt),
    [agents],
  );

  return (
    <>
      {needs.length > 0 && (
        <nav className="needs-strip" aria-label="Needs you summary">
          <span className="needs-label">Needs you ({needs.length})</span>
          {needs.map((a) => {
            const tone = a.pendingPermission || a.status === 'needs_you' ? 'am' : 'rd';
            const what = a.pendingPermission ? 'asks permission' : a.status === 'needs_you' ? 'asks you' : a.status === 'stuck' ? 'stuck' : 'error';
            return (
              <button key={a.id} className={`needs-chip needs-${tone}`} onClick={() => openAgent(a.id)} title={a.task}>
                <i />
                <span className="needs-name">{a.name}</span>
                <span className="needs-what">· {what}</span>
              </button>
            );
          })}
        </nav>
      )}
      <section ref={ref} className="inbox" tabIndex={-1} hidden={pending.length === 0 && questions.length === 0} aria-label="Needs you">
        {pending.map((a, i) => (
          <div key={a.pendingPermission!.requestId} className="inbox-row" onClick={() => openAgent(a.id)}>
            <div className="inbox-main">
              <div className="inbox-line">
                <span className="dot dot-needs_you" />
                <span className="inbox-agent">{a.name}</span>
                <span className="inbox-req">{a.pendingPermission!.title}</span>
                {i === 0 && <kbd className="inbox-kbd" title="Enter allows (when this list has focus)">↵ allows</kbd>}
              </div>
              {a.pendingPermission!.detail && (
                <details className="inbox-details" onClick={(e) => e.stopPropagation()}>
                  <summary>Details</summary>
                  <code className="mono-detail">{a.pendingPermission!.detail}</code>
                </details>
              )}
            </div>
            <PermissionButtons agent={a} req={a.pendingPermission!} />
          </div>
        ))}
        {questions.map(({ a, q }) => (
          <QuestionCard key={q.id} a={a} q={q} showAgent />
        ))}
      </section>
    </>
  );
}

function rank(a: AgentSummary): number {
  if (a.pendingPermission || a.status === 'needs_you') return 0;
  if (a.status === 'stuck' || a.status === 'error') return 1;
  return 2;
}

function statusLine(a: AgentSummary): string {
  const msg = a.lastMessage?.trim();
  switch (a.status) {
    case 'needs_you':
      return a.pendingPermission ? `Waiting on you · ${a.pendingPermission.title}` : msg ? `Waiting on you · ${msg}` : 'Waiting on you';
    case 'working':
      return msg ? `Working · ${msg}` : 'Working';
    case 'starting':
      return 'Starting…';
    case 'done':
      return msg ? `Done · ${msg}` : 'Done';
    case 'stuck':
      return msg ? `Stuck · ${msg}` : 'Stuck · no progress';
    case 'error':
      return msg ? `Error · ${msg}` : 'Error';
    case 'stopped':
      return msg ? `Stopped · ${msg}` : 'Stopped';
    default:
      return msg ?? STATUS_LABEL[a.status];
  }
}

// ---------- card ----------
export const AgentCard = memo(function AgentCard({ a, selected }: { a: AgentSummary; selected: boolean }) {
  const now = useNow();
  const accounts = useAccounts();
  const account = accounts.find((x) => x.id === a.accountId);
  // row 8: the account shows only when there is a choice (>1 logged-in account of this kind); never the raw id
  const showAcct = accounts.filter((x) => x.kind === a.kind && x.loggedIn).length > 1;
  const movedAcctId = useStore((s) => (a.movedFrom ? (a.movedFrom.accountId ?? s.agents[a.movedFrom.agentId]?.accountId) : undefined));
  const movedLabel = a.movedFrom ? (accounts.find((x) => x.id === movedAcctId)?.label ?? movedAcctId ?? 'another account') : undefined;
  const queued = a.queued?.length ?? 0;
  const ctx = a.usage && a.usage.size > 0 ? Math.min(100, (a.usage.used / a.usage.size) * 100) : undefined;
  const done = a.plan ? a.plan.filter((p) => p.status === 'completed').length : 0;
  return (
    <button className={`card card-${a.status} ${selected ? 'selected' : ''}`} onClick={() => openAgent(a.id)}>
      <div className="card-top">
        <span className={`dot dot-${a.status}`} title={STATUS_LABEL[a.status]} aria-label={STATUS_LABEL[a.status]} />
        <span className="card-name">{a.name}</span>
      </div>
      <div className="card-task">{a.task}</div>
      <div className={`card-msg card-st-${a.status}`}>{statusLine(a)}</div>
      {a.status === 'error' && a.error && <div className="card-err">{a.error}</div>}
      {movedLabel && (
        <span className="card-moved" title={`Moved from ${movedLabel}`}>
          Moved from {movedLabel}
        </span>
      )}
      <div className="card-meta">
        <span title={`Running for ${ago(now - a.createdAt)}`}>{ago(now - a.lastActivityAt)} ago</span>
        {showAcct && account && (
          <>
            <span className="sep">·</span>
            <span className="card-acct" title={account.label}>{account.label.replace(/^[^·]+·\s*/, '')}</span>
          </>
        )}
        <span className="spacer" />
        {queued > 0 && <span className="queued-badge">{queued} queued</span>}
        {a.plan && a.plan.length > 0 && (
          <span className="meta-chip" title="Plan progress">
            <span className="mini-plan">
              <span style={{ width: `${(done / a.plan.length) * 100}%` }} />
            </span>
            {done}/{a.plan.length}
          </span>
        )}
        <span className="card-tag" title={KIND_LABEL[a.kind]}>{a.model ?? KIND_SHORT[a.kind]}</span>
      </div>
      {ctx !== undefined && (
        <span className="card-ctx" title={`Context ${Math.round(ctx)}% (${a.usage!.used.toLocaleString()} / ${a.usage!.size.toLocaleString()} tokens)`}>
          <span style={{ width: `${ctx}%` }} className={ctx > 80 ? 'hot' : ''} />
        </span>
      )}
    </button>
  );
});

export function ToolIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M10.5 2.5a3 3 0 0 0-3.9 3.7L2.5 10.3a1.4 1.4 0 0 0 2 2l4.1-4.1a3 3 0 0 0 3.7-3.9l-1.8 1.8-1.6-.4-.4-1.6z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}
