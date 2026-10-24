// Wave B extra routes: uploads, tmux control (throwaway `-L` tmux server only), agent socket, `tower ask` CLI.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Short path: unix socket paths are limited to ~104 bytes on macOS.
const DATA = fs.mkdtempSync(path.join('/tmp', 'twx-'));
process.env.TOWER_DATA_DIR = DATA;
const TMUX_SOCK = `tower-test-${process.pid}`;
process.env.TOWER_TMUX_SOCKET = TMUX_SOCK;

const { handleExtra } = await import('../src/extra.js');
const { getUpload, MAX_UPLOAD_BYTES } = await import('../src/uploads.js');
const { startAgentSocket } = await import('../src/agent-socket.js');

const hasTmux = (() => {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

type Card = { id: string; source: 'tower' | 'tmux' };
const cards = new Map<string, Card>([
  ['t1', { id: 't1', source: 'tmux' }],
  ['w1', { id: 'w1', source: 'tower' }],
]);
const fakeManager = {
  getAgent: (id: string) => cards.get(id),
  tmuxTarget: (id: string) => (id === 't1' ? 'tt' : undefined),
};

let server: http.Server;
let base = '';

before(async () => {
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const json = (r: http.ServerResponse, code: number, body: unknown) => {
      r.writeHead(code, { 'content-type': 'application/json' });
      r.end(JSON.stringify(body));
    };
    const readBody = (r: http.IncomingMessage) =>
      new Promise<unknown>((resolve, reject) => {
        let d = '';
        r.on('data', (c) => (d += c));
        r.on('end', () => {
          try {
            resolve(d ? JSON.parse(d) : {});
          } catch (e) {
            reject(e);
          }
        });
      });
    const handled = await handleExtra({
      req,
      res,
      path: url.pathname,
      url,
      manager: fakeManager as never,
      send: () => {},
      json,
      readBody,
    });
    if (!handled) json(res, 404, { error: 'not handled' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  if (hasTmux) {
    execFileSync('tmux', ['-L', TMUX_SOCK, 'new-session', '-d', '-s', 'tt', '-x', '120', '-y', '40', 'cat']);
  }
});

after(() => {
  server.close();
  if (hasTmux) {
    try {
      execFileSync('tmux', ['-L', TMUX_SOCK, 'kill-server'], { stdio: 'ignore' });
    } catch {
      /* already gone */
    }
  }
  fs.rmSync(DATA, { recursive: true, force: true });
});

test('upload round trip: 201, bytes stored 600 under uploads/ (700), getUpload resolves, name sanitized', async () => {
  const bytes = Buffer.from('hello tower upload\n');
  const r = await fetch(`${base}/api/uploads?name=${encodeURIComponent('../../etc/my file$(x).txt')}`, {
    method: 'POST',
    body: bytes,
  });
  assert.equal(r.status, 201);
  const body = (await r.json()) as { id: string; name: string; size: number };
  assert.equal(body.size, bytes.length);
  assert.match(body.name, /^[A-Za-z0-9._-]{1,100}$/);
  assert.equal(body.name, 'my_file__x_.txt');
  const up = getUpload(body.id);
  assert.ok(up);
  assert.equal(up.size, bytes.length);
  assert.equal(up.name, body.name);
  assert.ok(up.path.startsWith(path.join(DATA, 'uploads')));
  assert.deepEqual(fs.readFileSync(up.path), bytes);
  assert.equal(fs.statSync(up.path).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(DATA, 'uploads')).mode & 0o777, 0o700);
  // sidecar survives a restart: the sidecar json carries the metadata
  const side = JSON.parse(fs.readFileSync(path.join(DATA, 'uploads', `${body.id}.json`), 'utf8'));
  assert.equal(side.name, body.name);
  assert.equal(getUpload('../agents'), undefined);
  assert.equal(getUpload('0'.repeat(32)), undefined);
});

test('long names are cut to 100 chars', async () => {
  const r = await fetch(`${base}/api/uploads?name=${'a'.repeat(300)}.png`, { method: 'POST', body: 'x' });
  assert.equal(r.status, 201);
  const body = (await r.json()) as { name: string };
  assert.equal(body.name.length, 100);
});


test('upload over 20 MB -> 413 (declared length and chunked stream), nothing left on disk', async () => {
  const before = fs.readdirSync(path.join(DATA, 'uploads')).length;
  // declared content-length above the cap: answered before any body byte is read
  const declared = await new Promise<number>((resolve, reject) => {
    const req = http.request(
      `${base}/api/uploads?name=big.bin`,
      { method: 'POST', headers: { 'content-length': String(MAX_UPLOAD_BYTES + 1) } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
        req.destroy();
      },
    );
    req.on('error', (e) => reject(e));
    req.flushHeaders();
  });
  assert.equal(declared, 413);
  // chunked (no content-length): the streaming limit trips; the client stops writing once answered
  const status = await new Promise<number>((resolve, reject) => {
    let answered = false;
    const req = http.request(`${base}/api/uploads?name=big2.bin`, { method: 'POST' }, (res) => {
      answered = true;
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', (e) => {
      if (!answered) reject(e);
    });
    const chunk = Buffer.alloc(1024 * 1024, 2);
    let n = 0;
    const pump = () => {
      while (!answered && n < 21 && req.write(chunk)) n++;
      if (!answered && n < 21) req.once('drain', () => (n++, pump()));
    };
    pump();
  });
  assert.equal(status, 413);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(fs.readdirSync(path.join(DATA, 'uploads')).length, before);
});

test('tmux routes: 404 unknown, 409 when TOWER_TMUX_INTERACTIVE is not 1 or card is not tmux', async () => {
  delete process.env.TOWER_TMUX_INTERACTIVE;
  assert.equal((await fetch(`${base}/api/agents/nope/screen`)).status, 404);
  assert.equal((await fetch(`${base}/api/agents/t1/screen`)).status, 409);
  const s = await fetch(`${base}/api/agents/t1/send`, { method: 'POST', body: JSON.stringify({ text: 'x' }) });
  assert.equal(s.status, 409);
  process.env.TOWER_TMUX_INTERACTIVE = '1';
  try {
    assert.equal((await fetch(`${base}/api/agents/w1/screen`)).status, 409);
    const k = await fetch(`${base}/api/agents/w1/key`, { method: 'POST', body: JSON.stringify({ key: 'Enter' }) });
    assert.equal(k.status, 409);
  } finally {
    delete process.env.TOWER_TMUX_INTERACTIVE;
  }
});

test('tmux send/key/screen against a throwaway -L tmux server running cat', { skip: !hasTmux && 'tmux not installed' }, async () => {
  process.env.TOWER_TMUX_INTERACTIVE = '1';
  delete process.env.TOWER_TMUX_ALLOW;
  try {
    // review fix A3: the flag alone is not enough; the session must match TOWER_TMUX_ALLOW
    assert.equal((await fetch(`${base}/api/agents/t1/screen`)).status, 409);
    process.env.TOWER_TMUX_ALLOW = 'other, t?';
    assert.equal((await fetch(`${base}/api/agents/t1/screen`)).status, 200);
    const bad = await fetch(`${base}/api/agents/t1/key`, { method: 'POST', body: JSON.stringify({ key: 'C-d' }) });
    assert.equal(bad.status, 400);
    const long = await fetch(`${base}/api/agents/t1/send`, {
      method: 'POST',
      body: JSON.stringify({ text: 'x'.repeat(20001) }),
    });
    assert.equal(long.status, 400);
    const s = await fetch(`${base}/api/agents/t1/send`, {
      method: 'POST',
      body: JSON.stringify({ text: 'hello from tower $(not-a-shell)' }),
    });
    assert.equal(s.status, 200);
    const k = await fetch(`${base}/api/agents/t1/key`, { method: 'POST', body: JSON.stringify({ key: 'Enter' }) });
    assert.equal(k.status, 200);
    await new Promise((r) => setTimeout(r, 300));
    const scr = await fetch(`${base}/api/agents/t1/screen`);
    assert.equal(scr.status, 200);
    const body = (await scr.json()) as { text: string; at: number };
    assert.equal(typeof body.at, 'number');
    // cat echoes the typed line (tty echo) and prints it back: at least two copies
    const hits = body.text.split('hello from tower $(not-a-shell)').length - 1;
    assert.ok(hits >= 2, `screen: ${JSON.stringify(body.text.slice(0, 300))}`);
    assert.doesNotMatch(body.text, /\x1b/);
    // no tower-* paste buffers left behind
    const bufs = execFileSync('tmux', ['-L', TMUX_SOCK, 'list-buffers', '-F', '#{buffer_name}'], { encoding: 'utf8' });
    assert.doesNotMatch(bufs, /tower-/);
  } finally {
    delete process.env.TOWER_TMUX_INTERACTIVE;
  }
});

function sockRequest(sock: string, line: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(sock);
    let buf = '';
    c.setEncoding('utf8');
    c.on('connect', () => c.write(line + '\n'));
    c.on('data', (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        c.end();
        resolve(JSON.parse(buf.slice(0, nl)));
      }
    });
    c.on('error', reject);
  });
}

