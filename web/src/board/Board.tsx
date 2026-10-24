import { forwardRef, useState } from 'react';
import type { AgentSummary, Note } from '../../../shared/contract';
import { toast } from '../store';
import { AgentCard } from '../ui';
import { notesApi, setArchived } from './api-extra';

export const DT_AGENT = 'application/x-tower-agent';
export const DT_NOTE = 'application/x-tower-note';

export function archive(id: string, archived: boolean) {
  setArchived(id, archived).catch((e) => toast(`Could not ${archived ? 'archive' : 'restore'}: ${(e as Error).message}`));
}

export function BoardCard({ a, selected, focused }: { a: AgentSummary; selected: boolean; focused: boolean }) {
  const [dragging, setDragging] = useState(false);
  const tower = a.source !== 'tmux';
  const observed = a.source === 'tmux' || a.status === 'observed';
  return (
    <div
      className={`bcard ${focused ? 'kfocus' : ''} ${dragging ? 'dragging' : ''} ${['done', 'stopped', 'error'].includes(a.status) ? 'bcard-fin' : ''}`}
      data-card-id={a.id}
      draggable={tower}
      onDragStart={(e) => {
        if (!tower) return;
        e.dataTransfer.setData(DT_AGENT, a.id);
        e.dataTransfer.effectAllowed = 'move';
        setDragging(true);
      }}
      onDragEnd={() => setDragging(false)}
    >
      <AgentCard a={a} selected={selected} />
      {tower && (
        <div className="bcard-acts">
          <button className="bcard-act" aria-label={`Archive ${a.name}`} onClick={() => archive(a.id, true)}>
            Archive
          </button>
        </div>
      )}
      {/* clicking a live session opens its terminal; only say something when it can't be opened */}
      {observed && !a.interactive && <div className="ro-hint">Read-only</div>}
    </div>
  );
}

export function ArchivedSection({
  agents,
  notes,
  dragActive,
}: {
  agents: AgentSummary[];
  notes: Note[];
  dragActive: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [over, setOver] = useState(false);
  const n = agents.length + notes.length;
  if (n === 0 && !dragActive) return null;
  return (
    <section
      className={`archived ${over ? 'drop-ok' : ''}`}
      aria-label="Archived"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(DT_AGENT)) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        const id = e.dataTransfer.getData(DT_AGENT);
        if (id) {
          e.preventDefault();
          archive(id, true);
        }
      }}
    >
      <button className="observed-toggle archived-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="caret">{open ? '▾' : '▸'}</span>
        Archived ({n})
      </button>
      {dragActive && <div className="archived-drop">Drop here to archive</div>}
      {open && n > 0 && (
        <div className="archived-body">
          {agents.map((a) => (
            <div key={a.id} className="archived-item" data-archived-id={a.id}>
              <span className="col-dot archived-dot" />
              <span className="archived-name">{a.name}</span>
              <button className="btn btn-secondary btn-sm" onClick={() => archive(a.id, false)}>
                Restore
              </button>
            </div>
          ))}
          {notes.map((x) => (
            <div key={x.id} className="archived-item" data-archived-note={x.id}>
              <span className="col-dot archived-dot" />
              <span className="archived-name">{x.title}</span>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => notesApi.update(x.id, { archived: false }).catch((e) => toast((e as Error).message))}
              >
                Restore
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export const SearchBox = forwardRef<HTMLInputElement, { value: string; onChange: (v: string) => void; className?: string }>(function SearchBox(
  { value, onChange, className },
  ref,
) {
  return (
    <div className={`search ${className ?? ''}`} role="search">
      <span className="search-ico">
        <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="7" cy="7" r="4.8" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M10.5 10.5l3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </span>
      <input
        ref={ref}
        type="search"
        placeholder="Search"
        aria-label="Search cards and notes"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onChange('');
            e.currentTarget.blur();
          }
        }}
      />
      <kbd>/</kbd>
    </div>
  );
});

export function matches(q: string, ...fields: (string | undefined)[]): boolean {
  if (!q) return true;
  const s = q.toLowerCase();
  return fields.some((f) => f && f.toLowerCase().includes(s));
}
