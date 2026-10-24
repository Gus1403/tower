#!/usr/bin/env node
// ACP handshake probe for Tower.
// Usage: node acp-probe.mjs <kind> [--mode <modeId>] [--prompt <text>] [--tag <t>] [--session-meta <json>] -- <command...>
// Env: PROBE_WORK_DIR (default ~/tower-work or /tmp), PROBE_TIMEOUT_MS (default 120000)
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acp from '@agentclientprotocol/sdk';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
if (sep < 1 || sep === argv.length - 1) {
  console.error('usage: node acp-probe.mjs <kind> [--mode <id>] [--prompt <text>] -- <command...>');
  process.exit(2);
}
const opts = argv.slice(0, sep);
const kind = opts[0];
const cmd = argv.slice(sep + 1);
const optVal = (k) => { const i = opts.indexOf(k); return i >= 0 ? opts[i + 1] : undefined; };
const wantMode = optVal('--mode');
const promptText = optVal('--prompt') ?? 'Create a file named hello.txt containing the word hi, then reply DONE.';
const TIMEOUT = Number(process.env.PROBE_TIMEOUT_MS ?? 120000);

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, 'out');
fs.mkdirSync(outDir, { recursive: true });
const host = os.hostname().split('.')[0];
const tag = optVal('--tag');
const outFile = path.join(outDir, `${kind}${tag ? '-' + tag : ''}-${host}.ndjson`);
const out = fs.createWriteStream(outFile, { flags: 'w' });
const t0 = Date.now();
function log(type, data) {
  const line = JSON.stringify({ t: Date.now() - t0, type, ...data });
  process.stdout.write(line + '\n');
  out.write(line + '\n');
}

const workRoot = process.env.PROBE_WORK_DIR
  ?? (fs.existsSync(path.join(os.homedir(), 'tower-work')) ? path.join(os.homedir(), 'tower-work') : os.tmpdir());
fs.mkdirSync(workRoot, { recursive: true });
const sessionDir = fs.realpathSync(fs.mkdtempSync(path.join(workRoot, `probe-${kind}-`)));
log('probe_start', { kind, cmd, sessionDir, outFile, wantMode });

const child = spawn(cmd[0], cmd.slice(1), { cwd: sessionDir, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
let stderrTail = '';
child.stderr.on('data', (d) => { stderrTail = (stderrTail + d.toString()).slice(-4000); });
child.on('exit', (code, signal) => log('child_exit', { code, signal, stderrTail: stderrTail.slice(-1500) }));
child.on('error', (e) => { log('spawn_error', { message: e.message }); finish(1); });

let finished = false;
function finish(code) {
  if (finished) return;
  finished = true;
  try { child.kill('SIGTERM'); } catch {}
  setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 1500).unref();
  let files = [];
  try { files = fs.readdirSync(sessionDir); } catch {}
  let hello;
  try { hello = fs.readFileSync(path.join(sessionDir, 'hello.txt'), 'utf8'); } catch {}
  log('probe_end', { code, elapsedMs: Date.now() - t0, sessionFiles: files, helloTxt: hello });
  out.end(() => process.exit(code));
}
const timer = setTimeout(() => { log('timeout', { ms: TIMEOUT, stderrTail: stderrTail.slice(-1500) }); finish(3); }, TIMEOUT);

function inside(p) {
  const r = path.resolve(sessionDir, p);
  if (r !== sessionDir && !r.startsWith(sessionDir + path.sep)) throw new Error(`path outside session dir: ${p}`);
  return r;
}

let permCount = 0;
const client = {
  async sessionUpdate(params) {
    log('session_update', { kind: params.update?.sessionUpdate, params });
  },
  async requestPermission(params) {
    permCount++;
    const allow = params.options.find((o) => o.kind === 'allow_once')
      ?? params.options.find((o) => o.kind?.startsWith('allow'))
      ?? params.options[0];
    log('request_permission', { n: permCount, params, answer: allow?.optionId });
    return { outcome: { outcome: 'selected', optionId: allow.optionId } };
  },
  async readTextFile(params) {
    log('fs_read', { params });
    const content = fs.readFileSync(inside(params.path), 'utf8');
    let lines = content.split('\n');
    if (params.line) lines = lines.slice(params.line - 1);
    if (params.limit) lines = lines.slice(0, params.limit);
    return { content: lines.join('\n') };
  },
  async writeTextFile(params) {
    log('fs_write', { params: { ...params, content: params.content?.slice(0, 400) } });
    const p = inside(params.path);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, params.content);
    return {};
  },
};

const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
const conn = new acp.ClientSideConnection(() => client, stream);

try {
  const init = await conn.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
    clientInfo: { name: 'tower-probe', version: '0.0.1' },
  });
  log('initialize_response', { init });
  const metaJson = optVal('--session-meta'); // e.g. '{"claudeCode":{"options":{"settingSources":["project","local"]}}}'
  const sess = await conn.newSession({ cwd: sessionDir, mcpServers: [], ...(metaJson ? { _meta: JSON.parse(metaJson) } : {}) });
  log('new_session_response', { sess });
  if (wantMode) {
    const r = await conn.setSessionMode({ sessionId: sess.sessionId, modeId: wantMode });
    log('set_mode_response', { modeId: wantMode, r });
  }
  const res = await conn.prompt({ sessionId: sess.sessionId, prompt: [{ type: 'text', text: promptText }] });
  log('prompt_response', { stopReason: res.stopReason, res });
  clearTimeout(timer);
  finish(0);
} catch (e) {
  log('error', { message: e?.message ?? String(e), data: e?.data, code: e?.code, stderrTail: stderrTail.slice(-1500) });
  clearTimeout(timer);
  finish(1);
}
