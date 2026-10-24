import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentStatus, AgentSummary, Board, Note } from '../../shared/contract';
import { AccountsPanel, useAttentionAlerts } from './Accounts';
import { ArchivedSection, BoardCard, DT_AGENT, DT_NOTE, matches, SearchBox } from './board/Board';
import { mockMakeInteractive, useBoardNotes } from './board/api-extra';
import { NewAgentDialog } from './NewAgent';
import { NotesColumn, StartNoteDialog } from './Notes';
import { Panel } from './Panel';
import { getState, openAgent, setLaunchOpen, useStore } from './store';
import { TmuxPanel } from './TmuxPanel';
import { Inbox, TopBar } from './ui';
import { initNotifications } from './notify';
import { subscribe } from './store';
import { BoardTabs } from './boards/BoardTabs';
import { boardOf, useActiveBoard } from './boards/activeBoard';
import { CardCustomer, CardRequestedBy } from './boards/Handoffs';

initNotifications(
  () =>
    Object.values(getState().agents)
      .filter((a) => a.status === 'needs_you')
      .map((a) => ({ id: a.id, name: a.name, title: a.pendingPermission?.title ?? a.questions?.[0]?.text ?? a.lastMessage ?? '' })),
  subscribe,
);

type Col = string; // Board column id (Wave D)
type Tab = Col | 'notes';
interface ColDef {
  key: Col;
  label: string;
  statuses: AgentStatus[];
  dot: 'working' | 'needs' | 'stuck' | 'done';
}
// colour/dot class of a board column, from its statuses (needs_you wins, then working, then done)
const dotOf = (st: AgentStatus[]): ColDef['dot'] =>
  st.includes('needs_you') && !st.includes('working') ? 'needs' : st.includes('working') || st.includes('starting') ? 'working' : st.includes('stuck') ? 'stuck' : 'done';
const colsOf = (b: Board | undefined): ColDef[] => (b?.columns ?? []).map((c) => ({ key: c.id, label: c.name, statuses: c.statuses, dot: dotOf(c.statuses) }));

const PIN: Record<AgentStatus, number> = { needs_you: 0, stuck: 1, starting: 2, working: 2, done: 3, stopped: 3, error: 3, observed: 4 };

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

const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.isContentEditable);
};
const agentMatch = (q: string, a: AgentSummary) => matches(q, a.name, a.task, a.lastMessage, a.customer);
const noteMatch = (q: string, n: Note) => matches(q, n.title, n.body);

