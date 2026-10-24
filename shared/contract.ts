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
  host: string; // os.hostname()
}

// ---- HTTP (all JSON, all require auth) ----
// GET  /api/state                         -> StateResponse
// GET  /api/agents/:id/feed               -> FeedItem[]   (full feed, oldest first)
// POST /api/agents                        body LaunchRequest -> AgentSummary (201)
// POST /api/agents/:id/prompt             body { text: string } -> 202 (409 if status is working/needs_you/starting)
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
}

// ---- WebSocket: GET /api/ws?token=... (server -> client only) ----
export type ServerEvent =
  | { type: 'snapshot'; state: StateResponse } // sent once on connect
  | { type: 'agent'; agent: AgentSummary } // upsert by agent.id
  | { type: 'feed'; agentId: string; item: FeedItem } // upsert by item.id within agentId
  | { type: 'capacity'; capacity: Capacity[] };
