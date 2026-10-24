import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import type { AgentSummary, FeedItem, ServerEvent, StateResponse } from '../../shared/contract.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TSX = path.join(ROOT, 'node_modules', '.bin', 'tsx');
const FAKE = path.join(ROOT, 'server', 'test', 'fake-agent.ts');
const PORT = 14747 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'test-token-abc';
const AUTH = { authorization: `Bearer ${TOKEN}` };

let serverProc: ChildProcess;
const events: ServerEvent[] = [];
let ws: WebSocket;

const waitFor = async <T>(fn: () => T | undefined, ms = 15000, step = 50): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, step));
  }
};

const lastSummary = (id: string): AgentSummary | undefined => {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type === 'agent' && ev.agent.id === id) return ev.agent;
    if (ev.type === 'snapshot') {
      const a = ev.state.agents.find((x) => x.id === id);
      if (a) return a;
    }
  }
  return undefined;
};

const feedOf = async (id: string): Promise<FeedItem[]> =>
  (await (await fetch(`${BASE}/api/agents/${id}/feed`, { headers: AUTH })).json()) as FeedItem[];

const launch = (kind: string, task = 'do stuff') =>
  fetch(`${BASE}/api/agents`, {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({ kind, task }),
  });

before(async () => {
  const workDir = mkdtempSync(path.join(tmpdir(), 'tower-test-'));
  serverProc = spawn(
    TSX,
    [path.join(ROOT, 'server', 'src', 'main.ts')],
    {
      env: {
        ...process.env,
        TOWER_TOKEN: TOKEN,
        TOWER_PORT: String(PORT),
        TOWER_HOST: '127.0.0.1',
        TOWER_WORK_DIR: workDir,
        TOWER_STUCK_MS: '2000',
        TOWER_CMD_DEVIN: `${TSX} ${FAKE} normal`,
        TOWER_CMD_CLAUDE: `${TSX} ${FAKE} silent`,
        TOWER_CMD_CODEX: `${TSX} ${FAKE} crash`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  serverProc.stderr!.on('data', (d) => process.stderr.write(`[server] ${d}`));
  await waitFor(() => {
    try {
      return (serverProc.stdout!.read() ?? '').toString().includes('listening') || undefined;
    } catch {
      return undefined;
    }
  });
  // fall back to polling the port
  await waitFor(async () => {
    try {
      const r = await fetch(`${BASE}/api/state`, { headers: AUTH });
      return r.ok ? true : undefined;
    } catch {
      return undefined;
    }
  });
  ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/ws?token=${TOKEN}`);
  ws.on('message', (d) => events.push(JSON.parse(d.toString())));
  await new Promise((res) => ws.once('open', res));
  await waitFor(() => (events.some((e) => e.type === 'snapshot') ? true : undefined));
});

after(async () => {
  ws?.close();
  serverProc?.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 500));
});

test('full lifecycle: launch -> working -> needs_you -> done with correct feed', async () => {
  const res = await launch('devin', 'write hello file');
  assert.equal(res.status, 201);
  const agent = (await res.json()) as AgentSummary;
  assert.equal(agent.kind, 'devin');
  assert.equal(agent.source, 'tower');

  const working = await waitFor(() => {
    const s = lastSummary(agent.id);
    return s && (s.status === 'working' || s.status === 'needs_you') ? s : undefined;
  });
  assert.ok(working);

  const needsYou = await waitFor(() => {
    const s = lastSummary(agent.id);
    return s?.status === 'needs_you' && s.pendingPermission ? s : undefined;
  });
  assert.equal(needsYou.pendingPermission!.title, 'Write file out.txt');
  assert.equal(needsYou.pendingPermission!.options[0].optionId, 'allow-1');

  const perm = await fetch(`${BASE}/api/agents/${agent.id}/permission`, {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({
      requestId: needsYou.pendingPermission!.requestId,
      optionId: 'allow-1',
    }),
  });
  assert.equal(perm.status, 200);

  const done = await waitFor(() => {
    const s = lastSummary(agent.id);
    return s?.status === 'done' ? s : undefined;
  });
  assert.equal(done.stopReason, 'end_turn');
  assert.ok(done.plan && done.plan.length === 2);
  assert.equal(done.toolCalls, 2);

  const feed = await feedOf(agent.id);
  const msgs = feed.filter((f) => f.type === 'agent_message');
  assert.equal(msgs.length, 2);
  assert.equal((msgs[0] as { text: string }).text, 'Working on it. Second half of message.');
  assert.equal((msgs[1] as { text: string }).text, 'All done after permission.');
  const tc1 = feed.find((f) => f.type === 'tool_call' && f.toolCallId === 'tc-1');
  assert.equal(tc1 && (tc1 as { status: string }).status, 'completed');
  const permItem = feed.find((f) => f.type === 'permission') as { resolution?: string } | undefined;
  assert.equal(permItem?.resolution, 'Allow once');
  assert.ok(feed.some((f) => f.type === 'status' && (f as { text: string }).text.includes('end_turn')));
});

test('auth: 401 without/with wrong token on HTTP and WS', async () => {
  assert.equal((await fetch(`${BASE}/api/state`)).status, 401);
  assert.equal(
    (await fetch(`${BASE}/api/state`, { headers: { authorization: 'Bearer wrong' } })).status,
    401,
  );
  assert.equal((await fetch(`${BASE}/api/state?token=${TOKEN}`)).status, 200);
  await assert.rejects(
    new Promise((res, rej) => {
      const bad = new WebSocket(`ws://127.0.0.1:${PORT}/api/ws`);
      bad.once('open', res);
      bad.once('unexpected-response', (_req, res2) =>
        (res2 as { statusCode?: number }).statusCode === 401 ? rej(new Error('401')) : rej(new Error('other')),
      );
      bad.once('error', rej);
    }),
    /401|error/i,
  );
  await new Promise((res, rej) => {
    const good = new WebSocket(`ws://127.0.0.1:${PORT}/api/ws?token=${TOKEN}`);
    good.once('open', () => {
      good.close();
      res(undefined);
    });
    good.once('error', rej);
  });
});

