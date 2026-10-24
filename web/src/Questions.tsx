import { useMemo, useState } from 'react';
import type { AgentSummary, Question } from '../../shared/contract';
import { api } from './api';
import { openAgent, patchAgentLocal, toast, useStore } from './store';
import { KindBadge } from './ui';
import './questions.css';

async function sendAnswer(a: AgentSummary, q: Question, text: string): Promise<boolean> {
  const prev = a.questions ?? [];
  patchAgentLocal(a.id, { questions: prev.filter((x) => x.id !== q.id) });
  try {
    await api.answer(a.id, q.id, text);
    return true;
  } catch (e) {
    patchAgentLocal(a.id, { questions: prev });
    toast(`Could not answer: ${(e as Error).message}`);
    return false;
  }
}

/** Question text + recommendation + answer box. Used by the inbox and the agent panel. */
export function QuestionCard({ a, q, showAgent }: { a: AgentSummary; q: Question; showAgent?: boolean }) {
  const [text, setText] = useState('');
  const send = () => {
    const t = text.trim();
    if (!t) return;
    setText('');
    void sendAnswer(a, q, t).then((ok) => !ok && setText(t));
  };
  return (
    <div className="q-row" data-question={q.id}>
      <div className="q-line">
        {showAgent && (
          <>
            <KindBadge kind={a.kind} />
            <button className="q-agent" onClick={() => openAgent(a.id)}>
              {a.name}
            </button>
          </>
        )}
        <span className="q-tag">Question</span>
      </div>
      <div className="q-text">{q.text}</div>
      {q.recommendation && (
        <div className="q-rec">
          <span className="q-rec-text">
            <span className="q-rec-label">Recommended:</span> {q.recommendation}
          </span>
          <button className="q-use" onClick={() => setText(q.recommendation!)}>
            Use recommendation
          </button>
        </div>
      )}
      <div className="q-answer">
        <textarea
          className="q-input"
          rows={1}
          value={text}
          placeholder="Type your answer"
          aria-label={`Answer to: ${q.text}`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button className="btn btn-primary btn-sm q-send" disabled={!text.trim()} onClick={send}>
          Answer
        </button>
      </div>
    </div>
  );
}

/** One row per open question across all agents. */
export function QuestionsInbox() {
  const agents = useStore((s) => s.agents);
  const rows = useMemo(
    () =>
      Object.values(agents)
        .filter((a) => !a.archived)
        .flatMap((a) => (a.questions ?? []).map((q) => ({ a, q })))
        .sort((x, y) => x.q.createdAt - y.q.createdAt),
    [agents],
  );
  if (rows.length === 0) return null;
  return (
    <section className="qinbox" aria-label="Questions">
      <div className="qinbox-head">
        <span className="qinbox-title">Questions</span>
        <span className="count-badge">{rows.length}</span>
      </div>
      {rows.map(({ a, q }) => (
        <QuestionCard key={q.id} a={a} q={q} showAgent />
      ))}
    </section>
  );
}

/** Open questions of one agent, shown in its panel above the composer. */
export function PanelQuestions({ a }: { a: AgentSummary }) {
  const qs = a.questions ?? [];
  if (qs.length === 0) return null;
  return (
    <div className="panel-questions">
      {qs.map((q) => (
        <QuestionCard key={q.id} a={a} q={q} />
      ))}
    </div>
  );
}
