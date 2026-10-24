// Wave D (boards, send/handoff/agents over the agent socket) + review-fix regressions, at the HTTP / socket boundary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import type { AgentSummary, FeedItem, ServerEvent, StateResponse } from '../../shared/contract.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TSX = path.join(ROOT, 'node_modules', '.bin', 'tsx');
const FAKE = path.join(ROOT, 'server', 'test', 'fake-agent.ts');
const TOKEN = 'test-token-waved';
const AUTH = { authorization: `Bearer ${TOKEN}` };
// short path: unix socket paths are limited to ~104 bytes on macOS
const DATA = mkdtempSync(path.join('/tmp', 'twd-'));
process.env.TOWER_DATA_DIR = DATA;
process.env.TOWER_TMUX = '0';
process.env.TOWER_CMD_DEVIN = `${TSX} ${FAKE} slow`;

const { AgentManager } = await import('../src/agents.js');
const { createServer } = await import('../src/http.js');
const { startAgentSocket } = await import('../src/agent-socket.js');
const { createRotation } = await import('../src/rotation.js');
const { getUpload } = await import('../src/uploads.js');
const { tmuxAllowed } = await import('../src/tmux-control.js');
import type { AccountsPort, PersistedAgent, StorePort } from '../src/ports.js';

const waitFor = async <T>(fn: () => T | undefined, ms = 15000, step = 50): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, step));
  }
};

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
    return { accountId: 'acc-1', env: {} };
  },
  start: () => {},
  stop: () => {},
};

type Mgr = InstanceType<typeof AgentManager>;
async function inProc(opts: { boardsFile?: string; notesFile?: string; before?: (m: Mgr) => void } = {}) {
  const manager = new AgentManager({
    workDir: mkdtempSync(path.join(tmpdir(), 'tower-wd-')),
    stuckMs: 60000,
    accounts: fakeAccounts,
    store: memStore(),
    notesFile: opts.notesFile,
    boardsFile: opts.boardsFile ?? path.join(mkdtempSync(path.join(tmpdir(), 'tower-b-')), 'boards.json'),
  });
  opts.before?.(manager);
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
  const del = (p: string) => fetch(`${base}${p}`, { method: 'DELETE', headers: AUTH });
  const get = async <T>(p: string) => (await (await fetch(`${base}${p}`, { headers: AUTH })).json()) as T;
  const launch = async (body: Record<string, unknown>) =>
    (await (await post('/api/agents', { kind: 'devin', ...body })).json()) as AgentSummary;
  const close = async () => {
    sock.close();
    manager.shutdown();
    await manager.stopAll();
    await new Promise((r) => server.close(() => r(undefined)));
  };
  return { manager, base, evs, last, post, del, get, launch, close };
}
type H = Awaited<ReturnType<typeof inProc>>;

const untilStatus = (h: H, id: string, st: string) => waitFor(() => (h.last(id)?.status === st ? h.last(id) : undefined));
const userTexts = (f: FeedItem[]) => f.filter((x) => x.type === 'user_message').map((x) => (x as { text: string }).text);
const statusTexts = (f: FeedItem[]) => f.filter((x) => x.type === 'status').map((x) => (x as { text: string }).text);

function runCli(args: string[], env: Record<string, string>): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const e: NodeJS.ProcessEnv = { ...process.env, ...env };
    execFile(process.execPath, [path.join(ROOT, 'cli', 'tower'), ...args], { env: e, timeout: 15000 }, (err, out, errOut) => {
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: String(out), err: String(errOut) });
    });
  });
}

