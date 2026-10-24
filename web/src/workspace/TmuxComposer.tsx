import { useEffect, useRef, useState } from 'react';
import type { AgentSummary } from '../../../shared/contract';
import { tmuxApi, type TmuxKey } from '../board/api-extra';
import { toast } from '../store';
import { getDraft, restoreDraft, setDraft } from './drafts';

const KEYS: { key: TmuxKey; label: string; aria: string }[] = [
  { key: 'Escape', label: 'Esc', aria: 'Escape' },
  { key: 'Enter', label: 'Enter', aria: 'Enter' },
  { key: 'Up', label: '↑', aria: 'Up arrow' },
  { key: 'Down', label: '↓', aria: 'Down arrow' },
  { key: 'Tab', label: 'Tab', aria: 'Tab' },
  { key: 'C-c', label: 'Ctrl-C', aria: 'Control C' },
];

const trustKey = (id: string) => `tower.tmux.trust.${id}`;
const trusted = (id: string) => {
  try {
    return localStorage.getItem(trustKey(id)) === '1';
  } catch {
    return false;
  }
};

type Pending = { kind: 'send'; text: string } | { kind: 'key'; key: TmuxKey };

/**
 * Types into a live tmux session. Every send and key goes through the existing guard (confirm unless the owner
 * trusted this card). Mounted once per session, so the confirmation never carries over to another session.
 */
export function TmuxComposer({ a, showKeys, onSent }: { a: AgentSummary; showKeys: boolean; onSent: () => void }) {
  const [text, setText] = useState(() => getDraft(a.id));
  const [confirm, setConfirm] = useState<Pending | null>(null);
  const [dontAsk, setDontAsk] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const busy = useRef(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  if (!a.interactive) {
    return (
      <div className="ws-foot-note" role="note">
        Read-only session. Tower can show what it reports but cannot type into it.
      </div>
    );
  }

  const change = (t: string) => {
    setText(t);
    setDraft(a.id, t);
    if (error) setError(null);
  };

  const run = async (p: Pending) => {
    if (busy.current) return;
    busy.current = true;
    setSending(true);
    setError(null);
    try {
      if (p.kind === 'send') {
        await tmuxApi.send(a.id, p.text);
        if (getDraft(a.id) === p.text) setDraft(a.id, '');
        if (mounted.current) setText((cur) => (cur === p.text ? '' : cur));
      } else await tmuxApi.key(a.id, p.key);
      if (mounted.current) onSent();
    } catch (e) {
      const msg = (e as Error).message || 'Request failed';
      if (p.kind === 'send') restoreDraft(a.id, p.text);
      if (mounted.current) setError(p.kind === 'send' ? `Not sent: ${msg}` : `Could not send ${p.key}: ${msg}`);
      else toast(`Could not send to ${a.name}: ${msg}`);
    } finally {
      busy.current = false;
      if (mounted.current) setSending(false);
    }
  };

  const request = (p: Pending) => {
    if (busy.current) return;
    if (trusted(a.id)) void run(p);
    else {
      setDontAsk(false);
      setConfirm(p);
    }
  };

  const send = () => {
    const t = text.trim();
    if (!t || sending) return;
    request({ kind: 'send', text: t });
  };

  const accept = () => {
    if (!confirm) return;
    if (dontAsk) {
      try {
        localStorage.setItem(trustKey(a.id), '1');
      } catch {
        /* ignore */
      }
    }
    const c = confirm;
    setConfirm(null);
    void run(c);
    requestAnimationFrame(() => taRef.current?.focus());
  };

  return (
    <div className="ws-foot-inner">
      {showKeys && (
        <div className="tmux-keys ws-keys" role="group" aria-label="Keys">
          {KEYS.map((k) => (
            <button key={k.key} className="tmux-key" aria-label={k.aria} disabled={sending || !!confirm} onClick={() => request({ kind: 'key', key: k.key })}>
              {k.label}
            </button>
          ))}
        </div>
      )}
      {confirm ? (
        <div
          className="tmux-confirm"
          role="alertdialog"
          aria-label="Confirm send"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              setConfirm(null);
            }
          }}
        >
          <div className="tmux-confirm-text">
            This types into a live session. Send?
            <code>{confirm.kind === 'send' ? confirm.text : confirm.key}</code>
          </div>
          <label className="tmux-dontask">
            <input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} /> Don’t ask again for this card
          </label>
          <div className="tmux-confirm-actions">
            <button className="btn btn-secondary btn-sm" onClick={() => setConfirm(null)}>
              Cancel
            </button>
            <button className="btn btn-primary btn-sm" onClick={accept} autoFocus>
              Send
            </button>
          </div>
        </div>
      ) : (
        <div className="composer c-box tmux-composer">
          <textarea
            ref={taRef}
            className="tmux-input"
            value={text}
            rows={2}
            placeholder="Type into the session…"
            aria-label="Send to session"
            onChange={(e) => change(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div className="c-tools">
            <span className="c-hint">Enter sends · Shift+Enter new line</span>
            <span className="spacer" />
            <button className="btn btn-primary c-send" disabled={!text.trim() || sending} onClick={send} aria-busy={sending}>
              {sending ? 'Sending…' : 'Send'}
            </button>
          </div>
        </div>
      )}
      {error && (
        <div className="ws-send-err" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
