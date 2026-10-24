import { EventEmitter } from 'node:events';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acp from '@agentclientprotocol/sdk';
import type {
  AgentKind,
  AgentStatus,
  AgentSummary,
  Capacity,
  FeedItem,
  LaunchRequest,
  PermissionRequest,
  PlanEntry,
} from '../../shared/contract.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FEED_CAP = 2000;
const STDERR_CAP = 200;
const STUCK_CHECK_MS = 5000;

const KIND_LABEL: Record<AgentKind, string> = {
  devin: 'Devin',
  claude: 'Claude Code',
  codex: 'Codex',
};

function newId(len = 5): string {
  return randomBytes(8)
    .toString('base64url')
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, len);
}

function splitCommand(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function preview(v: unknown, max = 400): string | undefined {
  if (v == null) return undefined;
  let s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s == null) return undefined;
  return s.length > max ? s.slice(0, max) : s;
}

function blockText(content: acp.ContentBlock | undefined): string {
  if (!content) return '';
  if (content.type === 'text') return content.text;
  return `[${content.type}]`;
}

function onPath(cmd: string): boolean {
  if (cmd.includes('/')) return existsSync(cmd);
  const r = spawnSync('which', [cmd], { stdio: 'ignore' });
  return r.status === 0;
}

interface PendingPermission {
  request: PermissionRequest;
  resolve: (r: acp.RequestPermissionResponse) => void;
}

interface ToolState {
  title?: string;
  kind?: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  detail?: string;
}

interface AgentEntry {
  summary: AgentSummary;
  cwd: string;
  proc?: ChildProcess;
  conn?: acp.ClientSideConnection;
  sessionId?: string;
  feed: FeedItem[];
  tools: Map<string, ToolState>;
  pending?: PendingPermission;
  stderr: string[];
  lastMsgId: Partial<Record<'agent_message' | 'thought' | 'user_message', string>>;
  lastUpdateKind?: string;
  turnRunning: boolean;
  stopping: boolean;
  errored: boolean;
}

export interface AgentManagerEvents {
  agent: (a: AgentSummary) => void;
  feed: (agentId: string, item: FeedItem) => void;
  capacity: (c: Capacity[]) => void;
}

export declare interface AgentManager {
  on<E extends keyof AgentManagerEvents>(ev: E, fn: AgentManagerEvents[E]): this;
  emit<E extends keyof AgentManagerEvents>(ev: E, ...args: Parameters<AgentManagerEvents[E]>): boolean;
}

export class AgentManager extends EventEmitter {
  private agents = new Map<string, AgentEntry>();
  private stuckMs: number;
  private workDir: string;
  private counter = 0;
  private lastCapacityJson = '';
  private loggedUnknown = new Set<string>();
  private timer?: NodeJS.Timeout;

  constructor(opts: { workDir: string; stuckMs: number }) {
    super();
    this.workDir = opts.workDir;
    this.stuckMs = opts.stuckMs;
    mkdirSync(this.workDir, { recursive: true });
    this.timer = setInterval(() => this.checkStuck(), STUCK_CHECK_MS);
    this.timer.unref();
    this.broadcastCapacity();
  }

  private nid(prefix: string): string {
    return `${prefix}-${++this.counter}-${randomBytes(3).toString('hex')}`;
  }

  private setStatus(e: AgentEntry, s: AgentStatus, extra?: Partial<AgentSummary>) {
    e.summary = { ...e.summary, status: s, ...extra };
    this.emit('agent', e.summary);
    this.broadcastCapacity();
  }

  private pushFeed(e: AgentEntry, item: FeedItem) {
    const idx = e.feed.findIndex((f) => f.id === item.id);
    if (idx >= 0) e.feed[idx] = item;
    else {
      e.feed.push(item);
      if (e.feed.length > FEED_CAP) e.feed.splice(0, e.feed.length - FEED_CAP);
    }
    this.emit('feed', e.summary.id, item);
  }