test('wave D: tower send A->B arrives at B as "[From A] text" (queued if busy); unknown/self errors; tower agents lists', async () => {
  const h = await inProc();
  const sockPath = path.join(DATA, 's1.sock');
  const closeSock = startAgentSocket(h.manager, sockPath);
  try {
    const a = await h.launch({ task: 'alpha task', name: 'Alpha' });
    const b = await h.launch({ task: 'beta task', name: 'Beta' });
    await untilStatus(h, a.id, 'done');
    await untilStatus(h, b.id, 'done');
    const env = { TOWER_AGENT_ID: a.id, TOWER_SOCKET: sockPath };

    const ok = await runCli(['send', '--to', b.id, 'please review the diff'], env);
    assert.equal(ok.code, 0, ok.err);
    assert.match(ok.out, new RegExp(`Sent to ${b.id}`));
    const want = '[From Alpha] please review the diff';
    await waitFor(() =>
      h.manager.getFeed(b.id)!.some((x) => x.type === 'agent_message' && x.text === `echo:${want}`) ? true : undefined,
    );
    assert.ok(userTexts(h.manager.getFeed(b.id)!).includes(want));
    assert.ok(statusTexts(h.manager.getFeed(a.id)!).some((t) => t.startsWith('Sent to Beta')));
    assert.ok(statusTexts(h.manager.getFeed(b.id)!).includes('Message from Alpha'));

    // by exact name, while B is busy -> queued
    await untilStatus(h, b.id, 'done');
    await h.post(`/api/agents/${b.id}/prompt`, { text: 'keep busy' });
    await untilStatus(h, b.id, 'working');
    const byName = await runCli(['send', '--to', 'Beta', 'second'], env);
    assert.equal(byName.code, 0, byName.err);
    assert.match(byName.out, /queued/);
    await waitFor(() => (userTexts(h.manager.getFeed(b.id)!).includes('[From Alpha] second') ? true : undefined));

    const unknown = await runCli(['send', '--to', 'nobody', 'x'], env);
    assert.equal(unknown.code, 1);
    assert.match(unknown.err, /unknown agent "nobody"\. Live agents: .*Alpha.*Beta|unknown agent "nobody"\. Live agents: .*Beta.*Alpha/);
    const self = await runCli(['send', '--to', a.id, 'x'], env);
    assert.equal(self.code, 1);
    assert.match(self.err, /yourself/);
    const noTo = await runCli(['send', 'x'], env);
    assert.equal(noTo.code, 2);

    const list = await runCli(['agents'], env);
    assert.equal(list.code, 0, list.err);
    assert.match(list.out, /ID\s+NAME\s+BOARD\s+CUSTOMER\s+STATUS/);
    assert.match(list.out, new RegExp(`${a.id} \\(you\\)\\s+Alpha\\s+programs`));
    assert.match(list.out, new RegExp(`${b.id}\\s+Beta\\s+programs`));
    const help = await runCli(['help'], {});
    assert.match(help.out, /tower send --to/);
    assert.match(help.out, /tower handoff/);
    assert.match(help.out, /tower agents/);
  } finally {
    closeSock();
    await h.close();
  }
});

test('wave D: tower handoff opens a linked agent; its end_turn result is delivered back to the requester once', async () => {
  const h = await inProc();
  const sockPath = path.join(DATA, 's2.sock');
  const closeSock = startAgentSocket(h.manager, sockPath);
  try {
    const a = await h.launch({ task: 'lead task', name: 'Lead' });
    await untilStatus(h, a.id, 'done');
    const env = { TOWER_AGENT_ID: a.id, TOWER_SOCKET: sockPath };
    const bad = await runCli(['handoff', '--board', 'nope', 'x'], env);
    assert.equal(bad.code, 1);
    assert.match(bad.err, /unknown board "nope"/);

    const r = await runCli(['handoff', '--board', 'customers', 'write the tests'], env);
    assert.equal(r.code, 0, r.err);
    const m = r.out.match(/Handed off to (.+) \(([^)]+)\)/);
    assert.ok(m, r.out);
    const childId = m![2];
    const child = h.manager.getAgent(childId)!;
    assert.deepEqual(child.requestedBy, { agentId: a.id, name: 'Lead' });
    assert.equal(child.kind, 'devin'); // sender's kind
    assert.equal(child.board, 'customers');
    assert.equal(child.accountId, 'acc-1'); // Automatic
    assert.equal(h.manager.getAgent(a.id)!.handoffs?.[0]?.agentId, childId);

    const want = `[Handoff result from ${child.name}] echo:write the tests`;
    await waitFor(() => (userTexts(h.manager.getFeed(a.id)!).includes(want) ? true : undefined));
    // requester's handoffs are kept current
    await waitFor(() => (h.last(a.id)?.handoffs?.[0]?.status === 'done' ? true : undefined));
    assert.ok(statusTexts(h.manager.getFeed(childId)!).includes('Result sent to Lead'));
    await untilStatus(h, a.id, 'done');
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(userTexts(h.manager.getFeed(a.id)!).filter((t) => t === want).length, 1);
  } finally {
    closeSock();
    await h.close();
  }
});

