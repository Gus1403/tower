import { EventEmitter } from 'node:events';
import { spawn, spawnSync, execFile, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { randomBytes, createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acp from '@agentclientprotocol/sdk';
import type {
  Board,
  ConfigOption,
  AgentKind,
  AgentStatus,
  AgentSummary,
  Capacity,
  FeedItem,
  Note,
  Question,
  StateResponse,
  RotationState,
  LaunchRequest,
  PermissionRequest,
  PlanEntry,
} from '../../shared/contract.js';
import type { AccountsPort, PersistedAgent, StorePort } from './ports.js';
import { deleteUpload, getUpload } from './uploads.js';
import { tmuxAllowed } from './tmux-control.js';

export function towerDataDir(): string {
  return process.env.TOWER_DATA_DIR || path.join(os.homedir(), '.local', 'state', 'tower');
}

export const MAX_TASK_CHARS = 8000;
export const CUSTOMER_RE = /^[A-Za-z0-9._ -]{1,64}$/;
export const DEFAULT_BOARDS: Board[] = [
  {
    id: 'programs',
    name: 'Programs',
    columns: [
      { id: 'working', name: 'Working', statuses: ['needs_you', 'stuck', 'starting', 'working'] },
      { id: 'done', name: 'Done', statuses: ['done', 'stopped', 'error'] },
    ],
  },
  {
    id: 'customers',
    name: 'Customers',
    columns: [
      { id: 'handling', name: 'Handling', statuses: ['starting', 'working', 'needs_you', 'stuck'] },
      { id: 'waiting', name: 'Waiting on the customer', statuses: ['done'] },
      { id: 'asleep', name: 'Asleep', statuses: ['stopped', 'error'] },
    ],
  },
];
const ALL_STATUSES: AgentStatus[] = ['starting', 'working', 'needs_you', 'stuck', 'done', 'error', 'stopped', 'observed'];
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}
type SockResult<T = object> = ({ ok: true } & T) | { ok: false; error: string };
const LIMIT_RE = /usage limit|rate limit|429|quota|limit reached|hit your limit|you(?:'|’)ve (?:hit|reached) your [^\n]{0,60}?limit|usage_limit_reached/i;

// Wave C: injected by rotation.ts (createRotation(...).attach(manager)); optional so the manager works without it.
export interface RotationHooks {
  onLimit(agentId: string, accountId: string | undefined, text: string): void;
  state(): RotationState;
}
const CANCEL_FORCE_MS = 5000;

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
  session: string;
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
  dead?: boolean; // removed from the manager: never emit again
  gen: number; // process generation (bumped by resume)
  turnId: number; // prompt turn id (bumped per turn and by a forced cancel)
}

export interface AgentManagerEvents {
  agent: (a: AgentSummary) => void;
  agent_removed: (agentId: string) => void;
  feed: (agentId: string, item: FeedItem) => void;
  capacity: (c: Capacity[]) => void;
  notes: (n: Note[]) => void;
  boards: (b: Board[]) => void;
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
  private notes: Note[] = [];
  private notesFile?: string;
  private notesStarting = new Set<string>();
  private customBoards: Board[] = [];
  private boardsFile?: string;
  rotation?: RotationHooks; // Wave C

  constructor(opts: {
    workDir: string;
    stuckMs: number;
    accounts?: AccountsPort;
    store?: StorePort;
    notesFile?: string;
    boardsFile?: string;
  }) {
    super();
    this.workDir = opts.workDir;
    this.stuckMs = opts.stuckMs;
    this.accounts = opts.accounts;
    this.store = opts.store;
    this.notesFile = opts.notesFile;
    this.boardsFile = opts.boardsFile;
    this.loadNotes();
    this.loadBoards();
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
            board: s.board ?? 'programs',
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
          gen: 0,
          turnId: 0,
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

  private live(e: AgentEntry): boolean {
    return !e.dead && this.agents.get(e.summary.id) === e;
  }

  private emitAgent(e: AgentEntry) {
    if (this.live(e)) this.emit('agent', e.summary);
  }

  // status while a turn is in flight: needs_you if a permission or a question is open
  private busyStatus(e: AgentEntry): AgentStatus {
    return e.pendingQueue.length || e.summary.questions?.length ? 'needs_you' : 'working';
  }

  private noteLimit(e: AgentEntry, text: string) {
    const tail = e.stderr.slice(-20).join('\n');
    if (LIMIT_RE.test(text) || LIMIT_RE.test(tail)) {
      e.summary.limitHit = true;
      const r = this.rotation;
      const id = e.summary.id;
      const acc = e.summary.accountId;
      // deferred: the caller sets status 'error' right after this returns
      if (r) setTimeout(() => r.onLimit(id, acc, `${text}\n${tail}`), 0);
    }
  }

  private setStatus(e: AgentEntry, s: AgentStatus, extra?: Partial<AgentSummary>) {
    if (!this.live(e)) return;
    e.summary = { ...e.summary, status: s, ...extra };
    this.emit('agent', e.summary);
    this.broadcastCapacity();
    this.syncHandoff(e);
  }

  // keeps requester.summary.handoffs[].status current
  private syncHandoff(e: AgentEntry) {
    const rb = e.summary.requestedBy;
    if (!rb) return;
    const r = this.agents.get(rb.agentId);
    if (!r || r.dead || !r.summary.handoffs) return;
    const i = r.summary.handoffs.findIndex((h) => h.agentId === e.summary.id);
    if (i < 0) return;
    const cur = r.summary.handoffs[i];
    if (cur.status === e.summary.status && cur.name === e.summary.name) return;
    r.summary.handoffs = r.summary.handoffs.map((h, j) =>
      j === i ? { ...h, status: e.summary.status, name: e.summary.name } : h,
    );
    this.emitAgent(r);
  }

  // on end_turn of a handoff agent: deliver its last message to the requester (once per turn end)
  private deliverHandoffResult(e: AgentEntry) {
    const rb = e.summary.requestedBy;
    if (!rb) return;
    const r = this.agents.get(rb.agentId);
    if (!r || r.dead) return;
    const msgId = e.lastMsgId.agent_message;
    const item = msgId ? e.feed.find((f) => f.id === msgId) : undefined;
    let text = item && item.type === 'agent_message' ? item.text : (e.summary.lastMessage ?? '');
    text = text.trim();
    if (!text) text = '(no message)';
    if (text.length > 4000) text = text.slice(0, 4000);
    const res = this.prompt(r.summary.id, `[Handoff result from ${e.summary.name}] ${text}`);
    this.pushFeed(e, {
      type: 'status',
      id: this.nid('st'),
      at: Date.now(),
      text: res.result === 'ok' ? `Result sent to ${r.summary.name}` : `Could not deliver result to ${r.summary.name} (not running)`,
    });
  }

  private pushFeed(e: AgentEntry, item: FeedItem) {
    if (!this.live(e)) return;
    const idx = e.feed.findIndex((f) => f.id === item.id);
    if (idx >= 0) e.feed[idx] = item;
    else {
      e.feed.push(item);
      if (e.feed.length > FEED_CAP) e.feed.splice(0, e.feed.length - FEED_CAP);
    }
    this.emit('feed', e.summary.id, item);
  }

  private touch(e: AgentEntry) {
    if (!this.live(e)) return;
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

  async launch(req: LaunchRequest, extra?: Partial<AgentSummary>): Promise<AgentSummary> {
    const board = req.board ?? 'programs';
    if (!this.hasBoard(board)) throw new Error('unknown board');
    if (req.task.length > MAX_TASK_CHARS) req = { ...req, task: req.task.slice(0, MAX_TASK_CHARS) };
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
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
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
        board,
        customer: req.customer,
        ...extra,
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
      gen: 0,
      turnId: 0,
    };
    this.agents.set(id, e);
    this.emitAgent(e);
    this.broadcastCapacity();
    this.startProcess(e, req, extraEnv, undefined, e.gen).catch((err) => this.startFailed(e, err, e.gen));
    return e.summary;
  }

  private startFailed(e: AgentEntry, err: unknown, gen: number) {
    {
      if (e.stopping || e.dead || e.gen !== gen) return;
      e.errored = true;
      const tail = e.stderr.slice(-20).join('\n');
      const m = err instanceof Error ? err.message : String(err);
      const msg = oneLine(`${m}${tail ? `: ${tail}` : ''}`, 400);
      this.noteLimit(e, m);
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
        const le = this.accounts.envFor(e.summary.kind, e.summary.accountId);
        if (e.summary.accountId && le.accountId !== e.summary.accountId) return 'unknown_account';
        extraEnv = le.env ?? {};
      } catch {
        return 'unknown_account';
      }
    }
    mkdirSync(e.cwd, { recursive: true, mode: 0o700 });
    e.gen += 1;
    e.turnId += 1;
    e.turnRunning = false;
    e.stopping = false;
    e.errored = false;
    e.stderr = [];
    e.proc = undefined;
    e.conn = undefined;
    this.setStatus(e, 'starting', { error: undefined, stopReason: undefined });
    const gen = e.gen;
    this.startProcess(
      e,
      { kind: e.summary.kind, task: e.summary.task, model: e.summary.model, accountId: e.summary.accountId },
      extraEnv,
      e.sessionId,
      e.gen,
    ).catch((err) => this.startFailed(e, err, gen));
    return 'ok';
  }

  private async startProcess(
    e: AgentEntry,
    req: LaunchRequest,
    extraEnv: Record<string, string>,
    resumeSessionId: string | undefined,
    gen: number,
  ): Promise<void> {
    const cmd = this.commandFor(req.kind, req.model);
    console.log(`[tower] spawn agent ${e.summary.id} (${req.kind}): ${cmd.join(' ')}`);
    const childEnv = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.startsWith('TOWER_')),
    ) as NodeJS.ProcessEnv;
    for (const [k, v] of Object.entries(extraEnv)) if (!k.startsWith('TOWER_')) childEnv[k] = v;
    childEnv.TOWER_AGENT_ID = e.summary.id;
    childEnv.TOWER_SOCKET = path.join(towerDataDir(), 'agent.sock');
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
    const abandoned = () => {
      if (!(e.dead || e.stopping || e.gen !== gen)) return false;
      try {
        proc.kill('SIGKILL');
      } catch {
        /* already dead */
      }
      return true;
    };
    if (abandoned()) return;
    proc.stderr!.setEncoding('utf8');
    proc.stderr!.on('data', (d: string) => {
      for (const line of d.split('\n')) {
        if (!line) continue;
        e.stderr.push(line);
        if (e.stderr.length > STDERR_CAP) e.stderr.shift();
      }
    });
    proc.on('error', (err) => {
      if (e.stopping || e.gen !== gen) return;
      e.errored = true;
      this.setStatus(e, 'error', { error: `spawn error: ${err.message}` });
    });
    proc.on('exit', (code, signal) => {
      if (e.stopping || e.gen !== gen) return;
      if (e.errored || e.summary.status === 'error') return;
      const tail = e.stderr.slice(-20).join('\n');
      this.cancelPending(e);
      const s = e.summary.status;
      if (s === 'starting' || s === 'working' || s === 'needs_you' || s === 'stuck') {
        e.errored = true;
        this.noteLimit(e, '');
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
    if (abandoned()) return;
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
      if (abandoned()) return;
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
        if (abandoned()) return;
        session = await conn.newSession(sessionReq);
      } else {
        throw err;
      }
    }
    if (abandoned()) return;
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
      if (abandoned()) return;
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
    this.emitAgent(e);
  }

  private clientFor(e: AgentEntry): acp.Client {
    return {
      sessionUpdate: (params) => this.onSessionUpdate(e, params),
      requestPermission: (params) => this.onRequestPermission(e, params),
      readTextFile: async (params) => ({ content: await this.guardedRead(e, params.path) }),
      writeTextFile: async (params) => {
        const target = this.guardPath(e, params.path);
        await mkdir(path.dirname(target), { recursive: true });
        this.guardPath(e, target); // re-check after mkdir (race with a planted symlink)
        await writeFile(target, params.content, 'utf8');
        return {};
      },
    };
  }

  private guardPath(e: AgentEntry, p: string): string {
    const resolved = path.resolve(e.cwd, p);
    let root = path.resolve(e.cwd);
    try {
      root = realpathSync(root); // macOS: /tmp -> /private/tmp
    } catch {
      /* keep unresolved */
    }
    const inside = (x: string) => x === root || x.startsWith(root + path.sep);
    // realpath the target, or its nearest existing ancestor for new files, so symlinks cannot escape
    let real: string | undefined;
    let cur = resolved;
    const rest: string[] = [];
    for (;;) {
      try {
        real = path.join(realpathSync(cur), ...rest);
        break;
      } catch {
        const parent = path.dirname(cur);
        if (parent === cur) break;
        rest.unshift(path.basename(cur));
        cur = parent;
      }
    }
    if (!real || !inside(real)) throw new Error(`path outside agent cwd: ${p}`);
    return real;
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
      this.emitAgent(e);
      return;
    }
    if (kind === 'config_option_update') {
      const co = normalizeConfig((u as acp.ConfigOptionUpdate).configOptions);
      if (co) e.summary.configOptions = co;
      this.emitAgent(e);
      return;
    }
    if (kind === 'available_commands_update') {
      const cmds = (u as { availableCommands?: Array<{ name?: unknown; description?: unknown }> }).availableCommands ?? [];
      e.summary.commands = cmds
        .filter((c) => typeof c?.name === 'string')
        .map((c) => ({
          name: c.name as string,
          description: typeof c.description === 'string' ? c.description : undefined,
        }));
      this.emitAgent(e);
      return;
    }
    if (kind === 'usage_update') {
      const uu = u as acp.UsageUpdate;
      e.summary.usage = { used: uu.used, size: uu.size };
      this.emitAgent(e);
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
        const full = e.feed.find((f) => f.id === e.lastMsgId.agent_message) as { text?: string } | undefined;
        e.summary.lastMessage = oneLine(full?.text ?? text, 280);
        this.emitAgent(e);
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
      this.emitAgent(e);
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
    this.emitAgent(e);
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
      else this.emitAgent(e);
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
    if (e.pendingQueue.length === 0) this.setStatus(e, this.busyStatus(e));
    else this.emitAgent(e); // still needs_you, next request surfaced
    return 'ok';
  }

  private runPrompt(e: AgentEntry, text: string): Promise<void> {
    const p = this.runPromptInner(e, text);
    e.turnPromise = p;
    return p;
  }

  private async runPromptInner(e: AgentEntry, text: string): Promise<void> {
    if (!e.conn || !e.sessionId) throw new Error('agent not ready');
    const gen = e.gen;
    const turn = ++e.turnId;
    const mine = () => e.gen === gen && e.turnId === turn && !e.dead;
    e.turnRunning = true;
    e.lastUpdateKind = undefined;
    e.lastMsgId = {};
    this.pushFeed(e, { type: 'user_message', id: this.nid('usr'), at: Date.now(), text });
    this.setStatus(e, this.busyStatus(e), { stopReason: undefined });
    try {
      const res = await e.conn.prompt({
        sessionId: e.sessionId,
        prompt: [{ type: 'text', text }],
      });
      if (!mine()) return; // superseded (resume / forced cancel / removed)
      e.turnRunning = false;
      if (e.stopping || e.errored) return;
      const after = e.summary.questions?.length ? 'needs_you' : 'done';
      this.setStatus(e, after, { stopReason: res.stopReason, limitHit: false });
      this.pushFeed(e, {
        type: 'status',
        id: this.nid('st'),
        at: Date.now(),
        text: `Turn ended: ${res.stopReason}`,
      });
      if (res.stopReason === 'end_turn') this.deliverHandoffResult(e);
      this.drain(e);
    } catch (err) {
      if (!mine()) return;
      e.turnRunning = false;
      if (e.stopping) return;
      e.errored = true;
      this.cancelPending(e);
      const n = e.summary.queued.length;
      if (n) {
        e.summary.queued = [];
        this.pushFeed(e, {
          type: 'status',
          id: this.nid('st'),
          at: Date.now(),
          text: `${n} queued prompt${n === 1 ? '' : 's'} discarded`,
        });
      }
      this.noteLimit(e, String(err));
      this.setStatus(e, 'error', { error: oneLine(`prompt failed: ${String(err)}`, 400) });
    }
  }

  private drain(e: AgentEntry) {
    if (e.holdDrain || e.stopping || e.errored || e.turnRunning) return;
    if (e.summary.status !== 'done') return;
    const next = e.summary.queued.shift();
    if (next === undefined) return;
    this.emitAgent(e);
    this.runPrompt(e, next).catch(() => {});
  }

  // copies uploads into <cwd>/attachments and returns the "Attached:" lines
  private attach(e: AgentEntry, ids: string[]): string[] | undefined {
    const ups = ids.map((id) => getUpload(id));
    if (ups.some((u) => !u)) return undefined;
    const dir = path.join(e.cwd, 'attachments');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const lines: string[] = [];
    for (const u of ups) {
      const base = path.basename(u!.name || 'file').replace(/^\.+/, '') || 'file';
      const ext = path.extname(base);
      const stem = base.slice(0, base.length - ext.length) || 'file';
      let name = base;
      for (let i = 1; existsSync(path.join(dir, name)); i++) name = `${stem}-${i}${ext}`;
      copyFileSync(u!.path, path.join(dir, name));
      lines.push(`Attached: attachments/${name}`);
    }
    for (const u of ups) deleteUpload(u!.id); // bytes now live in the agent cwd only
    return lines;
  }

  prompt(
    agentId: string,
    text: string,
    interrupt = false,
    attachments?: string[],
  ): { result: 'ok' | 'notfound' | 'conflict' | 'bad_attachment'; queued?: boolean } {
    const e = this.agents.get(agentId);
    if (!e) return { result: 'notfound' };
    const st = e.summary.status;
    if (st === 'stopped' || st === 'error' || st === 'observed') return { result: 'conflict' };
    if (attachments?.length) {
      const lines = this.attach(e, attachments);
      if (!lines) return { result: 'bad_attachment' };
      text = `${text}\n\n${lines.join('\n')}`;
    }
    if (st === 'working' || st === 'needs_you' || st === 'starting' || (st === 'stuck' && e.turnRunning)) {
      // stuck with a stale turn in flight: never run two prompts at once — queue first and cancel the stale turn
      if (interrupt || st === 'stuck') {
        e.summary.queued.unshift(text);
        this.emitAgent(e);
        if (e.turnRunning) void this.cancelTurn(e);
      } else {
        e.summary.queued.push(text);
        this.emitAgent(e);
      }
      return { result: 'ok', queued: true };
    }
    // done (or stuck with no turn): send now
    this.runPrompt(e, text).catch(() => {});
    return { result: 'ok', queued: false };
  }

  // session/cancel; if the adapter never ends the turn within 5 s, force it ended and move on
  private async cancelTurn(e: AgentEntry) {
    this.cancelPending(e);
    if (e.summary.status === 'needs_you' || e.summary.status === 'stuck') this.setStatus(e, this.busyStatus(e));
    const turn = e.turnId;
    const gen = e.gen;
    const p = e.turnPromise;
    try {
      if (e.conn && e.sessionId) await e.conn.cancel({ sessionId: e.sessionId });
    } catch {
      /* ignore */
    }
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      p?.catch(() => {}),
      new Promise<void>((r) => {
        timer = setTimeout(r, CANCEL_FORCE_MS);
        timer.unref();
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (e.turnRunning && e.turnId === turn && e.gen === gen && !e.stopping && !e.errored && this.live(e)) {
      e.turnId += 1; // the late prompt resolution is ignored
      e.turnRunning = false;
      this.setStatus(e, e.summary.questions?.length ? 'needs_you' : 'done', { stopReason: 'cancelled' });
      this.pushFeed(e, {
        type: 'status',
        id: this.nid('st'),
        at: Date.now(),
        text: 'Turn ended: cancelled (forced, agent did not answer the cancel)',
      });
      this.drain(e);
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
    this.emitAgent(e);
    return 'ok';
  }

  async setMode(agentId: string, modeId: string): Promise<'ok' | 'notfound' | 'conflict' | 'invalid'> {
    const e = this.agents.get(agentId);
    if (!e) return 'notfound';
    if (!e.conn || !e.sessionId || ['stopped', 'error', 'starting'].includes(e.summary.status)) return 'conflict';
    if (!e.summary.modes?.some((m) => m.id === modeId)) return 'invalid';
    await e.conn.setSessionMode({ sessionId: e.sessionId, modeId });
    e.summary.mode = modeId;
    this.emitAgent(e);
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
    this.emitAgent(e);
    return 'ok';
  }

  async remove(agentId: string): Promise<boolean> {
    const e = this.agents.get(agentId);
    if (!e) return false;
    const st = e.summary.status;
    this.agents.delete(agentId);
    e.dead = true; // nothing about this card is emitted or persisted again
    e.stopping = true;
    if (st !== 'stopped' && st !== 'error') await this.stopEntry(e);
    else if (e.proc && e.proc.exitCode == null) e.proc.kill('SIGKILL');
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
    await this.stopEntry(e);
    return true;
  }

  private async stopEntry(e: AgentEntry): Promise<void> {
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
      out = this.tmuxProbe ? await this.tmuxProbe() : await this.run('bash', [TMUX_LIST]);
    } catch {
      const gone = [...this.tmuxAgents.keys()];
      this.tmuxAgents.clear();
      for (const id of gone) this.emit('agent_removed', id);
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
        interactive: tmuxAllowed(sess),
      };
      const prev = this.tmuxAgents.get(id);
      const prevJson = prev ? JSON.stringify(prev.summary) : '';
      if (JSON.stringify(summary) !== prevJson) {
        this.tmuxAgents.set(id, { summary, session: sess });
        changed.push(summary);
      }
    }
    for (const id of [...this.tmuxAgents.keys()]) {
      if (!seen.has(id)) {
        this.tmuxAgents.delete(id);
        this.emit('agent_removed', id);
      }
    }
    for (const s of changed) this.emit('agent', s);
  }

  // test seam: run one tmux poll with an injected probe output (null = probe failed)
  async pollTmuxWith(out: string | null): Promise<void> {
    this.tmuxProbe = async () => {
      if (out === null) throw new Error('probe failed');
      return out;
    };
    try {
      await this.pollTmuxInner();
    } finally {
      this.tmuxProbe = undefined;
    }
  }
  private tmuxProbe?: () => Promise<string>;

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
      notes: this.listNotes(),
      boards: this.listBoards(),
      host,
      rotation: this.rotation?.state(),
    };
  }

  // real tmux session name of an observed card (never exposed in the API)
  tmuxTarget(agentId: string): string | undefined {
    return this.tmuxAgents.get(agentId)?.session;
  }

  // ---- Wave B: questions (`tower ask`) ----
  ask(
    agentId: string,
    text: string,
    recommendation?: string,
  ): { ok: true; questionId: string } | { ok: false; error: 'notfound' } {
    const e = this.agents.get(agentId);
    if (!e) return { ok: false, error: 'notfound' };
    const q: Question = { id: newId(8), agentId, text, recommendation, createdAt: Date.now() };
    e.summary.questions = [...(e.summary.questions ?? []), q];
    this.pushFeed(e, { type: 'status', id: this.nid('st'), at: Date.now(), text: `Asked: ${oneLine(text, 400)}` });
    const st = e.summary.status;
    if (st === 'stopped' || st === 'error') this.emitAgent(e);
    else this.setStatus(e, 'needs_you');
    return { ok: true, questionId: q.id };
  }

  answer(agentId: string, questionId: string, text: string): 'ok' | 'notfound' | 'conflict' {
    const e = this.agents.get(agentId);
    const q = e?.summary.questions?.find((x) => x.id === questionId);
    if (!e || !q) return 'notfound';
    const st0 = e.summary.status;
    if (st0 === 'stopped' || st0 === 'error' || st0 === 'observed') return 'conflict'; // keep the question
    e.summary.questions = e.summary.questions!.filter((x) => x.id !== questionId);
    if (e.summary.status === 'needs_you' && !e.pendingQueue.length && !e.summary.questions.length) {
      this.setStatus(e, e.turnRunning ? 'working' : 'done');
    } else this.emitAgent(e);
    const r = this.prompt(agentId, `[Answer to «${oneLine(q.text, 160)}»] ${text}`);
    return r.result === 'ok' ? 'ok' : 'conflict';
  }

  // ---- Wave B: archive / move ----
  setArchived(agentId: string, archived: boolean): 'ok' | 'notfound' {
    const e = this.agents.get(agentId);
    if (!e) return 'notfound';
    e.summary = { ...e.summary, archived };
    this.emitAgent(e);
    return 'ok';
  }

  async move(
    agentId: string,
    accountId: string,
  ): Promise<{ ok: true; agent: AgentSummary } | { ok: false; error: 'notfound' | 'unknown_account' }> {
    const e = this.agents.get(agentId);
    if (!e) return { ok: false, error: 'notfound' };
    if (!this.accounts) return { ok: false, error: 'unknown_account' };
    try {
      this.accounts.envFor(e.summary.kind, accountId);
    } catch {
      return { ok: false, error: 'unknown_account' };
    }
    const lines: string[] = [];
    for (const f of e.feed) {
      if (f.type === 'user_message') lines.push(`User: ${f.text}`);
      else if (f.type === 'agent_message') lines.push(`Agent: ${f.text}`);
      else if (f.type === 'tool_call') lines.push(`Tool: ${f.title}${f.status ? ` (${f.status})` : ''}`);
    }
    let convo = lines.slice(-40).join('\n');
    if (convo.length > 12000) convo = convo.slice(convo.length - 12000);
    const head = `Continue this task on a fresh session. Original task: ${oneLine(e.summary.task, 2000)}\n\nConversation so far (most recent last):\n`;
    const room = MAX_TASK_CHARS - head.length;
    if (convo.length > room) convo = convo.slice(convo.length - Math.max(0, room));
    const task = (head + convo).slice(0, MAX_TASK_CHARS);
    let agent: AgentSummary;
    try {
      agent = await this.launch({
        kind: e.summary.kind,
        task,
        name: `${e.summary.name} (moved)`,
        model: e.summary.model,
        accountId,
        board: this.hasBoard(e.summary.board ?? 'programs') ? e.summary.board : undefined,
        customer: e.summary.customer,
      });
    } catch {
      return { ok: false, error: 'unknown_account' };
    }
    const ne = this.agents.get(agent.id);
    if (ne) {
      ne.summary = { ...ne.summary, movedFrom: { agentId, accountId: e.summary.accountId } };
      this.emitAgent(ne);
    }
    const st = e.summary.status;
    if (st !== 'stopped' && st !== 'error') await this.stopEntry(e);
    this.setArchived(agentId, true);
    return { ok: true, agent: this.agents.get(agent.id)?.summary ?? agent };
  }

  // ---- Wave B: notes ----
  listNotes(): Note[] {
    return this.notes;
  }

  private loadNotes() {
    if (!this.notesFile) return;
    try {
      const data = JSON.parse(readFileSync(this.notesFile, 'utf8'));
      if (Array.isArray(data)) {
        this.notes = data.filter((n) => n && typeof n.id === 'string' && typeof n.title === 'string');
      }
    } catch {
      /* no notes yet */
    }
  }

  private notesChanged() {
    if (this.notesFile) {
      try {
        mkdirSync(path.dirname(this.notesFile), { recursive: true, mode: 0o700 });
        const tmp = `${this.notesFile}.${process.pid}.${Date.now()}.tmp`;
        writeFileSync(tmp, JSON.stringify(this.notes), { mode: 0o600 });
        chmodSync(tmp, 0o600);
        renameSync(tmp, this.notesFile);
      } catch (err) {
        console.error(`[tower] notes save failed: ${err}`);
      }
    }
    this.emit('notes', this.notes);
  }

  createNote(title: string, body: string): Note {
    const n: Note = { id: newId(8), title, body, createdAt: Date.now() };
    this.notes = [...this.notes, n];
    this.notesChanged();
    return n;
  }

  updateNote(id: string, patch: { title?: string; body?: string; archived?: boolean }): Note | undefined {
    const i = this.notes.findIndex((n) => n.id === id);
    if (i < 0) return undefined;
    const n: Note = { ...this.notes[i] };
    if (patch.title !== undefined) n.title = patch.title;
    if (patch.body !== undefined) n.body = patch.body;
    if (patch.archived !== undefined) n.archived = patch.archived;
    this.notes = this.notes.map((x, j) => (j === i ? n : x));
    this.notesChanged();
    return n;
  }

  deleteNote(id: string): boolean {
    if (!this.notes.some((n) => n.id === id)) return false;
    this.notes = this.notes.filter((n) => n.id !== id);
    this.notesChanged();
    return true;
  }

  // throws Error('unknown account') like launch; Error('note archived') when archived or already starting (409)
  async startNote(id: string, kind: AgentKind, accountId?: string): Promise<AgentSummary | undefined> {
    const n = this.notes.find((x) => x.id === id);
    if (!n) return undefined;
    if (n.archived || this.notesStarting.has(id)) throw new Error('note archived');
    this.notesStarting.add(id);
    try {
      const task = n.body.trim() ? `${n.title}\n\n${n.body}` : n.title;
      const agent = await this.launch({ kind, task, name: n.title.trim() || undefined, accountId });
      this.updateNote(id, { archived: true });
      return agent;
    } finally {
      this.notesStarting.delete(id);
    }
  }

  // ---- Wave D: boards ----
  listBoards(): Board[] {
    return [...DEFAULT_BOARDS, ...this.customBoards];
  }

  hasBoard(id: string): boolean {
    return this.listBoards().some((b) => b.id === id);
  }

  private loadBoards() {
    const f = this.boardsFile;
    if (!f) return;
    try {
      const data = JSON.parse(readFileSync(f, 'utf8'));
      if (Array.isArray(data)) {
        this.customBoards = data.filter(
          (b) =>
            b &&
            typeof b.id === 'string' &&
            typeof b.name === 'string' &&
            Array.isArray(b.columns) &&
            !DEFAULT_BOARDS.some((d) => d.id === b.id),
        );
      }
    } catch {
      /* no custom boards yet */
    }
  }

  private boardsChanged() {
    const f = this.boardsFile;
    if (f) {
      try {
        mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
        const tmp = `${f}.${process.pid}.${Date.now()}.tmp`;
        writeFileSync(tmp, JSON.stringify(this.customBoards), { mode: 0o600 });
        chmodSync(tmp, 0o600);
        renameSync(tmp, f);
      } catch (err) {
        console.error(`[tower] boards save failed: ${err}`);
      }
    }
    this.emit('boards', this.listBoards());
  }

  createBoard(name: string, columns?: unknown): { ok: true; board: Board } | { ok: false; error: 'invalid' | 'duplicate'; message: string } {
    const nm = name.trim().slice(0, 64);
    const id = slugify(nm);
    if (!id) return { ok: false, error: 'invalid', message: 'name must contain letters or digits' };
    if (this.hasBoard(id)) return { ok: false, error: 'duplicate', message: `board "${id}" already exists` };
    let cols: Board['columns'];
    if (columns == null) {
      cols = DEFAULT_BOARDS[0].columns.map((c) => ({ ...c, statuses: [...c.statuses] }));
    } else {
      if (!Array.isArray(columns) || !columns.length || columns.length > 12) {
        return { ok: false, error: 'invalid', message: 'columns must be a non-empty array (max 12)' };
      }
      cols = [];
      for (const c of columns as Array<Record<string, unknown>>) {
        if (!c || typeof c.name !== 'string' || !c.name.trim() || !Array.isArray(c.statuses)) {
          return { ok: false, error: 'invalid', message: 'each column needs name and statuses[]' };
        }
        if (!c.statuses.every((s) => ALL_STATUSES.includes(s as AgentStatus))) {
          return { ok: false, error: 'invalid', message: 'unknown status in columns' };
        }
        const cid = (typeof c.id === 'string' && slugify(c.id)) || slugify(c.name) || `col-${cols.length + 1}`;
        if (cols.some((x) => x.id === cid)) return { ok: false, error: 'invalid', message: 'duplicate column id' };
        cols.push({ id: cid, name: c.name.trim().slice(0, 64), statuses: [...new Set(c.statuses as AgentStatus[])] });
      }
    }
    const board: Board = { id, name: nm, columns: cols };
    this.customBoards = [...this.customBoards, board];
    this.boardsChanged();
    return { ok: true, board };
  }

  deleteBoard(id: string): 'ok' | 'notfound' | 'default' | 'not_empty' {
    if (DEFAULT_BOARDS.some((b) => b.id === id)) return 'default';
    if (!this.customBoards.some((b) => b.id === id)) return 'notfound';
    if ([...this.agents.values()].some((e) => !e.dead && e.summary.board === id)) return 'not_empty';
    this.customBoards = this.customBoards.filter((b) => b.id !== id);
    this.boardsChanged();
    return 'ok';
  }

  setBoard(agentId: string, board: string, customer?: string | null): 'ok' | 'notfound' | 'unknown_board' {
    const e = this.agents.get(agentId);
    if (!e) return 'notfound';
    if (!this.hasBoard(board)) return 'unknown_board';
    const next: Partial<AgentSummary> = { board };
    if (customer !== undefined) next.customer = customer || undefined;
    e.summary = { ...e.summary, ...next };
    this.emitAgent(e);
    return 'ok';
  }

  // ---- Wave D: sessions talking to each other (agent socket) ----
  private liveTowerAgents(): AgentEntry[] {
    return [...this.agents.values()].filter(
      (e) => !e.dead && !e.summary.archived && e.summary.status !== 'stopped' && e.summary.status !== 'error',
    );
  }

  listLiveAgents(): { id: string; name: string; board: string; customer?: string; status: AgentStatus; kind: AgentKind }[] {
    return this.liveTowerAgents().map((e) => ({
      id: e.summary.id,
      name: e.summary.name,
      board: e.summary.board ?? 'programs',
      customer: e.summary.customer,
      status: e.summary.status,
      kind: e.summary.kind,
    }));
  }

  agentsFor(fromId: string): SockResult<{ agents: ReturnType<AgentManager['listLiveAgents']> }> {
    if (!this.agents.has(fromId)) return { ok: false, error: 'unknown sender (TOWER_AGENT_ID)' };
    return { ok: true, agents: this.listLiveAgents() };
  }

  private liveListText(): string {
    const l = this.listLiveAgents();
    return l.length ? l.map((a) => `${a.id} (${a.name})`).join(', ') : '(none)';
  }

  sendMessage(fromId: string, to: string, text: string): SockResult<{ agentId: string; queued: boolean }> {
    const from = this.agents.get(fromId);
    if (!from || from.dead) return { ok: false, error: 'unknown sender (TOWER_AGENT_ID)' };
    let target = this.agents.get(to);
    if (target && (target.dead || target.summary.archived)) target = undefined;
    if (!target) {
      const byName = this.liveTowerAgents().filter((e) => e.summary.name === to);
      if (byName.length > 1) {
        return { ok: false, error: `name "${to}" is ambiguous; use an id. Live agents: ${this.liveListText()}` };
      }
      target = byName[0];
    }
    if (!target) return { ok: false, error: `unknown agent "${to}". Live agents: ${this.liveListText()}` };
    if (target === from) return { ok: false, error: 'cannot send a message to yourself' };
    const r = this.prompt(target.summary.id, `[From ${from.summary.name}] ${text}`);
    if (r.result !== 'ok') {
      return { ok: false, error: `agent ${target.summary.id} (${target.summary.name}) is not running. Live agents: ${this.liveListText()}` };
    }
    this.pushFeed(from, { type: 'status', id: this.nid('st'), at: Date.now(), text: `Sent to ${target.summary.name}: ${oneLine(text, 200)}` });
    this.pushFeed(target, { type: 'status', id: this.nid('st'), at: Date.now(), text: `Message from ${from.summary.name}` });
    return { ok: true, agentId: target.summary.id, queued: !!r.queued };
  }

  async handoff(
    fromId: string,
    opts: { task: string; kind?: AgentKind; board?: string },
  ): Promise<SockResult<{ agentId: string; name: string }>> {
    const from = this.agents.get(fromId);
    if (!from || from.dead) return { ok: false, error: 'unknown sender (TOWER_AGENT_ID)' };
    const board = opts.board ?? 'programs';
    if (!this.hasBoard(board)) {
      return { ok: false, error: `unknown board "${board}". Boards: ${this.listBoards().map((b) => b.id).join(', ')}` };
    }
    let agent: AgentSummary;
    try {
      agent = await this.launch(
        { kind: opts.kind ?? from.summary.kind, task: opts.task, board, accountId: undefined },
        { requestedBy: { agentId: from.summary.id, name: from.summary.name } },
      );
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'launch failed' };
    }
    const ne = this.agents.get(agent.id);
    const status = ne?.summary.status ?? agent.status;
    from.summary.handoffs = [...(from.summary.handoffs ?? []), { agentId: agent.id, name: agent.name, status }];
    this.pushFeed(from, { type: 'status', id: this.nid('st'), at: Date.now(), text: `Handed off to ${agent.name} (${agent.id})` });
    this.emitAgent(from);
    if (ne) this.syncHandoff(ne);
    return { ok: true, agentId: agent.id, name: agent.name };
  }

  shutdown() {
    if (this.timer) clearInterval(this.timer);
    if (this.capTimer) clearInterval(this.capTimer);
    if (this.tmuxTimer) clearInterval(this.tmuxTimer);
  }
}