test('agent socket: ask reaches the manager and replies ok; socket is 600; bad requests get errors', async () => {
  const got: unknown[] = [];
  const mgr = {
    ask: (agentId: string, text: string, recommendation?: string) => {
      got.push({ agentId, text, recommendation });
      return agentId === 'a1' ? { ok: true as const, questionId: 'q1' } : { ok: false as const, error: 'notfound' };
    },
  };
  const sock = path.join(DATA, 'agent.sock');
  fs.writeFileSync(sock, 'stale'); // stale file is unlinked
  const close = startAgentSocket(mgr);
  try {
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(fs.statSync(sock).mode & 0o777, 0o600);
    const r = await sockRequest(sock, JSON.stringify({ cmd: 'ask', agentId: 'a1', text: 'Which DB?', recommendation: 'Postgres' }));
    assert.deepEqual(r, { ok: true, questionId: 'q1' });
    assert.deepEqual(got, [{ agentId: 'a1', text: 'Which DB?', recommendation: 'Postgres' }]);
    assert.deepEqual(await sockRequest(sock, JSON.stringify({ cmd: 'ask', agentId: 'zz', text: 'q' })), {
      ok: false,
      error: 'notfound',
    });
    assert.equal((await sockRequest(sock, 'not json')).ok, false);
    assert.equal((await sockRequest(sock, JSON.stringify({ cmd: 'rm', agentId: 'a1', text: 'q' }))).ok, false);
    assert.equal((await sockRequest(sock, JSON.stringify({ cmd: 'ask', agentId: 'a1', text: ' ' }))).ok, false);
  } finally {
    close();
  }
  assert.equal(fs.existsSync(sock), false);
});

