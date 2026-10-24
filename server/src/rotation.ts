// Wave C: account rotation. Wraps an AccountsPort with per-account status (ok | exhausted | excluded | logged_out),
// persists exhausted/excluded/autoRotate/activity to <data dir>/rotation.json (mode 600, tmp + rename), and on a
// usage-limit banner marks the agent's account exhausted and (autoRotate) moves the agent to the next ok account.
// Limit-banner and reset-clock rules follow the owner's earlier tool (subswitch): only "You've hit/reached your …
// limit" (straight or curly apostrophe) or Codex's usage_limit_reached authorize rotation; 429 / "rate limit" /
// network errors never do (they still set limitHit so the owner can move by hand).
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Account, ActivityEntry, AgentKind, AgentSummary, RotationState, ServerEvent } from '../../shared/contract.js';
import type { AccountsPort, LaunchEnv } from './ports.js';
import { towerDataDir } from './agents.js';

const ACTIVITY_MAX = 200;
const MAX_MOVES = 3; // an agent lineage is auto-moved at most this many times
const DEFAULT_RESET_MS = 60 * 60 * 1000;
const MAX_TIMER_MS = 2 ** 31 - 1;

// A provider usage-limit banner. Lines mentioning 429 / rate limit / transport errors are not banners.
const BANNER_RE = /you(?:'|’)ve\s+(?:hit|reached)\s+your\s+[^\n]{0,60}?limit|usage[_ ]limit[_ ](?:reached|exceeded)/i;
const NOT_BANNER_LINE_RE = /HTTP\s*429|rate[ -]?limit|transport|network|timed?\s+out|timeout|DNS/i;

export function isLimitBanner(text: string): boolean {
  return text.split(/\r?\n/).some((line) => BANNER_RE.test(line) && !NOT_BANNER_LINE_RE.test(line));
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const UNIT_MS: Record<string, number> = { d: 86400000, h: 3600000, m: 60000, s: 1000 };

// Parses the reset moment out of a limit message. Returns undefined when nothing parseable is present.
// Accepted: ISO timestamps; "try again in 2h 13m" / "in 4 days 23 hours 35 minutes"; "resets 13:41", "resets at 5pm",
// "resets 9:20pm (Europe/Berlin)" (zone ignored: local clock), "resets 13:41 on Oct 30", "try again at 3:41 PM".
// An unqualified clock means its next occurrence; a month/day in the past (> 1 day) rolls to next year.
export function parseResetAt(text: string, now = Date.now()): number | undefined {
  const iso = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)/.exec(text);
  if (iso) {
    const t = Date.parse(iso[1]!);
    if (Number.isFinite(t)) return t;
  }
  const rel = /\b(?:try again|resets?|available(?: again)?)\s+in\s+((?:\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b[\s,]*(?:and\s+)?)+)/i.exec(
    text,
  );
  if (rel) {
    let ms = 0;
    for (const m of rel[1]!.matchAll(/(\d+)\s*([a-z]+)/gi)) ms += Number(m[1]) * (UNIT_MS[m[2]![0]!.toLowerCase()] ?? 0);
    if (ms > 0) return now + ms;
  }
  const clock =
    /\b(?:resets?|try again)\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?(?:\s*(am|pm))?(?:\s*\([^)]*\))?(?:\s+on\s+([A-Za-z]{3,9})\.?\s+(\d{1,2}))?/i.exec(
      text,
    );
  if (clock && (clock[2] !== undefined || clock[3] !== undefined)) {
    let h = Number(clock[1]);
    const min = clock[2] !== undefined ? Number(clock[2]) : 0;
    const ap = clock[3]?.toLowerCase();
    if (ap) {
      if (h < 1 || h > 12) return undefined;
      if (ap === 'pm' && h !== 12) h += 12;
      if (ap === 'am' && h === 12) h = 0;
    }
    if (h > 23 || min > 59) return undefined;
    const d = new Date(now);
    d.setSeconds(0, 0);
    d.setHours(h, min);
    if (clock[4]) {
      const mi = MONTHS.indexOf(clock[4].slice(0, 3).toLowerCase());
      if (mi < 0) return undefined;
      d.setMonth(mi, Number(clock[5]));
      if (d.getTime() < now - 86400000) d.setFullYear(d.getFullYear() + 1);
      return d.getTime();
    }
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  return undefined;
}

const hhmm = (t: number) => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const kindLabel = (k: AgentKind) => k[0]!.toUpperCase() + k.slice(1);

// Narrow view of AgentManager used by rotation (avoids a runtime import cycle).
export interface RotationManager {
  getAgent(id: string): AgentSummary | undefined;
  move(agentId: string, accountId: string): Promise<{ ok: true; agent: AgentSummary } | { ok: false; error: string }>;
  rotation?: unknown;
}

interface Persisted {
  autoRotate: boolean;
  activity: ActivityEntry[];
  exhausted: Record<string, number>;
  excluded: string[];
}

export interface Rotation extends AccountsPort {
  attach(manager: RotationManager): void;
  bindSend(send: (ev: ServerEvent) => void): void;
  onLimit(agentId: string, accountId: string | undefined, text: string): void;
  handleLimit(agentId: string, accountId: string | undefined, text: string): Promise<void>;
  state(): RotationState;
  clear(accountId: string): Account | undefined;
  setExcluded(accountId: string, excluded: boolean): Account | undefined;
  setAutoRotate(on: boolean): RotationState;
  markExhausted(accountId: string, resetAt: number): void;
  sweep(): void;
  close(): void;
}

export function createRotation(
  inner: AccountsPort,
  opts: { file?: string; now?: () => number } = {},
): Rotation {
  const file = opts.file ?? path.join(towerDataDir(), 'rotation.json');
  const now = opts.now ?? Date.now;
  let st: Persisted = { autoRotate: true, activity: [], exhausted: {}, excluded: [] };
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as Partial<Persisted>;
    st = {
      autoRotate: typeof j.autoRotate === 'boolean' ? j.autoRotate : true,
      activity: Array.isArray(j.activity) ? j.activity.slice(0, ACTIVITY_MAX) : [],
      exhausted: j.exhausted && typeof j.exhausted === 'object' ? j.exhausted : {},
      excluded: Array.isArray(j.excluded) ? j.excluded.filter((x) => typeof x === 'string') : [],
    };
  } catch {
    /* first run */
  }
  let manager: RotationManager | undefined;
  let send: ((ev: ServerEvent) => void) | undefined;
  let accountsCb: ((a: Account[]) => void) | undefined;
  const timers = new Map<string, NodeJS.Timeout>();
  const inFlight = new Set<string>();
  let seq = 0;

  function persist() {
    try {
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(st), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, file);
    } catch (err) {
      console.error('[tower] rotation persist failed:', err);
    }
  }

  function log(e: Omit<ActivityEntry, 'id' | 'at'>) {
    st.activity.unshift({ id: `act-${now()}-${++seq}`, at: now(), ...e });
    if (st.activity.length > ACTIVITY_MAX) st.activity.length = ACTIVITY_MAX;
  }

  function decorate(list: Account[]): Account[] {
    const t = now();
    return list.map((a) => {
      const excluded = st.excluded.includes(a.id);
      const r = st.exhausted[a.id];
      const resetAt = r !== undefined && r > t ? r : undefined;
      const status: Account['status'] = excluded
        ? 'excluded'
        : resetAt !== undefined
          ? 'exhausted'
          : a.loggedIn === false
            ? 'logged_out'
            : 'ok';
      return { ...a, status, resetAt, excluded };
    });
  }

  function changed() {
    persist();
    const accounts = decorate(inner.list());
    if (send) {
      send({ type: 'accounts', accounts });
      send({ type: 'rotation', rotation: state() });
    } else accountsCb?.(accounts);
  }

  function state(): RotationState {
    return { autoRotate: st.autoRotate, activity: st.activity.slice() };
  }

  function labelOf(id: string) {
    return inner.list().find((a) => a.id === id)?.label ?? id;
  }

  // clears every exhausted entry whose resetAt passed; returns true when something changed
  function sweepQuiet(): boolean {
    const t = now();
    let any = false;
    for (const [id, r] of Object.entries(st.exhausted)) {
      if (r <= t) {
        delete st.exhausted[id];
        clearTimeout(timers.get(id));
        timers.delete(id);
        log({ kind: 'cleared', accountId: id, text: `${labelOf(id)} is back (limit reset)` });
        any = true;
      }
    }
    return any;
  }
  function sweep() {
    if (sweepQuiet()) changed();
  }

  function arm(id: string, resetAt: number) {
    clearTimeout(timers.get(id));
    const delay = Math.min(Math.max(resetAt - now(), 0) + 50, MAX_TIMER_MS);
    const t = setTimeout(() => {
      timers.delete(id);
      sweep();
      if (st.exhausted[id] !== undefined) arm(id, st.exhausted[id]!); // timer capped or clock skew: re-arm
    }, delay);
    t.unref?.();
    timers.set(id, t);
  }
  for (const [id, r] of Object.entries(st.exhausted)) arm(id, r);

  function list(): Account[] {
    if (sweepQuiet()) {
      persist();
      queueMicrotask(changed);
    }
    return decorate(inner.list());
  }

  // ok accounts of a kind, best first: logged in before unknown, lowest usedPct, fewest running, id
  function candidates(kind: AgentKind, except?: string): Account[] {
    return list()
      .filter((a) => a.kind === kind && a.status === 'ok' && a.id !== except)
      .sort(
        (x, y) =>
          Number(y.loggedIn === true) - Number(x.loggedIn === true) ||
          (x.usedPct ?? 50) - (y.usedPct ?? 50) ||
          x.running - y.running ||
          (x.id < y.id ? -1 : x.id > y.id ? 1 : 0),
      );
  }

  function markExhausted(accountId: string, resetAt: number) {
    st.exhausted[accountId] = resetAt;
    arm(accountId, resetAt);
  }

  function lineageDepth(agent: AgentSummary): number {
    let depth = 0;
    let cur: AgentSummary | undefined = agent;
    while (cur?.movedFrom && depth < 10) {
      depth++;
      cur = manager?.getAgent(cur.movedFrom.agentId);
    }
    return depth;
  }

  async function handleLimit(agentId: string, accountId: string | undefined, text: string) {
    if (!accountId || !isLimitBanner(text)) return;
    const acc = inner.list().find((a) => a.id === accountId);
    if (!acc) return;
    if (inFlight.has(agentId)) return;
    inFlight.add(agentId);
    try {
      const resetAt = parseResetAt(text, now()) ?? now() + DEFAULT_RESET_MS;
      markExhausted(accountId, resetAt);
      log({ kind: 'limit_hit', accountId, agentId, text: `${acc.label} hit its limit; resets ${hhmm(resetAt)}` });
      const agent = manager?.getAgent(agentId);
      if (!st.autoRotate || !manager || !agent || agent.source !== 'tower' || agent.status === 'stopped' || agent.archived) {
        changed();
        return;
      }
      if (lineageDepth(agent) >= MAX_MOVES) {
        changed();
        return;
      }
      const target = candidates(acc.kind, accountId)[0];
      if (!target) {
        const resets = Object.entries(st.exhausted)
          .filter(([id, r]) => r > now() && list().some((a) => a.id === id && a.kind === acc.kind))
          .map(([, r]) => r);
        const next = resets.length ? Math.min(...resets) : resetAt;
        log({
          kind: 'no_account',
          accountId,
          agentId,
          text: `All ${kindLabel(acc.kind)} accounts are at their limit; next resets ${hhmm(next)}`,
        });
        changed();
        return;
      }
      const res = await manager.move(agentId, target.id);
      if (res.ok) {
        log({
          kind: 'moved',
          accountId,
          toAccountId: target.id,
          agentId,
          newAgentId: res.agent.id,
          text: `Moved "${agent.name}" from ${acc.label} to ${target.label}`,
        });
      }
      changed();
    } finally {
      inFlight.delete(agentId);
    }
  }

  const rot: Rotation = {
    list,
    envFor(kind, accountId): LaunchEnv {
      if (accountId && accountId !== 'auto') return inner.envFor(kind, accountId);
      const best = candidates(kind)[0];
      if (best && best.loggedIn !== false) return inner.envFor(kind, best.id);
      return inner.envFor(kind, accountId); // nothing ok: keep the base behaviour
    },
    start(cb, count) {
      accountsCb = cb;
      inner.start((l) => {
        sweepQuiet();
        cb(decorate(l));
      }, count);
    },
    stop() {
      inner.stop();
    },
    attach(m) {
      manager = m;
      m.rotation = rot;
    },
    bindSend(s) {
      send = s;
    },
    onLimit(agentId, accountId, text) {
      handleLimit(agentId, accountId, text).catch((err) => console.error('[tower] rotation failed:', err));
    },
    handleLimit,
    state,
    clear(accountId) {
      if (!inner.list().some((a) => a.id === accountId)) return undefined;
      if (st.exhausted[accountId] !== undefined) {
        delete st.exhausted[accountId];
        clearTimeout(timers.get(accountId));
        timers.delete(accountId);
        log({ kind: 'cleared', accountId, text: `${labelOf(accountId)} cleared by the owner` });
        changed();
      }
      return list().find((a) => a.id === accountId);
    },
    setExcluded(accountId, excluded) {
      if (!inner.list().some((a) => a.id === accountId)) return undefined;
      const was = st.excluded.includes(accountId);
      if (was !== excluded) {
        st.excluded = excluded ? [...st.excluded, accountId] : st.excluded.filter((x) => x !== accountId);
        log({
          kind: excluded ? 'excluded' : 'included',
          accountId,
          text: `${labelOf(accountId)} ${excluded ? 'excluded from' : 'included in'} Automatic and auto-rotate`,
        });
        changed();
      }
      return list().find((a) => a.id === accountId);
    },
    setAutoRotate(on) {
      if (st.autoRotate !== on) {
        st.autoRotate = on;
        changed();
      }
      return state();
    },
    markExhausted(accountId, resetAt) {
      markExhausted(accountId, resetAt);
      changed();
    },
    sweep,
    close() {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
  };
  return rot;
}