test('prompt: queued (202) while working, sent (202) after done', async () => {
  // silent agent stays in "working" forever
  const res = await launch('claude', 'silent task');
  const agent = (await res.json()) as AgentSummary;
  await waitFor(() => {
    const s = lastSummary(agent.id);
    return s?.status === 'working' ? s : undefined;
  });
  const busy = await fetch(`${BASE}/api/agents/${agent.id}/prompt`, {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'more' }),
  });
  assert.equal(busy.status, 202);
  assert.deepEqual(await busy.json(), { queued: true });
  await waitFor(() => (lastSummary(agent.id)?.queued.includes('more') ? true : undefined));

  const res2 = await launch('devin', 'finishing task');
  const a2 = (await res2.json()) as AgentSummary;
  const needsYou = await waitFor(() => {
    const s = lastSummary(a2.id);
    return s?.status === 'needs_you' && s.pendingPermission ? s : undefined;
  });
  await fetch(`${BASE}/api/agents/${a2.id}/permission`, {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: needsYou.pendingPermission!.requestId, optionId: 'allow-1' }),
  });
  await waitFor(() => {
    const s = lastSummary(a2.id);
    return s?.status === 'done' ? s : undefined;
  });
  const ok = await fetch(`${BASE}/api/agents/${a2.id}/prompt`, {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'another turn' }),
  });
  assert.equal(ok.status, 202);
  await waitFor(() => {
    const s = lastSummary(a2.id);
    return s?.status === 'needs_you' ? s : undefined;
  });
  // clean up: answer the new pending permission so it can finish
  const s2 = lastSummary(a2.id)!;
  await fetch(`${BASE}/api/agents/${a2.id}/permission`, {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: s2.pendingPermission!.requestId, optionId: 'allow-1' }),
  });
});

test('stuck: working agent with no events becomes stuck', async () => {
  const res = await launch('claude', 'very silent task');
  const agent = (await res.json()) as AgentSummary;
  await waitFor(() => {
    const s = lastSummary(agent.id);
    return s?.status === 'working' ? s : undefined;
  });
  const stuck = await waitFor(
    () => {
      const s = lastSummary(agent.id);
      return s?.status === 'stuck' ? s : undefined;
    },
    15000,
  );
  assert.equal(stuck.status, 'stuck');
});

