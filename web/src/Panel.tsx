import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AgentSummary, FeedItem } from '../../shared/contract';
import { api, loadFeed } from './api';
import { openAgent, patchAgentLocal, removeAgentLocal, toast, useAccounts, useStore } from './store';
import { accountStatus } from './Accounts';
import { PanelLinks } from './boards/Handoffs';
import { Composer } from './composer/Composer';
import { PanelQuestions } from './Questions';
import { Markdown } from './feed/markdown';
import './panel.css';
import { KIND_LABEL, PermissionButtons, StatusPill } from './ui';
const basename = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p;

const EMPTY: FeedItem[] = [];

function ToolStatusIcon({ status }: { status: string }) {
  if (status === 'completed')
    return (
      <svg className="ti ti-ok" width="14" height="14" viewBox="0 0 16 16" aria-label="completed">
        <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  if (status === 'failed')
    return (
      <svg className="ti ti-fail" width="14" height="14" viewBox="0 0 16 16" aria-label="failed">
        <path d="M4.5 4.5l7 7m0-7l-7 7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  if (status === 'in_progress') return <span className="ti ti-spin" aria-label="in progress" />;
  return <span className="ti ti-pending" aria-label="pending" />;
}

function Thought({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <button className={`f-thought ${open ? 'open' : ''}`} onClick={() => setOpen((o) => !o)}>
      <span className="caret">{open ? '▾' : '▸'}</span>
      <span className="f-thought-text">{open ? text : 'Thinking'}</span>
    </button>
  );
}

// Presentation only: pull a short, human detail (command / path / pattern) out of a raw tool detail.
function shortDetail(detail?: string): { cmd?: string; text?: string } {
  if (!detail) return {};
  const t = detail.trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      const j = JSON.parse(t) as Record<string, unknown>;
      const pick = (...ks: string[]) => {
        for (const k of ks) {
          const v = j && typeof j === 'object' ? (j as Record<string, unknown>)[k] : undefined;
          if (typeof v === 'string' && v) return v;
          if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v.join(' ');
        }
        return undefined;
      };
      const cmd = pick('command', 'cmd');
      if (cmd) return { cmd };
      const text = pick('file_path', 'path', 'filePath', 'pattern', 'query', 'url', 'description');
      return text ? { text } : {};
    } catch {
      return {};
    }
  }
  return { text: t.split('\n')[0] };
}

function ToolRow({ item }: { item: Extract<FeedItem, { type: 'tool_call' }> }) {
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState(false);
  const d = shortDetail(item.detail);
  const sameAsTitle = d.cmd && item.title.includes(d.cmd);
  if (d.text) {
    // drop a detail that only repeats the title (e.g. the same path), keep what's new ("+6 −1")
    const first = d.text.split(/\s+/)[0];
    if (item.title.includes(d.text)) d.text = undefined;
    else if (first && item.title.includes(first)) d.text = d.text.slice(first.length).trim() || undefined;
  }
  return (
    <div className={`f-toolwrap ${open ? 'open' : ''}`}>
      <button className={`f-tool f-tool-${item.status}`} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <ToolStatusIcon status={item.status} />
        {d.cmd && !sameAsTitle ? (
          <span className="f-tool-title">
            Ran <code className="f-tool-cmd">{d.cmd}</code>
          </span>
        ) : (
          <span className="f-tool-title">{item.title}</span>
        )}
        {d.text && d.text !== item.title && <span className="f-tool-detail">{d.text}</span>}
        {item.toolKind && <span className="f-tool-kind">{item.toolKind}</span>}
      </button>
      {open && (
        <div className="f-tool-out">
          <pre>{item.output || (item.status === 'completed' || item.status === 'failed' ? 'No output' : 'Running…')}</pre>
          {item.detail && (
            <button className="f-tool-raw-btn" aria-expanded={raw} onClick={() => setRaw((r) => !r)}>
              {raw ? 'Hide raw' : 'Raw'}
            </button>
          )}
          {raw && item.detail && <pre className="f-tool-out-detail">{item.detail}</pre>}
        </div>
      )}
    </div>
  );
}

