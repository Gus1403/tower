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

test('prompt: 409 while working, 202 after done', async () => {
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
  assert.equal(busy.status, 409);

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
