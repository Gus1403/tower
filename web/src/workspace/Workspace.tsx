// Full-page session workspace: one session at a time, with its conversation, terminal (observed tmux
// sessions only), context and composer. The board stays mounted underneath so returning keeps its state.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import type { AgentSummary, FeedItem } from '../../../shared/contract';
import { api, loadFeed } from '../api';
import { ControlBar, LimitBanner, MoreMenu } from '../Panel';
import { PanelQuestions } from '../Questions';
import { Composer } from '../composer/Composer';
import { getState, openAgent, toast, useStore } from '../store';
import { KindBadge, PermissionButtons, StatusPill } from '../ui';
import { AcpContext, SessionContext } from './ContextAside';
import { Conversation } from './Conversation';
import { Terminal } from './Terminal';
import { TmuxComposer } from './TmuxComposer';
import { useSessionWorkspace } from './useSessionWorkspace';
import '../tmux.css';
import './workspace.css';

const EMPTY: FeedItem[] = [];
const CTX_KEY = 'tower.workspace.context';

function readCtxPref(): boolean {
  try {
    const v = localStorage.getItem(CTX_KEY);
    if (v === '1' || v === '0') return v === '1' && !narrow();
  } catch {
    /* ignore */
  }
  return !narrow();
}
const narrow = () => window.matchMedia('(max-width: 1023px)').matches;

function modelLabel(a: AgentSummary): string | undefined {
  if (a.model) return a.model;
  const m = a.configOptions?.find((o) => o.id === 'model');
  return m?.options.find((o) => o.value === m.currentValue)?.name ?? m?.currentValue;
}

export interface WorkspaceNav {
  onPrev: () => void;
  onNext: () => void;
  canStep: boolean;
}

function close(id: string | null) {
  openAgent(null);
  if (!id) return;
  // give focus back to the card that was open (the board keeps its scroll position)
  requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(id)}"] .card`)?.focus({ preventScroll: true }));
}

function BackIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M10 3.5L5.5 8l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function ContextIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10 3v10" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function Header({ a, nav, ctxOpen, toggleCtx, actions }: { a: AgentSummary; nav: WorkspaceNav; ctxOpen: boolean; toggleCtx: () => void; actions?: ReactNode }) {
  const model = modelLabel(a);
  return (
    <header className="ws-head">
      <button className="ws-back" onClick={() => close(a.id)} aria-label="Back to board" title="Back to board (Esc)">
        <BackIcon />
        <span className="ws-back-label">Board</span>
      </button>
      <div className="ws-title">
        <h1 className="panel-name ws-name" title={a.name}>
          {a.name}
        </h1>
        <div className="ws-badges">
          <KindBadge kind={a.kind} />
          <StatusPill status={a.status} />
          {a.source === 'tmux' && a.interactive && (
            <span className="tmux-live" title="Live tmux session">
              <i /> Live
            </span>
          )}
          {model && (
            <span className="ws-model" title="Model">
              {model}
            </span>
          )}
        </div>
      </div>
      <span className="spacer" />
      {actions}
      <div className="ws-nav" role="group" aria-label="Sessions">
        <button className="icon-btn" aria-label="Previous session (K)" title="Previous session (K)" onClick={nav.onPrev} disabled={!nav.canStep}>
          ‹
        </button>
        <button className="icon-btn" aria-label="Next session (J)" title="Next session (J)" onClick={nav.onNext} disabled={!nav.canStep}>
          ›
        </button>
      </div>
      <button className={`ws-ctx-btn ${ctxOpen ? 'on' : ''}`} aria-pressed={ctxOpen} aria-controls="ws-aside" onClick={toggleCtx} title={ctxOpen ? 'Hide context' : 'Show context'}>
        <ContextIcon />
        <span className="ws-ctx-label">Context</span>
      </button>
    </header>
  );
}

function Layout({ main, aside, ctxOpen, label }: { main: ReactNode; aside: ReactNode; ctxOpen: boolean; label: string }) {
  return (
    <div className={`ws-body ${ctxOpen ? 'ctx-open' : ''}`}>
      <div className="ws-main">{main}</div>
      <aside id="ws-aside" className="ws-aside" aria-label={`${label} context`} hidden={!ctxOpen}>
        {aside}
      </aside>
    </div>
  );
}

