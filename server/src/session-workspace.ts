import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { AgentManager } from './agents.js';
import { tmuxAllowed } from './tmux-control.js';
import { readLocalHistory } from './local-history.js';
import type { FeedItem, SessionWorkspace } from '../../shared/contract.js';

const PAGE = 60;
// Forja's limit counts human turns; one turn can contain hundreds of tool events.
const FORJA_TURNS = 5;
const MAX_REPLY = 8 * 1024 * 1024;
type Manager = Pick<AgentManager, 'getAgent' | 'getFeed' | 'tmuxTarget'>;
type Card = { id?: unknown; kind?: unknown; session?: unknown; sessionId?: unknown; agent?: unknown; conversation?: unknown; work?: unknown; summary?: unknown; needReason?: unknown; questions?: unknown; delivery?: unknown; links?: unknown };
type BoardReply = { ok?: boolean; state?: { cards?: Card[] } };
type Config = { listen?: { host?: string; port?: number }; publicUrl?: string; auth?: { mode?: string } };

function unavailable(reason: string, context: SessionWorkspace['context'] = {}): SessionWorkspace {
  return { conversation: { available: false, reason, items: [], hasMore: false }, context };
}

function text(value: unknown, max = 20_000): string | undefined {
  return typeof value === 'string' && value.trim() ? value.slice(0, max) : undefined;
}

function safeUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}

function cardContext(card: Card, publicOrigin?: string): SessionWorkspace['context'] {
  const linkedUrl = (value: unknown): string | undefined => {
    const direct = safeUrl(value);
    if (direct) return direct;
    if (!publicOrigin || typeof value !== 'string' || !path.isAbsolute(value) || typeof card.id !== 'string') return undefined;
    if (!Array.isArray(card.links) || !card.links.some(link => link && typeof link === 'object' && link.url === value)) return undefined;
    const url = new URL(`/api/cards/${encodeURIComponent(card.id)}/file`, publicOrigin);
    url.searchParams.set('path', value);
    return url.href;
  };
  const work = text(card.work);
  const summary = text(card.summary);
  const questions = Array.isArray(card.questions) ? card.questions : [];
  const pending: NonNullable<SessionWorkspace['context']['pending']> = questions.filter(q => q && typeof q === 'object').slice(0, 20).flatMap(q => {
    const row = q as Record<string, unknown>;
    const question = text(row.text, 4000);
    return question ? [{ text: question, ...(text(row.recommendation, 4000) ? { recommendation: text(row.recommendation, 4000) } : {}) }] : [];
  });
  if (!pending.length && text(card.needReason)) pending.push({ text: text(card.needReason, 4000)! });
  const delivery = card.delivery && typeof card.delivery === 'object' ? card.delivery as Record<string, unknown> : null;
  const links = Array.isArray(card.links) ? card.links.slice(0, 40).flatMap(link => {
    if (!link || typeof link !== 'object') return [];
    const row = link as Record<string, unknown>;
    const url = linkedUrl(row.url);
    return url ? [{ title: text(row.title, 200) ?? url, url }] : [];
  }) : [];
  const result = delivery && linkedUrl(delivery.result);
  const deliveryText = delivery && [text(delivery.reason, 4000), !result && text(delivery.result, 2000)].filter(Boolean).join('\n');
  return {
    ...(work || summary ? { summary: work && summary && work !== summary ? `${work}\n\n${summary}` : work ?? summary } : {}),
    ...(pending.length ? { pending } : {}),
    ...(delivery && deliveryText ? { delivery: { text: deliveryText, ...(result ? { url: result } : {}), ...(text(delivery.at, 80) ? { at: text(delivery.at, 80) } : {}) } } : {}),
    ...(links.length ? { links } : {}),
  };
}

async function socketBoard(): Promise<BoardReply> {
  const socketPath = process.env.FORJA_AGENT_SOCKET ?? path.join(os.homedir(), '.local', 'state', 'forja', 'agent.sock');
  if (!path.isAbsolute(socketPath)) throw new Error('invalid socket path');
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const chunks: Buffer[] = [];
    let bytes = 0;
    const timer = setTimeout(() => socket.destroy(new Error('Forja board timeout')), 5000);
    socket.on('connect', () => socket.write('{"cmd":"board"}\n'));
    socket.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_REPLY) socket.destroy(new Error('Forja board too large'));
      else chunks.push(chunk);
    });
    socket.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as BoardReply); }
      catch { reject(new Error('invalid Forja board response')); }
    });
    socket.on('error', reject);
    socket.on('close', () => clearTimeout(timer));
  });
}

