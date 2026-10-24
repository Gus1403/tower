// Wave D: links between sessions (requestedBy / handoffs) and the customer line on cards.
import type { AgentSummary } from '../../../shared/contract';
import { openAgent, useStore } from '../store';
import { StatusPill } from '../ui';
import './boards.css';

/** Inside the agent panel: "Requested by <name>" and the list of sessions this one opened. */
export function PanelLinks({ agent }: { agent: AgentSummary }) {
  const agents = useStore((s) => s.agents);
  const req = agent.requestedBy;
  const hs = agent.handoffs ?? [];
  if (!req && hs.length === 0 && !agent.customer) return null;
  return (
    <div className="wbd-links" data-testid="panel-links">
      {agent.customer && (
        <div className="wbd-links-row">
          <span className="wbd-links-k">Customer</span>
          <span className="wbd-links-v wbd-mono">{agent.customer}</span>
        </div>
      )}
      {req && (
        <div className="wbd-links-row">
          <span className="wbd-links-k">Requested by</span>
          <button className="wbd-link" onClick={() => openAgent(req.agentId)} disabled={!agents[req.agentId]}>
            {agents[req.agentId]?.name ?? req.name}
          </button>
        </div>
      )}
      {hs.length > 0 && (
        <div className="wbd-links-row wbd-links-col">
          <span className="wbd-links-k">Opened sessions</span>
          <ul className="wbd-hand-list">
            {hs.map((h) => {
              const live = agents[h.agentId];
              return (
                <li key={h.agentId}>
                  <button className="wbd-link" onClick={() => openAgent(h.agentId)} disabled={!live}>
                    {live?.name ?? h.name}
                  </button>
                  <StatusPill status={live?.status ?? h.status} />
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Muted first line on a customer card, e.g. "cust-acme". */
export function CardCustomer({ a }: { a: AgentSummary }) {
  if (!a.customer) return null;
  return <div className="wbd-cust">{a.customer}</div>;
}

/** Tiny "↳ for <requester>" line on a card opened by a handoff. */
export function CardRequestedBy({ a }: { a: AgentSummary }) {
  const name = useStore((s) => (a.requestedBy ? (s.agents[a.requestedBy.agentId]?.name ?? a.requestedBy.name) : ''));
  if (!a.requestedBy) return null;
  return (
    <button
      className="wbd-for"
      onClick={(e) => {
        e.stopPropagation();
        openAgent(a.requestedBy!.agentId);
      }}
    >
      ↳ for {name}
    </button>
  );
}
