// Wave C: account rotation over the real HTTP + WS boundary, with the fake ACP agent in "limit" mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import type { Account, AgentSummary, RotationState, ServerEvent, StateResponse } from '../../shared/contract.js';
import { AgentManager } from '../src/agents.js';
import { createServer } from '../src/http.js';
import type { AccountsPort } from '../src/ports.js';
import { createRotation, isLimitBanner, parseResetAt, type Rotation } from '../src/rotation.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TSX = path.join(ROOT, 'node_modules', '.bin', 'tsx');
const FAKE = path.join(ROOT, 'server', 'test', 'fake-agent.ts');
const TOKEN = 'rot-token';
const AUTH = { authorization: `Bearer ${TOKEN}` };
process.env.TOWER_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'tower-rot-data-'));
process.env.TOWER_TMUX = '0';
process.env.TOWER_CMD_DEVIN = `${TSX} ${FAKE} limit`;

const waitFor = async <T>(fn: () => T | undefined | Promise<T | undefined>, ms = 15000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
};

const mkAccounts = (ids: string[]): AccountsPort => {
  const base: Account[] = ids.map((id) => ({
    id,
    kind: 'devin',
    label: `Devin · ${id}`,
    loggedIn: true,
    running: 0,
    loginCommand: 'devin auth login',
  }));
  return {
    list: () => base.map((a) => ({ ...a })),
    envFor: (_k, id) => {
      const a = id && id !== 'auto' ? base.find((x) => x.id === id) : base[0];
      if (!a) throw new Error('unknown account');
      return { accountId: a.id, env: { FAKE_ACCOUNT: a.id } };
    },
    start: () => {},
    stop: () => {},
  };
};

async function setup(ids = ['acc-a', 'acc-b']) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'tower-rot-')), 'rotation.json');
  const rotation = createRotation(mkAccounts(ids), { file });
  const manager = new AgentManager({
    workDir: mkdtempSync(path.join(tmpdir(), 'tower-rot-w-')),
    stuckMs: 60000,
    accounts: rotation,
  });
  rotation.attach(manager);
  const server = createServer(manager, TOKEN);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const evs: ServerEvent[] = [];
  const sock = new WebSocket(`${base.replace('http', 'ws')}/api/ws?token=${TOKEN}`);
  sock.on('message', (d) => evs.push(JSON.parse(d.toString())));
  await new Promise((r) => sock.once('open', r));
  const post = (p: string, body?: unknown) =>
    fetch(`${base}${p}`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const state = async () => (await (await fetch(`${base}/api/state`, { headers: AUTH })).json()) as StateResponse;
  const statusOf = async (id: string) => (await state()).agents.find((a) => a.id === id)?.status;
  const close = async () => {
    sock.close();
    rotation.close();
    manager.shutdown();
    await manager.stopAll();
    await new Promise((r) => server.close(() => r(undefined)));
  };
  return { rotation, manager, base, evs, post, state, statusOf, file, close };
}

