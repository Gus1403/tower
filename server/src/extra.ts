// Wave B routes that live outside http.ts (worker BS2 owns this file): tmux send/key/screen, uploads, notes.
// handleExtra returns true when it handled the request. http.ts calls it after auth, before its own routes.
import type http from 'node:http';
import type { ServerEvent } from '../../shared/contract.js';
import type { AgentManager } from './agents.js';

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

export async function handleExtra(_ctx: ExtraCtx): Promise<boolean> {
  return false;
}
