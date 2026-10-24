import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAccounts } from '../src/accounts.js';
import type { Account } from '../../shared/contract.js';

function fakeHome(): string {
  const home = mkdtempSync(path.join(os.tmpdir(), 'tower-acc-'));
  const mk = (dir: string, file: string) => {
    mkdirSync(path.join(home, dir), { recursive: true });
    writeFileSync(path.join(home, dir, file), '{}');
  };
  mk('.claude', '.credentials.json');
  mk('.claude-3', '.credentials.json');
  mk('.claude-2.parked-x', '.credentials.json');
  mk('.claude.pre-y', '.credentials.json');
  mkdirSync(path.join(home, '.claude-empty'));
  mk('.codex-2', 'auth.json');
  return home;
}

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const old: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    old[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(old)) {
      if (old[k] === undefined) delete process.env[k];
      else process.env[k] = old[k];
    }
  }
}

test('discovers claude/codex/devin accounts and skips parked/pre/markerless dirs', () => {
  const home = fakeHome();
  const acc = withEnv({ TOWER_ACCOUNTS_HOME: home, TOWER_ACCOUNTS_STATUS: '0' }, () => createAccounts());
  const list = acc.list();
  assert.deepEqual(
    list.map((a) => [a.id, a.kind, a.home]),
    [
      ['claude', 'claude', undefined],
      ['claude-3', 'claude', path.join(home, '.claude-3')],
      ['codex-2', 'codex', path.join(home, '.codex-2')],
      ['devin', 'devin', undefined],
    ],
  );
  assert.equal(list[1]!.label, 'Claude · ~/.claude-3');
  assert.equal(list[1]!.loginCommand, `CLAUDE_CONFIG_DIR=${path.join(home, '.claude-3')} claude /login`);
  assert.equal(list[0]!.loginCommand, 'claude /login');
  assert.equal(list[2]!.loginCommand, `CODEX_HOME=${path.join(home, '.codex-2')} codex login`);
  assert.equal(list[3]!.loginCommand, 'devin auth login --force-manual-token-flow');
  assert.ok(list.every((a) => a.loggedIn === null));
});

test('envFor: explicit id, unknown id throws, auto picks the logged-in account', async () => {
  const home = fakeHome();
  const script = path.join(home, 'fake-claude-status.sh');
  // Only ~/.claude-3 is logged in; the email must be stripped from detail paths.
  writeFileSync(
    script,
    `#!/bin/sh\ncase "$CLAUDE_CONFIG_DIR" in *claude-3) echo '{"loggedIn":true,"subscriptionType":"max","email":"a@b.com"}';; *) echo '{"loggedIn":false}';; esac\n`,
  );
  chmodSync(script, 0o755);
  const codexScript = path.join(home, 'fake-codex-status.sh');
  writeFileSync(codexScript, '#!/bin/sh\necho "Logged in using ChatGPT as x@y.io"\n');
  chmodSync(codexScript, 0o755);
  const devinScript = path.join(home, 'fake-devin-status.sh');
  writeFileSync(devinScript, '#!/bin/sh\necho "Logged in as me@z.dev"\necho "Plan: Devin Max"\n');
  chmodSync(devinScript, 0o755);

  const acc = withEnv(
    {
      TOWER_ACCOUNTS_HOME: home,
      TOWER_ACCOUNTS_STATUS: undefined,
      TOWER_CMD_STATUS_CLAUDE: script,
      TOWER_CMD_STATUS_CODEX: codexScript,
      TOWER_CMD_STATUS_DEVIN: devinScript,
    },
    () => {
      const a = createAccounts();
      return a;
    },
  );
  // statusCommand reads env at refresh time, so keep the overrides set while start() refreshes.
  const changed = await withEnv(
    { TOWER_CMD_STATUS_CLAUDE: script, TOWER_CMD_STATUS_CODEX: codexScript, TOWER_CMD_STATUS_DEVIN: devinScript },
    () =>
      new Promise<Account[]>((resolve) => {
        acc.start(resolve, (id) => (id === 'claude-3' ? 2 : 0));
      }),
  );
  acc.stop();

  const c3 = changed.find((a) => a.id === 'claude-3')!;
  assert.equal(c3.loggedIn, true);
  assert.equal(c3.plan, 'max');
  assert.equal(c3.running, 2);
  assert.equal(changed.find((a) => a.id === 'claude')!.loggedIn, false);
  const cx = changed.find((a) => a.id === 'codex-2')!;
  assert.equal(cx.loggedIn, true);
  assert.ok(!JSON.stringify(changed).includes('@'), 'no emails in accounts');
  const dv = changed.find((a) => a.id === 'devin')!;
  assert.equal(dv.plan, 'Devin Max');

  assert.deepEqual(acc.envFor('claude'), { accountId: 'claude-3', env: { CLAUDE_CONFIG_DIR: path.join(home, '.claude-3') } });
  assert.deepEqual(acc.envFor('claude', 'auto'), acc.envFor('claude'));
  assert.deepEqual(acc.envFor('claude', 'claude'), { accountId: 'claude', env: {} });
  assert.deepEqual(acc.envFor('codex', 'codex-2'), { accountId: 'codex-2', env: { CODEX_HOME: path.join(home, '.codex-2') } });
  assert.deepEqual(acc.envFor('devin'), { accountId: 'devin', env: {} });
  assert.throws(() => acc.envFor('claude', 'nope'), /unknown account/);
  assert.throws(() => acc.envFor('codex', 'claude-3'), /unknown account/);
});

test('envFor with no accounts of a kind returns empty env', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'tower-acc-empty-'));
  const acc = withEnv({ TOWER_ACCOUNTS_HOME: home, TOWER_ACCOUNTS_STATUS: '0' }, () => createAccounts());
  assert.deepEqual(acc.envFor('codex'), { accountId: undefined, env: {} });
});