const FeedRow = memo(function FeedRow({ item }: { item: FeedItem }) {
  switch (item.type) {
    case 'user_message':
      return (
        <div className="f-user">
          <div className="bubble">{item.text}</div>
        </div>
      );
    case 'agent_message':
      return (
        <div className="f-agent">
          <Markdown text={item.text} />
        </div>
      );
    case 'thought':
      return <Thought text={item.text} />;
    case 'tool_call':
      return <ToolRow item={item} />;
    case 'permission':
      return (
        <div className={`f-perm ${item.resolution ? 'resolved' : ''}`}>
          <span className="f-perm-icon">{item.resolution ? '✓' : '!'}</span>
          <span className="f-perm-title">{item.title}</span>
          <span className="f-perm-res">{item.resolution ?? 'Waiting for you'}</span>
        </div>
      );
    case 'status':
      return <div className="f-status">{humanStatus(item.text)}</div>;
  }
});

// Presentation only: lifecycle jargon -> plain words.
function humanStatus(t: string): string {
  const s = t.trim();
  const low = s.toLowerCase();
  if (/^turn ended:?\s*(end_turn)?$/.test(low) || low === 'end_turn') return 'Finished';
  if (/^turn ended:\s*cancell?ed$/.test(low) || low === 'cancelled' || low === 'canceled') return 'Interrupted';
  if (/^turn ended:\s*max_tokens$/.test(low)) return 'Stopped: output limit reached';
  if (/^turn ended:\s*refusal$/.test(low)) return 'The agent declined';
  if (/^turn ended:\s*max_turn_requests$/.test(low)) return 'Stopped: turn limit reached';
  if (/^turn ended\b/.test(low)) return 'Finished';
  if (!s || /^[\w.-]+:\s*[\w.-]*$/.test(s) && /_/.test(s)) return 'Status update';
  return s;
}

// Collapse consecutive identical (humanized) status lines.
function dedupeStatus(items: FeedItem[]): FeedItem[] {
  const out: FeedItem[] = [];
  let last: string | null = null;
  for (const it of items) {
    if (it.type === 'status') {
      const h = humanStatus(it.text);
      if (h === last) continue;
      last = h;
    } else last = null;
    out.push(it);
  }
  return out;
}

function Feed({ id }: { id: string }) {
  const items = useStore((s) => s.feeds[id] ?? EMPTY);
  const loaded = useStore((s) => !!s.feedLoaded[id]);
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    stick.current = true;
  }, [id]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items, loaded]);

  return (
    <div
      className="feed"
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      {!loaded ? (
        <div className="skeleton">
          <div className="sk sk-r" />
          <div className="sk w80" />
          <div className="sk w60" />
          <div className="sk w70" />
          <div className="sk w40" />
        </div>
      ) : (
        dedupeStatus(items).map((it) => <FeedRow key={it.id} item={it} />)
      )}
    </div>
  );
}

