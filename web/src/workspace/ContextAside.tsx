import type { ReactNode } from 'react';
import type { AgentSummary, SessionWorkspace } from '../../../shared/contract';
import { PanelLinks } from '../boards/Handoffs';
import { useAccounts, useNow } from '../store';
import { ago, KIND_LABEL } from '../ui';

const SAFE_URL = /^https?:\/\//i;

function Section({ title, children, className = '' }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={`ws-sec ${className}`}>
      <h2 className="ws-sec-title">{title}</h2>
      {children}
    </section>
  );
}

function SafeLink({ url, children }: { url: string; children: ReactNode }) {
  return SAFE_URL.test(url) ? (
    <a className="ws-link" href={url} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ) : (
    <span className="ws-link-off" title={url}>
      {children}
    </span>
  );
}

function when(at: string, now: number): string {
  const t = Date.parse(at);
  return Number.isFinite(t) ? `${ago(Math.max(0, now - t))} ago` : at;
}

function Details({ a }: { a: AgentSummary }) {
  const now = useNow();
  const accounts = useAccounts();
  const account = accounts.find((x) => x.id === a.accountId);
  const pct = a.usage && a.usage.size > 0 ? Math.min(100, Math.round((a.usage.used / a.usage.size) * 100)) : null;
  const rows: [string, ReactNode][] = [
    ['Folder', <code title={a.cwd}>{a.cwd}</code>],
    ['Agent', KIND_LABEL[a.kind]],
  ];
  if (a.model) rows.push(['Model', a.model]);
  if (a.source === 'tower' && account) rows.push(['Account', account.label]);
  if (a.source === 'tmux') rows.push(['Control', a.interactive ? 'Interactive terminal' : 'Read-only']);
  if (pct !== null) rows.push(['Context', `${pct}% used`]);
  if (a.source === 'tower') rows.push(['Tool calls', String(a.toolCalls)]);
  rows.push(['Last activity', `${ago(now - a.lastActivityAt)} ago`]);
  return (
    <Section title="Details">
      <dl className="ws-dl">
        {rows.map(([k, v]) => (
          <div key={k} className="ws-dl-row">
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <PanelLinks agent={a} />
    </Section>
  );
}

/** Context for a live ACP agent, built from what the agent itself reports. */
export function AcpContext({ a }: { a: AgentSummary }) {
  const done = a.plan?.filter((p) => p.status === 'completed').length ?? 0;
  const pending = [
    ...(a.pendingPermission ? [{ key: a.pendingPermission.requestId, text: `Permission: ${a.pendingPermission.title}`, rec: undefined as string | undefined }] : []),
    ...(a.questions ?? []).map((q) => ({ key: q.id, text: q.text, rec: q.recommendation })),
  ];
  return (
    <>
      <Section title="Task">
        <p className="ws-sum">{a.task}</p>
        {a.lastMessage && a.lastMessage !== a.task && (
          <p className="ws-sum ws-latest">
            <span className="ws-k">Latest</span> {a.lastMessage}
          </p>
        )}
      </Section>
      {pending.length > 0 && (
        <Section title="Pending decisions" className="ws-sec-pending">
          <ul className="ws-pending">
            {pending.map((p) => (
              <li key={p.key}>
                <span>{p.text}</span>
                {p.rec && <span className="ws-rec">Recommended: {p.rec}</span>}
              </li>
            ))}
          </ul>
          <p className="ws-hint">Answer from the conversation.</p>
        </Section>
      )}
      {a.plan && a.plan.length > 0 && (
        <Section title="Plan">
          <div className="plan ws-plan">
            <div className="plan-head">
              <span className="muted">
                {done}/{a.plan.length} done
              </span>
            </div>
            <ul>
              {a.plan.map((p, i) => (
                <li key={i} className={`plan-${p.status}`}>
                  <span className="pbox">{p.status === 'completed' ? '✓' : ''}</span>
                  {p.content}
                </li>
              ))}
            </ul>
          </div>
        </Section>
      )}
      <Details a={a} />
    </>
  );
}

/** Context reported for an observed session. Only real data; otherwise the card's own summary. */
export function SessionContext({ a, ctx, status, error }: { a: AgentSummary; ctx: SessionWorkspace['context']; status: 'loading' | 'ready' | 'error'; error?: string }) {
  const now = useNow();
  const pending = ctx.pending ?? [];
  const links = ctx.links ?? [];
  const summary = ctx.summary || a.lastMessage;
  return (
    <>
      <Section title="Summary">
        {status === 'loading' ? (
          <div className="skeleton" aria-label="Loading context">
            <div className="sk w80" />
            <div className="sk w60" />
          </div>
        ) : summary ? (
          <p className="ws-sum">{summary}</p>
        ) : (
          <p className="ws-hint">This session has not reported a summary.</p>
        )}
        {status === 'error' && <p className="ws-hint ws-hint-err">Context unavailable: {error}</p>}
      </Section>
      {pending.length > 0 && (
        <Section title="Pending decisions" className="ws-sec-pending">
          <ul className="ws-pending">
            {pending.map((p, i) => (
              <li key={i}>
                <span>{p.text}</span>
                {p.recommendation && <span className="ws-rec">Recommended: {p.recommendation}</span>}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {ctx.delivery && (
        <Section title="Latest delivery">
          <p className="ws-sum">{ctx.delivery.text}</p>
          <p className="ws-meta">
            {ctx.delivery.url && <SafeLink url={ctx.delivery.url}>Open</SafeLink>}
            {ctx.delivery.url && ctx.delivery.at && ' · '}
            {ctx.delivery.at && <span>{when(ctx.delivery.at, now)}</span>}
          </p>
        </Section>
      )}
      {links.length > 0 && (
        <Section title="Links">
          <ul className="ws-links">
            {links.map((l, i) => (
              <li key={`${i}-${l.url}`}>
                <SafeLink url={l.url}>{l.title || l.url}</SafeLink>
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Details a={a} />
    </>
  );
}
