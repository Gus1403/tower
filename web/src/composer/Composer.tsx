import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AgentSummary } from '../../../shared/contract';
import { api, type Upload } from '../api';
import { patchAgentLocal, toast } from '../store';
import { getDraft, restoreDraft, setDraft } from '../workspace/drafts';
import './composer.css';

type Att = { key: string; name: string; size: number; id?: string; failed?: boolean };

// ---------- dictation ----------
type Rec = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  start(): void;
  stop(): void;
};
function speechCtor(): (new () => Rec) | null {
  if (typeof window === 'undefined' || !window.isSecureContext) return null;
  const w = window as unknown as { SpeechRecognition?: new () => Rec; webkitSpeechRecognition?: new () => Rec };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function MicIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="5.5" y="1.5" width="5" height="8.5" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
function ClipIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M13 7.5l-5.3 5.3a3.2 3.2 0 0 1-4.5-4.5l5.6-5.6a2.1 2.1 0 0 1 3 3L6.2 11.3a1 1 0 0 1-1.5-1.5L10 4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export function Composer({ a, toolbar }: { a: AgentSummary; toolbar?: ReactNode }) {
  const [text, setTextState] = useState(() => getDraft(a.id));
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const mounted = useRef(true);
  const idRef = useRef(a.id);
  idRef.current = a.id;
  // every edit is kept as this session's draft, so switching sessions never loses or mixes text
  const setText = (v: string | ((t: string) => string)) =>
    setTextState((t) => {
      const next = typeof v === 'function' ? v(t) : v;
      setDraft(idRef.current, next);
      return next;
    });
  const [atts, setAtts] = useState<Att[]>([]);
  const [drag, setDrag] = useState(false);
  const [menuIdx, setMenuIdx] = useState(0);
  const [menuClosed, setMenuClosed] = useState(false);
  const [listening, setListening] = useState(false);
  const recRef = useRef<Rec | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const Speech = useMemo(speechCtor, []);

  const busy = a.status === 'working' || a.status === 'needs_you' || a.status === 'starting';
  const readOnly = a.source === 'tmux' || a.status === 'observed';
  const dead = a.status === 'stopped' || a.status === 'error';
  const disabled = readOnly || dead;
  const reason = readOnly
    ? 'Read-only session'
    : a.status === 'error'
      ? 'This agent hit an error'
      : a.status === 'stopped'
        ? a.resumable
          ? 'Stopped — Resume to continue'
          : 'Stopped'
        : null;
  const asking = a.status === 'needs_you' && (!!a.pendingPermission || (a.questions ?? []).length > 0);
  const hint = reason ?? (asking ? 'Answer above, or reply…' : busy ? 'Queue a follow-up…' : 'Reply…');
  const queued = a.queued ?? [];
  const uploading = atts.some((x) => !x.id && !x.failed);
  const ready = atts.filter((x) => x.id);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      recRef.current?.stop();
    };
  }, []);
  const shownId = useRef(a.id);
  useEffect(() => {
    if (shownId.current === a.id) return;
    shownId.current = a.id;
    setTextState(getDraft(a.id));
    setAtts([]);
  }, [a.id]);

  // ---------- "/" menu ----------
  const slash = /^\/(\S*)$/.exec(text);
  const cmds = useMemo(() => {
    if (!slash) return [];
    const f = slash[1].toLowerCase();
    return (a.commands ?? []).filter((c) => c.name.toLowerCase().includes(f)).slice(0, 8);
  }, [slash?.[1], a.commands]); // eslint-disable-line react-hooks/exhaustive-deps
  const menuOpen = !!slash && !menuClosed && cmds.length > 0 && !disabled;
  useEffect(() => setMenuIdx(0), [slash?.[1]]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!slash) setMenuClosed(false);
  }, [!!slash]); // eslint-disable-line react-hooks/exhaustive-deps
  const pick = (name: string) => {
    setText(`/${name} `);
    requestAnimationFrame(() => taRef.current?.focus());
  };

  // ---------- attachments ----------
  const addFiles = (files: FileList | File[] | null) => {
    if (!files || disabled) return;
    for (const f of Array.from(files)) {
      const key = `${Date.now()}-${Math.random()}`;
      const name = f.name || `pasted-${Date.now()}.png`;
      const file = f.name ? f : new File([f], name, { type: f.type });
      setAtts((xs) => [...xs, { key, name, size: f.size }]);
      api
        .upload(file)
        .then((u: Upload) => setAtts((xs) => xs.map((x) => (x.key === key ? { ...x, id: u.id, name: u.name, size: u.size } : x))))
        .catch((e: Error) => {
          setAtts((xs) => xs.map((x) => (x.key === key ? { ...x, failed: true } : x)));
          toast(`Could not upload ${name}: ${e.message}`);
        });
    }
  };

  // ---------- dictation ----------
  const toggleMic = () => {
    if (!Speech) return;
    if (listening) {
      recRef.current?.stop();
      return;
    }
    const rec = new Speech();
    rec.lang = navigator.language || 'en-US';
    rec.continuous = true;
    rec.interimResults = false;
    rec.onresult = (e) => {
      let said = '';
      for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) said += e.results[i][0].transcript;
      said = said.trim();
      if (said) setText((t) => (t && !/\s$/.test(t) ? `${t} ${said}` : t + said));
    };
    rec.onend = () => {
      setListening(false);
      recRef.current = null;
    };
    rec.onerror = (e) => {
      if (e.error !== 'no-speech' && e.error !== 'aborted') toast(`Dictation: ${e.error}`);
    };
    recRef.current = rec;
    try {
      rec.start();
      setListening(true);
    } catch (err) {
      toast(`Dictation unavailable: ${(err as Error).message}`);
    }
  };

  const send = async (interrupt: boolean) => {
    const t = text.trim();
    if ((!t && ready.length === 0) || disabled || uploading || sendingRef.current) return;
    const id = a.id;
    const sentAtts = atts;
    const ids = ready.map((x) => x.id!);
    sendingRef.current = true;
    setSending(true);
    setText('');
    setAtts([]);
    recRef.current?.stop();
    const label = t || ready.map((x) => x.name).join(', ');
    if (busy) patchAgentLocal(id, { queued: interrupt ? [label, ...queued] : [...queued, label] });
    try {
      await api.prompt(id, t, interrupt || undefined, ids.length ? ids : undefined);
    } catch (e) {
      // a late failure goes back to the session it was meant for, never into whichever session is open now
      restoreDraft(id, t);
      if (mounted.current && idRef.current === id) {
        setTextState(getDraft(id));
        setAtts((xs) => (xs.length ? xs : sentAtts));
      }
      patchAgentLocal(id, { queued });
      toast(`Could not send${idRef.current === id ? '' : ` to ${a.name}`}: ${(e as Error).message}`);
    } finally {
      sendingRef.current = false;
      if (mounted.current) setSending(false);
    }
  };

  if (a.status === 'stopped' && a.resumable && !readOnly) {
    return (
      <div className="composer composer-resume">
        <span className="muted">{reason}</span>
        <button className="btn btn-primary btn-sm" onClick={() => api.resume(a.id).catch((e: Error) => toast(`Could not resume: ${e.message}`))}>
          Resume
        </button>
      </div>
    );
  }
  const canSend = !disabled && !uploading && !sending && (!!text.trim() || ready.length > 0);
  return (
    <div
      className={`composer-wrap ${drag ? 'c-drag' : ''}`}
      onDragOver={(e) => {
        if (disabled || !e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrag(false);
      }}
      onDrop={(e) => {
        if (disabled) return;
        e.preventDefault();
        setDrag(false);
        addFiles(e.dataTransfer.files);
      }}
    >
      {queued.length > 0 && (
        <div className="queue" aria-label="Queued prompts">
          <span className="queue-label">Queued</span>
          {queued.map((q, i) => (
            <span className="qchip" key={`${i}-${q}`} title={q}>
              <span className="qchip-text">{q}</span>
              <button
                className="qchip-x"
                aria-label="Remove queued prompt"
                onClick={() => {
                  patchAgentLocal(a.id, { queued: queued.filter((_, j) => j !== i) });
                  api.removeQueued(a.id, i).catch((e: Error) => {
                    patchAgentLocal(a.id, { queued });
                    toast(`Could not remove: ${e.message}`);
                  });
                }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      {atts.length > 0 && (
        <div className="att-row" aria-label="Attachments">
          {atts.map((x) => (
            <span key={x.key} className={`att-chip ${x.id ? 'ok' : x.failed ? 'failed' : 'loading'}`} title={x.name}>
              {!x.id && !x.failed && <span className="att-spin" />}
              <span className="att-name">{x.name}</span>
              <span className="att-size">{x.failed ? 'failed' : fmtSize(x.size)}</span>
              <button className="att-x" aria-label={`Remove ${x.name}`} onClick={() => setAtts((xs) => xs.filter((y) => y.key !== x.key))}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="composer c-box">
        {menuOpen && (
          <div className="slash-menu" role="listbox" aria-label="Commands">
            {cmds.map((c, i) => (
              <button
                key={c.name}
                role="option"
                aria-selected={i === menuIdx}
                className={`slash-item ${i === menuIdx ? 'on' : ''}`}
                onMouseEnter={() => setMenuIdx(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(c.name);
                }}
              >
                <span className="slash-name">/{c.name}</span>
                {c.description && <span className="slash-desc">{c.description}</span>}
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={taRef}
          value={text}
          disabled={disabled}
          placeholder={listening ? 'Listening…' : hint}
          rows={2}
          aria-label={`Message ${a.name}`}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.items)
              .filter((it) => it.kind === 'file')
              .map((it) => it.getAsFile())
              .filter((f): f is File => !!f);
            if (files.length) {
              e.preventDefault();
              addFiles(files);
            }
          }}
          onKeyDown={(e) => {
            if (menuOpen) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const d = e.key === 'ArrowDown' ? 1 : -1;
                setMenuIdx((i) => (i + d + cmds.length) % cmds.length);
                return;
              }
              if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
                e.preventDefault();
                pick(cmds[menuIdx]?.name ?? cmds[0].name);
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setMenuClosed(true);
                return;
              }
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
              e.preventDefault();
              void send(busy && (e.metaKey || e.ctrlKey));
            }
          }}
        />
        <div className="c-tools">
          {!disabled && (
            <>
              <button className="c-icon c-attach" aria-label="Attach files" title="Attach files" onClick={() => fileRef.current?.click()}>
                <ClipIcon />
              </button>
              <input
                ref={fileRef}
                type="file"
                multiple
                hidden
                className="c-file"
                onChange={(e) => {
                  addFiles(e.target.files);
                  e.target.value = '';
                }}
              />
            </>
          )}
          {Speech && !disabled && (
            <button
              className={`c-icon c-mic ${listening ? 'on' : ''}`}
              aria-label={listening ? 'Stop dictation' : 'Dictate'}
              aria-pressed={listening}
              title={listening ? 'Stop dictation' : 'Dictate'}
              onClick={toggleMic}
            >
              <MicIcon />
            </button>
          )}
          {toolbar}
          <span className="spacer" />
          {!disabled && <span className="c-hint">{busy ? 'Enter queues · ⌘Enter interrupts' : 'Enter sends · Shift+Enter new line'}</span>}
          {busy && !disabled ? (
            <button className="btn btn-primary c-queue c-send" disabled={!canSend} onClick={() => void send(false)} title="Enter queues · ⌘Enter interrupts & sends" aria-busy={sending}>
              Queue
            </button>
          ) : (
            <button className="btn btn-primary send c-send" disabled={!canSend} onClick={() => void send(false)} aria-label="Send" aria-busy={sending}>
              {sending ? 'Sending…' : 'Send'}
            </button>
          )}
        </div>
      </div>
      {drag && <div className="c-dropzone">Drop files to attach</div>}
    </div>
  );
}