function runCli(args: string[], env: Record<string, string | undefined>): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const e: NodeJS.ProcessEnv = { ...process.env };
    delete e.TOWER_AGENT_ID;
    delete e.TOWER_SOCKET;
    Object.assign(e, env);
    execFile(process.execPath, [path.join(REPO, 'cli', 'tower'), ...args], { env: e, timeout: 15000 }, (err, out, errOut) => {
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: String(out), err: String(errOut) });
    });
  });
}

test('tower CLI end to end: ask over the socket, help, missing env exits 2', async () => {
  const got: { agentId: string; text: string; recommendation?: string }[] = [];
  const sock = path.join(DATA, 'agent.sock');
  const close = startAgentSocket({
    ask: (agentId: string, text: string, recommendation?: string) => {
      got.push({ agentId, text, recommendation });
      return { ok: true as const, questionId: 'q9' };
    },
  });
  try {
    await new Promise((r) => setTimeout(r, 100));
    const ok = await runCli(['ask', '--recommendation', 'use B', 'Should I use A or B?'], {
      TOWER_AGENT_ID: 'agent-7',
      TOWER_SOCKET: sock,
    });
    assert.equal(ok.code, 0, ok.err);
    assert.equal(ok.out.trim(), 'Asked. The owner will answer in Tower; the answer arrives as your next message.');
    assert.deepEqual(got, [{ agentId: 'agent-7', text: 'Should I use A or B?', recommendation: 'use B' }]);
    const plain = await runCli(['ask', 'q'], { TOWER_AGENT_ID: 'agent-7', TOWER_SOCKET: sock });
    assert.equal(plain.code, 0, plain.err);
    assert.equal(got[1].recommendation, undefined);
    const missing = await runCli(['ask', 'q'], {});
    assert.equal(missing.code, 2);
    assert.match(missing.err, /TOWER_AGENT_ID and TOWER_SOCKET must be set/);
    const help = await runCli(['help'], {});
    assert.equal(help.code, 0);
    assert.match(help.out, /tower ask \[--recommendation/);
  } finally {
    close();
  }
  const down = await runCli(['ask', 'q'], { TOWER_AGENT_ID: 'a', TOWER_SOCKET: sock });
  assert.equal(down.code, 1);
  assert.match(down.err, /cannot reach Tower/);
});
