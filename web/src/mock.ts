// In-browser fake Tower server. Emits contract-shaped ServerEvents over time. Never touches /api.
import type {
  Account,
  AgentKind,
  ConfigOption,
  AgentSummary,
  Board,
  Capacity,
  FeedItem,
  Note,
  PlanEntry,
  ActivityEntry,
  RotationState,
  ServerEvent,
  SessionWorkspace,
} from '../../shared/contract';
import type { Transport } from './api';
import type { LaunchRequest } from '../../shared/contract';

type Step =
  | { say: string }
  | { think: string }
  | { tool: string; kind: string; detail?: string; fail?: boolean }
  | { plan: number } // complete entry n-1, start entry n
  | { ask: string; kind: string; detail: string }
  | { end: string };

interface Runner {
  steps: Step[];
  i: number;
  sub: number;
  msgId?: string;
  toolId?: string;
}

const LABEL: Record<AgentKind, string> = { devin: 'Devin', claude: 'Claude Code', codex: 'Codex' };

export function mockTransport(): Transport {
  const T = Date.now();
  const agents = new Map<string, AgentSummary>();
  const feeds = new Map<string, FeedItem[]>();
  const runners = new Map<string, Runner>();
  let emit: (ev: ServerEvent) => void = () => {};
  let seq = 100;
  const uid = (p: string) => `${p}-${(seq++).toString(36)}`;

  const capacity = (): Capacity[] => {
    const running = (k: AgentKind) =>
      [...agents.values()].filter((a) => a.kind === k && a.source === 'tower' && a.status !== 'stopped' && a.status !== 'error').length;
    return [
      { kind: 'devin', label: 'Devin', available: true, running: running('devin'), detail: 'Logged in as gustavo@evaai.mx' },
      { kind: 'claude', label: 'Claude Code', available: true, running: running('claude'), detail: '5h window 42% used', usedPct: 42 },
      { kind: 'codex', label: 'Codex', available: true, running: running('codex'), detail: 'Weekly limit 18% used', usedPct: 18 },
    ];
  };

  const accountsList: Account[] = [
    { id: 'claude-12', kind: 'claude', label: 'Claude · ~/.claude-12', home: '~/.claude-12', loggedIn: true, plan: 'max', usedPct: 42, detail: '5h window 42% used', running: 0, loginCommand: 'CLAUDE_CONFIG_DIR=~/.claude-12 claude /login' },
    { id: 'claude-3', kind: 'claude', label: 'Claude · ~/.claude-3', home: '~/.claude-3', loggedIn: true, plan: 'max', usedPct: 9, detail: '5h window 9% used', running: 0, loginCommand: 'CLAUDE_CONFIG_DIR=~/.claude-3 claude /login' },
    { id: 'claude-5', kind: 'claude', label: 'Claude · ~/.claude-5', home: '~/.claude-5', loggedIn: null, plan: 'max', usedPct: 100, detail: '5h window 100% used', running: 0, loginCommand: 'CLAUDE_CONFIG_DIR=~/.claude-5 claude /login', status: 'exhausted', resetAt: T + 40 * 60_000 },
    { id: 'claude-7', kind: 'claude', label: 'Claude · ~/.claude-7', home: '~/.claude-7', loggedIn: false, running: 0, detail: 'Not logged in', loginCommand: 'CLAUDE_CONFIG_DIR=~/.claude-7 claude /login' },
    { id: 'codex', kind: 'codex', label: 'Codex · ~/.codex', loggedIn: true, plan: 'pro', usedPct: 18, detail: 'Weekly limit 18% used', running: 0, loginCommand: 'codex login' },
    { id: 'codex-2', kind: 'codex', label: 'Codex · ~/.codex-2', home: '~/.codex-2', loggedIn: true, plan: 'plus', usedPct: 61, detail: 'Weekly limit 61% used', running: 0, loginCommand: 'CODEX_HOME=~/.codex-2 codex login', excluded: true },
    { id: 'devin', kind: 'devin', label: 'Devin', loggedIn: true, plan: 'Devin Max', running: 0, loginCommand: 'devin auth login' },
  ];
  const statusOf = (a: Account): NonNullable<Account['status']> =>
    a.loggedIn === false ? 'logged_out' : a.excluded ? 'excluded' : a.status === 'exhausted' ? 'exhausted' : 'ok';
  const accounts = (): Account[] =>
    accountsList.map((acc) => ({
      ...acc,
      status: statusOf(acc),
      running: [...agents.values()].filter((a) => a.accountId === acc.id && a.status !== 'stopped' && a.status !== 'error').length,
    }));
  const rotation: RotationState = {
    autoRotate: true,
    activity: [
      { id: 'act-4', at: T - 3 * 60_000, kind: 'moved', accountId: 'claude-5', toAccountId: 'claude-3', agentId: 'c9p0', newAgentId: 'c9p4', text: 'Moved fix-tests to Claude · ~/.claude-3' },
      { id: 'act-3', at: T - 3 * 60_000 - 4000, kind: 'limit_hit', accountId: 'claude-5', text: 'Claude · ~/.claude-5 hit its limit' },
      { id: 'act-2', at: T - 52 * 60_000, kind: 'no_account', accountId: 'codex', text: 'No Codex account available; kept the agent waiting' },
      { id: 'act-1', at: T - 3 * 3600_000, kind: 'cleared', accountId: 'claude-12', text: 'Claude · ~/.claude-12 is available again' },
    ],
  };
  const emitRotation = () => emit({ type: 'rotation', rotation: { ...rotation, activity: rotation.activity.map((x) => ({ ...x })) } });
  const logActivity = (e: Omit<ActivityEntry, 'id' | 'at'>) => {
    rotation.activity.unshift({ ...e, id: uid('act'), at: Date.now() });
    rotation.activity.splice(200);
    emitRotation();
  };
  const MODES: Record<AgentKind, { id: string; name: string }[]> = {
    claude: [{ id: 'default', name: 'Default' }, { id: 'acceptEdits', name: 'Accept edits' }, { id: 'plan', name: 'Plan mode' }, { id: 'bypassPermissions', name: 'Bypass permissions' }],
    codex: [{ id: 'read-only', name: 'Read only' }, { id: 'auto', name: 'Auto' }, { id: 'full-access', name: 'Full access' }],
    devin: [{ id: 'normal', name: 'Normal' }, { id: 'plan', name: 'Plan' }],
  };
  const CONFIG: Record<AgentKind, ConfigOption[]> = {
    claude: [{ id: 'model', name: 'Model', currentValue: 'opus', options: [{ value: 'opus', name: 'Opus' }, { value: 'sonnet', name: 'Sonnet' }, { value: 'haiku', name: 'Haiku' }] }],
    codex: [
      { id: 'model', name: 'Model', currentValue: 'gpt-5-codex', options: [{ value: 'gpt-5-codex', name: 'GPT-5 Codex' }, { value: 'gpt-5', name: 'GPT-5' }] },
      { id: 'effort', name: 'Effort', currentValue: 'medium', options: [{ value: 'low', name: 'Low effort' }, { value: 'medium', name: 'Medium effort' }, { value: 'high', name: 'High effort' }] },
    ],
    devin: [{ id: 'thought_level', name: 'Thought level', currentValue: 'normal', options: [{ value: 'normal', name: 'Normal thinking' }, { value: 'deep', name: 'Deep thinking' }] }],
  };
  const COMMANDS: Record<AgentKind, { name: string; description?: string }[]> = {
    claude: [
      { name: 'compact', description: 'Summarize the conversation to free context' },
      { name: 'review', description: 'Review the current diff' },
      { name: 'init', description: 'Write a CLAUDE.md for this repo' },
      { name: 'pr-comments', description: 'Fetch comments from the open PR' },
      { name: 'clear', description: 'Start a fresh conversation' },
    ],
    codex: [
      { name: 'review', description: 'Review my current changes' },
      { name: 'diff', description: 'Show the git diff' },
      { name: 'compact', description: 'Summarize to free context' },
    ],
    devin: [
      { name: 'plan', description: 'Switch to plan mode' },
      { name: 'test', description: 'Run the test suite' },
    ],
  };
  const ACC: Record<AgentKind, string> = { claude: 'claude-12', codex: 'codex', devin: 'devin' };
  const defaults = (kind: AgentKind): Pick<AgentSummary, 'queued' | 'modes' | 'mode' | 'configOptions' | 'usage' | 'accountId' | 'commands'> => ({
    queued: [],
    commands: COMMANDS[kind],
    modes: MODES[kind],
    mode: MODES[kind][0].id,
    configOptions: CONFIG[kind].map((c) => ({ ...c })),
    usage: { used: 12000 + Math.floor(Math.random() * 60000), size: 200000 },
    accountId: ACC[kind],
  });

  const put = (a: AgentSummary) => {
    agents.set(a.id, a);
    emit({ type: 'agent', agent: a });
    // Wave D: keep the requester's handoffs list current
    const r = a.requestedBy && agents.get(a.requestedBy.agentId);
    const h = r && r.handoffs?.find((x) => x.agentId === a.id);
    if (r && h && h.status !== a.status) {
      const nr = { ...r, handoffs: r.handoffs!.map((x) => (x.agentId === a.id ? { ...x, status: a.status } : x)) };
      agents.set(nr.id, nr);
      emit({ type: 'agent', agent: nr });
    }
  };
  const patch = (id: string, p: Partial<AgentSummary>) => {
    const a = agents.get(id);
    if (!a) return;
    put({ ...a, ...p, lastActivityAt: Date.now() });
  };
  const feed = (agentId: string, item: FeedItem, silent = false) => {
    const list = feeds.get(agentId) ?? [];
    const i = list.findIndex((x) => x.id === item.id);
    if (i === -1) list.push(item);
    else list[i] = item;
    feeds.set(agentId, list);
    if (!silent) emit({ type: 'feed', agentId, item });
  };

  const mkAgent = (
    id: string,
    kind: AgentKind,
    name: string,
    task: string,
    status: AgentSummary['status'],
    ago: number,
    extra: Partial<AgentSummary> = {},
  ): AgentSummary => ({
    id,
    kind,
    name,
    task,
    cwd: `~/tower-work/${name}`,
    source: 'tower',
    status,
    createdAt: T - ago * 1000,
    lastActivityAt: T - 3000,
    toolCalls: 0,
    ...defaults(kind),
    ...extra,
  });

  const plan = (items: string[], done: number): PlanEntry[] =>
    items.map((content, i) => ({ content, status: i < done ? 'completed' : i === done ? 'in_progress' : 'pending' }));

  // ---------- seed ----------
  type Seed = FeedItem extends infer F ? (F extends FeedItem ? Omit<F, 'id' | 'at'> : never) : never;
  const seedHistory = (id: string, task: string, items: Array<Seed & { id?: string }>, startAgo: number) => {
    feed(id, { type: 'status', id: uid('st'), at: T - startAgo * 1000, text: 'Started' }, true);
    feed(id, { type: 'user_message', id: uid('u'), at: T - startAgo * 1000 + 800, text: task }, true);
    items.forEach((it, n) => {
      const at = T - startAgo * 1000 + 2000 + n * ((startAgo * 1000 - 4000) / Math.max(1, items.length));
      feed(id, { ...(it as FeedItem), id: it.id ?? uid('f'), at } as FeedItem, true);
    });
  };
  const fakeOutput = (title: string, detail?: string) =>
    title.startsWith('Run')
      ? `$ ${detail ?? title.slice(4)}\n\n> tower@0.1.0 ${detail ?? ''}\n\n  ✓ 24 passed (1.8s)\n`
      : title.startsWith('Edit') || title.startsWith('Write')
        ? `--- a/${(detail ?? '').split(' ')[0]}\n+++ b/${(detail ?? '').split(' ')[0]}\n@@ -1,4 +1,8 @@\n+import { z } from 'zod';\n+\n export function handler() {\n-  return null;\n+  return ok();\n }\n`
        : `${detail ?? title}\n${Array.from({ length: 30 }, (_, i) => `  line ${i + 1}: …`).join('\n')}`;
  const tc = (title: string, toolKind: string, detail?: string, status: 'completed' | 'failed' = 'completed') => {
    const toolCallId = uid('tc');
    return { type: 'tool_call' as const, id: `tool-${toolCallId}`, toolCallId, title, toolKind, status, detail, output: fakeOutput(title, detail) };
  };

  const apiPlan = ['Read existing router setup', 'Add /agents CRUD routes', 'Validate request bodies', 'Write route tests', 'Update OpenAPI spec'];
  const a1 = mkAgent('a1d3', 'devin', 'api-routes', 'Add REST routes for agents with validation and tests', 'working', 742, {
    plan: plan(apiPlan, 2),
    toolCalls: 6,
    lastMessage: 'Routes are wired. Now adding zod validation for the launch body.',
  });
  seedHistory(a1.id, a1.task, [
    { type: 'thought', text: 'The router lives in server/src/http.ts. I should keep handlers thin and put validation in one place.' },
    tc('Read server/src/http.ts', 'read', 'server/src/http.ts'),
    tc('Search "router.get"', 'search', 'rg -n "router.get" server/src'),
    { type: 'agent_message', text: 'The server uses a small hand-rolled router. I will add the agent routes next to the existing health check.' },
    tc('Edit server/src/routes/agents.ts', 'edit', 'server/src/routes/agents.ts  +84 −0'),
    tc('Edit server/src/http.ts', 'edit', 'server/src/http.ts  +6 −1'),
    tc('Run npm run typecheck', 'execute', 'npm run typecheck'),
    { type: 'agent_message', text: 'Routes are wired. Now adding zod validation for the launch body.' },
  ], 742);

  const a2 = mkAgent('b7k2', 'claude', 'landing-page', 'Build a landing page for Tower with a hero, features and a demo GIF', 'needs_you', 518, {
    plan: plan(['Scaffold Vite app', 'Install dependencies', 'Hero section', 'Feature grid', 'Responsive pass'], 1),
    toolCalls: 3,
    lastMessage: 'I need to install Vite before I can scaffold the page.',
  });
  seedHistory(a2.id, a2.task, [
    tc('List site/', 'read', 'site/'),
    { type: 'agent_message', text: 'The site folder is empty, so I will scaffold a fresh Vite + React app with a single page.' },
    tc('Write site/index.html', 'edit', 'site/index.html  +42'),
    tc('Write site/src/Hero.tsx', 'edit', 'site/src/Hero.tsx  +61'),
    { type: 'agent_message', text: 'I need to install Vite before I can scaffold the page.' },
  ], 518);
  const permReq = {
    requestId: 'r-vite',
    agentId: a2.id,
    title: 'Run npm install vite',
    toolKind: 'execute',
    detail: 'npm install vite@5.4.10',
    options: [
      { optionId: 'allow', name: 'Allow once', kind: 'allow_once' as const },
      { optionId: 'always', name: 'Always allow', kind: 'allow_always' as const },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' as const },
    ],
    createdAt: T - 21000,
  };
  a2.pendingPermission = permReq;
  feed(a2.id, { type: 'permission', id: 'perm-r-vite', at: T - 21000, requestId: 'r-vite', title: permReq.title }, true);

  const a3 = mkAgent('c9p4', 'claude', 'fix-tests', 'Fix the flaky websocket reconnect test in server/test', 'needs_you', 1630, {
    toolCalls: 11,
    accountId: 'claude-3',
    movedFrom: { agentId: 'c9p0', accountId: 'claude-5' },
    questions: [
      {
        id: 'q-flake',
        agentId: 'c9p4',
        text: 'The flake comes from a 50 ms backoff race. Should I fix it with fake timers in the test, or by making the client backoff injectable?',
        recommendation: 'Make the backoff injectable; the test then passes a 0 ms delay and stays deterministic.',
        createdAt: T - 95000,
      },
    ],
    lastMessage: 'Running the reconnect test 50 times to reproduce the flake…',
  });
  seedHistory(a3.id, a3.task, [
    tc('Read server/test/ws.test.ts', 'read', 'server/test/ws.test.ts'),
    { type: 'agent_message', text: 'The test races the server close against the client backoff timer. I will reproduce it in a loop first.' },
    tc('Run vitest ws.test.ts', 'execute', 'npx vitest run server/test/ws.test.ts', 'failed'),
    { type: 'agent_message', text: 'Running the reconnect test 50 times to reproduce the flake…' },
    tc('Run test loop', 'execute', 'for i in $(seq 50); do npx vitest run ws.test.ts || break; done'),
  ], 1630);
  a3.lastActivityAt = T - 6 * 60 * 1000;

  const a4 = mkAgent('d2m8', 'devin', 'docs', 'Write the README: what Tower is, install, run, and the ACP architecture', 'done', 2410, {
    toolCalls: 5,
    stopReason: 'end_turn',
    lastMessage: 'README.md is done: overview, quick start, architecture diagram and FAQ.',
    plan: plan(['Outline sections', 'Quick start', 'Architecture', 'FAQ'], 4),
  });
  seedHistory(a4.id, a4.task, [
    tc('Read package.json', 'read', 'package.json'),
    tc('Write README.md', 'edit', 'README.md  +128'),
    { type: 'agent_message', text: 'README.md is done: overview, quick start, architecture diagram and FAQ.' },
    { type: 'status', text: 'Turn ended: end_turn' },
  ], 2410);
  a4.lastActivityAt = T - 9 * 60 * 1000;

  const authPlan = ['Map current session handling', 'Extract token service', 'Replace cookie parsing', 'Migrate callers', 'Run full test suite', 'Remove dead code'];
  const a5 = mkAgent('e5q1', 'codex', 'refactor-auth', 'Refactor auth into a token service and remove the legacy cookie path', 'working', 1205, {
    plan: plan(authPlan, 3),
    toolCalls: 9,
    lastMessage: 'Token service extracted. Migrating the 7 callers now.',
    model: 'gpt-6-sol',
  });
  seedHistory(a5.id, a5.task, [
    tc('Search "parseCookie"', 'search', 'rg -n parseCookie src'),
    { type: 'agent_message', text: 'Found 7 callers of the legacy cookie parser across 4 files.' },
    tc('Write src/auth/token-service.ts', 'edit', 'src/auth/token-service.ts  +96'),
    tc('Edit src/auth/session.ts', 'edit', 'src/auth/session.ts  +12 −48'),
    { type: 'agent_message', text: 'Token service extracted. Migrating the 7 callers now.' },
  ], 1205);

  const o1: AgentSummary = {
    ...mkAgent('t1x9', 'claude', 'eva-forge · infra', 'tmux session "infra" on eva-forge', 'observed', 5400),
    source: 'tmux',
    cwd: '~/code/eva',
    lastMessage: 'Watching deploy logs for the canary release…',
  };
  const o2: AgentSummary = {
    ...mkAgent('t2y4', 'codex', 'review-lane', 'tmux session "review" on eva-forge', 'observed', 3100),
    source: 'tmux',
    cwd: '~/code/eva/.desk/review',
    lastMessage: 'Cross-model review: 0 P0, 1 P1 folded.',
  };
  const a6 = mkAgent('f8n3', 'claude', 'migrate-db', 'Migrate the agents table to store accountId and archived', 'error', 980, {
    toolCalls: 4,
    limitHit: true,
    error: 'Claude usage limit reached (429). Your limit resets at 18:00.',
    lastMessage: 'Usage limit reached',
  });
  seedHistory(a6.id, a6.task, [
    tc('Read server/src/db.ts', 'read', 'server/src/db.ts'),
    { type: 'agent_message', text: 'I will add two nullable columns and backfill accountId from the launch log.' },
    tc('Write server/migrations/004_agents.sql', 'edit', 'server/migrations/004_agents.sql  +14'),
    { type: 'status', text: 'Error: usage limit reached (429)' },
  ], 980);
  a6.lastActivityAt = T - 4 * 60 * 1000;
  const notes: Note[] = [
    { id: 'n1', title: 'Dark mode for settings', body: 'Add a theme toggle to settings and persist it in localStorage.', createdAt: T - 3600_000 },
    { id: 'n2', title: 'Flaky CI on Linux', body: 'ws.test.ts fails ~1 in 20 on the Linux runner. Look at the backoff timer.', createdAt: T - 7200_000 },
  ];
  const emitNotes = () => emit({ type: 'notes', notes: notes.map((n) => ({ ...n })) });
  const uploads = new Map<string, string>();
  [a1, a2, a3, a4, a5, a6, o1, o2].forEach((a) => agents.set(a.id, a));
  // ---------- Wave D: boards + customer sessions + one handoff ----------
  const boards: Board[] = [
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
  const emitBoards = () => emit({ type: 'boards', boards: boards.map((b) => ({ ...b, columns: b.columns.map((c) => ({ ...c })) })) });
  const cAcme = mkAgent('k1a2', 'claude', 'acme-onboarding', 'Own the Acme Corp account: answer their WhatsApp questions and get their export working', 'needs_you', 2900, {
    board: 'customers',
    customer: 'cust-acme',
    toolCalls: 7,
    lastMessage: 'Acme says the CSV export drops accents. I opened a program session to fix it.',
    handoffs: [{ agentId: 'g4h2', name: 'csv-export-accents', status: 'working' }],
  });
  const cDelta = mkAgent('k2d7', 'claude', 'delta-pricing', 'Delta Foods: explain the Pro plan and send the quote', 'done', 5200, {
    board: 'customers',
    customer: 'cust-delta',
    stopReason: 'end_turn',
    lastMessage: 'Sent the quote; waiting for Delta to reply.',
  });
  const cLumen = mkAgent('k3l5', 'codex', 'lumen-import', 'Lumen Studio: import their 3,000 contacts and confirm the count', 'working', 640, {
    board: 'customers',
    customer: 'cust-lumen',
    toolCalls: 3,
    plan: plan(['Read their CSV', 'Map columns', 'Import', 'Confirm with Lumen'], 2),
    lastMessage: 'Imported 2,140 of 3,000 contacts…',
  });
  const cPrisma = mkAgent('k4p9', 'devin', 'prisma-followup', 'Prisma Dental: follow up on the demo next week', 'stopped', 86_400, {
    board: 'customers',
    customer: 'cust-prisma',
    stopReason: 'cancelled',
    lastMessage: 'Asleep until Monday 9:00.',
  });
  const hFix = mkAgent('g4h2', 'claude', 'csv-export-accents', 'Fix the CSV export so accented names (José, Peña) survive: write UTF-8 with BOM', 'working', 300, {
    board: 'programs',
    requestedBy: { agentId: 'k1a2', name: 'acme-onboarding' },
    toolCalls: 2,
    plan: plan(['Reproduce with José Peña', 'Write UTF-8 with BOM', 'Add a test', 'Report back'], 1),
    lastMessage: 'Reproduced: the export is written as latin1.',
  });
  [cAcme, cDelta, cLumen, cPrisma, hFix].forEach((a) => {
    agents.set(a.id, a);
    seedHistory(a.id, a.task, [{ type: 'agent_message', text: a.lastMessage ?? '' }], Math.min(3600, (T - a.createdAt) / 1000));
  });
  for (const o of [o1, o2]) feed(o.id, { type: 'status', id: uid('st'), at: o.createdAt, text: 'Observed from tmux (read-only)' }, true);

  // ---------- session workspace: observed tmux history + context ----------
  // t3w5 has a long saved conversation (paged), t2y4 a short one, t1x9 none (its terminal is the only view).
  const o3: AgentSummary = {
    ...mkAgent('t3w5', 'claude', 'billing-webhooks', 'tmux session "billing" on eva-forge', 'working', 7200),
    source: 'tmux',
    board: 'programs',
    interactive: true,
    cwd: '~/code/eva/.desk/billing',
    model: 'claude-opus-5-5',
    lastMessage: 'Replaying the failed Stripe webhooks against the staging desk…',
  };
  agents.set(o3.id, o3);
  const history = new Map<string, FeedItem[]>();
  const o3Hist: FeedItem[] = [];
  const steps = [
    'Read server/billing/webhooks.ts',
    'Run pnpm vitest billing',
    'Search "invoice.paid"',
    'Edit server/billing/webhooks.ts',
    'Run ./eva test ready',
  ];
  for (let n = 0; n < 32; n++) {
    const at = T - 7200_000 + n * 200_000;
    o3Hist.push({ type: 'user_message', id: `t3-u${n}`, at, text: n === 0 ? 'Stripe says 14 invoice.paid webhooks failed overnight. Find out why and fix it without touching production data.' : `Step ${n}: keep going, and tell me before anything visible changes.` });
    const tool = steps[n % steps.length];
    const toolCallId = `t3-tc${n}`;
    o3Hist.push({ type: 'tool_call', id: `tool-${toolCallId}`, at: at + 20_000, toolCallId, title: tool, toolKind: tool.startsWith('Run') ? 'execute' : tool.startsWith('Edit') ? 'edit' : 'read', status: n === 7 ? 'failed' : 'completed', detail: tool.replace(/^\w+\s/, ''), output: fakeOutput(tool, tool.replace(/^\w+\s/, '')) });
    o3Hist.push({
      type: 'agent_message',
      id: `t3-m${n}`,
      at: at + 60_000,
      text:
        n === 0
          ? 'The failures all share one cause: the handler rejects events whose `customer` field is **null**, which Stripe sends for guest checkouts.\n\n- 14 events since 02:10\n- All `invoice.paid`\n- None reached the ledger'
          : `Checkpoint ${n}: ${n % 3 === 0 ? 'tests are green on the desk.' : n % 3 === 1 ? 'replayed one more batch; no duplicates in the ledger.' : 'reviewed the retry path, no change needed.'}`,
    });
  }
  history.set(o3.id, o3Hist);
  history.set(o2.id, [
    { type: 'user_message', id: 't2-u0', at: T - 3000_000, text: 'Run the cross-model review on the billing branch and fold anything P0/P1.' },
    { type: 'tool_call', id: 'tool-t2-tc0', at: T - 2900_000, toolCallId: 't2-tc0', title: 'Run ./eva review --cross-model', toolKind: 'execute', status: 'completed', detail: './eva review --cross-model', output: 'P0: 0\nP1: 1 (retry without idempotency key)\nP2: 3' },
    { type: 'agent_message', id: 't2-m0', at: T - 2800_000, text: 'Cross-model review: **0 P0, 1 P1** — the retry path could double-post without an idempotency key. Folding it now.' },
    { type: 'tool_call', id: 'tool-t2-tc1', at: T - 2700_000, toolCallId: 't2-tc1', title: 'Edit server/billing/retry.ts', toolKind: 'edit', status: 'completed', detail: 'server/billing/retry.ts  +9 −2', output: fakeOutput('Edit server/billing/retry.ts', 'server/billing/retry.ts') },
    { type: 'agent_message', id: 't2-m1', at: T - 2600_000, text: 'Cross-model review: 0 P0, 1 P1 folded.' },
  ]);
  const contexts: Record<string, SessionWorkspace['context']> = {
    [o3.id]: {
      summary: 'Fixing failed Stripe invoice.paid webhooks for guest checkouts on the billing desk. Production data is untouched; replays run on staging.',
      pending: [
        { text: 'Replay the 14 failed webhooks in production once the fix ships?', recommendation: 'Yes, after the ready gate passes; replays are idempotent.' },
        { text: 'Notify the two affected customers?', recommendation: 'Only if a replay fails.' },
      ],
      delivery: { text: 'Fix pushed to the billing branch; ready gate green.', url: 'https://github.com/example/eva/pull/482', at: new Date(T - 20 * 60_000).toISOString() },
      links: [
        { title: 'Pull request #482', url: 'https://github.com/example/eva/pull/482' },
        { title: 'Stripe webhook log', url: 'https://dashboard.stripe.com/test/webhooks' },
      ],
    },
    [o2.id]: { summary: 'Cross-model review of the billing branch. One P1 folded; waiting for the next diff.' },
    [o1.id]: { summary: 'Watching the canary deploy logs and comparing p95 with the previous release.' },
  };
  const PAGE = 30;
  const workspaceOf = (id: string, before?: string): SessionWorkspace | null => {
    const a = agents.get(id);
    if (!a) return null;
    const context = contexts[id] ?? {};
    if (a.source !== 'tmux') {
      return { conversation: { available: true, items: (feeds.get(id) ?? []).map((x) => ({ ...x })), hasMore: false }, context };
    }
    const all = history.get(id);
    if (!all) {
      return {
        conversation: { available: false, reason: 'No saved conversation was found for this session.', items: [], hasMore: false },
        context,
      };
    }
    const end = before !== undefined ? Math.max(0, Math.min(all.length, Number(before) || 0)) : all.length;
    const start = Math.max(0, end - PAGE);
    return {
      conversation: { available: true, items: all.slice(start, end).map((x) => ({ ...x })), hasMore: start > 0, before: start > 0 ? String(start) : undefined },
      context,
    };
  };
  // the long session keeps working: one new checkpoint every 12 s (a few times)
  let grow = 0;
  const growTimer = setInterval(() => {
    if (++grow > 8) return clearInterval(growTimer);
    const at = Date.now();
    o3Hist.push({ type: 'agent_message', id: `t3-live${grow}`, at, text: `Live update ${grow}: replayed batch ${grow} of 8 on staging, ledger matches Stripe.` });
    patch(o3.id, { lastMessage: `Replayed batch ${grow} of 8 on staging.` });
  }, 12_000);

  // ---------- scripts ----------
  runners.set(a1.id, {
    i: 0,
    sub: 0,
    steps: [
      { tool: 'Edit server/src/routes/schema.ts', kind: 'edit', detail: 'server/src/routes/schema.ts  +38' },
      { say: 'Validation is in place: launch bodies need a known kind and a non-empty task, and bad input returns a 400 with a clear message.' },
      { plan: 3 },
      { think: 'Tests should cover 201, 400 on empty task, 404 on unknown agent, and 409 while a turn is running.' },
      { tool: 'Write server/test/routes.test.ts', kind: 'edit', detail: 'server/test/routes.test.ts  +112' },
      { tool: 'Run npx vitest run routes', kind: 'execute', detail: 'npx vitest run server/test/routes.test.ts' },
      { say: 'All 14 route tests pass. Updating the OpenAPI spec so the web client and docs stay in sync.' },
      { plan: 4 },
      { tool: 'Edit docs/openapi.yaml', kind: 'edit', detail: 'docs/openapi.yaml  +64 −3' },
      { plan: 5 },
      { say: 'Done. Six routes added with validation and tests; the OpenAPI spec is updated.' },
      { end: 'end_turn' },
    ],
  });
  runners.set(a5.id, {
    i: 0,
    sub: 0,
    steps: [
      { tool: 'Edit src/api/login.ts', kind: 'edit', detail: 'src/api/login.ts  +4 −11' },
      { tool: 'Edit src/api/logout.ts', kind: 'edit', detail: 'src/api/logout.ts  +3 −9' },
      { say: 'Login and logout now go through the token service. Three callers left in middleware.' },
      { tool: 'Edit src/middleware/auth.ts', kind: 'edit', detail: 'src/middleware/auth.ts  +9 −27' },
      { plan: 4 },
      { tool: 'Run npm test', kind: 'execute', detail: 'npm test -- --reporter=dot' },
      { say: 'The suite is green: 212 passed. Removing the legacy cookie helpers.' },
      { plan: 5 },
      { tool: 'Delete src/auth/legacy-cookie.ts', kind: 'delete', detail: 'src/auth/legacy-cookie.ts  −140' },
      { plan: 6 },
      { say: 'Refactor complete. Auth now lives in one token service and the cookie path is gone (−212 lines).' },
      { end: 'end_turn' },
    ],
  });
  const afterAllow = (): Runner => ({
    i: 0,
    sub: 0,
    steps: [
      { tool: 'Run npm install vite', kind: 'execute', detail: 'npm install vite@5.4.10' },
      { plan: 2 },
      { say: 'Vite is installed. Building the hero: a big headline, one sentence and a screenshot of the board.' },
      { tool: 'Edit site/src/Hero.tsx', kind: 'edit', detail: 'site/src/Hero.tsx  +24 −6' },
      { plan: 3 },
      { tool: 'Write site/src/Features.tsx', kind: 'edit', detail: 'site/src/Features.tsx  +58' },
      { say: 'Hero and feature grid are done. Doing a responsive pass next.' },
      { plan: 4 },
      { tool: 'Edit site/src/styles.css', kind: 'edit', detail: 'site/src/styles.css  +31 −4' },
      { plan: 5 },
      { say: 'The landing page is ready at site/. It looks good from 360px to desktop.' },
      { end: 'end_turn' },
    ],
  });
  const replyScript = (text: string, withPlan: boolean): Runner => ({
    i: 0,
    sub: 0,
    steps: [
      { think: `The user asked: "${text.slice(0, 80)}". Let me look at the relevant files first.` },
      ...(withPlan ? [{ plan: 0 } as Step] : []),
      { tool: 'Search workspace', kind: 'search', detail: `rg -n "${text.split(/\s+/)[0] ?? 'todo'}" .` },
      { say: 'I looked through the workspace and know where to make the change.' },
      ...(withPlan ? [{ plan: 1 } as Step] : []),
      { tool: 'Edit src/index.ts', kind: 'edit', detail: 'src/index.ts  +18 −2' },
      ...(withPlan ? [{ plan: 2 } as Step] : []),
      { tool: 'Run npm test', kind: 'execute', detail: 'npm test' },
      ...(withPlan ? [{ plan: 3 } as Step] : []),
      { say: 'Done. The change is in and the tests pass.\n\n- **Edited** `src/index.ts`\n- Ran `npm test`: *all green*' },
      { end: 'end_turn' },
    ],
  });

  // ---------- engine ----------
  const step = (id: string) => {
    const a = agents.get(id);
    const r = runners.get(id);
    if (!a || !r || a.status !== 'working') return;
    const s = r.steps[r.i];
    if (!s) {
      runners.delete(id);
      return;
    }
    const next = () => {
      r.i++;
      r.sub = 0;
      r.msgId = undefined;
      r.toolId = undefined;
    };
    const now = Date.now();
    if ('say' in s || 'think' in s) {
      const text = 'say' in s ? s.say : s.think;
      const words = text.split(' ');
      r.msgId ??= uid('say' in s ? 'm' : 'th');
      r.sub = Math.min(words.length, r.sub + ('say' in s ? 3 : 8));
      const partial = words.slice(0, r.sub).join(' ');
      feed(id, { type: 'say' in s ? 'agent_message' : 'thought', id: r.msgId, at: now, text: partial });
      if ('say' in s) patch(id, { lastMessage: partial });
      else patch(id, {});
      if (r.sub >= words.length) next();
    } else if ('tool' in s) {
      const statuses = ['pending', 'in_progress', 'in_progress', s.fail ? 'failed' : 'completed'] as const;
      if (!r.toolId) r.toolId = uid('tc');
      const status = statuses[r.sub];
      feed(id, { type: 'tool_call', id: `tool-${r.toolId}`, at: now, toolCallId: r.toolId, title: s.tool, toolKind: s.kind, status, detail: s.detail, output: status === 'completed' || status === 'failed' ? fakeOutput(s.tool, s.detail) : undefined });
      if (r.sub === 0) patch(id, { toolCalls: a.toolCalls + 1, lastMessage: s.tool });
      else patch(id, {});
      r.sub++;
      if (r.sub >= statuses.length) next();
    } else if ('plan' in s) {
      if (a.plan) {
        const p = a.plan.map((e, i) => ({ ...e, status: i < s.plan ? 'completed' : i === s.plan ? 'in_progress' : 'pending' }) as PlanEntry);
        patch(id, { plan: p });
      }
      next();
    } else if ('end' in s) {
      feed(id, { type: 'status', id: uid('st'), at: now, text: `Turn ended: ${s.end}` });
      runners.delete(id);
      endTurn(id, s.end);
    }
  };

  const startTurn = (id: string, text: string, rest: string[]) => {
    feed(id, { type: 'user_message', id: uid('u'), at: Date.now(), text });
    const a = agents.get(id)!;
    patch(id, { status: 'working', stopReason: undefined, queued: rest, usage: a.usage && { ...a.usage, used: Math.min(a.usage.size, a.usage.used + 6000) } });
    runners.set(id, replyScript(text, false));
  };
  const endTurn = (id: string, reason: string) => {
    const a = agents.get(id);
    if (!a) return;
    const [next, ...rest] = a.queued ?? [];
    if (next !== undefined) {
      patch(id, { status: 'done', stopReason: reason, pendingPermission: undefined });
      setTimeout(() => startTurn(id, next, rest), 300);
    } else patch(id, { status: 'done', stopReason: reason, pendingPermission: undefined });
  };

  const tick = () => {
    for (const id of [...runners.keys()]) step(id);
  };

  const cancelTurn = (id: string) => {
    const a = agents.get(id);
    if (!a || (a.status !== 'working' && a.status !== 'needs_you' && a.status !== 'starting')) return;
    runners.delete(id);
    if (a.pendingPermission) {
      const p = a.pendingPermission;
      feed(id, { type: 'permission', id: `perm-${p.requestId}`, at: p.createdAt, requestId: p.requestId, title: p.title, resolution: 'cancelled' });
    }
    feed(id, { type: 'status', id: uid('st'), at: Date.now(), text: 'Turn ended: cancelled' });
    endTurn(id, 'cancelled');
  };

  const fail = (msg: string) => Promise.reject(new Error(msg));
  const delay = <X>(v: X, ms = 160) => new Promise<X>((res) => setTimeout(() => res(v), ms));

  function launchNow(req: LaunchRequest): Promise<AgentSummary> {
    if (!req.task.trim()) return fail('Task is required');
    const id = Math.random().toString(36).slice(2, 6);
    const name = req.name?.trim() || req.task.trim().split(/\s+/).slice(0, 4).join(' ').toLowerCase();
    const a: AgentSummary = {
      id,
      kind: req.kind,
      name,
      task: req.task.trim(),
      cwd: `~/tower-work/${name.replace(/[^a-z0-9]+/gi, '-')}`,
      source: 'tower',
      status: 'starting',
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      toolCalls: 0,
      model: req.model,
      ...defaults(req.kind),
      accountId: req.accountId && req.accountId !== 'auto' ? req.accountId : ACC[req.kind],
      ...(req.board ? { board: req.board } : {}),
      ...(req.customer ? { customer: req.customer } : {}),
    };
    put(a);
    emit({ type: 'capacity', capacity: capacity() });
    emit({ type: 'accounts', accounts: accounts() });
    feed(id, { type: 'status', id: uid('st'), at: Date.now(), text: 'Started' });
    setTimeout(() => {
      feed(id, { type: 'user_message', id: uid('u'), at: Date.now(), text: a.task });
      patch(id, {
        status: 'working',
        plan: plan(['Explore the codebase', 'Make the change', 'Run the tests', 'Summarize'], 0),
        lastMessage: `${LABEL[a.kind]} is reading the workspace…`,
      });
      runners.set(id, replyScript(a.task, true));
    }, 900);
    return delay({ ...a }, 120);
  }


  return {
    connect(onEvent, onStatus) {
      emit = onEvent;
      setTimeout(() => {
        onStatus(true);
        onEvent({ type: 'snapshot', state: { agents: [...agents.values()], capacity: capacity(), accounts: accounts(), notes: notes.map((n) => ({ ...n })), rotation: { ...rotation, activity: rotation.activity.map((x) => ({ ...x })) }, boards: boards.map((b) => ({ ...b })), host: 'eva-forge' } });
        setInterval(tick, 650);
      }, 0);
    },
    fetchWorkspace(id, before) {
      const w = workspaceOf(id, before);
      return w ? delay(w, 260) : fail('No such agent');
    },
    fetchFeed(id) {
      const list = feeds.get(id);
      return list ? delay(list.map((x) => ({ ...x })), 220) : fail('No such agent');
    },
    launch(req) {
      return launchNow(req);
    },
    answer(id, questionId, text) {
      const a = agents.get(id);
      const q = a?.questions?.find((x) => x.id === questionId);
      if (!a || !q) return fail('No such question');
      const rest = (a.questions ?? []).filter((x) => x.id !== questionId);
      const msg = `[Answer to «${q.text.slice(0, 160)}»] ${text}`;
      patch(id, { questions: rest });
      if (rest.length === 0) setTimeout(() => startTurn(id, msg, agents.get(id)?.queued ?? []), 120);
      else patch(id, { queued: [...(a.queued ?? []), msg] });
      return delay(undefined, 90);
    },
    move(id, accountId) {
      const a = agents.get(id);
      const acc = accountsList.find((x) => x.id === accountId);
      if (!a) return fail('No such agent');
      if (!acc || acc.kind !== a.kind) return fail('Account must be the same kind');
      runners.delete(id);
      feed(id, { type: 'status', id: uid('st'), at: Date.now(), text: `Moved to ${acc.label}` });
      patch(id, { status: 'stopped', archived: true, limitHit: false });
      return launchNow({ kind: a.kind, task: a.task, name: a.name, accountId }).then((n) => n);
    },
    archive(id, archived) {
      const a = agents.get(id);
      if (!a) return fail('No such agent');
      patch(id, { archived });
      return delay(undefined, 60);
    },
    upload(file) {
      const id = uid('up');
      uploads.set(id, file.name);
      return delay({ id, name: file.name, size: file.size }, 200);
    },
    createNote(title, body) {
      const n: Note = { id: uid('n'), title, body, createdAt: Date.now() };
      notes.push(n);
      emitNotes();
      return delay({ ...n }, 80);
    },
    updateNote(id, p) {
      const i = notes.findIndex((n) => n.id === id);
      if (i === -1) return fail('No such note');
      notes[i] = { ...notes[i], ...p };
      emitNotes();
      return delay({ ...notes[i] }, 80);
    },
    deleteNote(id) {
      const i = notes.findIndex((n) => n.id === id);
      if (i === -1) return fail('No such note');
      notes.splice(i, 1);
      emitNotes();
      return delay(undefined, 60);
    },
    startNote(id, kind, accountId) {
      const n = notes.find((x) => x.id === id);
      if (!n) return fail('No such note');
      return launchNow({ kind, task: `${n.title}\n\n${n.body}`.trim(), name: n.title.split(/\s+/).slice(0, 4).join(' ').toLowerCase(), accountId });
    },
    prompt(id, text, interrupt, attachments) {
      if (attachments?.length) text = [text, ...attachments.map((u) => `Attached: attachments/${uploads.get(u) ?? u}`)].filter(Boolean).join('\n');
      const a = agents.get(id);
      if (!a) return fail('No such agent');
      if (a.source === 'tmux' || a.status === 'observed') return fail('Observed agents are read-only');
      if (a.status === 'stopped' || a.status === 'error') return fail(`Agent is ${a.status}`);
      const busy = a.status === 'working' || a.status === 'needs_you' || a.status === 'starting';
      if (!busy) {
        startTurn(id, text, a.queued ?? []);
        return delay({ queued: false }, 80);
      }
      if (interrupt) {
        patch(id, { queued: [text, ...(a.queued ?? [])] });
        setTimeout(() => cancelTurn(id), 250);
      } else patch(id, { queued: [...(a.queued ?? []), text] });
      return delay({ queued: true }, 80);
    },
    interrupt(id) {
      const a = agents.get(id);
      if (!a) return fail('No such agent');
      cancelTurn(id);
      return delay(undefined, 80);
    },
    setMode(id, modeId) {
      const a = agents.get(id);
      if (!a) return fail('No such agent');
      if (!a.modes?.some((m) => m.id === modeId)) return fail('Mode not offered');
      patch(id, { mode: modeId });
      return delay(undefined, 80);
    },
    setConfig(id, configId, value) {
      const a = agents.get(id);
      if (!a) return fail('No such agent');
      const opts = a.configOptions ?? [];
      if (!opts.some((o) => o.id === configId)) return fail('No such option');
      patch(id, {
        configOptions: opts.map((o) => (o.id === configId ? { ...o, currentValue: value } : o)),
        ...(configId === 'model' ? { model: value } : {}),
      });
      return delay(undefined, 80);
    },
    removeQueued(id, index) {
      const a = agents.get(id);
      if (!a) return fail('No such agent');
      const q = a.queued ?? [];
      if (index < 0 || index >= q.length) return fail('No such queued prompt');
      patch(id, { queued: q.filter((_, i) => i !== index) });
      return delay(undefined, 60);
    },
    resume(id) {
      const a = agents.get(id);
      if (!a || !a.resumable) return fail('Not resumable');
      feed(id, { type: 'status', id: uid('st'), at: Date.now(), text: 'Resumed' });
      patch(id, { status: 'done', resumable: false, stopReason: undefined });
      return delay(undefined, 120);
    },
    remove(id) {
      const a = agents.get(id);
      if (!a) return fail('No such agent');
      if (a.source !== 'tower') return fail('Only tower agents can be removed');
      runners.delete(id);
      agents.delete(id);
      feeds.delete(id);
      emit({ type: 'agent_removed', agentId: id });
      emit({ type: 'capacity', capacity: capacity() });
      emit({ type: 'accounts', accounts: accounts() });
      return delay(undefined, 80);
    },
    accounts() {
      return delay(accounts(), 80);
    },
    clearAccount(id) {
      const acc = accountsList.find((x) => x.id === id);
      if (!acc) return fail('No such account');
      if (statusOf(acc) !== 'exhausted') return fail('Account is not at its limit');
      acc.status = 'ok';
      acc.resetAt = undefined;
      acc.usedPct = 0;
      acc.detail = '5h window 0% used';
      emit({ type: 'accounts', accounts: accounts() });
      logActivity({ kind: 'cleared', accountId: id, text: `${acc.label} is available again` });
      return delay(undefined, 90);
    },
    setExcluded(id, excluded) {
      const acc = accountsList.find((x) => x.id === id);
      if (!acc) return fail('No such account');
      acc.excluded = excluded;
      emit({ type: 'accounts', accounts: accounts() });
      logActivity({ kind: excluded ? 'excluded' : 'included', accountId: id, text: `${acc.label} ${excluded ? 'excluded from rotation' : 'back in rotation'}` });
      return delay(undefined, 90);
    },
    setAutoRotate(on) {
      rotation.autoRotate = on;
      emitRotation();
      return delay({ ...rotation, activity: rotation.activity.map((x) => ({ ...x })) }, 90);
    },
    permission(id, requestId, optionId) {
      const a = agents.get(id);
      const p = a?.pendingPermission;
      if (!a || !p || p.requestId !== requestId) return fail('No such pending request');
      const opt = p.options.find((o) => o.optionId === optionId);
      feed(id, { type: 'permission', id: `perm-${requestId}`, at: p.createdAt, requestId, title: p.title, resolution: opt?.name ?? optionId });
      if (opt && opt.kind.startsWith('reject')) {
        feed(id, { type: 'agent_message', id: uid('m'), at: Date.now(), text: 'Understood, I will not install it. Tell me how you would like to proceed.' });
        feed(id, { type: 'status', id: uid('st'), at: Date.now(), text: 'Turn ended: end_turn' });
        patch(id, { status: 'done', pendingPermission: undefined, stopReason: 'end_turn' });
      } else {
        patch(id, { status: 'working', pendingPermission: undefined });
        runners.set(id, afterAllow());
      }
      return delay(undefined, 90);
    },
    stop(id) {
      const a = agents.get(id);
      if (!a) return fail('No such agent');
      runners.delete(id);
      feed(id, { type: 'status', id: uid('st'), at: Date.now(), text: 'Stopped' });
      patch(id, { status: 'stopped', pendingPermission: undefined, stopReason: 'cancelled' });
      emit({ type: 'capacity', capacity: capacity() });
      return delay(undefined, 90);
    },
    // ---- Wave D ----
    createBoard(name) {
      const n = name.trim();
      if (!n) return fail('Name is required');
      const base = n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'board';
      let id = base;
      for (let i = 2; boards.some((b) => b.id === id); i++) id = `${base}-${i}`;
      const b: Board = { id, name: n, columns: boards[0].columns.map((c) => ({ ...c })) };
      boards.push(b);
      emitBoards();
      return delay({ ...b }, 90);
    },
    deleteBoard(id) {
      if (id === 'programs' || id === 'customers') return fail('Default boards cannot be deleted');
      const i = boards.findIndex((b) => b.id === id);
      if (i === -1) return fail('No such board');
      if ([...agents.values()].some((a) => (a.board ?? 'programs') === id && !a.archived)) return fail('Board is not empty');
      boards.splice(i, 1);
      emitBoards();
      return delay(undefined, 90);
    },
    setBoard(id, board, customer) {
      const a = agents.get(id);
      if (!a) return fail('No such agent');
      if (!boards.some((b) => b.id === board)) return fail('No such board');
      put({ ...a, board, ...(customer ? { customer } : {}) });
      return delay(undefined, 90);
    },
  };
}