test('stop: kills process and resolves pending permission as cancelled', async () => {
  const res = await launch('devin', 'task to stop');
  const agent = (await res.json()) as AgentSummary;
  const needsYou = await waitFor(() => {
    const s = lastSummary(agent.id);
    return s?.status === 'needs_you' && s.pendingPermission ? s : undefined;
  });
  const stop = await fetch(`${BASE}/api/agents/${agent.id}/stop`, { method: 'POST', headers: AUTH });
  assert.equal(stop.status, 200);
  const stopped = await waitFor(() => {
    const s = lastSummary(agent.id);
    return s?.status === 'stopped' ? s : undefined;
  });
  assert.equal(stopped.status, 'stopped');
  const feed = await feedOf(agent.id);
  const permItem = feed.find((f) => f.type === 'permission') as { resolution?: string } | undefined;
  assert.equal(permItem?.resolution, 'cancelled');
});

test('crash: agent process exiting -> error status with stderr', async () => {
  const res = await launch('codex', 'doomed task');
  const agent = (await res.json()) as AgentSummary;
  const err = await waitFor(() => {
    const s = lastSummary(agent.id);
    return s?.status === 'error' ? s : undefined;
  });
  assert.match(err.error ?? '', /exited|crashing on purpose/i);
});

test('stop during starting: stays stopped, never flips to error', async () => {
  const res = await launch('devin', 'stop me early');
  const agent = (await res.json()) as AgentSummary;
  const stop = await fetch(`${BASE}/api/agents/${agent.id}/stop`, { method: 'POST', headers: AUTH });
  assert.equal(stop.status, 200);
  // give the spawn/exit handlers time to (not) clobber the status
  await new Promise((r) => setTimeout(r, 1500));
  const s = lastSummary(agent.id);
  assert.equal(s?.status, 'stopped');
});

test('permission: unknown requestId -> 404', async () => {
  const res = await launch('devin', 'perm test');
  const agent = (await res.json()) as AgentSummary;
  await waitFor(() => {
    const s = lastSummary(agent.id);
    return s?.status === 'needs_you' && s.pendingPermission ? s : undefined;
  });
  const r = await fetch(`${BASE}/api/agents/${agent.id}/permission`, {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: 'no-such', optionId: 'allow-1' }),
  });
  assert.equal(r.status, 404);
  // clean up
  const s = lastSummary(agent.id)!;
  await fetch(`${BASE}/api/agents/${agent.id}/permission`, {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: s.pendingPermission!.requestId, optionId: 'allow-1' }),
  });
});

// ---- Wave A: in-process manager + HTTP server with an in-memory store and fake accounts ----
import { AgentManager } from '../src/agents.js';
import { createServer } from '../src/http.js';
import type { AccountsPort, PersistedAgent, StorePort } from '../src/ports.js';

const memStore = (): StorePort & { data: PersistedAgent[] } => {
  const st = {
    data: [] as PersistedAgent[],
    load: () => JSON.parse(JSON.stringify(st.data)) as PersistedAgent[],
    save: (a: PersistedAgent[]) => {
      st.data = JSON.parse(JSON.stringify(a));
    },
  };
  return st;
};
const fakeAccounts: AccountsPort = {
  list: () => [],
  envFor: (_k, id) => {
    if (id && id !== 'acc-1') throw new Error('unknown account');
    return { accountId: 'acc-1', env: { FAKE_ACCOUNT: '1' } };
  },
  start: () => {},
  stop: () => {},
};

