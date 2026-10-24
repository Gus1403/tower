import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/http.js';
import type { AgentSummary, FeedItem, SessionWorkspace } from '../../shared/contract.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-workspace-'));
const socketPath = path.join(dir, 'agent.sock');
const token = 'tower-test-token';
const auth = { authorization: `Bearer ${token}` };
const tmux = (id: string, kind: AgentSummary['kind'] = 'claude'): AgentSummary => ({
  id, kind, name: id, task: 'redacted', cwd: '', source: 'tmux', status: 'observed',
  createdAt: 1, lastActivityAt: 1, toolCalls: 0, queued: [],
});
const tower: AgentSummary = {
  ...tmux('owned'), source: 'tower', task: 'Build workspace', status: 'done',
  lastMessage: 'Delivered', plan: [{ content: 'Wire endpoint', status: 'completed' }],
  questions: [{ id: 'q', agentId: 'owned', text: 'Which release?', recommendation: 'Today', createdAt: 1 }],
};
const feeds: FeedItem[] = Array.from({ length: 70 }, (_, i) => ({ type: 'agent_message', id: `m${i}`, at: i, text: `message ${i}` }));
const agents = new Map([['observed', tmux('observed')], ['other', tmux('other')], ['nonclaude', tmux('nonclaude', 'codex')], ['owned', tower]]);
const manager = Object.assign(new EventEmitter(), {
  getAgent: (id: string) => agents.get(id),
  getFeed: (id: string) => id === 'owned' ? feeds : undefined,
  tmuxTarget: (id: string) => id === 'observed' ? 'exact-session' : id === 'other' ? 'other-session' : id === 'nonclaude' ? 'codex-session' : undefined,
});
let cards: unknown[] = [];
let malformedBoard = false;
let malformedHistory = false;
let historyUnavailable = false;
const requested: { id: string; before: string | null; sessionId: string | null }[] = [];
let boardServer: net.Server;
let forja: http.Server;
let towerServer: http.Server;
let base = '';
let forjaOrigin = '';