  private touch(e: AgentEntry) {
    e.summary.lastActivityAt = Date.now();
    if (e.summary.status === 'stuck') {
      e.summary.status = 'working';
    }
    this.emit('agent', e.summary);
  }

  private commandFor(kind: AgentKind, model?: string): string[] {
    const envKey = `TOWER_CMD_${kind.toUpperCase()}`;
    const override = process.env[envKey];
    if (override) return splitCommand(override);
    if (kind === 'devin') {
      const cmd = ['devin', 'acp'];
      if (model) cmd.push('--model', model);
      return cmd;
    }
    const bin = kind === 'claude' ? 'claude-agent-acp' : 'codex-acp';
    return [path.join(REPO_ROOT, 'node_modules', '.bin', bin)];
  }

  async launch(req: LaunchRequest): Promise<AgentSummary> {
    const id = newId();
    const cwd = path.join(this.workDir, id);
    mkdirSync(cwd, { recursive: true });
    const name = req.name?.trim() || req.task.trim().split(/\s+/).slice(0, 4).join(' ');
    const e: AgentEntry = {
      summary: {
        id,
        kind: req.kind,
        name,
        task: req.task,
        cwd,
        model: req.model,
        source: 'tower',
        status: 'starting',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        toolCalls: 0,
      },
      cwd,
      feed: [],
      tools: new Map(),
      stderr: [],
      lastMsgId: {},
      turnRunning: false,
      stopping: false,
      errored: false,
    };
    this.agents.set(id, e);
    this.emit('agent', e.summary);
    this.broadcastCapacity();
    this.startProcess(e, req).catch((err) => {
      e.errored = true;
      const tail = e.stderr.slice(-20).join('\n');
      const msg = oneLine(`${String(err?.message ?? err)}${tail ? `: ${tail}` : ''}`, 400);
      this.setStatus(e, 'error', { error: msg });
    });
    return e.summary;
  }

  private async startProcess(e: AgentEntry, req: LaunchRequest): Promise<void> {
    const cmd = this.commandFor(req.kind, req.model);
    console.log(`[tower] spawn agent ${e.summary.id} (${req.kind}): ${cmd.join(' ')}`);
    let proc: ChildProcess;
    try {
      proc = spawn(cmd[0], cmd.slice(1), {
        cwd: e.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
      });
    } catch (err) {
      throw new Error(`spawn failed: ${String(err)}`);
    }
    e.proc = proc;
    proc.stderr!.setEncoding('utf8');
    proc.stderr!.on('data', (d: string) => {
      for (const line of d.split('\n')) {
        if (!line) continue;
        e.stderr.push(line);
        if (e.stderr.length > STDERR_CAP) e.stderr.shift();
      }
    });
    proc.on('error', (err) => {
      e.errored = true;
      this.setStatus(e, 'error', { error: `spawn error: ${err.message}` });
    });
    proc.on('exit', (code, signal) => {
      if (e.stopping) return;
      if (e.errored || e.summary.status === 'error') return;
      const tail = e.stderr.slice(-20).join('\n');
      e.errored = true;
      this.cancelPending(e);
      this.setStatus(e, 'error', {
        error: oneLine(`process exited (code ${code}, signal ${signal})${tail ? ': ' + tail : ''}`, 400),
      });
    });

    const stream = acp.ndJsonStream(
      Writable.toWeb(proc.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>,
    );
    const conn = new acp.ClientSideConnection(() => this.clientFor(e), stream);
    e.conn = conn;

    const init = await conn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
      clientInfo: { name: 'tower', version: '0.1.0' },
    });
    const authMethods = (init as { authMethods?: Array<{ id: string }> }).authMethods ?? [];

