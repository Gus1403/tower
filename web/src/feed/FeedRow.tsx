// Feed rows shared by every session conversation (ACP live feed and observed session history).
import { memo, useState } from 'react';
import type { FeedItem } from '../../../shared/contract';
import { Markdown } from './markdown';

function ToolStatusIcon({ status }: { status: string }) {
  if (status === 'completed')
    return (
      <svg className="ti ti-ok" width="14" height="14" viewBox="0 0 16 16" aria-label="completed">
        <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  if (status === 'failed')
    return (
      <svg className="ti ti-fail" width="14" height="14" viewBox="0 0 16 16" aria-label="failed">
        <path d="M4.5 4.5l7 7m0-7l-7 7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  if (status === 'in_progress') return <span className="ti ti-spin" aria-label="in progress" />;
  return <span className="ti ti-pending" aria-label="pending" />;
}

function Thought({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <button className={`f-thought ${open ? 'open' : ''}`} onClick={() => setOpen((o) => !o)}>
      <span className="caret">{open ? '▾' : '▸'}</span>
      <span className="f-thought-text">{open ? text : 'Thinking'}</span>
    </button>
  );
}

// Presentation only: pull a short, human detail (command / path / pattern) out of a raw tool detail.
function shortDetail(detail?: string): { cmd?: string; text?: string } {
  if (!detail) return {};
  const t = detail.trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      const j = JSON.parse(t) as Record<string, unknown>;
      const pick = (...ks: string[]) => {
        for (const k of ks) {
          const v = j && typeof j === 'object' ? (j as Record<string, unknown>)[k] : undefined;
          if (typeof v === 'string' && v) return v;
          if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v.join(' ');
        }
        return undefined;
      };
      const cmd = pick('command', 'cmd');
      if (cmd) return { cmd };
      const text = pick('file_path', 'path', 'filePath', 'pattern', 'query', 'url', 'description');
      return text ? { text } : {};
    } catch {
      return {};
    }
  }
  return { text: t.split('\n')[0] };
}

function ToolRow({ item }: { item: Extract<FeedItem, { type: 'tool_call' }> }) {
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState(false);
  const d = shortDetail(item.detail);
  const sameAsTitle = d.cmd && item.title.includes(d.cmd);
  if (d.text) {
    // drop a detail that only repeats the title (e.g. the same path), keep what's new ("+6 −1")
    const first = d.text.split(/\s+/)[0];
    if (item.title.includes(d.text)) d.text = undefined;
    else if (first && item.title.includes(first)) d.text = d.text.slice(first.length).trim() || undefined;
  }
  return (
    <div className={`f-toolwrap ${open ? 'open' : ''}`}>
      <button className={`f-tool f-tool-${item.status}`} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <ToolStatusIcon status={item.status} />
        {d.cmd && !sameAsTitle ? (
          <span className="f-tool-title">
            Ran <code className="f-tool-cmd">{d.cmd}</code>
          </span>
        ) : (
          <span className="f-tool-title">{item.title}</span>
        )}
        {d.text && d.text !== item.title && <span className="f-tool-detail">{d.text}</span>}
        {item.toolKind && <span className="f-tool-kind">{item.toolKind}</span>}
      </button>
      {open && (
        <div className="f-tool-out">
          <pre>{item.output || (item.status === 'completed' || item.status === 'failed' ? 'No output' : 'Running…')}</pre>
          {item.detail && (
            <button className="f-tool-raw-btn" aria-expanded={raw} onClick={() => setRaw((r) => !r)}>
              {raw ? 'Hide raw' : 'Raw'}
            </button>
          )}
          {raw && item.detail && <pre className="f-tool-out-detail">{item.detail}</pre>}
        </div>
      )}
    </div>
  );
}

export const FeedRow = memo(function FeedRow({ item }: { item: FeedItem }) {
  switch (item.type) {
    case 'user_message':
      return (
        <div className="f-user">
          <div className="bubble">{item.text}</div>
        </div>
      );
    case 'agent_message':
      return (
        <div className="f-agent">
          <Markdown text={item.text} />
        </div>
      );
    case 'thought':
      return <Thought text={item.text} />;
    case 'tool_call':
      return <ToolRow item={item} />;
    case 'permission':
      return (
        <div className={`f-perm ${item.resolution ? 'resolved' : ''}`}>
          <span className="f-perm-icon">{item.resolution ? '✓' : '!'}</span>
          <span className="f-perm-title">{item.title}</span>
          <span className="f-perm-res">{item.resolution ?? 'Waiting for you'}</span>
        </div>
      );
    case 'status':
      return <div className="f-status">{humanStatus(item.text)}</div>;
  }
});

// Presentation only: lifecycle jargon -> plain words.
function humanStatus(t: string): string {
  const s = t.trim();
  const low = s.toLowerCase();
  if (/^turn ended:?\s*(end_turn)?$/.test(low) || low === 'end_turn') return 'Finished';
  if (/^turn ended:\s*cancell?ed$/.test(low) || low === 'cancelled' || low === 'canceled') return 'Interrupted';
  if (/^turn ended:\s*max_tokens$/.test(low)) return 'Stopped: output limit reached';
  if (/^turn ended:\s*refusal$/.test(low)) return 'The agent declined';
  if (/^turn ended:\s*max_turn_requests$/.test(low)) return 'Stopped: turn limit reached';
  if (/^turn ended\b/.test(low)) return 'Finished';
  if (!s || /^[\w.-]+:\s*[\w.-]*$/.test(s) && /_/.test(s)) return 'Status update';
  return s;
}

// Collapse consecutive identical (humanized) status lines.
export function dedupeStatus(items: FeedItem[]): FeedItem[] {
  const out: FeedItem[] = [];
  let last: string | null = null;
  for (const it of items) {
    if (it.type === 'status') {
      const h = humanStatus(it.text);
      if (h === last) continue;
      last = h;
    } else last = null;
    out.push(it);
  }
  return out;
}
