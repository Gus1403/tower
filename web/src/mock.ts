// In-browser fake Tower server. Emits contract-shaped ServerEvents over time. Never touches /api.
import type {
  AgentKind,
  AgentSummary,
  Capacity,
  FeedItem,
  PlanEntry,
  ServerEvent,
} from '../../shared/contract';
import type { Transport } from './api';

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

  const put = (a: AgentSummary) => {
    agents.set(a.id, a);
    emit({ type: 'agent', agent: a });
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
  const tc = (title: string, toolKind: string, detail?: string, status: 'completed' | 'failed' = 'completed') => {
    const toolCallId = uid('tc');
    return { type: 'tool_call' as const, id: `tool-${toolCallId}`, toolCallId, title, toolKind, status, detail };
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

  const a3 = mkAgent('c9p4', 'claude', 'fix-tests', 'Fix the flaky websocket reconnect test in server/test', 'stuck', 1630, {
    toolCalls: 11,
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
  [a1, a2, a3, a4, a5, o1, o2].forEach((a) => agents.set(a.id, a));
  for (const o of [o1, o2]) feed(o.id, { type: 'status', id: uid('st'), at: o.createdAt, text: 'Observed from tmux (read-only)' }, true);

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
      { say: 'Done. The change is in and the tests pass.' },
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
      feed(id, { type: 'tool_call', id: `tool-${r.toolId}`, at: now, toolCallId: r.toolId, title: s.tool, toolKind: s.kind, status, detail: s.detail });
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
      patch(id, { status: 'done', stopReason: s.end });
      runners.delete(id);
    }
  };

  const tick = () => {
    for (const id of [...runners.keys()]) step(id);
  };

  const fail = (msg: string) => Promise.reject(new Error(msg));
  const delay = <X>(v: X, ms = 160) => new Promise<X>((res) => setTimeout(() => res(v), ms));

  return {
    connect(onEvent, onStatus) {
      emit = onEvent;
      setTimeout(() => {
        onStatus(true);
        onEvent({ type: 'snapshot', state: { agents: [...agents.values()], capacity: capacity(), host: 'eva-forge' } });
        setInterval(tick, 650);
      }, 0);
    },
    fetchFeed(id) {
      const list = feeds.get(id);
      return list ? delay(list.map((x) => ({ ...x })), 220) : fail('No such agent');
    },
    launch(req) {
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
      };
      put(a);
      emit({ type: 'capacity', capacity: capacity() });
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
    },
    prompt(id, text) {
      const a = agents.get(id);
      if (!a) return fail('No such agent');
      if (a.status === 'working' || a.status === 'needs_you' || a.status === 'starting') return fail('Agent is busy');
      if (a.source === 'tmux') return fail('Observed agents are read-only');
      feed(id, { type: 'user_message', id: uid('u'), at: Date.now(), text });
      patch(id, { status: 'working', stopReason: undefined });
      runners.set(id, replyScript(text, false));
      return delay(undefined, 80);
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
  };
}