const next1341 = () => {
  const d = new Date();
  d.setHours(13, 41, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d.getTime();
};

test('rotation: limit banner -> account exhausted (resets 13:41) -> auto-moved to B; all exhausted -> no_account', async () => {
  const h = await setup();
  try {
    const a = (await (await h.post('/api/agents', { kind: 'devin', task: 'first', accountId: 'acc-a' })).json()) as AgentSummary;
    await waitFor(async () => ((await h.statusOf(a.id)) === 'done' ? true : undefined));
    assert.equal((await h.post(`/api/agents/${a.id}/prompt`, { text: 'limit-me please' })).status, 202);

    const moved = await waitFor(async () => (await h.state()).rotation?.activity.find((x) => x.kind === 'moved'));
    const st = await h.state();
    const accA = st.accounts.find((x) => x.id === 'acc-a')!;
    assert.equal(accA.status, 'exhausted');
    assert.equal(accA.resetAt, next1341());
    assert.equal(st.accounts.find((x) => x.id === 'acc-b')!.status, 'ok');
    const kinds = st.rotation!.activity.map((x) => x.kind);
    assert.deepEqual(kinds, ['moved', 'limit_hit']);
    const hit = st.rotation!.activity[1]!;
    assert.equal(hit.accountId, 'acc-a');
    assert.equal(hit.agentId, a.id);
    assert.equal(hit.text, 'Devin · acc-a hit its limit; resets 13:41');
    assert.equal(moved.agentId, a.id);
    assert.equal(moved.accountId, 'acc-a');
    assert.equal(moved.toAccountId, 'acc-b');
    const b = st.agents.find((x) => x.id === moved.newAgentId)!;
    assert.ok(b, 'new agent exists');
    assert.equal(b.accountId, 'acc-b');
    assert.deepEqual(b.movedFrom, { agentId: a.id, accountId: 'acc-a' });
    assert.ok(b.task.startsWith('Continue this task on a fresh session. Original task: first'));
    const old = st.agents.find((x) => x.id === a.id)!;
    assert.equal(old.archived, true);
    assert.equal(old.limitHit, true);
    // WS: rotation + accounts broadcasts and the movedFrom upsert
    assert.ok(h.evs.some((e) => e.type === 'rotation' && e.rotation.activity.some((x) => x.kind === 'moved')));
    assert.ok(h.evs.some((e) => e.type === 'accounts' && e.accounts.some((x) => x.id === 'acc-a' && x.status === 'exhausted')));
    assert.ok(h.evs.some((e) => e.type === 'agent' && e.agent.id === b.id && e.agent.movedFrom?.agentId === a.id));
    // persisted, mode 600
    assert.equal(statSync(h.file).mode & 0o777, 0o600);
    const disk = JSON.parse(readFileSync(h.file, 'utf8'));
    assert.equal(disk.exhausted['acc-a'], next1341());
    assert.equal(disk.activity.length, 2);

    // second account hits its limit too: nowhere to go
    await waitFor(async () => ((await h.statusOf(b.id)) === 'done' ? true : undefined));
    assert.equal((await h.post(`/api/agents/${b.id}/prompt`, { text: 'limit-me again' })).status, 202);
    const none = await waitFor(async () => (await h.state()).rotation?.activity.find((x) => x.kind === 'no_account'));
    assert.equal(none.text, 'All Devin accounts are at their limit; next resets 13:41');
    assert.equal(none.agentId, b.id);
    const st2 = await h.state();
    assert.equal(st2.accounts.find((x) => x.id === 'acc-b')!.status, 'exhausted');
    assert.equal(st2.agents.find((x) => x.id === b.id)!.archived, undefined);
    assert.equal(st2.agents.filter((x) => x.movedFrom).length, 1, 'no further move');
  } finally {
    await h.close();
  }
});

test('rotation routes: autoRotate=false -> no move; exclude/clear; Automatic skips excluded/exhausted', async () => {
  const h = await setup();
  try {
    assert.equal((await h.post('/api/rotation', { autoRotate: 'no' })).status, 400);
    const r = await h.post('/api/rotation', { autoRotate: false });
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as RotationState).autoRotate, false);
    assert.ok(h.evs.some((e) => e.type === 'rotation' && e.rotation.autoRotate === false));

    const a = (await (await h.post('/api/agents', { kind: 'devin', task: 'stay', accountId: 'acc-a' })).json()) as AgentSummary;
    await waitFor(async () => ((await h.statusOf(a.id)) === 'done' ? true : undefined));
    await h.post(`/api/agents/${a.id}/prompt`, { text: 'limit-me' });
    await waitFor(async () => ((await h.state()).rotation?.activity.some((x) => x.kind === 'limit_hit') ? true : undefined));
    await new Promise((res) => setTimeout(res, 300));
    const st = await h.state();
    assert.deepEqual(st.rotation!.activity.map((x) => x.kind), ['limit_hit']);
    assert.equal(st.agents.length, 1, 'no new agent');
    assert.equal(st.agents[0]!.archived, undefined);
    assert.equal(st.accounts.find((x) => x.id === 'acc-a')!.status, 'exhausted');

    // Automatic skips the exhausted account
    const auto1 = (await (await h.post('/api/agents', { kind: 'devin', task: 'auto one' })).json()) as AgentSummary;
    assert.equal(auto1.accountId, 'acc-b');

    // exclude route
    assert.equal((await h.post('/api/accounts/acc-b/exclude', { excluded: 'yes' })).status, 400);
    assert.equal((await h.post('/api/accounts/nope/exclude', { excluded: true })).status, 404);
    const ex = await h.post('/api/accounts/acc-b/exclude', { excluded: true });
    assert.equal(ex.status, 200);
    const exAcc = (await ex.json()) as Account;
    assert.equal(exAcc.status, 'excluded');
    assert.equal(exAcc.excluded, true);

    // clear route
    assert.equal((await h.post('/api/accounts/nope/clear')).status, 404);
    const cl = await h.post('/api/accounts/acc-a/clear');
    assert.equal(cl.status, 200);
    assert.equal(((await cl.json()) as Account).status, 'ok');
    // acc-b excluded, acc-a ok again -> Automatic picks acc-a
    const auto2 = (await (await h.post('/api/agents', { kind: 'devin', task: 'auto two' })).json()) as AgentSummary;
    assert.equal(auto2.accountId, 'acc-a');

    const inc = await h.post('/api/accounts/acc-b/exclude', { excluded: false });
    assert.equal(((await inc.json()) as Account).status, 'ok');
    const kinds = (await h.state()).rotation!.activity.map((x) => x.kind);
    assert.deepEqual(kinds, ['included', 'cleared', 'excluded', 'limit_hit']);
    assert.ok(h.evs.some((e) => e.type === 'accounts' && e.accounts.some((x) => x.id === 'acc-b' && x.status === 'excluded')));

    // persisted and reloaded by a fresh instance
    await h.post('/api/accounts/acc-b/exclude', { excluded: true });
    const again = createRotation(mkAccounts(['acc-a', 'acc-b']), { file: h.file });
    assert.equal(again.state().autoRotate, false);
    assert.equal(again.list().find((x) => x.id === 'acc-b')!.status, 'excluded');
    again.close();
  } finally {
    await h.close();
  }
});

