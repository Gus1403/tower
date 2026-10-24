import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import type { AgentManager } from './agents.js';
import type { LaunchRequest, ServerEvent } from '../../shared/contract.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_DIST = path.join(REPO_ROOT, 'web', 'dist');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
  '.webp': 'image/webp',
};

function tokenEq(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

export function createServer(manager: AgentManager, token: string) {
  const clients = new Set<WebSocket>();

  const send = (ev: ServerEvent) => {
    const data = JSON.stringify(ev);
    for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(data);
  };
  manager.on('agent', (agent) => send({ type: 'agent', agent }));
  manager.on('feed', (agentId, item) => send({ type: 'feed', agentId, item }));
  manager.on('capacity', (capacity) => send({ type: 'capacity', capacity }));

  const authed = (req: http.IncomingMessage): boolean => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const q = url.searchParams.get('token');
    if (q && tokenEq(q, token)) return true;
    const h = req.headers.authorization;
    if (h?.startsWith('Bearer ') && tokenEq(h.slice(7), token)) return true;
    return false;
  };

  const json = (res: http.ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const readBody = (req: http.IncomingMessage): Promise<unknown> =>
    new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (c) => {
        data += c;
        if (data.length > 1_000_000) reject(new Error('body too large'));
      });
      req.on('end', () => {
        if (!data) return resolve({});
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error('invalid JSON'));
        }
      });
      req.on('error', reject);
    });

  const serveStatic = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!existsSync(WEB_DIST)) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('tower: web UI not built yet (run npm run build)\n');
      return;
    }
    let p = decodeURIComponent(url.pathname);
    if (p === '/') p = '/index.html';
    let file = path.join(WEB_DIST, p);
    if (!file.startsWith(WEB_DIST + path.sep) && file !== WEB_DIST) {
      res.writeHead(403).end();
      return;
    }
    if (!existsSync(file) || !statSync(file).isFile()) {
      file = path.join(WEB_DIST, 'index.html'); // SPA fallback
    }
    const ext = path.extname(file);
    res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream' });
    res.end(await readFile(file));
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const p = url.pathname;
      if (!p.startsWith('/api/')) {
        if (req.method === 'GET' || req.method === 'HEAD') return await serveStatic(req, res);
        return json(res, 404, { error: 'not found' });
      }
      if (!authed(req)) return json(res, 401, { error: 'unauthorized' });
      const state = () => manager.state(os.hostname());

      if (req.method === 'GET' && p === '/api/state') return json(res, 200, state());

      const feedMatch = p.match(/^\/api\/agents\/([^/]+)\/feed$/);
      if (req.method === 'GET' && feedMatch) {
        const feed = manager.getFeed(feedMatch[1]);
        if (!feed) return json(res, 404, { error: 'no such agent' });
        return json(res, 200, feed);
      }

      if (req.method === 'POST' && p === '/api/agents') {
        const body = (await readBody(req)) as Partial<LaunchRequest>;
        const kinds = ['devin', 'claude', 'codex'];
        if (!body || typeof body !== 'object' || !kinds.includes(body.kind as string)) {
          return json(res, 400, { error: 'kind must be devin|claude|codex' });
        }
        if (typeof body.task !== 'string' || !body.task.trim()) {
          return json(res, 400, { error: 'task is required' });
        }
        if (body.name != null && typeof body.name !== 'string') {
          return json(res, 400, { error: 'name must be a string' });
        }
        if (body.model != null && typeof body.model !== 'string') {
          return json(res, 400, { error: 'model must be a string' });
        }
        const agent = await manager.launch({
          kind: body.kind as LaunchRequest['kind'],
          task: body.task,
          name: body.name,
          model: body.model,
        });
        return json(res, 201, agent);
      }

      const actMatch = p.match(/^\/api\/agents\/([^/]+)\/(prompt|permission|stop)$/);
      if (req.method === 'POST' && actMatch) {
        const [, id, action] = actMatch;
        if (!manager.getAgent(id)) return json(res, 404, { error: 'no such agent' });
        if (action === 'prompt') {
          const body = (await readBody(req)) as { text?: unknown };
          if (typeof body.text !== 'string' || !body.text.trim()) {
            return json(res, 400, { error: 'text is required' });
          }
          const r = manager.prompt(id, body.text);
          if (r === 'conflict') return json(res, 409, { error: 'agent is busy' });
          return json(res, 202, { ok: true });
        }
        if (action === 'permission') {
          const body = (await readBody(req)) as { requestId?: unknown; optionId?: unknown };
          if (typeof body.requestId !== 'string' || typeof body.optionId !== 'string') {
            return json(res, 400, { error: 'requestId and optionId are required' });
          }
          const r = manager.answerPermission(id, body.requestId, body.optionId);
          if (r === 'notfound') return json(res, 404, { error: 'no such pending request' });
          return json(res, 200, { ok: true });
        }
        // stop
        await manager.stop(id);
        return json(res, 200, { ok: true });
      }

      return json(res, 404, { error: 'not found' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = msg === 'invalid JSON' || msg === 'body too large' ? 400 : 500;
      if (!res.headersSent) json(res, code, { error: msg });
      else res.end();
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.send(JSON.stringify({ type: 'snapshot', state: manager.state(os.hostname()) } satisfies ServerEvent));
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/api/ws' || !authed(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  return server;
}
