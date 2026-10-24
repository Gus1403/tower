import { EventEmitter } from 'node:events';
import { spawn, spawnSync, execFile, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { randomBytes, createHash } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acp from '@agentclientprotocol/sdk';
import type {
  ConfigOption,
  AgentKind,
  AgentStatus,
  AgentSummary,
  Capacity,
  FeedItem,
  StateResponse,
  LaunchRequest,
  PermissionRequest,
  PlanEntry,
} from '../../shared/contract.js';
import type { AccountsPort, PersistedAgent, StorePort } from './ports.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TMUX_LIST = path.join(REPO_ROOT, 'probes', 'tmux-list.sh');
const FEED_CAP = 2000;
const PERSIST_FEED = 500;
const OUTPUT_CAP = 8000;
const SAVE_DEBOUNCE_MS = 1000;

function normalizeConfig(raw: unknown): ConfigOption[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ConfigOption[] = [];
  for (const o of raw as Array<Record<string, unknown>>) {
    if (!o || o.type !== 'select' || typeof o.id !== 'string') continue;
    const opts: { value: string; name: string }[] = [];
    for (const x of (o.options as Array<Record<string, unknown>>) ?? []) {
      if (Array.isArray(x?.options)) {
        for (const y of x.options as Array<Record<string, unknown>>) {
          if (typeof y?.value === 'string') opts.push({ value: y.value, name: String(y.name ?? y.value) });
        }
      } else if (typeof x?.value === 'string') opts.push({ value: x.value, name: String(x.name ?? x.value) });
    }
    out.push({
      id: o.id,
      name: String(o.name ?? o.id),
      currentValue: typeof o.currentValue === 'string' ? o.currentValue : undefined,
      options: opts,
    });
  }
  return out;
}

function outputText(rawOutput: unknown, content: unknown): string | undefined {
  let s = '';
  if (Array.isArray(content)) {
    for (const c of content as Array<Record<string, unknown>>) {
      const inner = c?.type === 'content' ? (c.content as Record<string, unknown>) : c;
      if (inner?.type === 'text' && typeof inner.text === 'string') s += (s ? '\n' : '') + inner.text;
    }
  }
  if (!s && rawOutput != null) s = typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput) ?? '';
  if (!s) return undefined;
  return s.length > OUTPUT_CAP ? s.slice(0, OUTPUT_CAP) : s;
}
const STDERR_CAP = 200;
const STUCK_CHECK_MS = 5000;
const CAPACITY_REFRESH_MS = 60_000;
const TMUX_POLL_MS = 15_000;

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

interface TmuxEntry {
  summary: AgentSummary;
}

interface ToolState {
  title?: string;
  kind?: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  detail?: string;
  output?: string;
}

interface AgentEntry {
  summary: AgentSummary;
  cwd: string;
  proc?: ChildProcess;
  conn?: acp.ClientSideConnection;
  sessionId?: string;
  feed: FeedItem[];
  tools: Map<string, ToolState>;
  pendingQueue: PendingPermission[];
  stderr: string[];
  lastMsgId: Partial<Record<'agent_message' | 'thought' | 'user_message', string>>;
  lastUpdateKind?: string;
  turnRunning: boolean;
  turnPromise?: Promise<void>;
  stopping: boolean;
  errored: boolean;
  replaying?: boolean;
  holdDrain?: boolean;
}

export interface AgentManagerEvents {
  agent: (a: AgentSummary) => void;
  agent_removed: (agentId: string) => void;
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
  private capTimer?: NodeJS.Timeout;
  private tmuxTimer?: NodeJS.Timeout;
  private capExtra: Partial<Record<AgentKind, { available?: boolean; detail?: string }>> = {};
  private tmuxAgents = new Map<string, TmuxEntry>(); // keyed by id
  private tmuxNums = new Map<string, number>(); // session -> stable n
  private tmuxNextN = 1;
  private tmuxPolling = false;
  private capRefreshing = false;
  private accounts?: AccountsPort;
  private store?: StorePort;
  private saveTimer?: NodeJS.Timeout;

