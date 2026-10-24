// ACP session controls used by the session workspace: mode/config bar, account move, more menu.
import { useEffect, useRef, useState } from 'react';
import type { AgentSummary } from '../../shared/contract';
import { api } from './api';
import { openAgent, patchAgentLocal, removeAgentLocal, toast, useAccounts } from './store';
import { accountStatus } from './Accounts';
import './panel.css';
import { KIND_LABEL } from './ui';

export function ControlBar({ a }: { a: AgentSummary }) {
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

export function LimitBanner({ a, picking, setPicking }: { a: AgentSummary; picking: boolean; setPicking: (v: boolean) => void }) {
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

export function MoreMenu({ a, onMove }: { a: AgentSummary; onMove: () => void }) {
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
