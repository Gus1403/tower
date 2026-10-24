// Unix socket for agent-side commands (`tower ask`). Path: <data dir>/agent.sock, mode 600, no token.
// Protocol: one JSON object per line {cmd:'ask', agentId, text, recommendation?} -> one JSON line {ok, questionId?|error}.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { dataDir } from './uploads.js';

export type AskResult = { ok: true; questionId: string } | { ok: false; error: string };
export interface AskManager {
  ask?(agentId: string, text: string, recommendation?: string): AskResult | Promise<AskResult>;
}

export function agentSocketPath(): string {
  return path.join(dataDir(), 'agent.sock');
}

async function handleLine(manager: AskManager, line: string): Promise<unknown> {
  let req: { cmd?: unknown; agentId?: unknown; text?: unknown; recommendation?: unknown };
  try {
    req = JSON.parse(line);
  } catch {
    return { ok: false, error: 'invalid JSON' };
  }
  if (!req || typeof req !== 'object') return { ok: false, error: 'invalid request' };
  if (req.cmd !== 'ask') return { ok: false, error: 'unknown cmd' };
  if (typeof req.agentId !== 'string' || !req.agentId) return { ok: false, error: 'agentId is required' };
  if (typeof req.text !== 'string' || !req.text.trim()) return { ok: false, error: 'text is required' };
  const rec = typeof req.recommendation === 'string' && req.recommendation.trim() ? req.recommendation : undefined;
  if (typeof manager.ask !== 'function') return { ok: false, error: 'ask not supported' };
  try {
    return await manager.ask(req.agentId, req.text.slice(0, 4000), rec?.slice(0, 2000));
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'ask failed' };
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
