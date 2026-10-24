import { useEffect, useRef, useState } from 'react';
import type { AgentKind, Note } from '../../shared/contract';
import { notesApi } from './board/api-extra';
import { openAgent, toast, useAccounts, useStore } from './store';
import { KIND_LABEL } from './ui';
import './notes.css';

const KINDS: AgentKind[] = ['claude', 'codex', 'devin'];

function NoteEditor({
  initial,
  onSave,
  onCancel,
  saveLabel,
}: {
  initial?: { title: string; body: string };
  onSave: (title: string, body: string) => void;
  onCancel: () => void;
  saveLabel: string;
}) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [body, setBody] = useState(initial?.body ?? '');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const save = () => title.trim() && onSave(title.trim(), body.trim());
  return (
    <div
      className="note note-edit"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onCancel();
        }
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save();
      }}
    >
      <input
        ref={ref}
        className="note-title-in"
        placeholder="Title"
        aria-label="Note title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && !e.metaKey && !e.ctrlKey && (e.preventDefault(), save())}
      />
      <textarea className="note-body-in" placeholder="Details (optional)" aria-label="Note body" rows={3} value={body} onChange={(e) => setBody(e.target.value)} />
      <div className="note-edit-foot">
        <button className="btn btn-secondary btn-sm" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn btn-primary btn-sm" disabled={!title.trim()} onClick={save}>
          {saveLabel}
        </button>
      </div>
    </div>
  );
}

export function NoteCard({ n, focused, onStart }: { n: Note; focused: boolean; onStart: (n: Note) => void }) {
  const [editing, setEditing] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [menu, setMenu] = useState(false);
  if (editing)
    return (
      <NoteEditor
        initial={n}
        saveLabel="Save"
        onCancel={() => setEditing(false)}
        onSave={(title, body) => {
          setEditing(false);
          notesApi.update(n.id, { title, body }).catch((e) => toast(`Could not save: ${(e as Error).message}`));
        }}
      />
    );
  return (
    <div
      className={`note ${focused ? 'kfocus' : ''}`}
      data-note-id={n.id}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('application/x-tower-note', n.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
    >
      <button className="note-main" onClick={() => setEditing(true)} title="Edit">
        <span className="note-title">{n.title}</span>
        {n.body && <span className="note-body">{n.body}</span>}
      </button>
      {confirmDel ? (
        <div className="note-actions note-confirm">
          <span>Delete this note?</span>
          <button className="btn btn-secondary btn-sm" onClick={() => setConfirmDel(false)}>
            Keep
          </button>
          <button
            className="btn btn-sm note-danger"
            onClick={() => notesApi.remove(n.id).catch((e) => toast(`Could not delete: ${(e as Error).message}`))}
          >
            Delete
          </button>
        </div>
      ) : (
        <div className="note-actions">
          <button className="btn btn-primary btn-sm note-start" onClick={() => onStart(n)}>
            Start
          </button>
          <span className="spacer" />
          <button className="note-act note-more" aria-label="More" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((v) => !v)}>
            ⋯
          </button>
          {menu && (
            <div className="note-menu" role="menu">
              <button role="menuitem" className="note-act" onClick={() => notesApi.update(n.id, { archived: true }).catch((e) => toast((e as Error).message))}>
                Archive
              </button>
              <button role="menuitem" className="note-act note-act-danger" onClick={() => setConfirmDel(true)}>
                Delete
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function NotesColumn({
  notes,
  focusId,
  onStart,
  className,
}: {
  notes: Note[];
  focusId: string | null;
  onStart: (n: Note) => void;
  className?: string;
}) {
  const [adding, setAdding] = useState(false);
  return (
    <section className={`col col-notes ${className ?? ''}`} aria-label="To do">
      <div className="col-head">
        <span className="col-dot dot-notes" />
        To do
        <span className="col-count">{notes.length}</span>
        <span className="spacer" />
        <button className="note-add" onClick={() => setAdding(true)} aria-label="Add note">
          + Note
        </button>
      </div>
      <div className="col-body">
        {adding && (
          <NoteEditor
            saveLabel="Add"
            onCancel={() => setAdding(false)}
            onSave={(title, body) => {
              setAdding(false);
              notesApi.create(title, body).catch((e) => toast(`Could not add note: ${(e as Error).message}`));
            }}
          />
        )}
        {notes.map((n) => (
          <NoteCard key={n.id} n={n} focused={focusId === `note:${n.id}`} onStart={onStart} />
        ))}
      </div>
    </section>
  );
}

export function StartNoteDialog({ note, onClose }: { note: Note; onClose: () => void }) {
  const capacity = useStore((s) => s.capacity);
  const accounts = useAccounts();
  const avail = (k: AgentKind) => capacity.find((c) => c.kind === k)?.available ?? true;
  const [kind, setKind] = useState<AgentKind>(KINDS.find(avail) ?? 'claude');
  const [account, setAccount] = useState('auto');
  const [busy, setBusy] = useState(false);
  const mine = accounts.filter((a) => a.kind === kind);
  useEffect(() => setAccount('auto'), [kind]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  const start = async () => {
    setBusy(true);
    try {
      const a = await notesApi.start(note, kind, account);
      onClose();
      openAgent(a.id);
    } catch (e) {
      toast(`Could not start: ${(e as Error).message}`);
      setBusy(false);
    }
  };
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog start-dialog" role="dialog" aria-label="Start note">
        <div className="dialog-head">
          <h2>Start “{note.title}”</h2>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="segmented" role="radiogroup" aria-label="Agent">
          {KINDS.map((k) => (
            <button key={k} role="radio" aria-checked={kind === k} className={kind === k ? 'on' : ''} disabled={!avail(k)} onClick={() => setKind(k)}>
              <span className={`cap-dot kind-dot-${k}`} />
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>
        <label className="field">
          Account
          <select className="start-acct" value={account} onChange={(e) => setAccount(e.target.value)}>
            <option value="auto">Automatic</option>
            {mine.map((a) => (
              <option key={a.id} value={a.id} disabled={a.loggedIn === false}>
                {a.label}
                {a.loggedIn === false ? ' (logged out)' : ''}
              </option>
            ))}
          </select>
        </label>
        {note.body && <div className="start-preview">{note.body}</div>}
        <div className="dialog-foot">
          <span className="spacer" />
          <button className="btn btn-primary start-go" disabled={busy} onClick={start}>
            {busy ? 'Starting…' : 'Start agent'}
          </button>
        </div>
      </div>
    </div>
  );
}