async function readBounded(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('empty Forja response');
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_REPLY) throw new Error('Forja response too large');
      parts.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return JSON.parse(Buffer.concat(parts.map(p => Buffer.from(p)), bytes).toString('utf8'));
}

async function conversationPage(card: Card, before?: string): Promise<{ events: unknown[]; before: string | null }> {
  const configFile = process.env.TOWER_FORJA_CONFIG ?? path.join(os.homedir(), '.config', 'forja', 'config.json');
  const config = JSON.parse(await readFile(configFile, 'utf8')) as Config;
  const configured = config.publicUrl ? new URL(config.publicUrl) : null;
  const local = config.listen?.host && config.listen.port ? new URL(`http://${config.listen.host}:${config.listen.port}`) : null;
  const origin = process.env.TOWER_FORJA_ORIGIN ? new URL(process.env.TOWER_FORJA_ORIGIN) : configured ?? local;
  if (!origin || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash ||
    !(configured && configured.protocol === 'https:' && origin.origin === configured.origin ||
      local && ['127.0.0.1', '[::1]'].includes(local.hostname) && origin.origin === local.origin)) throw new Error('Forja origin not allowed');
  const headers: Record<string, string> = {};
  if (config.auth?.mode === 'cloudflare-access') {
    const tokenFile = process.env.TOWER_FORJA_SERVICE_TOKEN_FILE ?? path.join(os.homedir(), '.config', 'forja', 'service-token.json');
    const credentials = JSON.parse(await readFile(tokenFile, 'utf8')) as { client_id?: unknown; client_secret?: unknown };
    if (typeof credentials.client_id !== 'string' || typeof credentials.client_secret !== 'string') throw new Error('Forja credentials unavailable');
    headers['CF-Access-Client-Id'] = credentials.client_id;
    headers['CF-Access-Client-Secret'] = credentials.client_secret;
  } else if (config.auth?.mode !== 'none' || origin.origin !== local?.origin) throw new Error('Forja authentication unavailable');
  if (typeof card.sessionId === 'string') headers['x-forja-session-id'] = card.sessionId;
  const url = new URL(`/api/cards/${encodeURIComponent(String(card.id))}/conversation`, origin);
  url.searchParams.set('limit', String(FORJA_TURNS));
  if (before) url.searchParams.set('before', before);
  const response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`Forja history HTTP ${response.status}`);
  const body = await readBounded(response);
  if (!body || typeof body !== 'object') throw new Error('invalid Forja history');
  const page = body as { events?: unknown; before?: unknown };
  if (!Array.isArray(page.events) || !(page.before === null || typeof page.before === 'string')) throw new Error('invalid Forja history');
  return { events: page.events, before: page.before };
}

function mapEvent(raw: unknown): FeedItem | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const event = raw as Record<string, unknown>;
  const id = text(event.id, 200);
  const at = typeof event.at === 'string' ? Date.parse(event.at) : event.at;
  if (!id || typeof at !== 'number' || !Number.isFinite(at)) return undefined;
  if (event.k === 'user' && typeof event.text === 'string') return { type: 'user_message', id, at, text: event.text };
  if (event.k === 'text' && typeof event.md === 'string') return { type: 'agent_message', id, at, text: event.md };
  if (event.k === 'thinking') return { type: 'thought', id, at, text: text(event.text, 8000) ?? 'Thinking' };
  if (event.k === 'tool' || event.k === 'edit' || event.k === 'agent') {
    const title = text(event.label, 400) ?? text(event.description, 400) ?? text(event.file, 400) ?? text(event.name, 400) ?? text(event.tool, 400) ?? 'Tool';
    const status = event.status === 'failed' || event.error === true ? 'failed' : event.status === 'done' ? 'completed' : 'in_progress';
    return { type: 'tool_call', id, at, toolCallId: id, title, status,
      ...(text(event.kind, 80) ? { toolKind: text(event.kind, 80) } : {}),
      ...(text(event.path, 400) ?? text(event.cmd, 400) ? { detail: text(event.path, 400) ?? text(event.cmd, 400) } : {}),
      ...(text(event.summary, 8000) ? { output: text(event.summary, 8000) } : {}),
    };
  }
  if (event.k === 'notice' || event.k === 'error' || event.k === 'command' || event.k === 'compact' || event.k === 'question')
    return { type: 'status', id, at, text: text(event.text, 8000) ?? (event.k === 'compact' ? 'Context compacted' : event.k === 'question' ? 'Agent asked a question' : 'Notice') };
  return undefined;
}