test('wave D: boards CRUD, persisted 600, WS boards, launch onto customers, move card between boards', async () => {
  const boardsFile = path.join(mkdtempSync(path.join(tmpdir(), 'tower-bf-')), 'boards.json');
  const h = await inProc({ boardsFile });
  try {
    const st = await h.get<StateResponse>('/api/state');
    // routines board added for the owner's fleet (rutina-* sessions)
    assert.deepEqual(st.boards.map((b) => b.id), ['programs', 'customers', 'routines']);
    assert.deepEqual(
      st.boards[1].columns.map((c) => [c.name, c.statuses]),
      [
        ['Handling', ['starting', 'working', 'needs_you', 'stuck']],
        ['Waiting on the customer', ['done']],
        ['Asleep', ['stopped', 'error', 'observed']], // existing fleet sessions with no Forja state rest here
      ],
    );
    assert.equal((await h.post('/api/boards', {})).status, 400);
    const c = await h.post('/api/boards', { name: 'Ops Team' });
    assert.equal(c.status, 201);
    const ops = (await c.json()) as { id: string; columns: unknown[] };
    assert.equal(ops.id, 'ops-team');
    assert.deepEqual(ops.columns, st.boards[0].columns);
    await waitFor(() => (h.evs.some((e) => e.type === 'boards' && e.boards.some((b) => b.id === 'ops-team')) ? true : undefined));
    assert.equal((await h.post('/api/boards', { name: 'ops team' })).status, 409);
    assert.equal((await h.post('/api/boards', { name: 'Programs' })).status, 409);
    assert.equal((await h.post('/api/boards', { name: 'X', columns: [{ name: 'A', statuses: ['bogus'] }] })).status, 400);
    assert.equal(statSync(boardsFile).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(boardsFile, 'utf8')).map((b: { id: string }) => b.id), ['ops-team']);

    assert.equal((await h.post('/api/agents', { kind: 'devin', task: 't', board: 'nope' })).status, 400);
    assert.equal((await h.post('/api/agents', { kind: 'devin', task: 't', customer: 'bad/name' })).status, 400);
    assert.equal((await h.post('/api/agents', { kind: 'devin', task: 't', customer: 'x'.repeat(65) })).status, 400);
    const plain = await h.launch({ task: 'plain' });
    assert.equal(plain.board, 'programs');
    const cust = await h.launch({ task: 'help acme', board: 'customers', customer: 'cust-acme' });
    assert.equal(cust.board, 'customers');
    assert.equal(cust.customer, 'cust-acme');

    assert.equal((await h.post(`/api/agents/${plain.id}/board`, { board: 'nope' })).status, 400);
    assert.equal((await h.post(`/api/agents/missing/board`, { board: 'ops-team' })).status, 404);
    assert.equal((await h.post(`/api/agents/${plain.id}/board`, { board: 'ops-team', customer: 'Ops 1' })).status, 200);
    await waitFor(() => (h.last(plain.id)?.board === 'ops-team' && h.last(plain.id)?.customer === 'Ops 1' ? true : undefined));
    assert.equal((await h.del('/api/boards/ops-team')).status, 409); // not empty
    assert.equal((await h.del('/api/boards/customers')).status, 409); // default
    assert.equal((await h.del('/api/boards/programs')).status, 409);
    assert.equal((await h.del('/api/boards/zzz')).status, 404);
    assert.equal((await h.post(`/api/agents/${plain.id}/board`, { board: 'programs', customer: '' })).status, 200);
    await waitFor(() => (h.last(plain.id)?.board === 'programs' && h.last(plain.id)?.customer === undefined ? true : undefined));
    // board persisted with the agent
    h.manager.saveNow();
    assert.equal((await h.del('/api/boards/ops-team')).status, 200);
    await waitFor(() => (h.evs.some((e) => e.type === 'boards' && !e.boards.some((b) => b.id === 'ops-team')) ? true : undefined));
    await h.post('/api/boards', { name: 'Kept' });
  } finally {
    await h.close();
  }
  const h2 = await inProc({ boardsFile });
  try {
    const st = await h2.get<StateResponse>('/api/state');
    assert.deepEqual(st.boards.map((b) => b.id), ['programs', 'customers', 'routines', 'kept']);
  } finally {
    await h2.close();
  }
});

test('review fixes: answer on a stopped agent is 409 and keeps the question; task cap 8000; move seed truncated', async () => {
  const h = await inProc();
  try {
    assert.equal((await h.post('/api/agents', { kind: 'devin', task: 'x'.repeat(8001) })).status, 400);
    const a = await h.launch({ task: 'y'.repeat(7990) });
    await untilStatus(h, a.id, 'done');
    const q = h.manager.ask(a.id, 'Which DB?') as { ok: true; questionId: string };
    await h.post(`/api/agents/${a.id}/stop`);
    await untilStatus(h, a.id, 'stopped');
    const r = await h.post(`/api/agents/${a.id}/answer`, { questionId: q.questionId, text: 'pg' });
    assert.equal(r.status, 409);
    assert.equal(h.manager.getAgent(a.id)!.questions?.length, 1, 'question must survive a refused answer');

    const mv = await h.post(`/api/agents/${a.id}/move`, { accountId: 'acc-1' });
    assert.equal(mv.status, 201);
    const b = (await mv.json()) as AgentSummary;
    assert.ok(b.task.length <= 8000, `seed is ${b.task.length} chars`);
    assert.ok(b.task.startsWith('Continue this task on a fresh session.'));
  } finally {
    await h.close();
  }
});