// ---------- ACP agent ----------
function AcpSession({ a, nav, ctxOpen, toggleCtx }: { a: AgentSummary; nav: WorkspaceNav; ctxOpen: boolean; toggleCtx: () => void }) {
  const items = useStore((s) => s.feeds[a.id] ?? EMPTY);
  const loaded = useStore((s) => !!s.feedLoaded[a.id]);
  const [picking, setPicking] = useState(false);
  const [stopping, setStopping] = useState(false);
  useEffect(() => {
    void loadFeed(a.id);
  }, [a.id]);

  const canStop = a.source === 'tower' && a.status !== 'stopped' && a.status !== 'error' && a.status !== 'done';
  const working = a.status === 'working' || a.status === 'starting';
  const actions = (
    <>
      {canStop && (
        <button
          className="btn btn-secondary btn-sm"
          disabled={stopping}
          onClick={() => {
            setStopping(true);
            api
              .stop(a.id)
              .catch((e: Error) => toast(`Could not stop: ${e.message}`))
              .finally(() => setStopping(false));
          }}
        >
          {stopping ? 'Stopping…' : 'Stop'}
        </button>
      )}
      <MoreMenu a={a} onMove={() => setPicking(true)} />
    </>
  );
  return (
    <>
      <Header a={a} nav={nav} ctxOpen={ctxOpen} toggleCtx={toggleCtx} actions={actions} />
      <Layout
        label={a.name}
        ctxOpen={ctxOpen}
        main={
          <>
            <Conversation
              label={`Conversation with ${a.name}`}
              items={items}
              loading={!loaded}
              empty={<p className="ws-empty">{a.status === 'starting' ? 'Starting the agent…' : 'No messages yet.'}</p>}
              tail={
                working && loaded ? (
                  <div className="ws-working" aria-live="polite">
                    <span className="ti ti-spin" /> {a.status === 'starting' ? 'Starting…' : 'Working…'}
                  </div>
                ) : null
              }
            />
            <div className="ws-dock">
              <div className="ws-col">
                {a.pendingPermission && (
                  <div className="panel-perm ws-card">
                    <div className="panel-perm-text">
                      <b>{a.pendingPermission.title}</b>
                      {a.pendingPermission.detail && <code className="mono-detail">{a.pendingPermission.detail}</code>}
                    </div>
                    <PermissionButtons agent={a} req={a.pendingPermission} />
                  </div>
                )}
                <PanelQuestions a={a} />
                {a.status === 'error' && a.error && (
                  <div className="panel-error ws-card" role="alert">
                    {a.error}
                  </div>
                )}
                <LimitBanner a={a} picking={picking} setPicking={setPicking} />
              </div>
            </div>
            <footer className="ws-foot">
              <div className="ws-col">
                <Composer a={a} toolbar={<ControlBar a={a} />} />
              </div>
            </footer>
          </>
        }
        aside={<AcpContext a={a} />}
      />
    </>
  );
}

// ---------- observed tmux session ----------
type Tab = 'conversation' | 'terminal';

function TmuxSession({ a, nav, ctxOpen, toggleCtx }: { a: AgentSummary; nav: WorkspaceNav; ctxOpen: boolean; toggleCtx: () => void }) {
  const ws = useSessionWorkspace(a.id);
  const [chosen, setChosen] = useState<Tab | null>(null);
  const [nudge, setNudge] = useState(0);
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({ conversation: null, terminal: null });
  // conversation first when there is real history; otherwise the terminal (never a fake chat built from the screen)
  const tab: Tab = chosen ?? (ws.status === 'ready' && !ws.available && a.interactive ? 'terminal' : 'conversation');

  const pick = (t: Tab, focus = false) => {
    setChosen(t);
    if (focus) tabRefs.current[t]?.focus();
  };
  const onTabKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const order: Tab[] = ['conversation', 'terminal'];
      const i = order.indexOf(tab);
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + 2) % 2;
      pick(order[next], true);
    }
  };

  const openTerminal = a.interactive ? (
    <button className="btn btn-primary btn-sm" onClick={() => pick('terminal', true)}>
      Open terminal
    </button>
  ) : null;

  let notice: ReactNode = null;
  if (ws.status === 'error') {
    notice = (
      <div className="ws-notice" role="alert">
        <h3>Could not load the conversation</h3>
        <p>{ws.error}</p>
        <div className="ws-notice-actions">
          <button className="btn btn-secondary btn-sm" onClick={ws.retry}>
            Try again
          </button>
          {openTerminal}
        </div>
      </div>
    );
  } else if (ws.status === 'ready' && !ws.available) {
    notice = (
      <div className="ws-notice">
        <h3>No conversation history for this session</h3>
        {ws.reason && <p>{ws.reason}</p>}
        <p className="muted">{a.interactive ? 'The terminal shows its live screen as it is.' : 'This session is read-only, so its screen is not shown either.'}</p>
        {openTerminal && <div className="ws-notice-actions">{openTerminal}</div>}
      </div>
    );
  }

  const main = (
    <>
      <div className="ws-tabs-row">
        <div className="ws-tabs" role="tablist" aria-label="Session view" onKeyDown={onTabKey}>
          {(['conversation', 'terminal'] as Tab[]).map((t) => (
            <button
              key={t}
              ref={(el) => {
                tabRefs.current[t] = el;
              }}
              role="tab"
              id={`ws-tab-${t}`}
              aria-selected={tab === t}
              aria-controls={`ws-pane-${t}`}
              tabIndex={tab === t ? 0 : -1}
              className={`ws-tab ${tab === t ? 'on' : ''}`}
              onClick={() => pick(t)}
            >
              {t === 'conversation' ? 'Conversation' : 'Terminal'}
              {t === 'conversation' && ws.status === 'ready' && !ws.available && <span className="ws-tab-note">unavailable</span>}
            </button>
          ))}
        </div>
        {ws.stale && (
          <span className="ws-stale" role="status" title={ws.error}>
            History not refreshing · retrying
          </span>
        )}
      </div>
      <div className="ws-pane" role="tabpanel" id={`ws-pane-${tab}`} aria-labelledby={`ws-tab-${tab}`}>
        {tab === 'conversation' ? (
          <Conversation
            label={`Conversation history of ${a.name}`}
            items={ws.items}
            loading={ws.status === 'loading'}
            notice={notice}
            empty={<p className="ws-empty">No messages recorded yet.</p>}
            hasMore={ws.hasMore}
            loadingOlder={ws.loadingOlder}
            olderError={ws.olderError}
            onLoadOlder={() => void ws.loadOlder()}
          />
        ) : a.interactive ? (
          <Terminal a={a} nudge={nudge} />
        ) : (
          <div className="ws-convo-wrap">
            <div className="ws-col">
              <div className="ws-notice">
                <h3>Terminal view is off for this session</h3>
                <p>Tower only shows the screen of sessions with interactive control enabled. Nothing here can type into it.</p>
              </div>
            </div>
          </div>
        )}
      </div>
      <footer className="ws-foot">
        <div className={tab === 'terminal' ? 'ws-col ws-col-wide' : 'ws-col'}>
          <TmuxComposer
            a={a}
            showKeys={tab === 'terminal'}
            onSent={() => {
              setNudge((n) => n + 1);
              void ws.refresh();
            }}
          />
        </div>
      </footer>
    </>
  );
  return (
    <>
      <Header a={a} nav={nav} ctxOpen={ctxOpen} toggleCtx={toggleCtx} />
      <Layout label={a.name} ctxOpen={ctxOpen} main={main} aside={<SessionContext a={a} ctx={ws.context} status={ws.status} error={ws.error} />} />
    </>
  );
}