async function inProc(store: StorePort) {
  process.env.TOWER_TMUX = '0';
  process.env.TOWER_CMD_DEVIN = `${TSX} ${FAKE} slow`;
  const manager = new AgentManager({
    workDir: mkdtempSync(path.join(tmpdir(), 'tower-w-')),
    stuckMs: 60000,
    accounts: fakeAccounts,
    store,
  });
  const server = createServer(manager, TOKEN);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const evs: ServerEvent[] = [];
  const sock = new WebSocket(`ws://127.0.0.1:${port}/api/ws?token=${TOKEN}`);
  sock.on('message', (d) => evs.push(JSON.parse(d.toString())));
  await new Promise((r) => sock.once('open', r));
  const last = (id: string) => {
    for (let i = evs.length - 1; i >= 0; i--) {
      const ev = evs[i];
      if (ev.type === 'agent' && ev.agent.id === id) return ev.agent;
    }
    return undefined;
  };
  const post = (p: string, body?: unknown) =>
    fetch(`${base}${p}`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const feed = async (id: string) =>
    (await (await fetch(`${base}/api/agents/${id}/feed`, { headers: AUTH })).json()) as FeedItem[];
  const close = async () => {
    sock.close();
    manager.shutdown();
    await manager.stopAll();
    await new Promise((r) => server.close(() => r(undefined)));
  };
  return { manager, base, evs, last, post, feed, close };
}

const untilStatus = (h: { last: (id: string) => AgentSummary | undefined }, id: string, st: string) =>
  waitFor(() => (h.last(id)?.status === st ? h.last(id) : undefined));

const userTexts = (f: FeedItem[]) =>
  f.filter((x) => x.type === 'user_message').map((x) => (x as { text: string }).text);

test('wave A: queue drains FIFO, interrupt runs next, mode/config, usage, tool output, account', async () => {
  const h = await inProc(memStore());
  try {
    const bad = await h.post('/api/agents', { kind: 'devin', task: 'x', accountId: 'nope' });
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: 'unknown account' });

    const r = await h.post('/api/agents', { kind: 'devin', task: 'first', accountId: 'acc-1' });
    assert.equal(r.status, 201);
    const a = (await r.json()) as AgentSummary;
    assert.equal(a.accountId, 'acc-1');
    await untilStatus(h, a.id, 'working');
    const q1 = await h.post(`/api/agents/${a.id}/prompt`, { text: 'second' });
    assert.equal(q1.status, 202);
    assert.deepEqual(await q1.json(), { queued: true });
    await h.post(`/api/agents/${a.id}/prompt`, { text: 'third' });
    assert.deepEqual(h.last(a.id)?.queued, ['second', 'third']);
    await waitFor(() => {
      const s = h.last(a.id);
      return s?.status === 'done' && s.queued.length === 0 && s.stopReason === 'end_turn' ? s : undefined;
    });
    // wait until the final turn (third) ended
    await waitFor(() => {
      const ends = h.evs.filter(
        (e) => e.type === 'feed' && e.agentId === a.id && e.item.type === 'status' && e.item.text.startsWith('Turn ended'),
      ).length;
      return ends >= 3 ? true : undefined;
    });
    assert.deepEqual(userTexts(await h.feed(a.id)), ['first', 'second', 'third']);

    // usage + tool output
    const s = h.last(a.id)!;
    assert.deepEqual(s.usage, { used: 1234, size: 200000 });
    const tool = (await h.feed(a.id)).find((x) => x.type === 'tool_call' && x.toolCallId === 't-first') as
      | { output?: string }
      | undefined;
    assert.match(tool?.output ?? '', /file-a/);

    // interrupt: queue an older item, then interrupt with new text -> new text runs next
    await h.post(`/api/agents/${a.id}/prompt`, { text: 'fourth' });
    await untilStatus(h, a.id, 'working');
    await h.post(`/api/agents/${a.id}/prompt`, { text: 'older' });
    const ir = await h.post(`/api/agents/${a.id}/prompt`, { text: 'urgent', interrupt: true });
    assert.equal(ir.status, 202);
    await waitFor(() => {
      const t = userTexts(h.manager.getFeed(a.id)!);
      return t.includes('older') ? t : undefined;
    });
    await untilStatus(h, a.id, 'done');
    await waitFor(() => (h.last(a.id)?.queued.length === 0 && h.last(a.id)?.status === 'done' ? true : undefined));
    const f = await h.feed(a.id);
    assert.deepEqual(userTexts(f).slice(3), ['fourth', 'urgent', 'older']);
    assert.ok(
      f.some((x) => x.type === 'status' && x.text === 'Turn ended: cancelled'),
      'fourth was cancelled',
    );

    // DELETE queue item
    await h.post(`/api/agents/${a.id}/prompt`, { text: 'q-a' });
    await untilStatus(h, a.id, 'working');
    await h.post(`/api/agents/${a.id}/prompt`, { text: 'q-b' });
    const dq = await fetch(`${h.base}/api/agents/${a.id}/queue/0`, { method: 'DELETE', headers: AUTH });
    assert.equal(dq.status, 200);
    assert.deepEqual(h.last(a.id)?.queued, []);
    await untilStatus(h, a.id, 'done');

    // controls
    assert.deepEqual(h.last(a.id)?.modes?.map((m) => m.id), ['default', 'plan']);
    assert.equal(h.last(a.id)?.mode, 'default');
    assert.equal((await h.post(`/api/agents/${a.id}/mode`, { modeId: 'nope' })).status, 400);
    assert.equal((await h.post(`/api/agents/${a.id}/mode`, { modeId: 'plan' })).status, 200);
    assert.equal(h.last(a.id)?.mode, 'plan');
    await waitFor(() =>
      h.manager.getFeed(a.id)!.some((x) => x.type === 'agent_message' && x.text === 'mode:plan') ? true : undefined,
    );
    assert.equal((await h.post(`/api/agents/${a.id}/config`, { configId: 'model', value: 'zz' })).status, 400);
    assert.equal((await h.post(`/api/agents/${a.id}/config`, { configId: 'bogus', value: 'm2' })).status, 400);
    assert.equal((await h.post(`/api/agents/${a.id}/config`, { configId: 'model', value: 'm2' })).status, 200);
    assert.equal(h.last(a.id)?.configOptions?.[0].currentValue, 'm2');

    // interrupt endpoint: cancels, process stays, back to done
    await h.post(`/api/agents/${a.id}/prompt`, { text: 'to-cancel' });
    await untilStatus(h, a.id, 'working');
    assert.equal((await h.post(`/api/agents/${a.id}/interrupt`)).status, 200);
    const d = await waitFor(() => {
      const x = h.last(a.id);
      return x?.status === 'done' && x.stopReason === 'cancelled' ? x : undefined;
    });
    assert.equal(d.status, 'done');
  } finally {
    await h.close();
  }
});