    let session;
    try {
      session = await conn.newSession({ cwd: e.cwd, mcpServers: [] });
    } catch (err) {
      if (authMethods.length > 0) {
        console.log(`[tower] agent ${e.summary.id} requires auth, trying ${authMethods[0].id}`);
        await conn.authenticate({ methodId: authMethods[0].id });
        session = await conn.newSession({ cwd: e.cwd, mcpServers: [] });
      } else {
        throw err;
      }
    }
    e.sessionId = session.sessionId;
    this.pushFeed(e, { type: 'status', id: this.nid('st'), at: Date.now(), text: 'Started' });
    await this.runPrompt(e, req.task);
  }

  private clientFor(e: AgentEntry): acp.Client {
    return {
      sessionUpdate: (params) => this.onSessionUpdate(e, params),
      requestPermission: (params) => this.onRequestPermission(e, params),
      readTextFile: async (params) => ({ content: await this.guardedRead(e, params.path) }),
      writeTextFile: async (params) => {
        this.guardPath(e, params.path);
        await writeFile(params.path, params.content, 'utf8');
        return {};
      },
    };
  }

  private guardPath(e: AgentEntry, p: string): string {
    const resolved = path.resolve(p);
    let root = path.resolve(e.cwd);
    try {
      root = realpathSync(root); // macOS: /tmp -> /private/tmp
    } catch {
      /* keep unresolved */
    }
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new Error(`path outside agent cwd: ${p}`);
    }
    return resolved;
  }

  private async guardedRead(e: AgentEntry, p: string): Promise<string> {
    const resolved = this.guardPath(e, p);
    return readFile(resolved, 'utf8');
  }

  private onSessionUpdate(e: AgentEntry, params: acp.SessionNotification): void {
    if (params.sessionId !== e.sessionId) return;
    const u = params.update as acp.SessionUpdate & { sessionUpdate: string };
    this.touch(e);
    const kind = u.sessionUpdate;
    const newMessageBoundary = () => {
      e.lastUpdateKind = kind;
    };
    if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk' || kind === 'user_message_chunk') {
      const feedType =
        kind === 'agent_message_chunk' ? 'agent_message' : kind === 'agent_thought_chunk' ? 'thought' : 'user_message';
      const text = blockText((u as acp.ContentChunk).content);
      if (e.lastUpdateKind === kind && e.lastMsgId[feedType]) {
        const id = e.lastMsgId[feedType]!;
        const prev = e.feed.find((f) => f.id === id) as Extract<FeedItem, { type: typeof feedType }> | undefined;
        this.pushFeed(e, { type: feedType, id, at: Date.now(), text: (prev?.text ?? '') + text } as FeedItem);
      } else {
        const id = this.nid(feedType === 'user_message' ? 'usr' : 'msg');
        e.lastMsgId[feedType] = id;
        this.pushFeed(e, { type: feedType, id, at: Date.now(), text } as FeedItem);
      }
      if (feedType === 'agent_message') {
        e.summary.lastMessage = oneLine(text, 280);
        this.emit('agent', e.summary);
      }
      newMessageBoundary();
      return;
    }
    // any non-chunk update breaks message contiguity
    e.lastUpdateKind = kind;
    if (kind === 'tool_call') {
      const t = u as acp.ToolCall & { sessionUpdate: string };
      const st: ToolState = {
        title: t.title,
        kind: t.kind,
        status: t.status ?? 'pending',
        detail: preview(t.rawInput) ?? preview(t.content),
      };
      e.tools.set(t.toolCallId, { ...(e.tools.get(t.toolCallId) ?? { status: 'pending' }), ...st });
      e.summary.toolCalls = e.tools.size;
      e.summary.lastMessage = oneLine(t.title ?? 'tool call', 280);
      this.emitTool(e, t.toolCallId);
      return;
    }
    if (kind === 'tool_call_update') {
      const t = u as acp.ToolCallUpdate & { sessionUpdate: string };
      const prev = e.tools.get(t.toolCallId) ?? { status: 'pending' as const };
      const merged: ToolState = { ...prev };
      if (t.title != null) merged.title = t.title;
      if (t.kind != null) merged.kind = t.kind;
      if (t.status != null) merged.status = t.status;
      const d = preview(t.rawInput) ?? preview(t.content) ?? preview(t.rawOutput);
      if (d) merged.detail = d;
      e.tools.set(t.toolCallId, merged);
      if (merged.title) e.summary.lastMessage = oneLine(merged.title, 280);
      this.emitTool(e, t.toolCallId);
      return;
    }
    if (kind === 'plan' || kind === 'plan_update') {
      const p = u as acp.Plan;
      e.summary.plan = (p.entries ?? []).map(
        (en): PlanEntry => ({
          content: en.content,
          status: en.status === 'in_progress' ? 'in_progress' : en.status === 'completed' ? 'completed' : 'pending',
        }),
      );
      this.emit('agent', e.summary);
      return;
    }
    if (!this.loggedUnknown.has(kind)) {
      this.loggedUnknown.add(kind);
      console.log(`[tower] ignoring unknown sessionUpdate variant: ${kind}`);
    }
  }

  private emitTool(e: AgentEntry, toolCallId: string) {
    const t = e.tools.get(toolCallId)!;
    this.pushFeed(e, {
      type: 'tool_call',
      id: `tool-${toolCallId}`,
      at: Date.now(),
      toolCallId,
      title: t.title ?? '',
      toolKind: t.kind,
      status: t.status,
      detail: t.detail,
    });
    this.emit('agent', e.summary);
  }

  private onRequestPermission(
    e: AgentEntry,
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    const tc = params.toolCall;
    const request: PermissionRequest = {
      requestId: newId(8),
      agentId: e.summary.id,
      title: tc?.title ?? 'Permission requested',
      toolKind: tc?.kind ?? undefined,
      detail: preview(tc?.rawInput) ?? preview(tc?.content),
      options: (params.options ?? []).map((o) => ({
        optionId: o.optionId,
        name: o.name,
        kind: o.kind,
      })),
      createdAt: Date.now(),
    };
    return new Promise<acp.RequestPermissionResponse>((resolve) => {
      e.pending = { request, resolve };
      e.summary.pendingPermission = request;
      this.setStatus(e, 'needs_you');
      this.pushFeed(e, {
        type: 'permission',
        id: `perm-${request.requestId}`,
        at: Date.now(),
        requestId: request.requestId,
        title: request.title,
      });
    });
  }

  private cancelPending(e: AgentEntry) {
    if (!e.pending) return;
    const p = e.pending;
    e.pending = undefined;
    e.summary.pendingPermission = undefined;
    p.resolve({ outcome: { outcome: 'cancelled' } });
    this.resolvePermissionFeed(e, p.request.requestId, 'cancelled');
  }

  private resolvePermissionFeed(e: AgentEntry, requestId: string, resolution: string) {
    const id = `perm-${requestId}`;
    const prev = e.feed.find((f) => f.id === id) as Extract<FeedItem, { type: 'permission' }> | undefined;
    if (prev) this.pushFeed(e, { ...prev, resolution });
  }

  answerPermission(agentId: string, requestId: string, optionId: string): 'ok' | 'notfound' {
    const e = this.agents.get(agentId);
    if (!e?.pending || e.pending.request.requestId !== requestId) return 'notfound';
    const p = e.pending;
    e.pending = undefined;
    e.summary.pendingPermission = undefined;
    p.resolve({ outcome: { outcome: 'selected', optionId } });
    const name = p.request.options.find((o) => o.optionId === optionId)?.name ?? optionId;
    this.resolvePermissionFeed(e, requestId, name);
    this.setStatus(e, 'working');
    return 'ok';
  }

  private async runPrompt(e: AgentEntry, text: string): Promise<void> {
    if (!e.conn || !e.sessionId) throw new Error('agent not ready');
    e.turnRunning = true;
    e.lastUpdateKind = undefined;
    e.lastMsgId = {};
    this.pushFeed(e, { type: 'user_message', id: this.nid('usr'), at: Date.now(), text });
    this.setStatus(e, 'working', { stopReason: undefined });
    try {
      const res = await e.conn.prompt({
        sessionId: e.sessionId,
        prompt: [{ type: 'text', text }],
      });
      e.turnRunning = false;
      if (e.stopping || e.errored) return;
      this.setStatus(e, 'done', { stopReason: res.stopReason });
      this.pushFeed(e, {
        type: 'status',
        id: this.nid('st'),
        at: Date.now(),
        text: `Turn ended: ${res.stopReason}`,
      });
    } catch (err) {
      e.turnRunning = false;
      if (e.stopping) return;
      e.errored = true;
      this.cancelPending(e);
      this.setStatus(e, 'error', { error: oneLine(`prompt failed: ${String(err)}`, 400) });
    }
  }

  prompt(agentId: string, text: string): 'ok' | 'notfound' | 'conflict' {
    const e = this.agents.get(agentId);
    if (!e) return 'notfound';
    if (e.summary.status !== 'done' && e.summary.status !== 'stuck') return 'conflict';
    this.runPrompt(e, text).catch(() => {});
    return 'ok';
  }

  async stop(agentId: string): Promise<boolean> {
    const e = this.agents.get(agentId);
    if (!e) return false;
    e.stopping = true;
    this.cancelPending(e); // (a) permission -> cancelled
    if (e.conn && e.sessionId && e.turnRunning) {
      try {
        await e.conn.cancel({ sessionId: e.sessionId }); // (b) session/cancel
      } catch {
        /* connection may already be gone */
      }
    }
    const proc = e.proc;
    if (proc && proc.exitCode == null && !proc.killed) {
      proc.kill('SIGTERM'); // (c) SIGTERM then SIGKILL after 3 s
      await new Promise<void>((res) => {
        const t = setTimeout(() => {
          try {
            proc.kill('SIGKILL');
          } catch {
            /* already dead */
          }
          res();
        }, 3000);
        proc.once('exit', () => {
          clearTimeout(t);
          res();
        });
      });
    }
    e.turnRunning = false;
    this.setStatus(e, 'stopped');
    this.pushFeed(e, { type: 'status', id: this.nid('st'), at: Date.now(), text: 'Stopped' });
    return true;
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.agents.keys()].map((id) => this.stop(id)));
  }

  private checkStuck() {
    const now = Date.now();
    for (const e of this.agents.values()) {
      if (e.summary.status === 'working' && now - e.summary.lastActivityAt > this.stuckMs) {
        this.setStatus(e, 'stuck');
      }
    }
  }

  private capacityList(): Capacity[] {
    const kinds: AgentKind[] = ['devin', 'claude', 'codex'];
    return kinds.map((kind) => {
      const cmd = this.commandFor(kind);
      const running = [...this.agents.values()].filter(
        (a) => a.summary.kind === kind && a.summary.status !== 'stopped' && a.summary.status !== 'error',
      ).length;
      return { kind, label: KIND_LABEL[kind], available: onPath(cmd[0]), running };
    });
  }

  private broadcastCapacity() {
    const c = this.capacityList();
    const j = JSON.stringify(c);
    if (j === this.lastCapacityJson) return;
    this.lastCapacityJson = j;
    this.emit('capacity', c);
  }

  getAgent(id: string): AgentSummary | undefined {
    return this.agents.get(id)?.summary;
  }

  getFeed(id: string): FeedItem[] | undefined {
    return this.agents.get(id)?.feed;
  }

  state(host: string): { agents: AgentSummary[]; capacity: Capacity[]; host: string } {
    return {
      agents: [...this.agents.values()].map((a) => a.summary),
      capacity: this.capacityList(),
      host,
    };
  }

  shutdown() {
    if (this.timer) clearInterval(this.timer);
  }
}