export function App() {
  const agents = useStore((s) => s.agents);
  const openId = useStore((s) => s.openId);
  const connected = useStore((s) => s.connected);
  const everConnected = useStore((s) => s.everConnected);
  const launchOpen = useStore((s) => s.launchOpen);
  const allNotes = useBoardNotes();
  const boards = useStore((s) => s.boards);
  const activeRaw = useActiveBoard();
  const board = boards.find((b) => b.id === activeRaw) ?? boards.find((b) => b.id === 'programs') ?? boards[0];
  const boardId = board?.id ?? 'programs';
  const isPrograms = boardId === 'programs';
  const COLS = useMemo(() => colsOf(board), [board]);
  const TAB_ORDER: Tab[] = useMemo(() => {
    const needs = COLS.filter((c) => c.dot === 'needs').map((c) => c.key);
    const rest = COLS.filter((c) => c.dot !== 'needs').map((c) => c.key);
    return [...needs, ...rest, ...(isPrograms ? ['notes'] : [])];
  }, [COLS, isPrograms]);
  const [tabRaw, setTab] = useState<Tab>('needs');
  const tab: Tab = TAB_ORDER.includes(tabRaw) ? tabRaw : (TAB_ORDER[0] ?? 'notes');
  useAttentionAlerts();
  const [showObserved, setShowObserved] = useState(false);
  const [q, setQ] = useState('');
  const [focusId, setFocusId] = useState<string | null>(null);
  const [starting, setStarting] = useState<Note | null>(null);
  const [dragKind, setDragKind] = useState<null | 'agent' | 'note'>(null);
  const [dropCol, setDropCol] = useState<Col | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const searchRefPhone = useRef<HTMLInputElement>(null);

  // mock only: one observed tmux card is interactive so the live panel can be demoed
  useEffect(() => mockMakeInteractive(), [agents]);

  const { cols, observed, archived, total, counts } = useMemo(() => {
    const list = Object.values(agents);
    const live = list.filter((a) => !a.archived || a.source === 'tmux');
    const counts: Record<string, number> = {};
    for (const a of live) if (a.source !== 'tmux' && a.status !== 'observed') counts[boardOf(a)] = (counts[boardOf(a)] ?? 0) + 1;
    const onBoard = live.filter((a) => a.source !== 'tmux' && boardOf(a) === boardId);
    const cols = {} as Record<Col, AgentSummary[]>;
    for (const c of COLS) {
      // decided: needs_you pinned first, then stuck, then the rest by recency
      cols[c.key] = onBoard
        .filter((a) => c.statuses.includes(a.status) && agentMatch(q, a))
        .sort((a, b) => PIN[a.status] - PIN[b.status] || b.lastActivityAt - a.lastActivityAt);
      // keep finished columns stable: muted stopped/error after done
      if (c.statuses.includes('done'))
        cols[c.key].sort((a, b) => Number(a.status !== 'done') - Number(b.status !== 'done') || b.lastActivityAt - a.lastActivityAt);
    }
    const observedAll = live.filter((a) => a.source === 'tmux' || a.status === 'observed');
    const observed = isPrograms ? observedAll.filter((a) => agentMatch(q, a)) : [];
    const archived = list.filter((a) => a.archived && a.source !== 'tmux' && boardOf(a) === boardId && agentMatch(q, a));
    return { cols, observed, archived, total: list.length - observedAll.length, counts };
  }, [agents, q, COLS, boardId, isPrograms]);

  const notes = useMemo(() => (isPrograms ? allNotes.filter((n) => !n.archived && noteMatch(q, n)) : []), [allNotes, q, isPrograms]);
  const archivedNotes = useMemo(() => (isPrograms ? allNotes.filter((n) => n.archived && noteMatch(q, n)) : []), [allNotes, q, isPrograms]);

  // flat order for J/K: notes, then columns left→right, then observed (when expanded or searching)
  const order = useMemo(() => {
    const ids: string[] = notes.map((n) => `note:${n.id}`);
    for (const c of COLS) for (const a of cols[c.key] ?? []) ids.push(a.id);
    if (showObserved || q) for (const a of observed) ids.push(a.id);
    return ids;
  }, [notes, cols, observed, showObserved, q, COLS]);

  const openItem = useCallback(
    (id: string) => {
      if (id.startsWith('note:')) {
        openAgent(null);
        const n = allNotes.find((x) => `note:${x.id}` === id);
        if (n) setStarting(n);
      } else openAgent(id);
    },
    [allNotes],
  );

  const step = useCallback(
    (dir: 1 | -1, openIt: boolean) => {
      if (order.length === 0) return;
      const cur = openIt && openId ? openId : (focusId ?? openId);
      let i = cur ? order.indexOf(cur) : -1;
      let next: string | undefined;
      for (let n = 0; n < order.length; n++) {
        i = i === -1 ? (dir === 1 ? 0 : order.length - 1) : (i + dir + order.length) % order.length;
        next = order[i];
        if (!openIt || !next.startsWith('note:')) break;
      }
      if (!next) return;
      setFocusId(next);
      if (openIt && !next.startsWith('note:')) openAgent(next);
      document.querySelector(`[data-card-id="${next}"], [data-note-id="${next.slice(5)}"]`)?.scrollIntoView({ block: 'nearest' });
    },
    [order, focusId, openId],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || launchOpen || starting) return;
      if (isTyping(e.target)) return;
      if (e.key === '/') {
        e.preventDefault();
        (window.matchMedia('(max-width: 767px)').matches ? searchRefPhone : searchRef).current?.focus();
        return;
      }
      if (e.key === 'j' || e.key === 'J') {
        e.preventDefault();
        step(1, !!getState().openId);
      } else if (e.key === 'k' || e.key === 'K') {
        e.preventDefault();
        step(-1, !!getState().openId);
      } else if (e.key === 'Enter' && focusId && !getState().openId) {
        // capture phase + stopImmediatePropagation: Enter on a J/K focus must not also allow the Inbox's first permission
        e.preventDefault();
        e.stopImmediatePropagation();
        openItem(focusId);
      } else if (e.key === 'Escape' && q && !getState().openId) {
        setQ('');
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [step, focusId, openItem, launchOpen, starting, q]);

  const open = openId ? agents[openId] : undefined;
  const tmuxOpen = open && open.source === 'tmux' && open.interactive;

  const startCol = isPrograms ? COLS.find((c) => c.statuses.includes('working'))?.key : undefined;
  const colDrop = (c: Col) => ({
    onDragOver: (e: React.DragEvent) => {
      if (c === startCol && e.dataTransfer.types.includes(DT_NOTE)) {
        e.preventDefault();
        setDropCol(c);
      }
    },
    onDragLeave: () => setDropCol(null),
    onDrop: (e: React.DragEvent) => {
      setDropCol(null);
      setDragKind(null);
      const id = e.dataTransfer.getData(DT_NOTE);
      const n = id && allNotes.find((x) => x.id === id);
      if (c === startCol && n) {
        e.preventDefault();
        setStarting(n);
      }
    },
  });

  return (
    <div
      className={`app ${openId ? 'has-panel' : ''}`}
      onDragStart={(e) => setDragKind(e.dataTransfer.types.includes(DT_AGENT) ? 'agent' : e.dataTransfer.types.includes(DT_NOTE) ? 'note' : null)}
      onDragEnd={() => {
        setDragKind(null);
        setDropCol(null);
      }}
      onDrop={() => setDragKind(null)}
    >
      <TopBar
        search={<SearchBox ref={searchRef} value={q} onChange={setQ} className="search-desk" />}
        tabs={<BoardTabs boards={boards} active={boardId} counts={counts} />}
      />
      {!connected && (
        <div className="reconnect">
          <span className="spin" /> {everConnected ? 'Reconnecting…' : 'Connecting…'}
        </div>
      )}
      <main className="main">
        <SearchBox ref={searchRefPhone} value={q} onChange={setQ} className="search-phone" />
        <Inbox />
        {q && order.length === 0 && archived.length === 0 && <p className="search-empty">Nothing matches “{q}”.</p>}
        {total === 0 && allNotes.length === 0 && everConnected && !q ? (
          <div className="empty">
            <p>No agents yet. Give one a task and watch it work.</p>
            <button className="btn btn-primary" onClick={() => setLaunchOpen(true)}>
              + New agent
            </button>
          </div>
        ) : (
          <>
            <nav className={`tabs ${isPrograms ? 'with-notes' : ''}`} role="tablist" style={{ gridTemplateColumns: `repeat(${TAB_ORDER.length}, 1fr)` }}>
              {TAB_ORDER.map((k) => {
                const c = COLS.find((x) => x.key === k);
                return (
                  <button key={k} role="tab" aria-selected={tab === k} className={`tab tab-${c ? c.dot : 'notes'} ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>
                    {c ? c.label : 'To do'}
                    <span className="tab-count">{k === 'notes' ? notes.length : (cols[k]?.length ?? 0)}</span>
                  </button>
                );
              })}
            </nav>
            <div
              className={`board ${isPrograms ? 'has-notes' : ''}`}
              data-board={boardId}
              style={{ gridTemplateColumns: `repeat(${COLS.length + (isPrograms ? 1 : 0)}, minmax(0, 1fr))` }}
            >
              {isPrograms && <NotesColumn notes={notes} focusId={focusId} onStart={setStarting} className={tab === 'notes' ? 'tab-on' : ''} />}
              {COLS.map((c) => (
                <section
                  key={c.key}
                  data-col={c.key}
                  className={`col col-${c.dot} col-id-${c.key} ${tab === c.key ? 'tab-on' : ''} ${dropCol === c.key ? 'drop-ok' : ''}`}
                  {...colDrop(c.key)}
                >
                  <div className="col-head">
                    <span className={`col-dot dot-${c.dot}`} />
                    {c.label}
                    <span className="col-count">{cols[c.key].length}</span>
                  </div>
                  <div className="col-body">
                    {c.key === startCol && dragKind === 'note' && <div className="archived-drop">Drop to start an agent</div>}
                    {cols[c.key].map((a) => (
                      <div key={a.id} className="wbd-card">
                        <CardCustomer a={a} />
                        <BoardCard a={a} selected={a.id === openId} focused={a.id === focusId} />
                        <CardRequestedBy a={a} />
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </>
        )}
        {observed.length > 0 && (
          <section className="observed">
            <button className="observed-toggle" onClick={() => setShowObserved((v) => !v)} aria-expanded={showObserved || !!q}>
              <span className="caret">{showObserved || q ? '▾' : '▸'}</span>
              Other sessions
              <span className="col-count">{observed.length}</span>
            </button>
            <div className="observed-grid" hidden={!showObserved && !q}>
              {observed.map((a) => (
                <BoardCard key={a.id} a={a} selected={a.id === openId} focused={a.id === focusId} />
              ))}
            </div>
          </section>
        )}
        <ArchivedSection agents={archived} notes={archivedNotes} dragActive={dragKind === 'agent'} />
      </main>
      {tmuxOpen ? <TmuxPanel a={open} onNext={() => step(1, true)} onPrev={() => step(-1, true)} /> : <Panel />}
      {starting && <StartNoteDialog note={starting} onClose={() => setStarting(null)} />}
      <NewAgentDialog />
      <AccountsPanel />
      <Toasts />
    </div>
  );
}
