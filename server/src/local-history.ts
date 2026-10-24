import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { open, opendir, realpath, stat, type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FeedItem, SessionWorkspace } from '../../shared/contract.js';

type Conversation = SessionWorkspace['conversation'];
const PAGE_ITEMS = 50;
const PAGE_BYTES = 4 * 1024 * 1024;
const CHUNK = 64 * 1024;
const MAX_LINE = 512 * 1024;
const MAX_REGISTRY = 64 * 1024;
const MAX_PROCESSES = 128;
const MAX_PROJECTS = 1024;
const projectCache = new Map<string, { at: number; project: string | null }>();
const unavailable = (reason: string): Conversation => ({ available: false, reason, items: [], hasMore: false });
const within = (name: string, root: string) => { const rel = path.relative(root, name); return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)); };
const digest = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 32);
async function smallFile(name: string, max: number): Promise<Buffer | null> {
  const handle = await open(name, 'r');
  try {
    const buffer = Buffer.alloc(max + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return bytesRead > max ? null : buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

function tmux(session: string): Promise<string> {
  // The leading = is tmux's exact-session selector; no shell or fuzzy target matching.
  const args = [...(process.env.TOWER_TMUX_SOCKET ? ['-L', process.env.TOWER_TMUX_SOCKET] : []), 'list-panes', '-t', `=${session}:`, '-F', '#{session_name}\t#{pane_id}\t#{pane_pid}'];
  return new Promise((resolve, reject) => execFile('tmux', args, { timeout: 2000, maxBuffer: 8192 }, (err, out) => err ? reject(err) : resolve(out)));
}

type Proc = { pid: number; start: string; comm: string; argv: string[] };
async function processInfo(pid: number): Promise<Proc | null> {
  try {
    const [statBytes, cmdline] = await Promise.all([smallFile(`/proc/${pid}/stat`, 4096), smallFile(`/proc/${pid}/cmdline`, 8192)]);
    if (!statBytes || !cmdline) return null;
    const raw = statBytes.toString('utf8');
    const close = raw.lastIndexOf(')');
    const fields = raw.slice(close + 2).trim().split(/\s+/);
    if (close < 0 || !/^\d+$/.test(fields[19] || '')) return null;
    return { pid, start: fields[19], comm: raw.slice(raw.indexOf('(') + 1, close), argv: cmdline.toString().split('\0').filter(Boolean).slice(0, 24) };
  } catch { return null; }
}

function isClaude(p: Proc): boolean {
  return path.basename(p.comm) === 'claude' || path.basename(p.argv[0] || '') === 'claude';
}

async function nearestClaude(root: number): Promise<Proc | null> {
  let pending = [root];
  const seen = new Set<number>();
  while (pending.length && seen.size < MAX_PROCESSES) {
    const level = pending.splice(0, MAX_PROCESSES - seen.size).filter(pid => Number.isSafeInteger(pid) && pid > 0 && !seen.has(pid));
    for (const pid of level) seen.add(pid);
    const rows = await Promise.all(level.map(async pid => {
      const info = await processInfo(pid);
      let children: number[] = [];
      try { children = (await smallFile(`/proc/${pid}/task/${pid}/children`, 4096))?.toString('utf8').trim().split(/\s+/).map(Number).filter(Boolean).slice(0, MAX_PROCESSES) || []; } catch { /* exited */ }
      return { info, children };
    }));
    const found = rows.map(r => r.info).filter((p): p is Proc => !!p && isClaude(p));
    if (found.length !== 0) return found.length === 1 ? found[0] : null;
    pending = rows.flatMap(r => r.children).filter(pid => !seen.has(pid));
  }
  return null;
}

async function configHome(pid: number): Promise<string | null> {
  try {
    const env = await smallFile(`/proc/${pid}/environ`, 128 * 1024);
    if (!env) return null;
    const entry = env.toString().split('\0').find(s => s.startsWith('CLAUDE_CONFIG_DIR='));
    const value = entry?.slice('CLAUDE_CONFIG_DIR='.length);
    const base = path.resolve(process.env.TOWER_ACCOUNTS_HOME || os.homedir());
    if (!value || !path.isAbsolute(value) || !/^\.claude(?:-\d+)?$/.test(path.basename(value)) || path.dirname(value) !== base) return null;
    const [realBase, realHome] = await Promise.all([realpath(base), realpath(value)]);
    return path.dirname(realHome) === realBase ? realHome : null;
  } catch { return null; }
}

async function verifiedRegistry(home: string, proc: Proc, pane: string): Promise<{ id: string; cwd: string } | null> {
  let handle: FileHandle | undefined;
  try {
    const sessions = await realpath(path.join(home, 'sessions'));
    if (sessions !== path.join(home, 'sessions')) return null;
    handle = await open(path.join(sessions, `${proc.pid}.json`), 'r');
    const [file, target] = await Promise.all([handle.stat(), realpath(`/proc/self/fd/${handle.fd}`)]);
    if (!file.isFile() || file.size > MAX_REGISTRY || !within(target, sessions)) return null;
    const buffer = Buffer.alloc(file.size);
    const { bytesRead } = await handle.read(buffer, 0, file.size, 0);
    if (bytesRead !== file.size) return null;
    const row = JSON.parse(buffer.toString('utf8')) as Record<string, unknown>;
    if (row.pid !== proc.pid || String(row.procStart) !== proc.start || typeof row.tmux !== 'string' || !row.tmux.endsWith(`.${pane}`)) return null;
    if (typeof row.sessionId !== 'string' || !/^[a-f\d-]{16,64}$/i.test(row.sessionId) || typeof row.cwd !== 'string' || !path.isAbsolute(row.cwd)) return null;
    return { id: row.sessionId, cwd: row.cwd };
  } catch { return null; }
  finally { await handle?.close(); }
}

async function projectsRoot(home: string): Promise<string | null> {
  try {
    const requested = path.join(home, 'projects');
    const actual = await realpath(requested);
    if (actual === requested) return actual;
    // Fleet account homes may share the main Claude projects directory.
    const base = path.resolve(process.env.TOWER_ACCOUNTS_HOME || os.homedir());
    const entries = await opendir(base);
    let checked = 0;
    for await (const entry of entries) {
      if (++checked > 1024) break;
      if (!entry.isDirectory() || !/^\.claude(?:-\d+)?$/.test(entry.name)) continue;
      const other = path.join(base, entry.name, 'projects');
      if (actual === other && await realpath(other).catch(() => null) === other) return actual;
    }
  } catch { /* unavailable */ }
  return null;
}

async function transcript(home: string, registry: { id: string; cwd: string }): Promise<FileHandle | null> {
  const root = await projectsRoot(home);
  if (!root) return null;
  const name = registry.cwd.replace(/[^a-zA-Z0-9]/g, '-');
  const key = `${root}\0${registry.cwd}\0${registry.id}`;
  const prior = projectCache.get(key);
  const cached = prior && Date.now() - prior.at < 10_000 ? prior : undefined;
  if (cached?.project === null) return null;
  const candidates: string[] = cached?.project ? [cached.project] : [];
  if (name && name.length < 512 && !candidates.includes(name)) candidates.push(name);
  // A bounded lookup covers older Claude project encodings while keeping the exact registry ID.
  if (!(await stat(path.join(root, name, `${registry.id}.jsonl`)).catch(() => null)) && !cached?.project) {
    const entries = await opendir(root);
    let checked = 0;
    for await (const entry of entries) {
      if (++checked > MAX_PROJECTS) return null;
      if (entry.isDirectory() && entry.name !== name) candidates.push(entry.name);
    }
  }
  for (const project of candidates) {
    let handle: FileHandle | undefined;
    try {
      handle = await open(path.join(root, project, `${registry.id}.jsonl`), 'r');
      const [target, info] = await Promise.all([realpath(`/proc/self/fd/${handle.fd}`), handle.stat()]);
      if (info.isFile() && within(target, root) && path.basename(target) === `${registry.id}.jsonl`) {
        projectCache.delete(key);
        projectCache.set(key, { at: Date.now(), project });
        if (projectCache.size > 128) projectCache.delete(projectCache.keys().next().value!);
        return handle;
      }
    } catch { /* next project */ }
    await handle?.close();
  }
  projectCache.delete(key);
  projectCache.set(key, { at: Date.now(), project: null });
  if (projectCache.size > 128) projectCache.delete(projectCache.keys().next().value!);
  return null;
}

function redact(value: string, limit: number): string {
  return value
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]')
    .replace(/\b(?:sk-(?:ant-|proj-)?|gh[opusr]_|github_pat_|AKIA)[A-Za-z0-9_\-]{12,}\b/g, '[REDACTED TOKEN]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]{12,}/gi, '$1[REDACTED]')
    .replace(/\b((?:[A-Z][A-Z0-9]*_)*(?:PASSWORD|PASSWD|API_KEY|SECRET|TOKEN))\s*[:=]\s*['"]?[^\s,'"}]{6,}/gi, '$1=[REDACTED]')
    .replace(/(["'](?:password|passwd|api[_-]?key|secret|token)["']\s*:\s*["'])[^"']{6,}/gi, '$1[REDACTED]')
    .slice(0, limit);
}
function textParts(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(b => b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string').map(b => b.text as string).join('\n');
}
function cleanUser(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '').replace(/<system-reminder>[\s\S]*$/gi, '').trim();
}
function parseLine(line: Buffer, offset: number, sessionId: string): FeedItem[] {
  if (line.length > MAX_LINE) return [];
  let row: Record<string, any>;
  try { row = JSON.parse(line.toString('utf8')); } catch { return []; }
  if (!row || (row.type !== 'user' && row.type !== 'assistant') || row.isMeta === true || row.isSidechain === true || row.isCompactSummary === true) return [];
  if (row.sessionId !== sessionId) return [];
  const at = Date.parse(row.timestamp);
  if (!Number.isFinite(at)) return [];
  const content = row.message?.content;
  const key = typeof row.uuid === 'string' && /^[\w-]{8,80}$/.test(row.uuid) ? row.uuid : String(offset);
  const result: FeedItem[] = [];
  if (row.type === 'user') {
    const message = cleanUser(textParts(content));
    if (message && !/^<local-command|^<command-|^<system-/i.test(message)) result.push({ type: 'user_message', id: `history-${key}`, at, text: redact(message, 12000) });
    if (Array.isArray(content)) for (const block of content) if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string' && /^[\w-]{1,128}$/.test(block.tool_use_id)) {
      const output = typeof block.content === 'string' ? block.content : textParts(block.content);
      result.push({ type: 'tool_call', id: `tool-${block.tool_use_id}`, toolCallId: block.tool_use_id, at, title: 'Tool result', status: block.is_error ? 'failed' : 'completed', output: redact(output, 8000) });
    }
  } else if (Array.isArray(content)) {
    for (const [i, block] of content.entries()) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) result.push({ type: 'agent_message', id: `history-${key}-${i}`, at, text: redact(block.text, 12000) });
      else if (block?.type === 'thinking') result.push({ type: 'thought', id: `history-${key}-${i}`, at, text: 'Thinking' });
      else if (block?.type === 'tool_use' && typeof block.id === 'string' && /^[\w-]{1,128}$/.test(block.id)) {
        const title = typeof block.name === 'string' ? block.name : 'Tool';
        const input = block.input && typeof block.input === 'object' ? block.input : {};
        const detail = ['command', 'cmd', 'file_path', 'path', 'query'].map(k => input[k]).find(v => typeof v === 'string') as string | undefined;
        result.push({ type: 'tool_call', id: `tool-${block.id}`, toolCallId: block.id, at, title: redact(title, 120), toolKind: redact(title, 120), status: 'in_progress', detail: detail ? redact(detail, 400) : undefined });
      }
    }
  }
  return result;
}

type Cursor = { v: 1; key: string; dev: number; ino: number; born: number; prefix: string; anchor: string; offset: number };
function decodeCursor(raw: string): Cursor | null {
  if (raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Cursor;
    return c.v === 1 && typeof c.key === 'string' && Number.isSafeInteger(c.dev) && Number.isSafeInteger(c.ino) && Number.isFinite(c.born) && typeof c.prefix === 'string' && typeof c.anchor === 'string' && Number.isSafeInteger(c.offset) && c.offset >= 0 ? c : null;
  } catch { return null; }
}

/** Page a previously identity-verified Claude transcript. Exported for real-file parser contract tests. */
export async function pageClaudeTranscript(handle: FileHandle, sessionKey: string, sessionId: string, before?: string): Promise<Conversation> {
  const file = await handle.stat();
  if (!file.isFile()) return unavailable('History file unavailable');
  const prefixBuffer = Buffer.alloc(Math.min(file.size, 512));
  await handle.read(prefixBuffer, 0, prefixBuffer.length, 0);
  const fingerprint = digest(prefixBuffer.toString('base64'));
  const key = digest(sessionKey);
  const cursor = before === undefined ? null : decodeCursor(before);
  if (before !== undefined && (!cursor || cursor.key !== key)) return unavailable('History cursor does not match this session');
  const anchorAt = async (offset: number) => {
    const buffer = Buffer.alloc(Math.min(512, file.size - offset));
    await handle.read(buffer, 0, buffer.length, offset);
    return digest(buffer.toString('base64'));
  };
  if (cursor && (cursor.dev !== file.dev || cursor.ino !== file.ino || cursor.born !== file.birthtimeMs || cursor.prefix !== fingerprint || cursor.offset > file.size || cursor.anchor !== await anchorAt(cursor.offset))) return unavailable('History cursor is stale');
  let pos = cursor?.offset ?? file.size;
  let startOfPage = pos;
  let carry = Buffer.alloc(0);
  let bytes = 0;
  let firstChunk = true;
  const rows: { offset: number; items: FeedItem[] }[] = [];
  let foundOlder = false;
  while (pos > 0 && bytes < PAGE_BYTES) {
    const take = Math.min(CHUNK, pos, PAGE_BYTES - bytes);
    const start = pos - take;
    const block = Buffer.alloc(take);
    const read = await handle.read(block, 0, take, start);
    if (read.bytesRead !== take) return unavailable('History changed while reading');
    bytes += take;
    pos = start;
    let data = carry.length ? Buffer.concat([block, carry]) : block;
    if (firstChunk) {
      firstChunk = false;
      // A live append can leave an incomplete final JSONL line. Ignore it until complete.
      if (!cursor && data.length && data[data.length - 1] !== 10) data = data.subarray(0, data.lastIndexOf(10) + 1);
    }
    if (!data.length) { carry = Buffer.alloc(0); continue; }
    let end = data.length - 1;
    if (data[end] !== 10) { carry = data; continue; }
    while (end >= 0) {
      // Buffer.lastIndexOf(-1) searches from the end, so end=0 needs an explicit stop.
      const prev = end === 0 ? -1 : data.lastIndexOf(10, end - 1);
      if (prev < 0) break;
      const lineStart = start + prev + 1;
      const parsed = parseLine(data.subarray(prev + 1, end), lineStart, sessionId);
      if (parsed.length) {
        if (rows.length >= PAGE_ITEMS) { foundOlder = true; break; }
        rows.push({ offset: lineStart, items: parsed });
        startOfPage = lineStart;
      }
      end = prev;
    }
    if (foundOlder) break;
    carry = data.subarray(0, end + 1);
    if (carry.length > MAX_LINE) carry = Buffer.alloc(0);
  }
  if (pos === 0 && carry.length) {
    const parsed = parseLine(carry, 0, sessionId);
    if (parsed.length) {
      if (rows.length >= PAGE_ITEMS) foundOlder = true;
      else { rows.push({ offset: 0, items: parsed }); startOfPage = 0; }
    }
  }
  if (pos > 0 && !foundOlder) return unavailable('History page exceeds read limit');
  const byId = new Map<string, FeedItem>();
  for (const row of rows.reverse()) for (const item of row.items) {
    const earlier = byId.get(item.id);
    byId.set(item.id, earlier?.type === 'tool_call' && item.type === 'tool_call' ? { ...earlier, ...item, title: earlier.title === 'Tool result' ? item.title : earlier.title, output: item.output ?? earlier.output } : item);
  }
  const hasMore = foundOlder;
  return { available: true, items: [...byId.values()], hasMore, before: hasMore ? Buffer.from(JSON.stringify({ v: 1, key, dev: file.dev, ino: file.ino, born: file.birthtimeMs, prefix: fingerprint, anchor: await anchorAt(startOfPage), offset: startOfPage } satisfies Cursor)).toString('base64url') : undefined };
}

export async function readLocalHistory(session: string, before?: string): Promise<Conversation> {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(session)) return unavailable('Unsupported session');
  let panes: { id: string; pid: number }[];
  try {
    const output = await tmux(session);
    panes = output.trim().split('\n').filter(Boolean).map(line => {
      const [name, id, pid] = line.split('\t');
      return name === session && /^%\d+$/.test(id || '') && /^\d+$/.test(pid || '') ? { id, pid: Number(pid) } : null;
    }).filter((p): p is { id: string; pid: number } => !!p);
  } catch { return unavailable('Session unavailable'); }
  if (!panes.length || panes.length > 8) return unavailable('Session unavailable');
  const verified: { proc: Proc; home: string; registry: { id: string; cwd: string } }[] = [];
  for (const pane of panes) {
    const proc = await nearestClaude(pane.pid);
    if (!proc) continue;
    const home = await configHome(proc.pid);
    if (!home) continue;
    const registry = await verifiedRegistry(home, proc, pane.id);
    if (registry && (await processInfo(proc.pid))?.start === proc.start) verified.push({ proc, home, registry });
  }
  if (verified.length !== 1) return unavailable('Claude session identity unavailable');
  const { proc, home, registry } = verified[0];
  const handle = await transcript(home, registry);
  if (!handle) return unavailable('Claude history unavailable');
  try { return await pageClaudeTranscript(handle, `${session}\0${proc.pid}\0${proc.start}\0${registry.id}`, registry.id, before); }
  catch { return unavailable('Claude history unavailable'); }
  finally { await handle.close(); }
}
