// Tower contract: the ONLY shape shared by server/ and web/. Change it only through the lead.

export type AgentKind = 'devin' | 'claude' | 'codex';

// starting  : process spawned, ACP initialize/newSession in flight
// working   : a prompt turn is running and events are arriving
// needs_you : the agent is blocked on a permission request (pendingPermission is set)
// stuck     : status was working but no ACP event for TOWER_STUCK_MS (server-computed)
// done      : the last prompt turn ended (stopReason set); the agent accepts a new prompt
// error     : spawn/initialize/prompt failed (error set)
// stopped   : the user stopped it; the process is gone
// observed  : read-only card discovered from an existing tmux session (source === 'tmux')
export type AgentStatus =
  | 'starting'
  | 'working'
  | 'needs_you'
  | 'stuck'
  | 'done'
  | 'error'
  | 'stopped'
  | 'observed';

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
}

export interface PermissionRequest {
  requestId: string;
  agentId: string;
  title: string; // the tool call title, e.g. "Run npm install vite"
  toolKind?: string; // ACP tool kind: read | edit | execute | fetch | ...
  detail?: string; // short human preview of the raw input (command, path), max 400 chars
  options: PermissionOption[];
  createdAt: number; // epoch ms
}

export interface PlanEntry {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface AgentSummary {
  id: string; // short, url-safe, e.g. "a7f3"
  kind: AgentKind;
  name: string; // short label shown on the card
  task: string; // the first prompt, as typed
  cwd: string;
  model?: string;
  source: 'tower' | 'tmux';
  status: AgentStatus;
  createdAt: number;
  lastActivityAt: number;
  lastMessage?: string; // last agent text (or tool title), single line, max 280 chars
  pendingPermission?: PermissionRequest;
  plan?: PlanEntry[];
  stopReason?: string; // ACP stopReason of the last turn: end_turn | cancelled | max_tokens | refusal | ...
  error?: string;
  toolCalls: number; // count of tool calls so far
  // ---- Wave A additions ----
  queued: string[]; // prompts waiting for the current turn to end (sent FIFO, one per turn)
  usage?: { used: number; size: number }; // context tokens from ACP usage_update
  mode?: string; // current session mode id (ACP current_mode_update / setSessionMode)
  modes?: { id: string; name: string }[]; // modes the agent offers (newSession.modes.availableModes)
  configOptions?: ConfigOption[]; // e.g. model, effort, thought_level (newSession.configOptions / config_option_update)
  accountId?: string; // Account.id the agent was launched with
  resumable?: boolean; // persisted from a previous server run; POST /resume reloads it (ACP loadSession)
  // ---- Wave B additions ----
  questions?: Question[]; // open questions the agent asked with `tower ask` (status needs_you while any is open)
  commands?: { name: string; description?: string }[]; // ACP available_commands_update ("/" menu)
  archived?: boolean; // hidden from the board, listed under Archived
  limitHit?: boolean; // the last error/stop looked like a usage limit (429, quota, "limit") -> offer "Continue on another account"
  interactive?: boolean; // tmux cards only: true when TOWER_TMUX_INTERACTIVE=1 (send/key/screen allowed)
  movedFrom?: { agentId: string; accountId?: string }; // Wave C: set on the agent created by move / auto-rotate
  // ---- Wave D (boards + sessions talking to each other) ----
  board?: string; // Board.id; default 'programs'
  customer?: string; // e.g. "cust-acme": the customer this session is dedicated to (customers board)
  requestedBy?: { agentId: string; name: string }; // set on a session opened by `tower handoff`
  handoffs?: { agentId: string; name: string; status: AgentStatus }[]; // sessions this one opened (kept current)
}

export interface Board {
  id: string; // url-safe, e.g. "programs", "customers"
  name: string; // "Programs", "Customers"
  columns: { id: string; name: string; statuses: AgentStatus[] }[]; // which statuses land in each column
}

export interface Question {
  id: string;
  agentId: string;
  text: string;
  recommendation?: string;
  createdAt: number;
}

export interface Note {
  id: string;
  title: string;
  body: string;
  createdAt: number;
  archived?: boolean;
}

export interface ConfigOption {
  id: string; // ACP config option id, e.g. "model"
  name: string;
  currentValue?: string;
  options: { value: string; name: string }[];
}

export interface Account {
  id: string; // opaque, url-safe, e.g. "claude-12" (derived from the home dir basename)
  kind: AgentKind;
  label: string; // e.g. "Claude · ~/.claude-12"
  home?: string; // CLAUDE_CONFIG_DIR / CODEX_HOME value; undefined = the CLI default
  loggedIn: boolean | null; // null = unknown
  plan?: string; // e.g. "max", "pro", "Devin Max"
  usedPct?: number; // 0..100 when measurable (e.g. Codex weekly limit), else undefined
  detail?: string; // one line, no emails
  running: number; // tower agents launched with this account and not stopped/error
  loginCommand: string; // exact shell command the owner runs to log this account in
  // ---- Wave C (rotation) ----
  status?: 'ok' | 'exhausted' | 'excluded' | 'logged_out'; // server-computed, persisted (exhausted/excluded)
  resetAt?: number; // epoch ms when an exhausted account is expected back (auto-clears then)
  excluded?: boolean; // owner excluded it from Automatic + auto-rotate
}

export interface RotationState {
  autoRotate: boolean; // default true: on limitHit, move the agent to the next ok account of its kind
  activity: ActivityEntry[]; // newest first, max 200, persisted
}

export interface ActivityEntry {
  id: string;
  at: number;
  kind: 'limit_hit' | 'moved' | 'cleared' | 'excluded' | 'included' | 'no_account';
  accountId?: string;
  toAccountId?: string;
  agentId?: string;
  newAgentId?: string;
  text: string; // one human line, e.g. "Claude · ~/.claude-3 hit its limit; resets 17:40"
}

export type FeedItem =
  | { type: 'user_message'; id: string; at: number; text: string }
  | { type: 'agent_message'; id: string; at: number; text: string } // chunks of one message share one id; client upserts
  | { type: 'thought'; id: string; at: number; text: string } // same upsert rule
  | {
      type: 'tool_call';
      id: string; // === `tool-${toolCallId}`; updates upsert the same id
      at: number;
      toolCallId: string;
      title: string;
      toolKind?: string;
      status: 'pending' | 'in_progress' | 'completed' | 'failed';
      detail?: string; // max 400 chars
      output?: string; // tool result text for "expand" (rawOutput/content), max 8000 chars
    }
  | {
      type: 'permission';
      id: string; // === `perm-${requestId}`
      at: number;
      requestId: string;
      title: string;
      resolution?: string; // option name chosen, or "cancelled"
    }
  | { type: 'status'; id: string; at: number; text: string }; // lifecycle lines: "Started", "Turn ended: end_turn", "Stopped"

export interface Capacity {
  kind: AgentKind;
  label: string; // "Devin", "Claude Code", "Codex"
  available: boolean; // CLI/adapter installed and launchable on this host
  running: number; // tower agents of this kind not stopped/error
  detail?: string; // e.g. "logged in as …", "5h window 42% used"
  usedPct?: number; // 0..100 when the CLI exposes usage; omitted otherwise
}

export interface StateResponse {
  agents: AgentSummary[];
  capacity: Capacity[];
  accounts: Account[];
  notes: Note[];
  rotation?: RotationState; // Wave C
  boards: Board[]; // Wave D: always includes programs + customers
  host: string; // os.hostname()
}

// ---- HTTP (all JSON, all require auth) ----
// GET  /api/state                         -> StateResponse
// GET  /api/agents/:id/feed               -> FeedItem[]   (full feed, oldest first)
// POST /api/agents                        body LaunchRequest -> AgentSummary (201)
// POST /api/agents/:id/prompt             body { text: string; interrupt?: boolean } -> 202 { queued: boolean }
//      Wave A: accepted in any live status. done/stuck -> sent now. working/needs_you/starting -> appended to
//      AgentSummary.queued and sent when the turn ends; with interrupt:true the running turn is cancelled
//      (session/cancel, pending permissions answered cancelled) and this text is sent right after it ends.
//      409 only for stopped/error/observed.
// POST /api/agents/:id/interrupt          -> 200: session/cancel the running turn (process stays alive), queue kept
// POST /api/agents/:id/mode               body { modeId: string } -> 200 (ACP setSessionMode; 400 if not offered)
// POST /api/agents/:id/config             body { configId: string; value: string } -> 200 (ACP setSessionConfigOption)
// DELETE /api/agents/:id/queue/:index     -> 200 removes one queued prompt
// POST /api/agents/:id/resume             -> 202: for resumable agents, spawn + loadSession(sessionId) on the same account
// DELETE /api/agents/:id                  -> 200: stops if live and removes the card (tower agents only)
// GET  /api/accounts                      -> Account[] (also in StateResponse.accounts and WS 'accounts' events)
// ---- Wave B ----
// POST /api/agents/:id/answer             body { questionId: string; text: string } -> 200; removes the question and
//      delivers to the agent as a prompt (queued if busy): "[Answer to «<question, 160 chars>»] <text>"
// POST /api/agents/:id/move               body { accountId: string } -> 201 AgentSummary of a NEW agent on that account
//      (same kind), seeded with the original task + the last 40 feed items as context; the old card is stopped+archived
// POST /api/agents/:id/archive            body { archived: boolean } -> 200 (tower agents)
// POST /api/agents/:id/prompt             body may also carry attachments?: string[] (upload ids): files are copied to
//      <cwd>/attachments/<name> and the prompt gets a line "Attached: attachments/<name>" per file
// POST /api/uploads?name=<filename>       raw body (≤ 20 MB, any content-type) -> 201 { id, name, size }
// tmux cards (source 'tmux', only when interactive): POST /api/agents/:id/send { text } (bracketed paste + Enter),
//      POST /api/agents/:id/key { key } key ∈ Escape|Enter|Up|Down|Left|Right|Tab|C-c, GET /api/agents/:id/screen
//      -> { text: string; at: number } (capture-pane, last 120 lines, ANSI stripped); 409 when not interactive
// POST /api/notes { title, body } -> 201 Note · PATCH /api/notes/:id { title?, body?, archived? } -> Note
// DELETE /api/notes/:id -> 200 · POST /api/notes/:id/start { kind, accountId? } -> 201 AgentSummary (task = title + body)
// Agent CLI `tower ask [--recommendation "…"] "question"`: talks to the unix socket ~/.local/state/tower/agent.sock
//      (mode 600, no token); identifies the agent by env TOWER_AGENT_ID (set by the server for every agent it spawns).
// ---- Wave C (rotation) ----
// POST /api/accounts/:id/clear            -> 200: exhausted -> ok (activity 'cleared')
// POST /api/accounts/:id/exclude          body { excluded: boolean } -> 200 (activity 'excluded' / 'included')
// POST /api/rotation                      body { autoRotate: boolean } -> 200 RotationState
// WS { type: 'rotation'; rotation: RotationState } on every change; accounts changes still go out as 'accounts'.
// ---- Wave D (boards + sessions talking to each other) ----
// Default boards: programs { Working: starting|working|stuck, Needs you: needs_you, Done: done|stopped|error } and
//      customers { Handling: starting|working|needs_you|stuck, Waiting on the customer: done, Asleep: stopped|error }.
// POST /api/boards { name, columns? } -> 201 Board (columns default to the programs set) · DELETE /api/boards/:id (empty only)
// POST /api/agents/:id/board { board, customer? } -> 200 (moves a card between boards)
// Agent CLI over the same unix socket:
//   `tower send --to <agent id or exact name> "text"` -> delivered to that agent as a prompt (queued if busy):
//      "[From <sender name>] <text>"; feed status line on both sides. Unknown target -> error listing live agents.
//   `tower handoff [--kind devin|claude|codex] [--board programs] "task"` -> launches a new agent with
//      requestedBy = sender (same account choice: Automatic); the sender's summary.handoffs lists it; when the new
//      agent's turn ends with end_turn, the server delivers "[Handoff result from <name>] <its last agent message,
//      ≤4000 chars>" to the requester as a prompt.
//   `tower agents` -> lists live agents (id, name, board, customer, status) for the sender to address.
// WS boards changes: { type: 'boards'; boards: Board[] }
// POST /api/agents/:id/permission         body { requestId: string; optionId: string } -> 200 (404 if no such pending request)
//      ACP reply is nested: { outcome: { outcome: 'selected', optionId } }
// POST /api/agents/:id/stop               -> 200: (a) answer any pending permission { outcome: { outcome: 'cancelled' } },
//      (b) send session/cancel, (c) SIGTERM then SIGKILL after 3 s; status stopped
// ACP v1 notes for the server (SDK 1.9.0): message/thought chunks carry content: ContentBlock — use text only when
// content.type === 'text', render other blocks as "[image]" etc.; tool_call_update fields are partial — merge onto the
// stored tool call (last writer wins per field) and always emit the full merged item; permission title/toolKind/detail
// come from params.toolCall.{title,kind,rawInput}; unknown sessionUpdate variants are ignored (log once).
// stopReason values: end_turn | max_tokens | max_turn_requests | refusal | cancelled. Stuck applies only from working.
// The server never logs request URLs (the WS token travels in ?token=).
// Errors: { error: string } with 400/401/404/409/500.
//
// Auth: every /api/* request and the WebSocket need the token from env TOWER_TOKEN,
// as `Authorization: Bearer <token>` or `?token=<token>` (the web app reads ?token= once from
// the page URL and stores it in localStorage). Non-/api paths serve web/dist statically.
// Server env: TOWER_HOST (default 127.0.0.1), TOWER_PORT (default 4747), TOWER_TOKEN (required),
// TOWER_WORK_DIR (default ~/tower-work), TOWER_STUCK_MS (default 300000).

export interface LaunchRequest {
  kind: AgentKind;
  task: string; // first prompt, required, non-empty
  name?: string; // default: first 4 words of task
  model?: string; // passed to the agent when supported (devin: --model)
  accountId?: string; // Account.id; omitted or 'auto' = the logged-in account of that kind with the lowest usedPct
  board?: string; // Wave D
  customer?: string; // Wave D
}

// ---- WebSocket: GET /api/ws?token=... (server -> client only) ----
export type ServerEvent =
  | { type: 'snapshot'; state: StateResponse } // sent once on connect
  | { type: 'agent'; agent: AgentSummary } // upsert by agent.id
  | { type: 'feed'; agentId: string; item: FeedItem } // upsert by item.id within agentId
  | { type: 'capacity'; capacity: Capacity[] }
  | { type: 'accounts'; accounts: Account[] }
  | { type: 'agent_removed'; agentId: string }
  | { type: 'notes'; notes: Note[] }
  | { type: 'rotation'; rotation: RotationState }
  | { type: 'boards'; boards: Board[] };
