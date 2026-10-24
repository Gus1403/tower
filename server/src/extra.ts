// Wave B routes that live outside http.ts (worker BS2 owns this file): tmux send/key/screen, uploads.
// handleExtra returns true when it handled the request. http.ts calls it after auth, before its own routes.
import type http from 'node:http';
import type { ServerEvent } from '../../shared/contract.js';
import type { AgentManager } from './agents.js';
import { saveUpload } from './uploads.js';
import type { Rotation } from './rotation.js';
import { ALLOWED_KEYS, MAX_SEND_CHARS, formatTarget, tmuxAllowed, tmuxKey, tmuxScreen, tmuxSend } from './tmux-control.js';
import { sessionWorkspace } from './session-workspace.js';

export interface ExtraCtx {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  path: string;
  url: URL;
  manager: AgentManager;
  send: (ev: ServerEvent) => void;
  json: (res: http.ServerResponse, code: number, body: unknown) => void;
  readBody: (req: http.IncomingMessage) => Promise<unknown>;
}

// Narrow view of the manager: tmuxTarget is added by BS1; optional so this compiles before and after.
type Mgr = Pick<AgentManager, 'getAgent'> & { tmuxTarget?(agentId: string): string | undefined };

export async function handleExtra(ctx: ExtraCtx): Promise<boolean> {
  const { req, res, path: p, url, json } = ctx;
  const rot = (ctx.manager as { rotation?: unknown }).rotation as Rotation | undefined;
  rot?.bindSend?.(ctx.send);

  // ---- Wave C: rotation routes ----
  if (rot && req.method === 'POST') {
    const ma = p.match(/^\/api\/accounts\/([^/]+)\/(clear|exclude)$/);
    if (ma || p === '/api/rotation') {
      let body: { excluded?: unknown; autoRotate?: unknown } = {};
      if (!ma || ma[2] === 'exclude') {
        try {
          body = ((await ctx.readBody(req)) ?? {}) as typeof body;
        } catch {
          json(res, 400, { error: 'invalid JSON' });
          return true;
        }
      }
      if (!ma) {
        if (typeof body.autoRotate !== 'boolean') {
          json(res, 400, { error: 'autoRotate must be a boolean' });
          return true;
        }
        json(res, 200, rot.setAutoRotate(body.autoRotate));
        return true;
      }
      const id = decodeURIComponent(ma[1]!);
      if (ma[2] === 'exclude' && typeof body.excluded !== 'boolean') {
        json(res, 400, { error: 'excluded must be a boolean' });
        return true;
      }
      const acc = ma[2] === 'clear' ? rot.clear(id) : rot.setExcluded(id, body.excluded as boolean);
      if (!acc) json(res, 404, { error: 'account not found' });
      else json(res, 200, acc);
      return true;
    }
  }

  if (req.method === 'POST' && p === '/api/uploads') {
    const r = await saveUpload(req, url.searchParams.get('name'));
    if (r.ok) {
      json(res, 201, { id: r.upload.id, name: r.upload.name, size: r.upload.size });
    } else {
      res.setHeader('connection', 'close');
      json(res, r.code, { error: r.error });
      if (r.code === 413) res.on('finish', () => req.destroy());
    }
    return true;
  }

  const workspace = p.match(/^\/api\/agents\/([^/]+)\/workspace$/);
  if (req.method === 'GET' && workspace) {
    const result = await sessionWorkspace(ctx.manager, decodeURIComponent(workspace[1]!), url.searchParams.get('before') ?? undefined);
    json(res, result.code, result.body);
    return true;
  }

  const m = p.match(/^\/api\/agents\/([^/]+)\/(send|key|screen)$/);
  if (!m) return false;
  const action = m[2];
  if ((action === 'screen' && req.method !== 'GET') || (action !== 'screen' && req.method !== 'POST')) return false;
  const id = decodeURIComponent(m[1]);
  const mgr = ctx.manager as unknown as Mgr;
  const agent = mgr.getAgent(id);
  if (!agent) {
    json(res, 404, { error: 'agent not found' });
    return true;
  }
  if (agent.source !== 'tmux' || process.env.TOWER_TMUX_INTERACTIVE !== '1') {
    json(res, 409, { error: 'tmux control not enabled for this card' });
    return true;
  }
  const session = mgr.tmuxTarget?.(id);
  if (!session) {
    json(res, 409, { error: 'tmux session not available' });
    return true;
  }
  if (!tmuxAllowed(session)) {
    json(res, 409, { error: 'tmux control not enabled for this card (TOWER_TMUX_ALLOW)' });
    return true;
  }
  const target = formatTarget(session);
  try {
    if (action === 'screen') {
      json(res, 200, await tmuxScreen(target));
      return true;
    }
    let body: { text?: unknown; key?: unknown };
    try {
      body = (await ctx.readBody(req)) as typeof body;
    } catch {
      json(res, 400, { error: 'invalid JSON' });
      return true;
    }
    if (action === 'send') {
      if (typeof body.text !== 'string' || !body.text) {
        json(res, 400, { error: 'text is required' });
        return true;
      }
      if (body.text.length > MAX_SEND_CHARS) {
        json(res, 400, { error: `text too long (max ${MAX_SEND_CHARS})` });
        return true;
      }
      await tmuxSend(target, body.text);
    } else {
      if (typeof body.key !== 'string' || !(ALLOWED_KEYS as readonly string[]).includes(body.key)) {
        json(res, 400, { error: `key must be one of ${ALLOWED_KEYS.join('|')}` });
        return true;
      }
      await tmuxKey(target, body.key);
    }
    json(res, 200, { ok: true });
  } catch {
    json(res, 500, { error: 'tmux command failed' });
  }
  return true;
}
