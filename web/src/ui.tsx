import { memo, useCallback, useEffect, useMemo } from 'react';
import type { AgentKind, AgentStatus, AgentSummary, Capacity, PermissionOption, PermissionRequest } from '../../shared/contract';
import { api } from './api';
import { getState, openAgent, setLaunchOpen, toast, upsertAgent, useNow, useStore } from './store';
import { AlertControls, openAccounts, useAccounts } from './Accounts';

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
  observed: 'Observed',
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
      <rect width="24" height="24" rx="6" fill="#111" />
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

// ---------- top bar ----------
function CapacityChip({ c }: { c: Capacity }) {
  const accounts = useAccounts().filter((a) => a.kind === c.kind);
  const logged = accounts.filter((a) => a.loggedIn).length;
  const tip = c.detail ?? (c.available ? c.label : `${c.label} is not installed on this host`);
  return (
    <button
      className={`cap ${c.available ? '' : 'cap-off'}`}
      title={tip}
      aria-label={`${c.label}: ${logged} accounts, ${c.running} running`}
      onClick={() => openAccounts(c.kind)}
    >
      <span className={`cap-dot kind-dot-${c.kind}`} />
      <span className="cap-label">{c.label}</span>
      {accounts.length > 0 && <span className="cap-sub" title={`${logged} logged-in ${logged === 1 ? 'account' : 'accounts'}`}>· {logged} ·</span>}
      <span className="cap-num">{c.running}</span>
      <span className="cap-sub cap-run">running</span>
      {c.usedPct !== undefined && (
        <span className="cap-bar">
          <span style={{ width: `${Math.min(100, Math.max(0, c.usedPct))}%` }} className={c.usedPct > 80 ? 'hot' : ''} />
        </span>
      )}
    </button>
  );
}

export function TopBar() {
  const agents = useStore((s) => s.agents);
  const capacity = useStore((s) => s.capacity);
  const host = useStore((s) => s.host);
  const counts = useMemo(() => {
    const c = { working: 0, needs: 0, stuck: 0 };
    for (const a of Object.values(agents)) {
      if (a.status === 'working' || a.status === 'starting') c.working++;
      else if (a.status === 'needs_you') c.needs++;
      else if (a.status === 'stuck') c.stuck++;
    }
    return c;
  }, [agents]);
  return (
    <header className="topbar">
      <div className="brand">
        <TowerGlyph />
        <span className="wordmark">Tower</span>
        {host && <span className="host">{host}</span>}
      </div>
      <div className="counts">
        <span><b className="c-working">{counts.working}</b> working</span>
        <span className="sep">·</span>
        <span className={counts.needs ? 'hl-amber' : ''}><b>{counts.needs}</b> needs you</span>
        <span className="sep">·</span>
        <span className={counts.stuck ? 'hl-red' : ''}><b>{counts.stuck}</b> stuck</span>
      </div>
      <div className="spacer" />
      <div className="caps">
        {capacity.map((c) => (
          <CapacityChip key={c.kind} c={c} />
        ))}
        <button className="cap cap-all" onClick={() => openAccounts('all')}>
          Accounts
        </button>
      </div>
      <AlertControls />
      <button className="btn btn-primary new-btn" onClick={() => setLaunchOpen(true)}>
        <span className="plus">+</span>
        <span className="new-label">New agent</span>
      </button>
    </header>
  );
}

// ---------- inbox ----------
export function Inbox() {
  const agents = useStore((s) => s.agents);
  const launchOpen = useStore((s) => s.launchOpen);
  const pending = useMemo(
    () =>
      Object.values(agents)
        .filter((a) => a.pendingPermission)
        .sort((a, b) => a.pendingPermission!.createdAt - b.pendingPermission!.createdAt),
    [agents],
  );

  const first = pending[0];
  const onKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.shiftKey || e.metaKey || e.ctrlKey || launchOpen || !first) return;
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.tagName === 'BUTTON' || t.isContentEditable)) return;
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

  return (
    <section className="inbox" hidden={pending.length === 0} aria-label="Needs you">
      <div className="inbox-head">
        <span className="inbox-title">Needs you</span>
        <span className="count-badge">{pending.length}</span>
        <span className="hint">
          <kbd>Enter</kbd> allows the first
        </span>
      </div>
      {pending.map((a) => (
        <div key={a.pendingPermission!.requestId} className="inbox-row" onClick={() => openAgent(a.id)}>
          <div className="inbox-main">
            <div className="inbox-line">
              <KindBadge kind={a.kind} />
              <span className="inbox-agent">{a.name}</span>
              <span className="inbox-req">{a.pendingPermission!.title}</span>
            </div>
            {a.pendingPermission!.detail && <code className="mono-detail">{a.pendingPermission!.detail}</code>}
          </div>
          <PermissionButtons agent={a} req={a.pendingPermission!} />
        </div>
      ))}
    </section>
  );
}

// ---------- card ----------
export const AgentCard = memo(function AgentCard({ a, selected }: { a: AgentSummary; selected: boolean }) {
  const now = useNow();
  const account = useAccounts().find((x) => x.id === a.accountId);
  const queued = a.queued?.length ?? 0;
  const ctx = a.usage && a.usage.size > 0 ? Math.min(100, (a.usage.used / a.usage.size) * 100) : undefined;
  const done = a.plan ? a.plan.filter((p) => p.status === 'completed').length : 0;
  return (
    <button className={`card card-${a.status} ${selected ? 'selected' : ''}`} onClick={() => openAgent(a.id)}>
      <div className="card-top">
        <KindBadge kind={a.kind} />
        <span className="card-name">{a.name}</span>
        <span className={`dot dot-${a.status}`} title={STATUS_LABEL[a.status]} />
      </div>
      <div className="card-task">{a.task}</div>
      {a.lastMessage && <div className="card-msg">{a.lastMessage}</div>}
      {a.status === 'error' && a.error && <div className="card-err">{a.error}</div>}
      <div className="card-meta">
        <span title="Elapsed" className="elapsed">{ago(now - a.createdAt)}</span>
        <span className="sep elapsed">·</span>
        <span title="Last activity">active {ago(now - a.lastActivityAt)} ago</span>
        {a.accountId && (
          <>
            <span className="sep">·</span>
            <span className="card-acct" title="Account">{account?.label ?? a.accountId}</span>
          </>
        )}
        <span className="spacer" />
        {queued > 0 && <span className="queued-badge">{queued} queued</span>}
        {a.toolCalls > 0 && (
          <span className="meta-chip" title="Tool calls">
            <ToolIcon /> {a.toolCalls}
          </span>
        )}
        {a.plan && a.plan.length > 0 && (
          <span className="meta-chip" title="Plan progress">
            <span className="mini-plan">
              <span style={{ width: `${(done / a.plan.length) * 100}%` }} />
            </span>
            {done}/{a.plan.length}
          </span>
        )}
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
