import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AgentSummary, FeedItem } from '../../shared/contract';
import { api, loadFeed } from './api';
import { openAgent, toast, useNow, useStore } from './store';
import { KindBadge, PermissionButtons, StatusPill, ago } from './ui';

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

const FeedRow = memo(function FeedRow({ item }: { item: FeedItem }) {
  switch (item.type) {
    case 'user_message':
      return (
        <div className="f-user">
          <div className="bubble">{item.text}</div>
        </div>
      );
    case 'agent_message':
      return <div className="f-agent">{item.text}</div>;
    case 'thought':
      return <Thought text={item.text} />;
    case 'tool_call':
      return (
        <div className={`f-tool f-tool-${item.status}`} title={item.detail}>
          <ToolStatusIcon status={item.status} />
          <span className="f-tool-title">{item.title}</span>
          {item.detail && <span className="f-tool-detail">{item.detail}</span>}
          {item.toolKind && <span className="f-tool-kind">{item.toolKind}</span>}
        </div>
      );
    case 'permission':
      return (
        <div className={`f-perm ${item.resolution ? 'resolved' : ''}`}>
          <span className="f-perm-icon">{item.resolution ? '✓' : '!'}</span>
          <span className="f-perm-title">{item.title}</span>
          <span className="f-perm-res">{item.resolution ?? 'Waiting for you'}</span>
        </div>
      );
    case 'status':
      return <div className="f-status">{item.text}</div>;
  }
});

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
        items.map((it) => <FeedRow key={it.id} item={it} />)
      )}
    </div>
  );
}

function Composer({ a }: { a: AgentSummary }) {
  const [text, setText] = useState('');
  const busy = a.status === 'working' || a.status === 'needs_you' || a.status === 'starting';
  const readOnly = a.source === 'tmux' || a.status === 'observed';
  const disabled = busy || readOnly || a.status === 'stopped';
  const hint = readOnly
    ? 'Observed from tmux — read-only'
    : a.status === 'stopped'
      ? 'This agent was stopped'
      : a.status === 'needs_you'
        ? 'Waiting for your decision above'
        : busy
          ? `${a.name} is working…`
          : 'Reply or give a follow-up task';
  const send = async () => {
    const t = text.trim();
    if (!t || disabled) return;
    setText('');
    try {
      await api.prompt(a.id, t);
    } catch (e) {
      setText(t);
      toast(`Could not send: ${(e as Error).message}`);
    }
  };
  return (
    <div className="composer">
      <textarea
        value={text}
        disabled={disabled}
        placeholder={hint}
        rows={1}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <button className="btn btn-primary send" disabled={disabled || !text.trim()} onClick={() => void send()} aria-label="Send">
        ↑
      </button>
    </div>
  );
}

export function Panel() {
  const id = useStore((s) => s.openId);
  const a = useStore((s) => (s.openId ? s.agents[s.openId] : undefined));
  const now = useNow();

  useEffect(() => {
    if (id) void loadFeed(id);
  }, [id]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && openAgent(null);
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  if (!id || !a) return null;
  const canStop = a.source === 'tower' && a.status !== 'stopped' && a.status !== 'error';
  const done = a.plan?.filter((p) => p.status === 'completed').length ?? 0;
  return (
    <aside className="panel" aria-label={`Agent ${a.name}`}>
      <div className="panel-head">
        <div className="panel-row">
          <KindBadge kind={a.kind} />
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
          <button className="icon-btn" onClick={() => openAgent(null)} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="panel-sub">
          <code>{a.cwd}</code>
          {a.model && <span className="muted">· {a.model}</span>}
          <span className="muted">· {ago(now - a.createdAt)}</span>
        </div>
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
      {a.status === 'error' && a.error && <div className="panel-error">{a.error}</div>}
      <Composer a={a} />
    </aside>
  );
}