  constructor(opts: { workDir: string; stuckMs: number; accounts?: AccountsPort; store?: StorePort }) {
    super();
    this.workDir = opts.workDir;
    this.stuckMs = opts.stuckMs;
    this.accounts = opts.accounts;
    this.store = opts.store;
    mkdirSync(this.workDir, { recursive: true });
    if (this.store) {
      for (const p of this.store.load()) {
        const s = p.summary;
        if (!s?.id || s.source !== 'tower') continue;
        const e: AgentEntry = {
          summary: {
            ...s,
            status: 'stopped',
            pendingPermission: undefined,
            queued: s.queued ?? [],
            resumable: !!p.sessionId,
          },
          cwd: s.cwd,
          sessionId: p.sessionId,
          feed: p.feed ?? [],
          tools: new Map(),
          pendingQueue: [],
          stderr: [],
          lastMsgId: {},
          turnRunning: false,
          stopping: false,
          errored: false,
        };
        this.agents.set(s.id, e);
      }
      this.on('agent', (a) => {
        if (a.source === 'tower') this.scheduleSave();
      });
      this.on('feed', () => this.scheduleSave());
    }
    this.timer = setInterval(() => this.checkStuck(), STUCK_CHECK_MS);
    this.timer.unref();
    this.capTimer = setInterval(
      () => this.refreshCapacityDetails().catch(() => {}),
      CAPACITY_REFRESH_MS,
    );
    this.capTimer.unref();
    this.refreshCapacityDetails().catch(() => {});
    if (process.env.TOWER_TMUX !== '0') {
      this.tmuxTimer = setInterval(() => this.pollTmux().catch(() => {}), TMUX_POLL_MS);
      this.tmuxTimer.unref();
      this.pollTmux().catch(() => {});
    }
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
    let extraEnv: Record<string, string> = {};
    if (this.accounts) {
      let le;
      try {
        le = this.accounts.envFor(req.kind, req.accountId);
      } catch {
        throw new Error('unknown account');
      }
      extraEnv = le.env ?? {};
      req = { ...req, accountId: le.accountId };
    }
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
        queued: [],
        accountId: req.accountId,
      },
      cwd,
      feed: [],
      tools: new Map(),
      pendingQueue: [],
      stderr: [],
      lastMsgId: {},
      turnRunning: false,
      turnPromise: undefined,
      stopping: false,
      errored: false,
    };
    this.agents.set(id, e);
    this.emit('agent', e.summary);
    this.broadcastCapacity();
    this.startProcess(e, req, extraEnv).catch((err) => this.startFailed(e, err));
    return e.summary;
  }

  private startFailed(e: AgentEntry, err: unknown) {
    {
      if (e.stopping) return;
      e.errored = true;
      const tail = e.stderr.slice(-20).join('\n');
      const m = err instanceof Error ? err.message : String(err);
      const msg = oneLine(`${m}${tail ? `: ${tail}` : ''}`, 400);
      this.setStatus(e, 'error', { error: msg });
    }
  }

  async resume(agentId: string): Promise<'ok' | 'notfound' | 'conflict' | 'unknown_account'> {
    const e = this.agents.get(agentId);
    if (!e) return 'notfound';
    if (!e.summary.resumable || !e.sessionId || e.summary.status !== 'stopped') return 'conflict';
    let extraEnv: Record<string, string> = {};
    if (this.accounts) {
      try {
        extraEnv = this.accounts.envFor(e.summary.kind, e.summary.accountId).env ?? {};
      } catch {
        return 'unknown_account';
      }
    }
    mkdirSync(e.cwd, { recursive: true });
    e.stopping = false;
    e.errored = false;
    e.stderr = [];
    e.proc = undefined;
    e.conn = undefined;
    this.setStatus(e, 'starting', { error: undefined, stopReason: undefined });
    this.startProcess(
      e,
      { kind: e.summary.kind, task: e.summary.task, model: e.summary.model, accountId: e.summary.accountId },
      extraEnv,
      e.sessionId,
    ).catch((err) => this.startFailed(e, err));
    return 'ok';
  }

  private async startProcess(
    e: AgentEntry,
    req: LaunchRequest,
    extraEnv: Record<string, string>,
    resumeSessionId?: string,
  ): Promise<void> {
    const cmd = this.commandFor(req.kind, req.model);
    console.log(`[tower] spawn agent ${e.summary.id} (${req.kind}): ${cmd.join(' ')}`);
    const childEnv = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.startsWith('TOWER_')),
    ) as NodeJS.ProcessEnv;
    for (const [k, v] of Object.entries(extraEnv)) if (!k.startsWith('TOWER_')) childEnv[k] = v;
    let proc: ChildProcess;
    try {
      proc = spawn(cmd[0], cmd.slice(1), {
        cwd: e.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: childEnv,
      });
    } catch (err) {
      throw new Error(`spawn failed: ${String(err)}`);
    }
    e.proc = proc;
    if (e.stopping) {
      proc.kill('SIGKILL');
      return;
    }
    proc.stderr!.setEncoding('utf8');
    proc.stderr!.on('data', (d: string) => {
      for (const line of d.split('\n')) {
        if (!line) continue;
        e.stderr.push(line);
        if (e.stderr.length > STDERR_CAP) e.stderr.shift();
      }
    });
    proc.on('error', (err) => {
      if (e.stopping) return;
      e.errored = true;
      this.setStatus(e, 'error', { error: `spawn error: ${err.message}` });
    });
    proc.on('exit', (code, signal) => {
      if (e.stopping) return;
      if (e.errored || e.summary.status === 'error') return;
      const tail = e.stderr.slice(-20).join('\n');
      this.cancelPending(e);
      const s = e.summary.status;
      if (s === 'starting' || s === 'working' || s === 'needs_you' || s === 'stuck') {
        e.errored = true;
        this.setStatus(e, 'error', {
          error: oneLine(
            `process exited (code ${code}, signal ${signal})${tail ? ': ' + tail : ''}`,
            400,
          ),
        });
      } else {
        this.pushFeed(e, {
          type: 'status',
          id: this.nid('st'),
          at: Date.now(),
          text: 'Agent process exited',
        });
      }
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

    if (resumeSessionId) {
      e.sessionId = resumeSessionId;
      e.replaying = true;
      let loaded;
      try {
        loaded = await conn.loadSession({ sessionId: resumeSessionId, cwd: e.cwd, mcpServers: [] });
      } finally {
        e.replaying = false;
      }
      this.captureControls(e, loaded);
      e.summary.resumable = false;
      this.pushFeed(e, { type: 'status', id: this.nid('st'), at: Date.now(), text: 'Resumed' });
      this.setStatus(e, 'done');
      this.drain(e);
      return;
    }

    const sessionReq: acp.NewSessionRequest = { cwd: e.cwd, mcpServers: [] };
    if (req.kind === 'claude') {
      sessionReq._meta = { claudeCode: { options: { allowDangerouslySkipPermissions: false } } };
    }
    let session;
    try {
      session = await conn.newSession(sessionReq);
    } catch (err) {
      if (authMethods.length > 0) {
        console.log(`[tower] agent ${e.summary.id} requires auth, trying ${authMethods[0].id}`);
        await conn.authenticate({ methodId: authMethods[0].id });
        session = await conn.newSession(sessionReq);
      } else {
        throw err;
      }
    }
    e.sessionId = session.sessionId;
    this.captureControls(e, session);

    const modeDefault: Record<AgentKind, string> = {
      devin: 'accept-edits',
      claude: 'default',
      codex: 'read-only',
    };
    const wantMode = process.env[`TOWER_MODE_${req.kind.toUpperCase()}`] ?? modeDefault[req.kind];
    const offered = (
      session as { modes?: { availableModes?: Array<{ id: string }> } }
    ).modes?.availableModes?.map((m) => m.id);
    if (wantMode && offered?.includes(wantMode)) {
      try {
        await conn.setSessionMode({ sessionId: e.sessionId, modeId: wantMode });
        e.summary.mode = wantMode;
      } catch (err) {
        console.log(`[tower] agent ${e.summary.id}: setSessionMode ${wantMode} failed: ${err}`);
      }
    }
    this.pushFeed(e, { type: 'status', id: this.nid('st'), at: Date.now(), text: 'Started' });
    await this.runPrompt(e, req.task);
  }

  private captureControls(e: AgentEntry, r: unknown) {
    const x = (r ?? {}) as {
      modes?: { currentModeId?: string; availableModes?: Array<{ id: string; name?: string }> } | null;
      configOptions?: unknown;
    };
    if (x.modes?.availableModes) {
      e.summary.modes = x.modes.availableModes.map((m) => ({ id: m.id, name: m.name ?? m.id }));
    }
    if (x.modes?.currentModeId) e.summary.mode = x.modes.currentModeId;
    const co = normalizeConfig(x.configOptions);
    if (co) e.summary.configOptions = co;
    this.emit('agent', e.summary);
  }

  private clientFor(e: AgentEntry): acp.Client {
    return {
      sessionUpdate: (params) => this.onSessionUpdate(e, params),
      requestPermission: (params) => this.onRequestPermission(e, params),
      readTextFile: async (params) => ({ content: await this.guardedRead(e, params.path) }),
      writeTextFile: async (params) => {
        this.guardPath(e, params.path);
        await mkdir(path.dirname(params.path), { recursive: true });
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
    const kind = u.sessionUpdate;
    if (kind === 'current_mode_update') {
      e.summary.mode = (u as acp.CurrentModeUpdate).currentModeId;
      this.emit('agent', e.summary);
      return;
    }
    if (kind === 'config_option_update') {
      const co = normalizeConfig((u as acp.ConfigOptionUpdate).configOptions);
      if (co) e.summary.configOptions = co;
      this.emit('agent', e.summary);
      return;
    }
    if (kind === 'usage_update') {
      const uu = u as acp.UsageUpdate;
      e.summary.usage = { used: uu.used, size: uu.size };
      this.emit('agent', e.summary);
      return;
    }
    if (e.replaying) return; // history replay from loadSession: the persisted feed already has it
    this.touch(e);
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
      const out = outputText(t.rawOutput, t.content);
      if (out) st.output = out;
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
      const out = outputText(t.rawOutput, t.content);
      if (out) merged.output = out;
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
      output: t.output,
    });
    this.emit('agent', e.summary);
  }

  private onRequestPermission(
    e: AgentEntry,
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    const tc = params.toolCall;
    // Some agents (devin) send only toolCallId + _meta; recover title/kind/detail
    // from the stored tool_call state that arrived moments earlier.
    const stored = tc?.toolCallId ? e.tools.get(tc.toolCallId) : undefined;
    const meta = tc?._meta as Record<string, unknown> | undefined;
    const editableCommand = meta?.['cognition.ai/editableCommand'];
    const request: PermissionRequest = {
      requestId: newId(8),
      agentId: e.summary.id,
      title: tc?.title ?? stored?.title ?? 'Permission requested',
      toolKind: tc?.kind ?? stored?.kind ?? undefined,
      detail:
        preview(tc?.rawInput) ??
        preview(tc?.content) ??
        (typeof editableCommand === 'string' ? preview(editableCommand) : undefined) ??
        stored?.detail,
      options: (params.options ?? []).map((o) => ({
        optionId: o.optionId,
        name: o.name,
        kind: o.kind,
      })),
      createdAt: Date.now(),
    };
    return new Promise<acp.RequestPermissionResponse>((resolve) => {
      e.pendingQueue.push({ request, resolve });
      // only the queue head is surfaced in pendingPermission; all get feed items
      if (e.pendingQueue.length === 1) e.summary.pendingPermission = request;
      this.pushFeed(e, {
        type: 'permission',
        id: `perm-${request.requestId}`,
        at: Date.now(),
        requestId: request.requestId,
        title: request.title,
      });
      if (e.summary.status !== 'needs_you') this.setStatus(e, 'needs_you');
      else this.emit('agent', e.summary);
    });
  }

  private cancelPending(e: AgentEntry) {
    const queue = e.pendingQueue;
    e.pendingQueue = [];
    e.summary.pendingPermission = undefined;
    for (const p of queue) {
      p.resolve({ outcome: { outcome: 'cancelled' } });
      this.resolvePermissionFeed(e, p.request.requestId, 'cancelled');
    }
  }

  private resolvePermissionFeed(e: AgentEntry, requestId: string, resolution: string) {
    const id = `perm-${requestId}`;
    const prev = e.feed.find((f) => f.id === id) as Extract<FeedItem, { type: 'permission' }> | undefined;
    if (prev) this.pushFeed(e, { ...prev, resolution });
  }

  answerPermission(agentId: string, requestId: string, optionId: string): 'ok' | 'notfound' {
    const e = this.agents.get(agentId);
    const idx = e?.pendingQueue.findIndex((p) => p.request.requestId === requestId) ?? -1;
    if (!e || idx < 0) return 'notfound';
    const [p] = e.pendingQueue.splice(idx, 1);
    p.resolve({ outcome: { outcome: 'selected', optionId } });
    const name = p.request.options.find((o) => o.optionId === optionId)?.name ?? optionId;
    this.resolvePermissionFeed(e, requestId, name);
    e.summary.pendingPermission = e.pendingQueue[0]?.request;
    if (e.pendingQueue.length === 0) this.setStatus(e, 'working');
    else this.emit('agent', e.summary); // still needs_you, next request surfaced
    return 'ok';
  }

  private runPrompt(e: AgentEntry, text: string): Promise<void> {
    const p = this.runPromptInner(e, text);
    e.turnPromise = p;
    return p;
  }

  private async runPromptInner(e: AgentEntry, text: string): Promise<void> {
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
      this.drain(e);
    } catch (err) {
      e.turnRunning = false;
      if (e.stopping) return;
      e.errored = true;
      this.cancelPending(e);
      this.setStatus(e, 'error', { error: oneLine(`prompt failed: ${String(err)}`, 400) });
    }
  }

  private drain(e: AgentEntry) {
    if (e.holdDrain || e.stopping || e.errored || e.turnRunning) return;
    if (e.summary.status !== 'done') return;
    const next = e.summary.queued.shift();
    if (next === undefined) return;
    this.emit('agent', e.summary);
    this.runPrompt(e, next).catch(() => {});
  }

  prompt(
    agentId: string,
    text: string,
    interrupt = false,
  ): { result: 'ok' | 'notfound' | 'conflict'; queued?: boolean } {
    const e = this.agents.get(agentId);
    if (!e) return { result: 'notfound' };
    const st = e.summary.status;
    if (st === 'stopped' || st === 'error' || st === 'observed') return { result: 'conflict' };
    if (st === 'working' || st === 'needs_you' || st === 'starting') {
      if (interrupt) {
        e.summary.queued.unshift(text);
        this.emit('agent', e.summary);
        if (e.turnRunning) void this.cancelTurn(e);
      } else {
        e.summary.queued.push(text);
        this.emit('agent', e.summary);
      }
      return { result: 'ok', queued: true };
    }
    // done / stuck: send now
    void (async () => {
      if (e.turnRunning) {
        // stuck: a stale turn is still in flight — cancel it and wait before re-prompting
        e.holdDrain = true;
        try {
          await e.conn?.cancel({ sessionId: e.sessionId! });
        } catch {
          /* ignore */
        }
        try {
          await Promise.race([e.turnPromise, new Promise((r) => setTimeout(r, 10_000))]);
        } catch {
          /* ignore */
        }
        e.holdDrain = false;
        if (e.stopping || e.errored) return;
      }
      this.runPrompt(e, text).catch(() => {});
    })();
    return { result: 'ok', queued: false };
  }

  private async cancelTurn(e: AgentEntry) {
    this.cancelPending(e);
    if (e.summary.status === 'needs_you') this.setStatus(e, 'working');
    try {
      if (e.conn && e.sessionId) await e.conn.cancel({ sessionId: e.sessionId });
    } catch {
      /* ignore */
    }
  }

  interrupt(agentId: string): 'ok' | 'notfound' | 'conflict' {
    const e = this.agents.get(agentId);
    if (!e) return 'notfound';
    if (!e.turnRunning) return 'conflict';
    void this.cancelTurn(e);
    return 'ok';
  }

  removeQueued(agentId: string, index: number): 'ok' | 'notfound' {
    const e = this.agents.get(agentId);
    if (!e || !Number.isInteger(index) || index < 0 || index >= e.summary.queued.length) return 'notfound';
    e.summary.queued.splice(index, 1);
    this.emit('agent', e.summary);
    return 'ok';
  }

  async setMode(agentId: string, modeId: string): Promise<'ok' | 'notfound' | 'conflict' | 'invalid'> {
    const e = this.agents.get(agentId);
    if (!e) return 'notfound';
    if (!e.conn || !e.sessionId || ['stopped', 'error', 'starting'].includes(e.summary.status)) return 'conflict';
    if (!e.summary.modes?.some((m) => m.id === modeId)) return 'invalid';
    await e.conn.setSessionMode({ sessionId: e.sessionId, modeId });
    e.summary.mode = modeId;
    this.emit('agent', e.summary);
    return 'ok';
  }

  async setConfig(
    agentId: string,
    configId: string,
    value: string,
  ): Promise<'ok' | 'notfound' | 'conflict' | 'invalid'> {
    const e = this.agents.get(agentId);
    if (!e) return 'notfound';
    if (!e.conn || !e.sessionId || ['stopped', 'error', 'starting'].includes(e.summary.status)) return 'conflict';
    const opt = e.summary.configOptions?.find((o) => o.id === configId);
    if (!opt || !opt.options.some((o) => o.value === value)) return 'invalid';
    const res = await e.conn.setSessionConfigOption({ sessionId: e.sessionId, configId, value });
    const co = normalizeConfig((res as { configOptions?: unknown })?.configOptions);
    if (co) e.summary.configOptions = co;
    else opt.currentValue = value;
    this.emit('agent', e.summary);
    return 'ok';
  }

  async remove(agentId: string): Promise<boolean> {
    const e = this.agents.get(agentId);
    if (!e) return false;
    const st = e.summary.status;
    if (st !== 'stopped' && st !== 'error') await this.stop(agentId);
    else if (e.proc && e.proc.exitCode == null) {
      e.stopping = true;
      e.proc.kill('SIGKILL');
    }
    this.agents.delete(agentId);
    this.emit('agent_removed', agentId);
    this.broadcastCapacity();
    this.scheduleSave();
    return true;
  }

  countRunning(accountId: string): number {
    return [...this.agents.values()].filter(
      (a) => a.summary.accountId === accountId && a.summary.status !== 'stopped' && a.summary.status !== 'error',
    ).length;
  }

  private scheduleSave() {
    if (!this.store || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.saveNow();
    }, SAVE_DEBOUNCE_MS);
    this.saveTimer.unref();
  }

  saveNow() {
    if (!this.store) return;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    const out: PersistedAgent[] = [...this.agents.values()].map((e) => ({
      summary: e.summary,
      feed: e.feed.slice(-PERSIST_FEED),
      sessionId: e.sessionId,
    }));
    try {
      this.store.save(out);
    } catch (err) {
      console.error(`[tower] store.save failed: ${err}`);
    }
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
      const extra = this.capExtra[kind] ?? {};
      return {
        kind,
        label: KIND_LABEL[kind],
        available: extra.available ?? onPath(cmd[0]),
        running,
        detail: extra.detail,
      };
    });
  }

  private run(cmd: string, args: string[], timeoutMs = 5000): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 256 * 1024 }, (err, stdout, stderr) => {
        if (err) reject(err);
        else resolve((stdout + stderr).trim());
      });
    });
  }

  private stripEmails(s: string): string {
    return s.replace(/\S+@\S+\.\S+/g, '***').trim();
  }

  private async refreshCapacityDetails(): Promise<void> {
    if (this.capRefreshing) return;
    this.capRefreshing = true;
    try {
      await this.refreshCapacityDetailsInner();
    } finally {
      this.capRefreshing = false;
    }
  }

  private async refreshCapacityDetailsInner(): Promise<void> {
    const next: typeof this.capExtra = {};
    await Promise.all([
      (async () => {
        try {
          const out = await this.run('devin', ['auth', 'status']);
          const first = this.stripEmails(out.split('\n')[0] ?? '');
          next.devin = { detail: first || undefined, available: !/not logged in/i.test(out) };
        } catch {
          next.devin = { available: onPath('devin') };
        }
      })(),
      (async () => {
        try {
          const out = await this.run('claude', ['auth', 'status']);
          const j = JSON.parse(out) as { loggedIn?: boolean; subscriptionType?: string };
          next.claude = {
            available: j.loggedIn === true,
            detail: j.loggedIn
              ? `${j.subscriptionType ?? 'account'} · logged in`
              : 'not logged in',
          };
        } catch {
          next.claude = { available: onPath('claude') };
        }
      })(),
      (async () => {
        // NEVER via ~/.local/bin/codex (subswitch shim refuses bare login commands)
        const bin = existsSync('/usr/bin/codex') ? '/usr/bin/codex' : 'codex';
        try {
          const out = await this.run(bin, ['login', 'status']);
          const first = this.stripEmails(out.split('\n')[0] ?? '');
          next.codex = { detail: first || undefined, available: !/not logged in/i.test(out) };
        } catch {
          next.codex = { available: undefined };
        }
      })(),
    ]);
    this.capExtra = next;
    this.broadcastCapacity();
  }

  private async pollTmux(): Promise<void> {
    if (this.tmuxPolling) return;
    this.tmuxPolling = true;
    try {
      await this.pollTmuxInner();
    } finally {
      this.tmuxPolling = false;
    }
  }

  private async pollTmuxInner(): Promise<void> {
    let out: string;
    try {
      out = await this.run('bash', [TMUX_LIST]);
    } catch {
      if (this.tmuxAgents.size) {
        this.tmuxAgents.clear();
      }
      return;
    }
    const redact = process.env.TOWER_TMUX_REDACT !== '0';
    const bySession = new Map<string, { kind: AgentKind; activity: number }>();
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      const [sess, , , , act, agent] = line.split('\t');
      if (!sess || agent === '-' || !agent) continue;
      const kind = agent as AgentKind;
      if (!KIND_LABEL[kind]) continue;
      const activity = (Number(act) || 0) * 1000;
      const cur = bySession.get(sess);
      if (!cur || activity > cur.activity) bySession.set(sess, { kind, activity });
    }
    const seen = new Set<string>();
    const changed: AgentSummary[] = [];
    for (const [sess, info] of bySession) {
      const id = `tmux-${createHash('sha1').update(sess).digest('hex').slice(0, 6)}`;
      seen.add(id);
      if (redact && !this.tmuxNums.has(sess)) {
        this.tmuxNums.set(sess, this.tmuxNextN);
        this.tmuxNextN += 1;
      }
      const label = KIND_LABEL[info.kind];
      const summary: AgentSummary = {
        id,
        kind: info.kind,
        name: redact ? `${label} session ${this.tmuxNums.get(sess)}` : sess,
        task: redact ? 'Existing tmux session' : sess,
        cwd: '',
        source: 'tmux',
        status: 'observed',
        createdAt: info.activity || Date.now(),
        lastActivityAt: info.activity || Date.now(),
        toolCalls: 0,
        queued: [],
      };
      const prev = this.tmuxAgents.get(id);
      const prevJson = prev ? JSON.stringify(prev.summary) : '';
      if (JSON.stringify(summary) !== prevJson) {
        this.tmuxAgents.set(id, { summary });
        changed.push(summary);
      }
    }
    for (const id of [...this.tmuxAgents.keys()]) {
      if (!seen.has(id)) {
        this.tmuxAgents.delete(id);
      }
    }
    for (const s of changed) this.emit('agent', s);
  }

  private broadcastCapacity() {
    const c = this.capacityList();
    const j = JSON.stringify(c);
    if (j === this.lastCapacityJson) return;
    this.lastCapacityJson = j;
    this.emit('capacity', c);
  }

  getAgent(id: string): AgentSummary | undefined {
    return this.agents.get(id)?.summary ?? this.tmuxAgents.get(id)?.summary;
  }

  isObserved(id: string): boolean {
    return this.tmuxAgents.has(id);
  }

  getFeed(id: string): FeedItem[] | undefined {
    return this.agents.get(id)?.feed;
  }

  listAccounts() {
    return this.accounts?.list() ?? [];
  }

  state(host: string): StateResponse {
    return {
      agents: [
        ...[...this.agents.values()].map((a) => a.summary),
        ...[...this.tmuxAgents.values()].map((t) => t.summary),
      ],
      capacity: this.capacityList(),
      accounts: this.listAccounts(),
      host,
    };
  }

  shutdown() {
    if (this.timer) clearInterval(this.timer);
    if (this.capTimer) clearInterval(this.capTimer);
    if (this.tmuxTimer) clearInterval(this.tmuxTimer);
  }
}