test('wave A: persistence -> stopped+resumable -> /resume loadSession -> done; DELETE broadcasts agent_removed', async () => {
  const store = memStore();
  const h1 = await inProc(store);
  let id: string;
  try {
    const a = (await (await h1.post('/api/agents', { kind: 'devin', task: 'persist me' })).json()) as AgentSummary;
    id = a.id;
    await untilStatus(h1, id, 'done');
    await waitFor(() => (store.data.some((p) => p.summary.id === id && p.summary.status === 'done') ? true : undefined), 5000);
    assert.ok(store.data.find((p) => p.summary.id === id)?.sessionId);
  } finally {
    h1.manager.shutdown();
    await h1.close();
  }
  const h2 = await inProc(store);
  try {
    const st = (await (await fetch(`${h2.base}/api/state`, { headers: AUTH })).json()) as StateResponse;
    const card = st.agents.find((x) => x.id === id)!;
    assert.equal(card.status, 'stopped');
    assert.equal(card.resumable, true);
    assert.deepEqual(st.accounts, []);
    assert.equal((await h2.post(`/api/agents/${id}/prompt`, { text: 'x' })).status, 409);
    assert.equal((await h2.post(`/api/agents/${id}/resume`)).status, 202);
    const done = await waitFor(() => {
      const s = h2.last(id);
      return s?.status === 'done' && s.mode === 'loaded' ? s : undefined;
    });
    assert.equal(done.resumable, false);
    const f = await h2.feed(id);
    assert.ok(userTexts(f).includes('persist me'), 'persisted feed kept');
    assert.ok(!f.some((x) => x.type === 'agent_message' && x.text === 'REPLAYED'), 'replay not duplicated');
    // resumed agent accepts a prompt
    assert.equal((await h2.post(`/api/agents/${id}/prompt`, { text: 'after resume' })).status, 202);
    await waitFor(() => (userTexts(h2.manager.getFeed(id)!).includes('after resume') ? true : undefined));

    const del = await fetch(`${h2.base}/api/agents/${id}`, { method: 'DELETE', headers: AUTH });
    assert.equal(del.status, 200);
    await waitFor(() => (h2.evs.some((e) => e.type === 'agent_removed' && e.agentId === id) ? true : undefined));
    assert.equal((await fetch(`${h2.base}/api/agents/${id}/feed`, { headers: AUTH })).status, 404);
    h2.manager.saveNow();
    assert.ok(!store.data.some((p) => p.summary.id === id));
  } finally {
    await h2.close();
  }
});
