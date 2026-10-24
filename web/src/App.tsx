import { useMemo, useState } from 'react';
import type { AgentStatus, AgentSummary } from '../../shared/contract';
import { AccountsPanel, useAttentionAlerts } from './Accounts';
import { NewAgentDialog } from './NewAgent';
import { Panel } from './Panel';
import { setLaunchOpen, useStore } from './store';
import { AgentCard, Inbox, TopBar } from './ui';

type Col = 'working' | 'needs' | 'stuck' | 'done';
const COLS: { key: Col; label: string; statuses: AgentStatus[] }[] = [
  { key: 'working', label: 'Working', statuses: ['starting', 'working'] },
  { key: 'needs', label: 'Needs you', statuses: ['needs_you'] },
  { key: 'stuck', label: 'Stuck', statuses: ['stuck'] },
  { key: 'done', label: 'Done', statuses: ['done', 'stopped', 'error'] },
];
const TAB_ORDER: Col[] = ['needs', 'working', 'stuck', 'done'];

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="toast">
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function App() {
  const agents = useStore((s) => s.agents);
  const openId = useStore((s) => s.openId);
  const connected = useStore((s) => s.connected);
  const everConnected = useStore((s) => s.everConnected);
  const [tab, setTab] = useState<Col>('needs');
  useAttentionAlerts();
  const [showObserved, setShowObserved] = useState(false);

  const { cols, observed, total } = useMemo(() => {
    const list = Object.values(agents);
    const cols = {} as Record<Col, AgentSummary[]>;
    for (const c of COLS) {
      cols[c.key] = list
        .filter((a) => a.source !== 'tmux' && c.statuses.includes(a.status))
        .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    }
    // keep Done stable: muted stopped/error after done
    cols.done.sort((a, b) => Number(a.status !== 'done') - Number(b.status !== 'done') || b.lastActivityAt - a.lastActivityAt);
    const observed = list.filter((a) => a.source === 'tmux' || a.status === 'observed');
    return { cols, observed, total: list.length - observed.length };
  }, [agents]);

  return (
    <div className={`app ${openId ? 'has-panel' : ''}`}>
      <TopBar />
      {!connected && (
        <div className="reconnect">
          <span className="spin" /> {everConnected ? 'Reconnecting…' : 'Connecting…'}
        </div>
      )}
      <main className="main">
        <Inbox />
        {total === 0 && everConnected ? (
          <div className="empty">
            <p>No agents yet. Give one a task and watch it work.</p>
            <button className="btn btn-primary" onClick={() => setLaunchOpen(true)}>
              + New agent
            </button>
          </div>
        ) : (
          <>
            <nav className="tabs" role="tablist">
              {TAB_ORDER.map((k) => {
                const c = COLS.find((x) => x.key === k)!;
                return (
                  <button key={k} role="tab" aria-selected={tab === k} className={`tab tab-${k} ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>
                    {c.label}
                    <span className="tab-count">{cols[k].length}</span>
                  </button>
                );
              })}
            </nav>
            <div className="board">
              {COLS.map((c) => (
                <section key={c.key} className={`col col-${c.key} ${tab === c.key ? 'tab-on' : ''}`}>
                  <div className="col-head">
                    <span className={`col-dot dot-${c.key}`} />
                    {c.label}
                    <span className="col-count">{cols[c.key].length}</span>
                  </div>
                  <div className="col-body">
                    {cols[c.key].map((a) => (
                      <AgentCard key={a.id} a={a} selected={a.id === openId} />
                    ))}
                    {cols[c.key].length === 0 && <div className="col-empty">Nothing here</div>}
                  </div>
                </section>
              ))}
            </div>
          </>
        )}
        {observed.length > 0 && (
          <section className="observed">
            <button className="observed-toggle" onClick={() => setShowObserved((v) => !v)} aria-expanded={showObserved}>
              <span className="caret">{showObserved ? '▾' : '▸'}</span>
              Observed (tmux)
              <span className="col-count">{observed.length}</span>
            </button>
            <div className="observed-grid" hidden={!showObserved}>
              {observed.map((a) => (
                <AgentCard key={a.id} a={a} selected={a.id === openId} />
              ))}
            </div>
          </section>
        )}
      </main>
      <Panel />
      <NewAgentDialog />
      <AccountsPanel />
      <Toasts />
    </div>
  );
}
