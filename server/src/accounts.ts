// Account discovery + login status per agent kind. Never reads credential file contents (existence only).
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Account, AgentKind } from '../../shared/contract.js';
import type { AccountsPort, LaunchEnv } from './ports.js';

const REFRESH_MS = 60_000;
const CMD_TIMEOUT_MS = 5_000;
const EMAIL_RE = /[^\s<>()"']+@[^\s<>()"']+\.[^\s<>()"']+/g;

function stripEmails(s: string): string {
  return s.replace(EMAIL_RE, '[email]').replace(/\s+/g, ' ').trim().slice(0, 200);
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ".claude" or ".claude-<suffix>" where suffix has no dots (skips ".claude-2.parked-x", ".claude.pre-x").
function matchesRoot(name: string, base: string): boolean {
  if (name === base) return true;
  if (!name.startsWith(base + '-')) return false;
  const suffix = name.slice(base.length + 1);
  return /^[A-Za-z0-9_-]+$/.test(suffix) && !/^(parked|pre)(-|$)/.test(suffix);
}

function discover(homeRoot: string): Account[] {
  const out: Account[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(homeRoot);
  } catch {
    names = [];
  }
  names.sort();
  for (const name of names) {
    const dir = path.join(homeRoot, name);
    if (matchesRoot(name, '.claude') && isDir(dir)) {
      const marker =
        existsSync(path.join(dir, '.credentials.json')) ||
        existsSync(path.join(dir, '.claude.json')) ||
        (name === '.claude' && existsSync(path.join(homeRoot, '.claude.json')));
      if (!marker) continue;
      const home = name === '.claude' ? undefined : dir;
      out.push({
        id: name.slice(1),
        kind: 'claude',
        label: `Claude · ~/${name}`,
        home,
        loggedIn: null,
        running: 0,
        loginCommand: home ? `CLAUDE_CONFIG_DIR=${home} claude /login` : 'claude /login',
      });
    } else if (matchesRoot(name, '.codex') && isDir(dir)) {
      if (!existsSync(path.join(dir, 'auth.json'))) continue;
      out.push({
        id: name.slice(1),
        kind: 'codex',
        label: `Codex · ~/${name}`,
        home: dir,
        loggedIn: null,
        running: 0,
        loginCommand: `CODEX_HOME=${dir} codex login`,
      });
    }
  }
  out.push({
    id: 'devin',
    kind: 'devin',
    label: 'Devin',
    loggedIn: null,
    running: 0,
    loginCommand: 'devin auth login --force-manual-token-flow',
  });
  return out;
}

function run(cmd: string, args: string[], env: Record<string, string>): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: CMD_TIMEOUT_MS, env: { ...process.env, ...env }, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({ ok: !err, out: `${stdout ?? ''}${stdout && stderr ? '\n' : ''}${stderr ?? ''}` });
      },
    );
  });
}

function accountEnv(a: Account): Record<string, string> {
  if (!a.home) return {};
  if (a.kind === 'claude') return { CLAUDE_CONFIG_DIR: a.home };
  if (a.kind === 'codex') return { CODEX_HOME: a.home };
  return {};
}

function statusCommand(kind: AgentKind): { cmd: string; args: string[] } {
  const override = process.env[`TOWER_CMD_STATUS_${kind.toUpperCase()}`];
  if (override) return { cmd: override, args: [] };
  if (kind === 'claude') return { cmd: 'claude', args: ['auth', 'status'] };
  if (kind === 'codex') return { cmd: existsSync('/usr/bin/codex') ? '/usr/bin/codex' : 'codex', args: ['login', 'status'] };
  return { cmd: 'devin', args: ['auth', 'status'] };
}

type Status = Pick<Account, 'loggedIn' | 'plan' | 'detail' | 'usedPct'>;