function listen(server: http.Server): Promise<string> {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as net.AddressInfo).port}`)));
}
function card(session: string, agent = 'claude', conversation = true) {
  return {
    id: session, kind: 'session', session, sessionId: `$${session}`, agent, conversation,
    work: `Full work for ${session}`, summary: `Summary for ${session}`,
    questions: [{ text: `Question for ${session}`, recommendation: 'Proceed' }],
    delivery: { reason: `Delivered ${session}`, result: 'https://example.com/result', at: '2026-10-24T12:00:00Z' },
    links: [{ title: 'Evidence', url: 'https://example.com/evidence' }, { title: 'Unsafe', url: 'javascript:alert(1)' }, { title: 'Report', url: '/home/owner/report.pdf' }],
  };
}

before(async () => {
  process.env.FORJA_AGENT_SOCKET = socketPath;
  process.env.TOWER_TMUX_INTERACTIVE = '1';
  process.env.TOWER_TMUX_ALLOW = 'exact-session,other-session,codex-session';
  process.env.TOWER_TMUX_REDACT = '0';
  cards = [card('exact-session'), card('other-session'), card('codex-session', 'codex')];
  boardServer = net.createServer(socket => {
    let input = '';
    socket.on('data', chunk => {
      input += chunk;
      if (input.includes('\n')) socket.end(malformedBoard ? '{broken' : JSON.stringify({ ok: true, state: { cards } }) + '\n');
    });
  });
  await new Promise<void>(resolve => boardServer.listen(socketPath, resolve));
  forja = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const match = url.pathname.match(/^\/api\/cards\/([^/]+)\/conversation$/);
    if (!match) { res.writeHead(404).end(); return; }
    const id = decodeURIComponent(match[1]!);
    requested.push({ id, before: url.searchParams.get('before'), sessionId: req.headers['x-forja-session-id'] as string ?? null });
    if (historyUnavailable) { res.writeHead(503).end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    if (malformedHistory) { res.end(JSON.stringify({ events: 'wrong', before: null })); return; }
    res.end(JSON.stringify(url.searchParams.has('before')
      ? { events: [{ k: 'text', id: 'older', at: '2026-10-23T12:00:00Z', md: `Old ${id}` }], before: null }
      : { events: [
        { k: 'user', id: 'u1', at: '2026-10-24T12:00:00Z', text: `User ${id}` },
        { k: 'text', id: 'a1', at: '2026-10-24T12:00:01Z', md: `Reply ${id}` },
        { k: 'tool', id: 'tool1', at: '2026-10-24T12:00:02Z', name: 'Read', label: 'Read file', status: 'done', summary: 'done' },
      ], before: 'older-cursor' }));
  });
  forjaOrigin = await listen(forja);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ publicUrl: 'https://board.example.com', listen: { host: '127.0.0.1', port: Number(new URL(forjaOrigin).port) }, auth: { mode: 'none' } }));
  process.env.TOWER_FORJA_CONFIG = path.join(dir, 'config.json');
  process.env.TOWER_FORJA_ORIGIN = forjaOrigin;
  towerServer = createServer(manager as never, token);
  base = await listen(towerServer);
});

after(async () => {
  await Promise.all([new Promise<void>(r => towerServer.close(() => r())), new Promise<void>(r => forja.close(() => r())), new Promise<void>(r => boardServer.close(() => r()))]);
  fs.rmSync(dir, { recursive: true, force: true });
  for (const key of ['FORJA_AGENT_SOCKET', 'TOWER_FORJA_CONFIG', 'TOWER_FORJA_ORIGIN', 'TOWER_TMUX_INTERACTIVE', 'TOWER_TMUX_ALLOW', 'TOWER_TMUX_REDACT']) delete process.env[key];
});

async function get(id: string, before?: string, authorized = true) {
  const url = `${base}/api/agents/${id}/workspace${before ? `?before=${encodeURIComponent(before)}` : ''}`;
  const response = await fetch(url, { headers: authorized ? auth : {} });
  return { status: response.status, body: await response.json() as SessionWorkspace & { error?: string } };
}

test('Tower ACP feed pages and carries task, plan, question, and delivery', async () => {
  const first = await get('owned');
  assert.equal(first.status, 200);
  assert.equal(first.body.conversation.items.length, 60);
  assert.equal(first.body.conversation.items[0]?.id, 'm10');
  assert.equal(first.body.conversation.before, 't_m10');
  assert.match(first.body.context.summary ?? '', /Build workspace[\s\S]*Wire endpoint/);
  assert.deepEqual(first.body.context.pending, [{ text: 'Which release?', recommendation: 'Today' }]);
  assert.equal(first.body.context.delivery?.text, 'Delivered');
  const second = await get('owned', first.body.conversation.before);
  assert.equal(second.body.conversation.items.length, 10);
  assert.equal(second.body.conversation.items[0]?.id, 'm0');
  assert.equal(second.body.conversation.hasMore, false);
});

test('exact Forja session yields normalized history, paging and card context', async () => {
  requested.length = 0;
  const first = await get('observed');
  assert.equal(first.status, 200);
  assert.equal(first.body.conversation.available, true);
  assert.deepEqual(first.body.conversation.items.map(i => i.type), ['user_message', 'agent_message', 'tool_call']);
  assert.equal(first.body.conversation.items[1]?.type === 'agent_message' && first.body.conversation.items[1].text, 'Reply exact-session');
  assert.equal(first.body.conversation.before, 'older-cursor');
  assert.match(first.body.context.summary ?? '', /Full work for exact-session/);
  assert.deepEqual(first.body.context.pending, [{ text: 'Question for exact-session', recommendation: 'Proceed' }]);
  assert.equal(first.body.context.delivery?.url, 'https://example.com/result');
  assert.deepEqual(first.body.context.links, [
    { title: 'Evidence', url: 'https://example.com/evidence' },
    { title: 'Report', url: 'https://board.example.com/api/cards/exact-session/file?path=%2Fhome%2Fowner%2Freport.pdf' },
  ]);
  const older = await get('observed', first.body.conversation.before);
  assert.equal(older.body.conversation.items[0]?.id, 'older');
  assert.equal(older.body.conversation.hasMore, false);
  assert.deepEqual(requested, [
    { id: 'exact-session', before: null, sessionId: '$exact-session' },
    { id: 'exact-session', before: 'older-cursor', sessionId: '$exact-session' },
  ]);
});

test('authentication, unknown card and allowlist protect workspace', async () => {
  assert.equal((await get('observed', undefined, false)).status, 401);
  assert.equal((await get('missing')).status, 404);
  process.env.TOWER_TMUX_ALLOW = 'other-session';
  try { assert.equal((await get('observed')).status, 409); }
  finally { process.env.TOWER_TMUX_ALLOW = 'exact-session,other-session,codex-session'; }
  assert.equal((await get('observed', '../bad')).status, 400);
});

test('missing exact binding never returns another session history or context', async () => {
  const before = requested.length;
  cards = [card('other-session'), card('codex-session', 'codex')];
  try {
    const result = await get('observed');
    assert.equal(result.body.conversation.available, false);
    assert.deepEqual(result.body.context, {});
    assert.equal(requested.length, before);
  } finally { cards = [card('exact-session'), card('other-session'), card('codex-session', 'codex')]; }
  const other = await get('other');
  assert.equal(other.body.conversation.items[1]?.type === 'agent_message' && other.body.conversation.items[1].text, 'Reply other-session');
});

test('unavailable histories and malformed dependencies preserve context without leaking another session', async () => {
  const codex = await get('nonclaude');
  assert.equal(codex.body.conversation.available, false);
  assert.match(codex.body.context.summary ?? '', /codex-session/);
  historyUnavailable = true;
  try {
    const unavailable = await get('observed');
    assert.equal(unavailable.body.conversation.available, false);
    assert.equal(unavailable.body.conversation.items.length, 0);
    assert.match(unavailable.body.context.summary ?? '', /exact-session/);
  } finally { historyUnavailable = false; }
  malformedHistory = true;
  try { assert.equal((await get('observed')).body.conversation.available, false); }
  finally { malformedHistory = false; }
  malformedBoard = true;
  try {
    const malformed = await get('observed');
    assert.equal(malformed.body.conversation.available, false);
    assert.deepEqual(malformed.body.context, {});
  } finally { malformedBoard = false; }
});

test('demo redaction returns no Forja data or history', async () => {
  process.env.TOWER_TMUX_REDACT = '1';
  const before = requested.length;
  try {
    const result = await get('observed');
    assert.equal(result.body.conversation.available, false);
    assert.deepEqual(result.body.context, {});
    assert.equal(requested.length, before);
  } finally { process.env.TOWER_TMUX_REDACT = '0'; }
});