// ---------- shell ----------
export function Workspace(nav: WorkspaceNav) {
  const id = useStore((s) => s.openId);
  const a = useStore((s) => (s.openId ? s.agents[s.openId] : undefined));
  const connected = useStore((s) => s.connected);
  const everConnected = useStore((s) => s.everConnected);
  const [ctxOpen, setCtxOpen] = useState(readCtxPref);
  const rootRef = useRef<HTMLElement>(null);

  const toggleCtx = useCallback(() => {
    setCtxOpen((v) => {
      try {
        localStorage.setItem(CTX_KEY, v ? '0' : '1');
      } catch {
        /* ignore */
      }
      return !v;
    });
  }, []);

  useEffect(() => {
    if (!id) return;
    const k = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || getState().launchOpen) return;
      close(getState().openId);
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [id]);

  // opening (not switching) moves focus into the workspace, so keyboard users start there
  const wasOpen = useRef(false);
  useEffect(() => {
    if (id && !wasOpen.current && !rootRef.current?.contains(document.activeElement)) rootRef.current?.focus({ preventScroll: true });
    wasOpen.current = !!id;
  }, [id]);

  if (!id) return null;
  const tmux = a?.source === 'tmux';
  return (
    <section ref={rootRef} tabIndex={-1} className={`ws panel ${tmux ? 'tmux-panel' : ''}`} aria-label={a ? `Session ${a.name}` : 'Session'}>
      {!connected && (
        <div className="ws-banner" role="status">
          <span className="spin" /> {everConnected ? 'Disconnected from Tower · reconnecting. What you see may be out of date.' : 'Connecting to Tower…'}
        </div>
      )}
      {!a ? (
        <div className="ws-missing">
          <button className="ws-back" onClick={() => close(null)} aria-label="Back to board">
            <BackIcon />
            <span className="ws-back-label">Board</span>
          </button>
          <div className="ws-notice">
            {everConnected ? (
              <>
                <h3>This session is not on the board anymore</h3>
                <p>It may have been removed. Go back to the board to pick another one.</p>
              </>
            ) : (
              <>
                <h3>Loading session…</h3>
                <p>Waiting for Tower.</p>
              </>
            )}
          </div>
        </div>
      ) : tmux ? (
        <TmuxSession key={a.id} a={a} nav={nav} ctxOpen={ctxOpen} toggleCtx={toggleCtx} />
      ) : (
        <AcpSession key={a.id} a={a} nav={nav} ctxOpen={ctxOpen} toggleCtx={toggleCtx} />
      )}
    </section>
  );
}
