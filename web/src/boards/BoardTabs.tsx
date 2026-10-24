// Wave D: board tabs ("Programs 13 · Customers 8 · +"), the New board dialog, delete, and drop-a-card-on-a-tab.
import { useEffect, useRef, useState } from 'react';
import type { Board } from '../../../shared/contract';
import { api } from '../api';
import { DT_AGENT } from '../board/Board';
import { getState, patchAgentLocal, setState, toast } from '../store';
import { setActiveBoard } from './activeBoard';
import './boards.css';

const DEFAULT_IDS = new Set(['programs', 'customers']);

export async function moveToBoard(agentId: string, board: string): Promise<void> {
  const a = getState().agents[agentId];
  if (!a || (a.board ?? 'programs') === board) return;
  const prev = a.board;
  patchAgentLocal(agentId, { board });
  try {
    await api.setBoard(agentId, board);
    const name = getState().boards.find((b) => b.id === board)?.name ?? board;
    toast(`Moved ${a.name} to ${name}`);
  } catch (e) {
    patchAgentLocal(agentId, { board: prev });
    toast(`Could not move: ${(e as Error).message}`);
  }
}

export function BoardTabs({ boards, active, counts }: { boards: Board[]; active: string; counts: Record<string, number> }) {
  const [over, setOver] = useState<string | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [menu]);

  const del = async (b: Board) => {
    setMenu(null);
    try {
      await api.deleteBoard(b.id);
      setState((s) => ({ ...s, boards: s.boards.filter((x) => x.id !== b.id) }));
      if (active === b.id) setActiveBoard('programs');
      toast(`Deleted board ${b.name}`);
    } catch (e) {
      toast(`Could not delete: ${(e as Error).message}`);
    }
  };

  return (
    <>
      <nav className="wbd-tabs" role="tablist" aria-label="Boards">
        {boards.map((b) => {
          const n = counts[b.id] ?? 0;
          const canMenu = !DEFAULT_IDS.has(b.id);
          return (
            <div key={b.id} className="wbd-tab-wrap">
              <button
                role="tab"
                aria-selected={active === b.id}
                data-board-tab={b.id}
                className={`wbd-tab ${active === b.id ? 'on' : ''} ${over === b.id ? 'drop-ok' : ''}`}
                onClick={() => setActiveBoard(b.id)}
                onContextMenu={(e) => {
                  if (!canMenu) return;
                  e.preventDefault();
                  setMenu(b.id);
                }}
                onDragOver={(e) => {
                  if (e.dataTransfer.types.includes(DT_AGENT)) {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    setOver(b.id);
                  }
                }}
                onDragLeave={() => setOver((o) => (o === b.id ? null : o))}
                onDrop={(e) => {
                  setOver(null);
                  const id = e.dataTransfer.getData(DT_AGENT);
                  if (id) {
                    e.preventDefault();
                    e.stopPropagation();
                    void moveToBoard(id, b.id);
                  }
                }}
              >
                {b.name}
                <span className="wbd-tab-n">{n}</span>
              </button>
              {canMenu && active === b.id && (
                <button
                  className="wbd-tab-more"
                  aria-label={`${b.name} board menu`}
                  aria-haspopup="menu"
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenu((m) => (m === b.id ? null : b.id));
                  }}
                >
                  ⋯
                </button>
              )}
              {menu === b.id && (
                <div className="wbd-menu" role="menu" onClick={(e) => e.stopPropagation()}>
                  <button role="menuitem" disabled={n > 0} title={n > 0 ? 'Move or archive its cards first' : undefined} onClick={() => void del(b)}>
                    Delete board{n > 0 ? ' (not empty)' : ''}
                  </button>
                </div>
              )}
            </div>
          );
        })}
        <button className="wbd-tab wbd-tab-add" aria-label="New board" title="New board" onClick={() => setCreating(true)}>
          +
        </button>
      </nav>
      {creating && <NewBoardDialog onClose={() => setCreating(false)} />}
    </>
  );
}

export function NewBoardDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setTimeout(() => ref.current?.focus(), 0);
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const b = await api.createBoard(name.trim());
      setState((s) => ({ ...s, boards: s.boards.some((x) => x.id === b.id) ? s.boards : [...s.boards, b] }));
      setActiveBoard(b.id);
      onClose();
    } catch (e) {
      toast(`Could not create board: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-label="New board">
        <div className="dialog-head">
          <h2>New board</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <label className="field">
          <span>Name</span>
          <input ref={ref} value={name} placeholder="e.g. Research" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void submit()} />
        </label>
        <div className="dialog-foot">
          <span className="hint">Columns: Working · Needs you · Done</span>
          <button className="btn btn-primary" disabled={!name.trim() || busy} onClick={() => void submit()}>
            Create board
          </button>
        </div>
      </div>
    </div>
  );
}