export async function sessionWorkspace(manager: Manager, id: string, before?: string): Promise<{ code: number; body: SessionWorkspace | { error: string } }> {
  const agent = manager.getAgent(id);
  if (!agent) return { code: 404, body: { error: 'agent not found' } };
  if (before && (before.length > 4096 || !/^[A-Za-z0-9_=-]+$/.test(before))) return { code: 400, body: { error: 'invalid cursor' } };
  if (agent.source === 'tower') {
    const feed = manager.getFeed(id) ?? [];
    const end = before ? feed.findIndex(item => item.id === before.slice(2)) : feed.length;
    if (before && (!before.startsWith('t_') || end < 0)) return { code: 400, body: { error: 'invalid cursor' } };
    const start = Math.max(0, end - PAGE);
    const items = feed.slice(start, end);
    const summary = [agent.task, ...(agent.plan?.length ? ['Plan:', ...agent.plan.map(p => `• ${p.content} (${p.status})`)] : [])].filter(Boolean).join('\n');
    const pending = [...(agent.questions ?? []).map(q => ({ text: q.text, ...(q.recommendation ? { recommendation: q.recommendation } : {}) })), ...(agent.pendingPermission ? [{ text: agent.pendingPermission.title }] : [])];
    return { code: 200, body: { conversation: { available: true, items, hasMore: start > 0, ...(start > 0 ? { before: `t_${feed[start]!.id}` } : {}) }, context: { ...(summary ? { summary } : {}), ...(pending.length ? { pending } : {}), ...(agent.status === 'done' && agent.lastMessage ? { delivery: { text: agent.lastMessage } } : {}) } } };
  }
  const session = manager.tmuxTarget(id);
  if (!session || !tmuxAllowed(session)) return { code: 409, body: { error: 'tmux card not allowed' } };
  if (process.env.TOWER_TMUX_REDACT !== '0') return { code: 200, body: unavailable('Session details hidden in demo mode') };
  let card: Card | undefined;
  try {
    const board = await socketBoard();
    if (!board.ok || !Array.isArray(board.state?.cards)) throw new Error('Forja board unavailable');
    const matches = board.state.cards.filter(c => c?.session === session && (c.kind === 'session' || c.kind === 'routine'));
    if (matches.length === 1) card = matches[0];
  } catch { return { code: 200, body: unavailable('Session context is temporarily unavailable') }; }
  if (!card || card.agent !== agent.kind || typeof card.id !== 'string' || typeof card.sessionId !== 'string') return { code: 200, body: unavailable('Session details are not available yet') };
  let publicOrigin: string | undefined;
  try {
    const config = JSON.parse(await readFile(process.env.TOWER_FORJA_CONFIG ?? path.join(os.homedir(), '.config', 'forja', 'config.json'), 'utf8')) as Config;
    const candidate = config.publicUrl && new URL(config.publicUrl);
    if (candidate && candidate.protocol === 'https:' && !candidate.username && !candidate.password && candidate.pathname === '/' && !candidate.search && !candidate.hash) publicOrigin = candidate.origin;
  } catch { /* web links remain available without a public file origin */ }
  const context = cardContext(card, publicOrigin);
  if (agent.kind !== 'claude') return { code: 200, body: unavailable('History unavailable for this session', context) };
  const localPage = async (): Promise<SessionWorkspace> => {
    const conversation = await readLocalHistory(session, before?.startsWith('lh_') ? before.slice(3) : undefined);
    if (conversation.before) conversation.before = `lh_${conversation.before}`;
    return { conversation, context };
  };
  if (before?.startsWith('lh_') || card.conversation !== true) {
    if (before && !before.startsWith('lh_')) return { code: 400, body: { error: 'history cursor is stale; reload the conversation' } };
    const body = await localPage();
    if (before && !body.conversation.available) return { code: 409, body: { error: body.conversation.reason ?? 'history unavailable' } };
    return { code: 200, body };
  }
  try {
    const page = await conversationPage(card, before);
    const items: FeedItem[] = [];
    for (const event of page.events) { const item = mapEvent(event); if (item) items.push(item); }
    return { code: 200, body: { conversation: { available: true, items, hasMore: !!page.before, ...(page.before ? { before: page.before } : {}) }, context } };
  } catch {
    if (before) return { code: 409, body: { error: 'History changed or is temporarily unavailable; reload the conversation' } };
    const local = await localPage();
    return { code: 200, body: local.conversation.available ? local : unavailable('History temporarily unavailable', context) };
  }
}