function ControlBar({ a }: { a: AgentSummary }) {
  const live = a.source === 'tower' && a.status !== 'stopped' && a.status !== 'error' && a.status !== 'observed';
  const modes = a.modes ?? [];
  const opts = a.configOptions ?? [];
  const pct = a.usage && a.usage.size > 0 ? Math.min(100, Math.round((a.usage.used / a.usage.size) * 100)) : null;
  if (!live && pct === null) return null;
  return (
    <div className="ctrl">
      {live && modes.length > 0 && (
        <label className="ctrl-sel">
          <span className="ctrl-lbl">Mode</span>
          <select
            aria-label="Mode"
            className="sel-mode"
            value={a.mode ?? ''}
            onChange={(e) => {
              const v = e.target.value;
              patchAgentLocal(a.id, { mode: v });
              api.setMode(a.id, v).catch((err: Error) => toast(`Could not change mode: ${err.message}`));
            }}
          >
            {!a.mode && <option value="">Mode</option>}
            {modes.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {live &&
        opts.filter((o) => !(modes.length > 0 && (o.id === 'mode' || (o.options.length > 0 && o.options.every((v) => modes.some((m) => m.id === v.value)))))).map((o) => (
          <label className="ctrl-sel" key={o.id}>
            <span className="ctrl-lbl">{o.name}</span>
            <select
              aria-label={o.name}
              className={`sel-config sel-${o.id}`}
              value={o.currentValue ?? ''}
              onChange={(e) => {
                const v = e.target.value;
                patchAgentLocal(a.id, { configOptions: opts.map((x) => (x.id === o.id ? { ...x, currentValue: v } : x)) });
                api.setConfig(a.id, o.id, v).catch((err: Error) => toast(`Could not change ${o.name}: ${err.message}`));
              }}
            >
              {!o.currentValue && <option value="">{o.name}</option>}
              {o.options.map((v) => (
                <option key={v.value} value={v.value}>
                  {v.name}
                </option>
              ))}
            </select>
          </label>
        ))}
      {pct !== null && (
        <span className="ctx" title={`${a.usage!.used.toLocaleString()} / ${a.usage!.size.toLocaleString()} tokens`}>
          <span className="ctx-bar">
            <span className={`ctx-fill ${pct >= 80 ? 'hot' : ''}`} style={{ width: `${pct}%` }} />
          </span>
          <span className="ctx-label">{pct}% context</span>
        </span>
      )}
    </div>
  );
}

function MovePicker({ a, onClose }: { a: AgentSummary; onClose: () => void }) {
  const accounts = useAccounts().filter((x) => x.kind === a.kind && x.id !== a.accountId && accountStatus(x) === 'ok');
  const [busy, setBusy] = useState<string | null>(null);
  const go = async (accountId: string) => {
    setBusy(accountId);
    try {
      const n = await api.move(a.id, accountId);
      onClose();
      openAgent(n.id);
    } catch (e) {
      toast(`Could not move: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="move-picker" role="listbox" aria-label="Move to another account">
      <div className="move-head">
        <span>Move to another account</span>
        <button className="icon-btn move-x" aria-label="Cancel" onClick={onClose}>
          ✕
        </button>
      </div>
      {accounts.length === 0 ? (
        <div className="move-empty">No other available {KIND_LABEL[a.kind]} account. Add one from Accounts.</div>
      ) : (
        accounts.map((acc) => (
          <button key={acc.id} role="option" aria-selected={false} className="move-acc" disabled={!!busy} onClick={() => void go(acc.id)}>
            <span className="move-acc-label">{acc.label}</span>
            <span className="move-acc-meta">{busy === acc.id ? 'Moving…' : acc.usedPct !== undefined ? `${acc.usedPct}% used` : (acc.plan ?? '')}</span>
          </button>
        ))
      )}
    </div>
  );
}

function LimitBanner({ a, picking, setPicking }: { a: AgentSummary; picking: boolean; setPicking: (v: boolean) => void }) {
  if (!a.limitHit && !picking) return null;
  return (
    <div className="limit-banner">
      {a.limitHit && (
        <div className="limit-row">
          <span className="limit-text">This account hit its limit</span>
          {!picking && (
            <button className="btn btn-primary btn-sm limit-move" onClick={() => setPicking(true)}>
              Move to another account
            </button>
          )}
        </div>
      )}
      {picking && <MovePicker a={a} onClose={() => setPicking(false)} />}
    </div>
  );
}

function MoreMenu({ a, onMove }: { a: AgentSummary; onMove: () => void }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  useEffect(() => {
    if (!open) setConfirm(false);
  }, [open]);
  if (a.source !== 'tower') return null;
  const working = a.status === 'working';
  return (
    <div className="more" ref={ref}>
      <button className="icon-btn" aria-label="More" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        ⋯
      </button>
      {open && (
        <div className="more-menu" role="menu">
          {working && (
            <button
              role="menuitem"
              className="more-interrupt"
              title="Cancel the current turn; the agent stays alive"
              onClick={() => {
                setOpen(false);
                api.interrupt(a.id).catch((e: Error) => toast(`Could not interrupt: ${e.message}`));
              }}
            >
              Interrupt
            </button>
          )}
          <button
            role="menuitem"
            className="more-move"
            onClick={() => {
              setOpen(false);
              onMove();
            }}
          >
            Move to another account
          </button>
          <button
            role="menuitem"
            className="more-archive"
            onClick={() => {
              setOpen(false);
              const next = !a.archived;
              patchAgentLocal(a.id, { archived: next });
              if (next) openAgent(null);
              api.archive(a.id, next).catch((e: Error) => {
                patchAgentLocal(a.id, { archived: !next });
                toast(`Could not ${next ? 'archive' : 'unarchive'}: ${e.message}`);
              });
            }}
          >
            {a.archived ? 'Unarchive' : 'Archive'}
          </button>
          <div className="more-sep" />
          {confirm ? (
            <div className="more-confirm" role="group" aria-label="Confirm remove">
              <span className="more-confirm-text">Remove this agent?</span>
              <div className="more-confirm-btns">
                <button className="btn btn-secondary btn-sm more-keep" onClick={() => setConfirm(false)}>
                  Keep
                </button>
                <button
                  className="btn btn-sm more-remove"
                  onClick={() => {
                    setOpen(false);
                    api
                      .remove(a.id)
                      .then(() => removeAgentLocal(a.id))
                      .catch((e: Error) => toast(`Could not remove: ${e.message}`));
                  }}
                >
                  Remove
                </button>
              </div>
            </div>
          ) : (
            <button role="menuitem" className="more-danger" onClick={() => setConfirm(true)}>
              Remove
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function Panel() {
  const id = useStore((s) => s.openId);
  const a = useStore((s) => (s.openId ? s.agents[s.openId] : undefined));
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    if (id) void loadFeed(id);
    setPicking(false);
  }, [id]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && openAgent(null);
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  if (!id || !a) return null;
  const canStop = a.source === 'tower' && a.status !== 'stopped' && a.status !== 'error' && a.status !== 'done';
  const done = a.plan?.filter((p) => p.status === 'completed').length ?? 0;
  return (
    <aside className="panel" aria-label={`Agent ${a.name}`}>
      <div className="panel-head">
        <div className="panel-row">
          <span className="panel-name">{a.name}</span>
          <StatusPill status={a.status} />
          <span className="spacer" />
          {canStop && (
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => api.stop(a.id).catch((e: Error) => toast(`Could not stop: ${e.message}`))}
            >
              Stop
            </button>
          )}
          <MoreMenu a={a} onMove={() => setPicking(true)} />
          <button className="icon-btn" onClick={() => openAgent(null)} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="panel-sub">
          {basename(a.cwd) !== a.name && <code title={a.cwd}>{basename(a.cwd)}</code>}
          <span className="muted" title={a.cwd}>
            {basename(a.cwd) !== a.name ? '· ' : ''}
            {KIND_LABEL[a.kind]}
          </span>
          {a.model && <span className="muted">· {a.model}</span>}
        </div>
        <PanelLinks agent={a} />
        <ControlBar a={a} />
      </div>
      {a.plan && a.plan.length > 0 && (
        <div className="plan">
          <div className="plan-head">
            Plan <span className="muted">{done}/{a.plan.length}</span>
          </div>
          <ul>
            {a.plan.map((p, i) => (
              <li key={i} className={`plan-${p.status}`}>
                <span className="pbox">{p.status === 'completed' ? '✓' : ''}</span>
                {p.content}
              </li>
            ))}
          </ul>
        </div>
      )}
      <Feed id={a.id} />
      {a.pendingPermission && (
        <div className="panel-perm">
          <div className="panel-perm-text">
            <b>{a.pendingPermission.title}</b>
            {a.pendingPermission.detail && <code className="mono-detail">{a.pendingPermission.detail}</code>}
          </div>
          <PermissionButtons agent={a} req={a.pendingPermission} />
        </div>
      )}
      <PanelQuestions a={a} />
      {a.status === 'error' && a.error && <div className="panel-error">{a.error}</div>}
      <LimitBanner a={a} picking={picking} setPicking={setPicking} />
      <Composer a={a} />
    </aside>
  );
}
