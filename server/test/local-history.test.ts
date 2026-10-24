import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, open, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pageClaudeTranscript } from '../src/local-history.js';

const id = '10000000-0000-4000-8000-000000000001';
const row = (n: number, content: unknown, type = 'user') => JSON.stringify({
  type, uuid: `entry-${String(n).padStart(8, '0')}`, sessionId: id,
  timestamp: new Date(1_700_000_000_000 + n * 1000).toISOString(), message: { content },
});

test('pages a large JSONL by stable IDs, skips malformed and incomplete lines, and binds cursors to the session and file', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tower-history-'));
  const filename = path.join(dir, `${id}.jsonl`);
  const lines = Array.from({ length: 104 }, (_, i) => row(i, `message ${i}`));
  lines.splice(56, 0, '{broken json');
  lines.splice(58, 0, JSON.stringify({ type: 'system', data: 'x'.repeat(70_000) }));
  lines.push('{"type":"user","uuid":"partial"');
  await writeFile(filename, lines.join('\n'));
  const file = await open(filename, 'r');
  try {
    const first = await pageClaudeTranscript(file, 'session A', id);
    assert.equal(first.available, true);
    assert.equal(first.items.length, 50);
    assert.equal(first.items[0]?.type, 'user_message');
    assert.equal((first.items[0] as { text: string }).text, 'message 54');
    assert.equal((first.items[49] as { text: string }).text, 'message 103');
    assert.equal(first.hasMore, true);
    assert.ok(first.before);

    const other = await pageClaudeTranscript(file, 'session B', id, first.before);
    assert.equal(other.available, false);
    assert.match(other.reason || '', /does not match/);
    assert.deepEqual(other.items, []);

    const second = await pageClaudeTranscript(file, 'session A', id, first.before);
    assert.equal(second.available, true);
    assert.equal(second.items.length, 50);
    assert.equal((second.items[0] as { text: string }).text, 'message 4');
    assert.equal((second.items[49] as { text: string }).text, 'message 53');
    assert.equal(second.hasMore, true);
    const third = await pageClaudeTranscript(file, 'session A', id, second.before);
    assert.equal(third.available, true);
    assert.deepEqual(third.items.map(x => (x as { text: string }).text), ['message 0', 'message 1', 'message 2', 'message 3']);
    assert.equal(third.hasMore, false);
    assert.equal(third.before, undefined);

    await appendFile(filename, '\n');
    const appended = await pageClaudeTranscript(file, 'session A', id, first.before);
    assert.equal(appended.available, true, 'append preserves an existing cursor');

    const replacement = path.join(dir, 'replacement.jsonl');
    await writeFile(replacement, lines.slice(0, -1).join('\n') + '\n');
    await rename(replacement, filename);
    const replaced = await open(filename, 'r');
    try {
      const stale = await pageClaudeTranscript(replaced, 'session A', id, first.before);
      assert.equal(stale.available, false);
      assert.match(stale.reason || '', /stale/);
    } finally { await replaced.close(); }
  } finally { await file.close(); }
});

test('normalizes human text, collapsed thinking, tool calls and output while excluding internal records and secrets', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tower-history-'));
  const filename = path.join(dir, `${id}.jsonl`);
  const records = [
    row(0, '<system-reminder>hidden instructions</system-reminder>hello password=topsecret'),
    JSON.stringify({ type: 'system', timestamp: new Date().toISOString(), message: { content: 'internal' } }),
    JSON.stringify({ type: 'user', isMeta: true, timestamp: new Date().toISOString(), message: { content: 'injected' } }),
    row(1, [
      { type: 'thinking', thinking: 'private reasoning' },
      { type: 'text', text: 'Done. Bearer abcdefghijklmnopqrstuvwxyz' },
      { type: 'tool_use', id: 'toolu_123', name: 'Bash', input: { command: 'echo safe' } },
    ], 'assistant'),
    row(2, [{ type: 'tool_result', tool_use_id: 'toolu_123', content: 'output sk-ant-abcdefghijklmnopqrstuv' }]),
    row(3, 'summary', 'user').replace('"type":"user"', '"type":"user","isCompactSummary":true'),
    row(4, 'wrong session').replace(id, '20000000-0000-4000-8000-000000000002'),
    JSON.stringify({ type: 'user', timestamp: new Date(1_700_000_005_000).toISOString(), message: { content: 'unbound row' } }),
  ];
  await writeFile(filename, records.join('\n') + '\n');
  const file = await open(filename, 'r');
  try {
    const page = await pageClaudeTranscript(file, 'session A', id);
    assert.equal(page.available, true);
    assert.equal(page.hasMore, false);
    assert.equal(page.items.filter(x => x.type === 'user_message').length, 1);
    const asText = JSON.stringify(page.items);
    for (const secret of ['topsecret', 'private reasoning', 'abcdefghijklmnopqrstuv', 'hidden instructions', 'injected', 'wrong session', 'unbound row']) assert.equal(asText.includes(secret), false);
    assert.match(asText, /REDACTED/);
    assert.equal(page.items.filter(x => x.type === 'thought').length, 1);
    const tool = page.items.find(x => x.type === 'tool_call');
    assert.ok(tool && tool.type === 'tool_call');
    assert.equal(tool.id, 'tool-toolu_123');
    assert.equal(tool.status, 'completed');
    assert.equal(tool.title, 'Bash');
    assert.match(tool.output || '', /output/);
  } finally { await file.close(); }
});

test('a newline exactly at a backward chunk boundary still finishes the page', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tower-history-'));
  const filename = path.join(dir, `${id}.jsonl`);
  const messages = Array.from({ length: 60 }, (_, i) => row(i, `message ${i}`)).join('\n') + '\n';
  const system = JSON.stringify({ type: 'system', filler: '' });
  const padding = 65_536 - 1 - system.length - 1 - Buffer.byteLength(messages);
  assert.ok(padding > 0);
  const tail = '\n' + JSON.stringify({ type: 'system', filler: 'x'.repeat(padding) }) + '\n' + messages;
  assert.equal(Buffer.byteLength(tail), 65_536);
  await writeFile(filename, row(999, 'earliest') + tail);
  const file = await open(filename, 'r');
  try {
    const first = await pageClaudeTranscript(file, 'session A', id);
    assert.equal(first.available, true);
    assert.equal(first.items.length, 50);
    assert.equal(first.hasMore, true);
    const second = await pageClaudeTranscript(file, 'session A', id, first.before);
    assert.equal(second.available, true);
    assert.equal(second.items.length, 11);
    assert.equal(second.hasMore, false);
  } finally { await file.close(); }
});
