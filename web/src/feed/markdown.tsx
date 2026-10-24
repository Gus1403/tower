// Tiny safe Markdown renderer: builds React elements only (no innerHTML).
import type { ReactNode } from 'react';

const SAFE_URL = /^(https?:|mailto:)/i;

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  // order matters: code, link, bold, italic
  const re = /(`[^`\n]+`)|(\[[^\]\n]+\]\([^)\s]+\))|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*|_[^_\n]+_)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}-${n++}`;
    const t = m[0];
    if (m[1]) out.push(<code key={k} className="md-code">{t.slice(1, -1)}</code>);
    else if (m[2]) {
      const mm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(t)!;
      const href = mm[2];
      out.push(
        SAFE_URL.test(href) ? (
          <a key={k} href={href} target="_blank" rel="noopener noreferrer">
            {mm[1]}
          </a>
        ) : (
          mm[1]
        ),
      );
    } else if (m[3]) out.push(<strong key={k}>{inline(t.slice(2, -2), k)}</strong>);
    else out.push(<em key={k}>{inline(t.slice(1, -1), k)}</em>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let b = 0;
  while (i < lines.length) {
    const line = lines[i];
    const key = `b${b++}`;
    if (/^```/.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
      i++;
      blocks.push(
        <pre key={key} className="md-pre">
          <code>{body.join('\n')}</code>
        </pre>,
      );
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      blocks.push(<div key={key} className="md-h">{inline(h[2], key)}</div>);
      i++;
      continue;
    }
    const ul = /^\s*[-*]\s+/;
    const ol = /^\s*\d+[.)]\s+/;
    if (ul.test(line) || ol.test(line)) {
      const ordered = ol.test(line);
      const re = ordered ? ol : ul;
      const items: ReactNode[] = [];
      while (i < lines.length && re.test(lines[i])) {
        items.push(<li key={`${key}-${items.length}`}>{inline(lines[i].replace(re, ''), `${key}-${items.length}`)}</li>);
        i++;
      }
      blocks.push(ordered ? <ol key={key} className="md-list">{items}</ol> : <ul key={key} className="md-list">{items}</ul>);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^```/.test(lines[i]) && !ul.test(lines[i]) && !ol.test(lines[i]) && !/^#{1,4}\s/.test(lines[i]))
      para.push(lines[i++]);
    const kids: ReactNode[] = [];
    para.forEach((p, j) => {
      if (j) kids.push(<br key={`${key}-br${j}`} />);
      kids.push(...inline(p, `${key}-${j}`));
    });
    blocks.push(<p key={key} className="md-p">{kids}</p>);
  }
  return <div className="md">{blocks}</div>;
}