async function probe(a: Account): Promise<Status> {
  const { cmd, args } = statusCommand(a.kind);
  const { ok, out } = await run(cmd, args, accountEnv(a));
  const text = out.trim();
  if (a.kind === 'claude') {
    try {
      const j = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
      const loggedIn = typeof j.loggedIn === 'boolean' ? j.loggedIn : null;
      const plan = typeof j.subscriptionType === 'string' && j.subscriptionType ? j.subscriptionType : undefined;
      return { loggedIn, plan, detail: loggedIn ? 'logged in' : loggedIn === false ? 'not logged in' : undefined };
    } catch {
      return { loggedIn: ok ? null : false, detail: text ? stripEmails(text.split('\n')[0]!) : undefined };
    }
  }
  const first = text.split('\n')[0] ?? '';
  if (a.kind === 'codex') {
    const loggedIn = /^logged in/i.test(first) ? true : /not logged in/i.test(text) ? false : ok ? null : false;
    return { loggedIn, detail: first ? stripEmails(first) : undefined };
  }
  const planMatch = /Plan:\s*(.+)/i.exec(text);
  const loggedIn = /not logged in|logged out|unauthenticated/i.test(text) ? false : ok ? true : false;
  return {
    loggedIn,
    plan: planMatch ? stripEmails(planMatch[1]!) : undefined,
    detail: first ? stripEmails(first) : undefined,
  };
}

export function createAccounts(): AccountsPort {
  const homeRoot = process.env.TOWER_ACCOUNTS_HOME || os.homedir();
  const skipStatus = process.env.TOWER_ACCOUNTS_STATUS === '0';
  let accounts = discover(homeRoot);
  let countRunning: (id: string) => number = () => 0;
  let onChange: (a: Account[]) => void = () => {};
  let timer: NodeJS.Timeout | undefined;
  let refreshing = false;

  const withRunning = (): Account[] => accounts.map((a) => ({ ...a, running: countRunning(a.id) }));

  async function refresh(): Promise<void> {
    if (refreshing) return;
    refreshing = true;
    try {
      const before = JSON.stringify(withRunning());
      const prev = new Map(accounts.map((a) => [a.id, a]));
      const next = discover(homeRoot).map((a) => {
        const p = prev.get(a.id);
        return p ? { ...a, loggedIn: p.loggedIn, plan: p.plan, detail: p.detail, usedPct: p.usedPct } : a;
      });
      if (!skipStatus) {
        await Promise.all(
          next.map(async (a) => {
            try {
              const s = await probe(a);
              a.loggedIn = s.loggedIn;
              a.plan = s.plan;
              a.detail = s.detail;
              a.usedPct = s.usedPct;
            } catch {
              a.loggedIn = null;
            }
          }),
        );
      }
      accounts = next;
      const after = withRunning();
      if (JSON.stringify(after) !== before) onChange(after);
    } finally {
      refreshing = false;
    }
  }

  function pick(kind: AgentKind): Account | undefined {
    const list = withRunning().filter((a) => a.kind === kind);
    if (list.length === 0) return undefined;
    const logged = list.filter((a) => a.loggedIn === true);
    if (logged.length === 0) return list[0];
    logged.sort(
      (x, y) =>
        (x.usedPct ?? 50) - (y.usedPct ?? 50) || x.running - y.running || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0),
    );
    return logged[0];
  }

  return {
    list: withRunning,
    envFor(kind, accountId): LaunchEnv {
      if (accountId && accountId !== 'auto') {
        const a = accounts.find((x) => x.kind === kind && x.id === accountId);
        if (!a) throw new Error('unknown account');
        return { accountId: a.id, env: accountEnv(a) };
      }
      const a = pick(kind);
      if (!a) return { accountId: undefined, env: {} };
      return { accountId: a.id, env: accountEnv(a) };
    },
    start(cb, count) {
      onChange = cb;
      countRunning = count;
      if (timer) clearInterval(timer);
      void refresh();
      timer = setInterval(() => void refresh(), REFRESH_MS);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
