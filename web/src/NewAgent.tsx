import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AgentKind } from '../../shared/contract';
import { api } from './api';
import { getState, openAgent, setLaunchOpen, toast, upsertAgent, useStore } from './store';
import { KINDS, KIND_LABEL } from './ui';
import { useAccounts } from './Accounts';
import { getActiveBoard } from './boards/activeBoard';

const LAST_KIND = 'tower.lastKind';
const lastKind = (): AgentKind => {
  try {
    const k = localStorage.getItem(LAST_KIND) as AgentKind | null;
    return k && KINDS.includes(k) ? k : 'devin';
  } catch {
    return 'devin';
  }
};

export function NewAgentDialog() {
  const open = useStore((s) => s.launchOpen);
  const capacity = useStore((s) => s.capacity);
  const [kind, setKind] = useState<AgentKind>(lastKind);
  const [task, setTask] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [accountId, setAccountId] = useState('');
  const boards = useStore((s) => s.boards);
  const [board, setBoard] = useState('programs');
  const [customer, setCustomer] = useState('');
  const needCustomer = board === 'customers';
  const custOk = !needCustomer || !!customer.trim();
  const accounts = useAccounts().filter((a) => a.kind === kind);
  const ta = useRef<HTMLTextAreaElement>(null);

  const avail = (k: AgentKind) => capacity.find((c) => c.kind === k)?.available ?? true;

  // Wave D: board defaults to the active board each time the dialog opens
  useLayoutEffect(() => {
    if (!open) return;
    const ab = getActiveBoard();
    setBoard(getState().boards.some((b) => b.id === ab) ? ab : 'programs');
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const lk = lastKind();
    if (avail(lk)) setKind(lk);
    else if (!avail(kind)) {
      const first = KINDS.find(avail);
      if (first) setKind(first);
    }
    setTimeout(() => ta.current?.focus(), 0);
    const k = (e: KeyboardEvent) => e.key === 'Escape' && setLaunchOpen(false);
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const submit = async () => {
    if (!task.trim() || busy || !avail(kind) || !custOk) return;
    setBusy(true);
    try {
      const a = await api.launch({
        kind,
        task: task.trim(),
        name: name.trim() || undefined,
        accountId: accountId || undefined,
        ...(board !== 'programs' ? { board } : {}),
        ...(needCustomer && customer.trim() ? { customer: customer.trim() } : {}),
      });
      try {
        localStorage.setItem(LAST_KIND, kind);
      } catch {
        /* ignore */
      }
      upsertAgent(a);
      setTask('');
      setName('');
      setCustomer('');
      setLaunchOpen(false);
      openAgent(a.id);
    } catch (e) {
      toast(`Launch failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && setLaunchOpen(false)}>
      <div className="dialog" role="dialog" aria-label="New agent">
        <div className="dialog-head">
          <h2>New agent</h2>
          <button className="icon-btn" onClick={() => setLaunchOpen(false)} aria-label="Close">
            ✕
          </button>
        </div>
        <label className="field">
          <span>Task</span>
          <textarea
            ref={ta}
            rows={4}
            value={task}
            placeholder="What should it do?"
            aria-label="Task"
            onChange={(e) => setTask(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit();
            }}
          />
        </label>
        <div className="segmented" role="radiogroup" aria-label="Agent">
          {KINDS.map((k) => (
            <button
              key={k}
              role="radio"
              aria-checked={kind === k}
              disabled={!avail(k)}
              className={kind === k ? 'on' : ''}
              onClick={() => {
                setKind(k);
                setAccountId('');
              }}
              title={capacity.find((c) => c.kind === k)?.detail}
            >
              <span className={`cap-dot kind-dot-${k}`} />
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>
        {boards.length > 1 && (
          <label className="field">
            <span>Board</span>
            <select value={board} onChange={(e) => setBoard(e.target.value)} aria-label="Board">
              {boards.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {needCustomer && (
          <label className="field">
            <span>Customer</span>
            <input value={customer} placeholder="Customer name" aria-label="Customer" required onChange={(e) => setCustomer(e.target.value)} />
          </label>
        )}
        <label className="field">
          <span>
            Name <em>optional</em>
          </span>
          <input value={name} placeholder="e.g. api-routes" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void submit()} />
        </label>
        {accounts.length > 0 && (
          <details className="na-advanced">
            <summary>Advanced</summary>
          <label className="field">
            <span>Account</span>
            <select value={accountId} onChange={(e) => setAccountId(e.target.value)} aria-label="Account">
              <option value="">Automatic</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id} disabled={a.loggedIn === false}>
                  {a.label}
                  {a.plan ? ` · ${a.plan}` : ''}
                  {a.loggedIn === false ? ' (logged out)' : a.usedPct !== undefined ? ` · ${Math.round(a.usedPct)}% used` : ''}
                </option>
              ))}
            </select>
          </label>
          </details>
        )}
        <div className="dialog-foot">
          <span className="hint">
            <kbd>⌘</kbd>
            <kbd>Enter</kbd> to launch
          </span>
          <button className="btn btn-primary" disabled={!task.trim() || busy || !avail(kind) || !custOk} onClick={() => void submit()}>
            Launch
          </button>
        </div>
      </div>
    </div>
  );
}