test('rotation: exhausted auto-clears when resetAt passes (timer and injected clock)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tower-rot-clock-'));
  // timer path: a short real resetAt
  const r1: Rotation = createRotation(mkAccounts(['acc-a']), { file: path.join(dir, 'r1.json') });
  r1.markExhausted('acc-a', Date.now() + 200);
  assert.equal(r1.list()[0]!.status, 'exhausted');
  await waitFor(() => (r1.state().activity[0]?.kind === 'cleared' ? true : undefined), 3000);
  assert.equal(r1.list()[0]!.status, 'ok');
  assert.equal(r1.list()[0]!.resetAt, undefined);
  r1.close();

  // clock path: list() sweeps on read
  let now = 1_000_000;
  const r2 = createRotation(mkAccounts(['acc-a', 'acc-b']), { file: path.join(dir, 'r2.json'), now: () => now });
  await r2.handleLimit('ghost', 'acc-a', "You've hit your usage limit · try again in 2h 13m");
  assert.equal(r2.list()[0]!.resetAt, 1_000_000 + (2 * 60 + 13) * 60000);
  assert.equal(r2.envFor('devin').accountId, 'acc-b');
  now += (2 * 60 + 13) * 60000;
  assert.equal(r2.list()[0]!.status, 'ok');
  assert.equal(r2.state().activity[0]!.kind, 'cleared');
  assert.equal(r2.envFor('devin').accountId, 'acc-a');
  // no banner (429 / rate limit): never exhausts
  await r2.handleLimit('ghost', 'acc-a', 'HTTP 429 rate limit exceeded');
  assert.equal(r2.list()[0]!.status, 'ok');
  // unparseable reset: now + 1h
  await r2.handleLimit('ghost', 'acc-b', "You've reached your Fable limit. Run /usage-credits to continue");
  assert.equal(r2.list()[1]!.resetAt, now + 3600000);
  r2.close();
});

test('rotation: banner detection and reset-time parsing', () => {
  assert.equal(isLimitBanner("You've hit your usage limit · resets 13:41"), true);
  assert.equal(isLimitBanner('  ⎿  You’ve hit your session limit · resets 9:20pm (Europe/Berlin)'), true);
  assert.equal(isLimitBanner("You've reached your Fable 5 limit"), true);
  assert.equal(isLimitBanner('error: usage_limit_reached'), true);
  assert.equal(isLimitBanner('HTTP 429 Too Many Requests'), false);
  assert.equal(isLimitBanner("rate limit: You've hit your limit"), false);
  assert.equal(isLimitBanner('the usage limit docs'), false);

  const now = new Date(2026, 9, 25, 10, 0, 0).getTime(); // Oct 25 10:00 local
  const at = (mo: number, d: number, h: number, mi: number, y = 2026) => new Date(y, mo, d, h, mi, 0).getTime();
  assert.equal(parseResetAt('resets 13:41', now), at(9, 25, 13, 41));
  assert.equal(parseResetAt('resets 09:15', now), at(9, 26, 9, 15)); // already past today -> tomorrow
  assert.equal(parseResetAt('resets at 5pm', now), at(9, 25, 17, 0));
  assert.equal(parseResetAt('resets 12am', now), at(9, 26, 0, 0));
  assert.equal(parseResetAt('You’ve hit your session limit · resets 9:20pm (Europe/Berlin)', now), at(9, 25, 21, 20));
  assert.equal(parseResetAt('resets 13:41 on Oct 30', now), at(9, 30, 13, 41));
  assert.equal(parseResetAt('resets 13:41 on Jan 3', now), at(0, 3, 13, 41, 2027));
  assert.equal(parseResetAt('try again at 3:41 PM.', now), at(9, 25, 15, 41));
  assert.equal(parseResetAt('try again in 2h 13m', now), now + (2 * 60 + 13) * 60000);
  assert.equal(parseResetAt('or try again in 4 days 23 hours 35 minutes.', now), now + ((4 * 24 + 23) * 60 + 35) * 60000);
  assert.equal(parseResetAt('resets 2026-10-30T13:41:00Z', now), Date.parse('2026-10-30T13:41:00Z'));
  assert.equal(parseResetAt('resets 5', now), undefined);
  assert.equal(parseResetAt('resets 25:00', now), undefined);
  assert.equal(parseResetAt("You've hit your limit", now), undefined);
});