test('review fixes: tmux ghosts emit agent_removed (vanish + probe failure); observed feed is []; allowlist', async () => {
  const h = await inProc();
  const prevI = process.env.TOWER_TMUX_INTERACTIVE;
  const prevA = process.env.TOWER_TMUX_ALLOW;
  try {
    process.env.TOWER_TMUX_INTERACTIVE = '1';
    delete process.env.TOWER_TMUX_ALLOW;
    assert.equal(tmuxAllowed('work'), false);
    process.env.TOWER_TMUX_ALLOW = 'dev-*, other';
    assert.equal(tmuxAllowed('dev-1'), true);
    assert.equal(tmuxAllowed('work'), false);
    delete process.env.TOWER_TMUX_INTERACTIVE;
    assert.equal(tmuxAllowed('dev-1'), false);
    process.env.TOWER_TMUX_INTERACTIVE = '1';

    await h.manager.pollTmuxWith('dev-1\t%1\tclaude\t1\t100\tclaude\nwork\t%2\tcodex\t2\t100\tcodex\n');
    const st = await h.get<StateResponse>('/api/state');
    const tm = st.agents.filter((x) => x.source === 'tmux');
    assert.equal(tm.length, 2);
    const dev = tm.find((x) => x.kind === 'claude')!;
    const work = tm.find((x) => x.kind === 'codex')!;
    assert.equal(dev.interactive, true);
    assert.equal(work.interactive, false);
    const feed = await fetch(`${h.base}/api/agents/${dev.id}/feed`, { headers: AUTH });
    assert.equal(feed.status, 200);
    assert.deepEqual(await feed.json(), []);

    await h.manager.pollTmuxWith('dev-1\t%1\tclaude\t1\t100\tclaude\n');
    await waitFor(() => (h.evs.some((e) => e.type === 'agent_removed' && e.agentId === work.id) ? true : undefined));
    await h.manager.pollTmuxWith(null);
    await waitFor(() => (h.evs.some((e) => e.type === 'agent_removed' && e.agentId === dev.id) ? true : undefined));
    const st2 = await h.get<StateResponse>('/api/state');
    assert.equal(st2.agents.filter((x) => x.source === 'tmux').length, 0);
  } finally {
    if (prevI === undefined) delete process.env.TOWER_TMUX_INTERACTIVE;
    else process.env.TOWER_TMUX_INTERACTIVE = prevI;
    if (prevA === undefined) delete process.env.TOWER_TMUX_ALLOW;
    else process.env.TOWER_TMUX_ALLOW = prevA;
    await h.close();
  }
});

test('review fixes: note start 409 when archived and when two starts race; upload bytes deleted after attach', async () => {
  const notesFile = path.join(mkdtempSync(path.join(tmpdir(), 'tower-n-')), 'notes.json');
  const h = await inProc({ notesFile });
  try {
    const n = (await (await h.post('/api/notes', { title: 'race me' })).json()) as { id: string };
    const [r1, r2] = await Promise.all([
      h.post(`/api/notes/${n.id}/start`, { kind: 'devin' }),
      h.post(`/api/notes/${n.id}/start`, { kind: 'devin' }),
    ]);
    assert.deepEqual([r1.status, r2.status].sort(), [201, 409]);
    assert.equal((await h.post(`/api/notes/${n.id}/start`, { kind: 'devin' })).status, 409);
    const towerAgents = (await h.get<StateResponse>('/api/state')).agents.filter((x) => x.task === 'race me');
    assert.equal(towerAgents.length, 1);

    const a = towerAgents[0];
    await untilStatus(h, a.id, 'done');
    const up = await fetch(`${h.base}/api/uploads?name=f.txt`, { method: 'POST', headers: AUTH, body: 'bytes' });
    const { id: upId } = (await up.json()) as { id: string };
    const stored = getUpload(upId)!.path;
    assert.ok(existsSync(stored));
    assert.equal((await h.post(`/api/agents/${a.id}/prompt`, { text: 'see', attachments: [upId] })).status, 202);
    assert.equal(readFileSync(path.join(a.cwd, 'attachments', 'f.txt'), 'utf8'), 'bytes');
    assert.equal(existsSync(stored), false);
    assert.equal(existsSync(`${stored}.json`), false);
    assert.equal(getUpload(upId), undefined);
  } finally {
    await h.close();
  }
});

test('review fix: rotation changes reach WS clients from server start, before any HTTP request', async () => {
  const rot = createRotation(fakeAccounts, { file: path.join(mkdtempSync(path.join(tmpdir(), 'tower-r-')), 'rotation.json') });
  const h = await inProc({ before: (m) => rot.attach(m as never) });
  try {
    rot.setAutoRotate(false);
    const ev = await waitFor(() => h.evs.find((e) => e.type === 'rotation'));
    assert.equal((ev as { rotation: { autoRotate: boolean } }).rotation.autoRotate, false);
  } finally {
    rot.close();
    await h.close();
  }
});
