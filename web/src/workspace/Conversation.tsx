import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { FeedItem } from '../../../shared/contract';
import { dedupeStatus, FeedRow } from '../feed/FeedRow';

const NEAR_BOTTOM = 80;

export interface ConversationProps {
  items: FeedItem[];
  loading: boolean;
  /** shown instead of the list (error, unavailable history); the list is never faked from other data */
  notice?: ReactNode;
  empty?: ReactNode;
  hasMore?: boolean;
  loadingOlder?: boolean;
  olderError?: string;
  onLoadOlder?: () => void;
  /** trailing row such as "Working…" */
  tail?: ReactNode;
  label: string;
}

export function Conversation({ items, loading, notice, empty, hasMore, loadingOlder, olderError, onLoadOlder, tail, label }: ConversationProps) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const anchor = useRef<{ height: number; top: number; first?: string } | null>(null);
  const [away, setAway] = useState(false);
  const rows = dedupeStatus(items);
  const first = rows[0]?.id;
  const last = rows[rows.length - 1];

  const older = () => {
    const el = ref.current;
    if (!el || !onLoadOlder || loadingOlder) return;
    anchor.current = { height: el.scrollHeight, top: el.scrollTop, first };
    onLoadOlder();
  };

  // keep the reader's place when older items are prepended; follow new items only when already near the bottom
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const a = anchor.current;
    if (a && first !== a.first) {
      el.scrollTop = a.top + (el.scrollHeight - a.height);
      anchor.current = null;
      return;
    }
    if (stick.current) el.scrollTop = el.scrollHeight;
  }, [first, last?.id, last, rows.length, loading, tail]);

  useLayoutEffect(() => {
    if (!loadingOlder && anchor.current && anchor.current.first === first) anchor.current = null;
  }, [loadingOlder, first]);

  return (
    <div className="ws-convo-wrap">
      <div
        className="feed ws-convo"
        ref={ref}
        role="log"
        aria-label={label}
        aria-busy={loading}
        tabIndex={0}
        onScroll={(e) => {
          const el = e.currentTarget;
          const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM;
          stick.current = near;
          if (away === near) setAway(!near);
          if (el.scrollTop < 60 && hasMore && !loadingOlder && !olderError) older();
        }}
      >
        <div className="ws-col">
          {notice ? (
            notice
          ) : loading ? (
            <div className="skeleton" aria-label="Loading conversation">
              <div className="sk sk-r" />
              <div className="sk w80" />
              <div className="sk w60" />
              <div className="sk w70" />
              <div className="sk w40" />
            </div>
          ) : (
            <>
              {hasMore && (
                <div className="ws-older">
                  {olderError ? (
                    <span className="ws-older-err" role="alert">
                      Could not load earlier messages: {olderError}{' '}
                      <button className="ws-linkbtn" onClick={older}>
                        Try again
                      </button>
                    </span>
                  ) : (
                    <button className="btn btn-secondary btn-sm ws-older-btn" onClick={older} disabled={loadingOlder}>
                      {loadingOlder ? 'Loading earlier messages…' : 'Load earlier messages'}
                    </button>
                  )}
                </div>
              )}
              {rows.length === 0 ? (empty ?? <p className="ws-empty">No messages yet.</p>) : rows.map((it) => <FeedRow key={it.id} item={it} />)}
              {tail}
            </>
          )}
        </div>
      </div>
      {away && !notice && !loading && (
        <button
          className="ws-jump"
          onClick={() => {
            const el = ref.current;
            if (el) el.scrollTop = el.scrollHeight;
            stick.current = true;
            setAway(false);
          }}
        >
          Jump to latest ↓
        </button>
      )}
    </div>
  );
}
