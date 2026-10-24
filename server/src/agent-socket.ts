// Unix socket for agent-side commands (`tower ask|send|handoff|agents`). Path: <data dir>/agent.sock, mode 600, no token.
// Protocol: one JSON object per line -> one JSON line {ok, ...|error}.
//   {cmd:'ask', agentId, text, recommendation?}       -> {ok, questionId}
//   {cmd:'send', agentId, to, text}                   -> {ok, agentId, queued}
//   {cmd:'handoff', agentId, task, kind?, board?}     -> {ok, agentId, name}
//   {cmd:'agents', agentId}                           -> {ok, agents:[{id,name,board,customer?,status,kind}]}
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { dataDir } from './uploads.js';

type R = { ok: true; [k: string]: unknown } | { ok: false; error: string };
export type AskResult = { ok: true; questionId: string } | { ok: false; error: string };
export interface AskManager {
  ask?(agentId: string, text: string, recommendation?: string): AskResult | Promise<AskResult>;
  sendMessage?(agentId: string, to: string, text: string): R | Promise<R>;
  handoff?(agentId: string, opts: { task: string; kind?: 'devin' | 'claude' | 'codex'; board?: string }): R | Promise<R>;
  agentsFor?(agentId: string): R | Promise<R>;
}

const MAX_TEXT = 8000;

export function agentSocketPath(): string {
  return path.join(dataDir(), 'agent.sock');
}

async function handleLine(manager: AskManager, line: string): Promise<unknown> {
  let req: {
    cmd?: unknown;
    agentId?: unknown;
    text?: unknown;
    recommendation?: unknown;
    to?: unknown;
    task?: unknown;
    kind?: unknown;
    board?: unknown;
  };
  try {
    req = JSON.parse(line);
  } catch {
    return { ok: false, error: 'invalid JSON' };
  }
  if (!req || typeof req !== 'object') return { ok: false, error: 'invalid request' };
  if (!['ask', 'send', 'handoff', 'agents'].includes(req.cmd as string)) return { ok: false, error: 'unknown cmd' };
  if (typeof req.agentId !== 'string' || !req.agentId) return { ok: false, error: 'agentId is required' };
  const agentId = req.agentId;
  try {
    if (req.cmd === 'agents') {
      if (typeof manager.agentsFor !== 'function') return { ok: false, error: 'agents not supported' };
      return await manager.agentsFor(agentId);
    }
    if (req.cmd === 'send') {
      if (typeof req.to !== 'string' || !req.to.trim()) return { ok: false, error: 'to is required' };
      if (typeof req.text !== 'string' || !req.text.trim()) return { ok: false, error: 'text is required' };
      if (req.text.length > MAX_TEXT) return { ok: false, error: `text too long (max ${MAX_TEXT} chars)` };
      if (typeof manager.sendMessage !== 'function') return { ok: false, error: 'send not supported' };
      return await manager.sendMessage(agentId, req.to.trim(), req.text);
    }
    if (req.cmd === 'handoff') {
      if (typeof req.task !== 'string' || !req.task.trim()) return { ok: false, error: 'task is required' };
      if (req.task.length > MAX_TEXT) return { ok: false, error: `task too long (max ${MAX_TEXT} chars)` };
      if (req.kind != null && !['devin', 'claude', 'codex'].includes(req.kind as string)) {
        return { ok: false, error: 'kind must be devin|claude|codex' };
      }
      if (req.board != null && typeof req.board !== 'string') return { ok: false, error: 'board must be a string' };
      if (typeof manager.handoff !== 'function') return { ok: false, error: 'handoff not supported' };
      return await manager.handoff(agentId, {
        task: req.task,
        kind: (req.kind as 'devin' | 'claude' | 'codex' | undefined) ?? undefined,
        board: (req.board as string | undefined) ?? undefined,
      });
    }
    // ask
    if (typeof req.text !== 'string' || !req.text.trim()) return { ok: false, error: 'text is required' };
    const rec = typeof req.recommendation === 'string' && req.recommendation.trim() ? req.recommendation : undefined;
    if (typeof manager.ask !== 'function') return { ok: false, error: 'ask not supported' };
    return await manager.ask(agentId, req.text.slice(0, 4000), rec?.slice(0, 2000));
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : `${String(req.cmd)} failed` };
  }
}

export function startAgentSocket(manager: AskManager, sockPath: string = agentSocketPath()): () => void {
  fs.mkdirSync(path.dirname(sockPath), { recursive: true, mode: 0o700 });
  try {
    fs.unlinkSync(sockPath);
  } catch {
    /* no stale socket */
  }
  const server = net.createServer((conn) => {
    let buf = '';
    conn.setEncoding('utf8');
    conn.on('error', () => {});
    conn.on('data', (chunk: string) => {
      buf += chunk;
      if (buf.length > 64 * 1024) {
        conn.end(JSON.stringify({ ok: false, error: 'request too large' }) + '\n');
        return;
      }
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        void handleLine(manager, line).then((reply) => {
          if (!conn.destroyed) conn.write(JSON.stringify(reply) + '\n');
        });
      }
    });
  });
  server.on('error', (e) => console.error(`tower: agent socket error: ${e.message}`));
  server.listen(sockPath, () => {
    try {
      fs.chmodSync(sockPath, 0o600);
    } catch {
      /* ignore */
    }
  });
  return () => {
    server.close();
    try {
      fs.unlinkSync(sockPath);
    } catch {
      /* ignore */
    }
  };
}
