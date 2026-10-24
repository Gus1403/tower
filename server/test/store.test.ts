import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import type { PersistedAgent } from '../src/ports.js';

function withDataDir<T>(dir: string, fn: () => T): T {
  const old = process.env.TOWER_DATA_DIR;
  process.env.TOWER_DATA_DIR = dir;
  try {
    return fn();
  } finally {
    if (old === undefined) delete process.env.TOWER_DATA_DIR;
    else process.env.TOWER_DATA_DIR = old;
  }
}

const agent: PersistedAgent = {
  sessionId: 'sess-1',
  summary: {
    id: 'a1', kind: 'claude', name: 'fix bug', task: 'fix the bug', cwd: '/tmp', source: 'tower',
    status: 'done', createdAt: 1, lastActivityAt: 2, toolCalls: 0, queued: [], accountId: 'claude-3',
  },
  feed: [{ type: 'user_message', id: 'u1', at: 1, text: 'fix the bug' }],
};

test('load on a missing dir returns []; save then load round-trips with private perms', () => {
  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), 'tower-store-')), 'nested', 'state');
  const store = withDataDir(dir, () => createStore());
  assert.deepEqual(store.load(), []);
  store.save([agent]);
  assert.deepEqual(store.load(), [agent]);
  assert.deepEqual(readdirSync(dir), ['agents.json']);
  assert.equal(statSync(path.join(dir, 'agents.json')).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  store.save([]);
  assert.deepEqual(store.load(), []);
});

test('corrupt file loads as []', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tower-store-bad-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'agents.json'), '{not json');
  const store = withDataDir(dir, () => createStore());
  assert.deepEqual(store.load(), []);
  assert.deepEqual(store.load(), []);
});
