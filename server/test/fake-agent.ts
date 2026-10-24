// Fake ACP agent for tests: a real ACP peer over stdio.
// Modes via env FAKE_MODE: normal (default) | silent | crash
import * as acp from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';

const mode = process.env.FAKE_MODE || process.argv[2] || 'normal';
if (mode === 'crash') {
  console.error('fake-agent: crashing on purpose');
  process.exit(1);
}

const sessions = new Map<string, { cancelled: boolean }>();
let conn: acp.AgentSideConnection;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const agent: acp.Agent = {
  async initialize() {
    return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {} };
  },
  async newSession() {
    const sessionId = `sess-${Math.random().toString(36).slice(2)}`;
    sessions.set(sessionId, { cancelled: false });
    return { sessionId };
  },
  async authenticate() {
    return {};
  },
  async prompt(params) {
    const sessionId = params.sessionId;
    const sess = sessions.get(sessionId);
    if (!sess) throw new Error('no session');
    if (mode === 'silent') {
      // never emits, never returns until cancelled
      await new Promise<void>((res) => {
        const t = setInterval(() => {
          if (sess.cancelled) {
            clearInterval(t);
            res();
          }
        }, 50);
      });
      return { stopReason: 'cancelled' };
    }
    const upd = (update: acp.SessionUpdate) =>
      conn.sessionUpdate({ sessionId, update }).catch(() => {});
    await upd({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Working on it. ' },
    });
    await upd({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Second half of message.' },
    });
    await upd({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      title: 'Run echo hi',
      kind: 'execute',
      status: 'in_progress',
      rawInput: { command: 'echo hi' },
    });
    await sleep(10);
    await upd({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-1',
      status: 'completed',
      rawOutput: 'hi',
    });
    await upd({
      sessionUpdate: 'plan',
      entries: [
        { content: 'do the thing', status: 'completed', priority: 'high' },
        { content: 'report back', status: 'in_progress', priority: 'medium' },
      ],
    });
    // like devin: tool_call first, then a bare requestPermission carrying only
    // toolCallId + _meta — the client must recover title/detail from the tool_call
    await upd({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-2',
      title: 'Write file out.txt',
      kind: 'edit',
      status: 'pending',
      rawInput: { path: 'out.txt' },
    });
    const perm = await conn.requestPermission({
      sessionId,
      toolCall: {
        toolCallId: 'tc-2',
        _meta: { 'cognition.ai/editableCommand': 'write out.txt' },
      },
      options: [
        { optionId: 'allow-1', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'deny-1', name: 'Reject', kind: 'reject_once' },
      ],
    });
    if (perm.outcome.outcome === 'cancelled' || sess.cancelled) {
      return { stopReason: 'cancelled' };
    }
    await upd({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-2',
      status: 'completed',
    });
    await upd({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'All done after permission.' },
    });
    return { stopReason: 'end_turn' };
  },
  async cancel(params) {
    const sess = sessions.get(params.sessionId);
    if (sess) sess.cancelled = true;
  },
};

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
);
conn = new acp.AgentSideConnection(() => agent, stream);
