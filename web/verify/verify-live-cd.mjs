// Headless verification of Wave C (rotation) + Wave D (boards, tower send/handoff/agents) on the LIVE Tower
// deployment (eva-forge, tailnet HTTPS) with REAL Devin agents. API + WS only (no UI).
// Token comes from env TOWER_TOKEN only — never written to files, redacted from every log line.
const BASE = process.env.TOWER_BASE || 'https://eva-forge.tail1259c5.ts.net:8443';
const TOKEN = process.env.TOWER_TOKEN;
if (!TOKEN) {
  console.error('TOWER_TOKEN env var required');
  process.exit(2);
}
const red = (s) => String(s).split(TOKEN).join('***');
const H = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
const api = async (method, p, body) => {
  const r = await fetch(`${BASE}${p}`, { method, headers: H, body: body !== undefined ? JSON.stringify(body) : undefined });
  let j = null;
  const t = await r.text();
  try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, json: j };
};
const trim = (o, n = 400) => red(JSON.stringify(o)).slice(0, n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, step = 2000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v;
    await sleep(step);
  }
  throw new Error(`timeout ${ms}ms`);
};

const results = {};
const bugs = [];
const mine = new Set(); // agent ids created (for cleanup + auto-approve)
const myBoards = new Set();
const log = (item, msg) => console.log(`[${item}] ${red(msg)}`);
const check = (item, cond, msg) => {
  results[item] ??= { pass: 0, fail: [] };
  if (cond) { results[item].pass++; log(item, `✓ ${msg}`); } else { results[item].fail.push(msg); log(item, `✗ ${msg}`); }
  return cond;
};
const state = async () => (await api('GET', '/api/state')).json;
const agent = async (id) => (await state()).agents.find((a) => a.id === id);
const feed = async (id) => (await api('GET', `/api/agents/${id}/feed`)).json;
const launch = async (body) => {
  const r = await api('POST', '/api/agents', { kind: 'devin', ...body });
  if (r.status === 201 && r.json?.id) mine.add(r.json.id);
  return r;
};
const waitStatus = (id, sts, ms = 240000) =>
  until(async () => { const a = await agent(id); return a && sts.includes(a.status) ? a : null; }, ms);

// ---- auto-approver: allow_once any pending permission on agents we created (and their handoff children)
let approving = true;
const approved = [];
(async () => {
  while (approving) {
    try {
      const s = await state();
      for (const a of s.agents) {
        if (a.requestedBy && mine.has(a.requestedBy.agentId)) mine.add(a.id);
        if (!mine.has(a.id) || !a.pendingPermission) continue;
        const p = a.pendingPermission;
        const opt = p.options.find((o) => o.kind === 'allow_once') || p.options.find((o) => o.kind === 'allow_always');
        if (!opt) continue;
        const r = await api('POST', `/api/agents/${a.id}/permission`, { requestId: p.requestId, optionId: opt.optionId });
        approved.push(`${a.id}:${p.title}:${r.status}`);
        console.log(`  [approve] ${a.id} "${red(p.title).slice(0, 80)}" -> ${r.status}`);
      }
    } catch (e) { console.log(`  [approve] err ${red(e.message)}`); }
    await sleep(1500);
  }
})();

// ---- WS
const wsEvents = [];
const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/api/ws?token=${encodeURIComponent(TOKEN)}`);
ws.onmessage = (m) => { try { const e = JSON.parse(m.data); wsEvents.push({ at: Date.now(), type: e.type, e }); } catch {} };
await until(async () => ws.readyState === 1, 15000, 200).catch(() => console.log('WS did not open'));

// =============== 1. Boards
const item1 = async () => {
  const I = '1-boards';
  const s = await state();
  const prog = s.boards?.find((b) => b.id === 'programs');
  const cust = s.boards?.find((b) => b.id === 'customers');
  check(I, prog && JSON.stringify(prog.columns.map((c) => c.name)) === '["Working","Done"]', `programs columns ${trim(prog?.columns.map((c) => c.name))}`);
  check(I, cust && JSON.stringify(cust.columns.map((c) => c.name)) === '["Handling","Waiting on the customer","Asleep"]', `customers columns ${trim(cust?.columns.map((c) => c.name))}`);
  const b = await api('POST', '/api/boards', { name: 'Judge test' });
  if (b.json?.id) myBoards.add(b.json.id);
  check(I, b.status === 201 && b.json?.id === 'judge-test', `POST /api/boards -> ${b.status} ${trim(b.json, 300)}`);
  const l = await launch({ task: 'Reply with the word HELLO.', board: 'customers', customer: 'cust-judge', name: 'cd-judge-cust' });
  check(I, l.status === 201, `launch on customers -> ${l.status} board=${l.json?.board} customer=${l.json?.customer}`);
  const id = l.json?.id;
  if (!id) return;
  const d = await waitStatus(id, ['done', 'error', 'stopped']);
  check(I, d.status === 'done' && d.board === 'customers' && d.customer === 'cust-judge', `agent ${id} ${d.status} board=${d.board} customer=${d.customer} last=${trim(d.lastMessage, 80)}`);
  const mv = await api('POST', `/api/agents/${id}/board`, { board: 'judge-test' });
  const a2 = await agent(id);
  check(I, mv.status === 200 && a2.board === 'judge-test', `move -> ${mv.status} board now ${a2.board} customer=${a2.customer}`);
  const del1 = await api('DELETE', '/api/boards/judge-test');
  check(I, del1.status === 409, `DELETE non-empty board -> ${del1.status} ${trim(del1.json, 200)}`);
  const back = await api('POST', `/api/agents/${id}/board`, { board: 'customers' });
  check(I, back.status === 200, `move back -> ${back.status}`);
  const rm = await api('DELETE', `/api/agents/${id}`);
  if (rm.status === 200) mine.delete(id);
  check(I, rm.status === 200, `DELETE agent -> ${rm.status}`);
  const del2 = await api('DELETE', '/api/boards/judge-test');
  if (del2.status === 200) myBoards.delete('judge-test');
  check(I, del2.status === 200, `DELETE empty board -> ${del2.status} ${trim(del2.json, 200)}`);
  const s2 = await state();
  check(I, !s2.boards.some((x) => x.id === 'judge-test'), `board gone from state; WS boards events=${wsEvents.filter((e) => e.type === 'boards').length}`);
};

// =============== 2. tower send
const item2 = async () => {
  const I = '2-send';
  const A = await launch({ task: 'Wait for a message from another session; when it arrives, reply with the exact text you received.', name: 'cd-send-A' });
  check(I, A.status === 201, `launch A -> ${A.status} ${A.json?.id}`);
  const aid = A.json?.id;
  if (!aid) return;
  await waitStatus(aid, ['done', 'error', 'stopped', 'working'], 120000).catch(() => {});
  const B = await launch({ task: `Run this exact shell command: tower agents — then run: tower send --to ${aid} "PING-FROM-B" — then reply DONE.`, name: 'cd-send-B' });
  check(I, B.status === 201, `launch B -> ${B.status} ${B.json?.id}`);
  const bid = B.json?.id;
  if (!bid) return;
  const fromItem = await until(async () => (await feed(aid)).find((f) => f.type === 'user_message' && f.text.startsWith('[From ') && f.text.includes('PING-FROM-B')), 300000).catch(() => null);
  check(I, !!fromItem, `A feed user_message: ${trim(fromItem?.text, 200)}`);
  const bd = await waitStatus(bid, ['done', 'error', 'stopped'], 240000).catch(() => null);
  const bf = await feed(bid);
  const sentLine = bf.find((f) => /Sent to/i.test(f.text || f.output || f.title || ''));
  check(I, !!sentLine, `B feed "Sent to": ${trim(sentLine, 250)}`);
  const tools = bf.filter((f) => f.type === 'tool_call');
  for (const t of tools) log(I, `  B tool: title=${trim(t.title, 60)} detail=${trim(t.detail, 160)} output=${trim(t.output, 160)}`);
  // `tower agents` lists live agents (id, name, ...): its result must mention A's id and not be the send result
  const agentsTool = tools.find((f) => `${f.detail || ''}${f.output || ''}`.includes(aid) && !/Sent to/.test(`${f.detail || ''}${f.output || ''}`));
  check(I, !!agentsTool, `B ran tower agents (result lists A=${aid}): ${trim(agentsTool?.output || agentsTool?.detail, 300)}`);
  check(I, bd?.status === 'done', `B status ${bd?.status} last=${trim(bd?.lastMessage, 80)}`);
  if (fromItem) {
    const reply = await until(async () => {
      const a = await agent(aid);
      if (a.status !== 'done') return null;
      const f = await feed(aid);
      const idx = f.findIndex((x) => x.id === fromItem.id);
      return f.slice(idx + 1).find((x) => x.type === 'agent_message' && x.text.includes('PING-FROM-B'));
    }, 240000).catch(() => null);
    check(I, !!reply, `A replied: ${trim(reply?.text, 200)}`);
  }
};

// =============== 3. tower handoff
const item3 = async () => {
  const I = '3-handoff';
  const R = await launch({ task: 'Run this exact shell command: tower handoff "Reply with the word HANDOFF-OK and nothing else." — then wait for the result and reply with what you received.', name: 'cd-handoff-R' });
  check(I, R.status === 201, `launch R -> ${R.status} ${R.json?.id}`);
  const rid = R.json?.id;
  if (!rid) return;
  const child = await until(async () => (await state()).agents.find((a) => a.requestedBy?.agentId === rid), 300000).catch(() => null);
  check(I, !!child, `child appeared: ${trim(child && { id: child.id, name: child.name, requestedBy: child.requestedBy, kind: child.kind, board: child.board }, 300)}`);
  if (!child) return;
  mine.add(child.id);
  const r1 = await agent(rid);
  check(I, r1.handoffs?.some((h) => h.agentId === child.id), `R.summary.handoffs=${trim(r1.handoffs, 300)}`);
  const cd = await waitStatus(child.id, ['done', 'error', 'stopped'], 240000).catch(() => null);
  check(I, cd?.status === 'done', `child ${cd?.status} last=${trim(cd?.lastMessage, 80)}`);
  const resItem = await until(async () => (await feed(rid)).find((f) => f.type === 'user_message' && f.text.startsWith('[Handoff result from') && f.text.includes('HANDOFF-OK')), 240000).catch(() => null);
  check(I, !!resItem, `R feed: ${trim(resItem?.text, 200)}`);
  const r2 = await agent(rid);
  check(I, r2.handoffs?.find((h) => h.agentId === child.id)?.status === 'done', `R.handoffs status kept current: ${trim(r2.handoffs, 200)}`);
  if (resItem) {
    const reply = await until(async () => {
      const a = await agent(rid);
      if (a.status !== 'done') return null;
      const f = await feed(rid);
      const idx = f.findIndex((x) => x.id === resItem.id);
      return f.slice(idx + 1).find((x) => x.type === 'agent_message' && x.text.includes('HANDOFF-OK'));
    }, 240000).catch(() => null);
    check(I, !!reply, `R replied: ${trim(reply?.text, 200)}`);
  }
};

// =============== 4. Rotation
const item4 = async () => {
  const I = '4-rotation';
  const s = await state();
  check(I, typeof s.rotation?.autoRotate === 'boolean' && Array.isArray(s.rotation?.activity), `state.rotation autoRotate=${s.rotation?.autoRotate} activity.len=${s.rotation?.activity?.length}`);
  const orig = s.rotation?.autoRotate ?? true;
  const t0 = Date.now();
  const r1 = await api('POST', '/api/rotation', { autoRotate: false });
  check(I, r1.status === 200 && r1.json?.autoRotate === false, `POST rotation false -> ${r1.status} autoRotate=${r1.json?.autoRotate}`);
  await sleep(800);
  check(I, wsEvents.some((e) => e.at >= t0 && e.type === 'rotation' && e.e.rotation.autoRotate === false), 'WS rotation event autoRotate=false');
  const r2 = await api('POST', '/api/rotation', { autoRotate: true });
  check(I, r2.status === 200 && r2.json?.autoRotate === true, `POST rotation true -> ${r2.status} autoRotate=${r2.json?.autoRotate}`);
  await sleep(800);
  check(I, wsEvents.some((e) => e.at >= t0 && e.type === 'rotation' && e.e.rotation.autoRotate === true), 'WS rotation event autoRotate=true');
  if (!orig) await api('POST', '/api/rotation', { autoRotate: false });
  // pick a claude account not excluded, preferably not running anything
  const cl = s.accounts.filter((a) => a.kind === 'claude' && !a.excluded);
  const acc = cl.find((a) => a.running === 0) || cl[0];
  if (!check(I, !!acc, `claude account picked: ${acc?.id} status=${acc?.status} running=${acc?.running}`)) return;
  const t1 = Date.now();
  const e1 = await api('POST', `/api/accounts/${acc.id}/exclude`, { excluded: true });
  check(I, e1.status === 200, `exclude true -> ${e1.status} ${trim(e1.json, 150)}`);
  const s1 = await state();
  const a1 = s1.accounts.find((a) => a.id === acc.id);
  check(I, a1?.status === 'excluded' && a1?.excluded === true, `state account status=${a1?.status} excluded=${a1?.excluded}`);
  const act1 = s1.rotation.activity.find((x) => x.at >= t1 - 2000 && x.kind === 'excluded' && x.accountId === acc.id);
  check(I, !!act1, `activity excluded: ${trim(act1, 200)}`);
  await sleep(800);
  check(I, wsEvents.some((e) => e.at >= t1 && e.type === 'accounts' && e.e.accounts.find((a) => a.id === acc.id)?.status === 'excluded'), 'WS accounts event with status excluded');
  check(I, wsEvents.some((e) => e.at >= t1 && e.type === 'rotation' && e.e.rotation.activity[0]?.kind === 'excluded'), 'WS rotation event with excluded activity');
  const t2 = Date.now();
  const e2 = await api('POST', `/api/accounts/${acc.id}/exclude`, { excluded: false });
  check(I, e2.status === 200, `exclude false -> ${e2.status}`);
  const s2 = await state();
  const a2 = s2.accounts.find((a) => a.id === acc.id);
  check(I, a2?.status !== 'excluded' && !a2?.excluded, `state account after include status=${a2?.status} excluded=${a2?.excluded}`);
  const act2 = s2.rotation.activity.find((x) => x.at >= t2 - 2000 && x.kind === 'included' && x.accountId === acc.id);
  check(I, !!act2, `activity included: ${trim(act2, 200)}`);
  await sleep(800);
  check(I, wsEvents.some((e) => e.at >= t2 && e.type === 'accounts' && e.e.accounts.find((a) => a.id === acc.id) && e.e.accounts.find((a) => a.id === acc.id).status !== 'excluded'), 'WS accounts event after include');
  check(I, wsEvents.some((e) => e.at >= t2 && e.type === 'rotation' && e.e.rotation.activity[0]?.kind === 'included'), 'WS rotation event with included activity');
};

// =============== 5. Review fixes
const item5 = async () => {
  const I = '5-review';
  const s = await state();
  const tm = s.agents.find((a) => a.source === 'tmux');
  if (tm) {
    const f = await api('GET', `/api/agents/${tm.id}/feed`);
    check(I, f.status === 200 && Array.isArray(f.json) && f.json.length === 0, `tmux ${tm.id} feed -> ${f.status} ${trim(f.json, 100)}`);
  } else log(I, 'no tmux card observed; skipped tmux feed check');
  const big = await api('POST', '/api/agents', { kind: 'devin', task: 'x'.repeat(9000) });
  if (big.json?.id) mine.add(big.json.id);
  check(I, big.status === 400, `9000-char task -> ${big.status} ${trim(big.json, 150)}`);
  const Q = await launch({ task: 'Run this exact shell command: tower ask "Which color, red or blue?" — then reply ASKED and stop.', name: 'cd-ask-Q' });
  check(I, Q.status === 201, `launch Q -> ${Q.status} ${Q.json?.id}`);
  const qid = Q.json?.id;
  if (!qid) return;
  const withQ = await until(async () => { const a = await agent(qid); return a?.questions?.length ? a : null; }, 240000).catch(() => null);
  if (!check(I, !!withQ, `question present: ${trim(withQ?.questions, 200)}`)) return;
  const question = withQ.questions[0];
  const st = await api('POST', `/api/agents/${qid}/stop`);
  check(I, st.status === 200, `stop -> ${st.status}`);
  await waitStatus(qid, ['stopped', 'error'], 30000).catch(() => {});
  const ans = await api('POST', `/api/agents/${qid}/answer`, { questionId: question.id, text: 'red' });
  check(I, ans.status === 409, `answer on stopped agent -> ${ans.status} ${trim(ans.json, 150)}`);
  const after = await agent(qid);
  check(I, after?.questions?.some((q) => q.id === question.id), `question still present after 409: ${trim(after?.questions?.map((q) => q.id))} status=${after?.status}`);
};

const runItem = async (name, fn) => {
  try { await fn(); } catch (e) { check(name, false, `threw: ${e.message}`); }
};
const t0 = Date.now();
await Promise.all([
  runItem('1-boards', item1),
  runItem('2-send', item2),
  runItem('3-handoff', item3),
  (async () => { await runItem('4-rotation', item4); await runItem('5-review', item5); })(),
]);

// ---- cleanup
approving = false;
const s = await state();
for (const a of s.agents) if (a.requestedBy && mine.has(a.requestedBy.agentId)) mine.add(a.id);
for (const id of mine) {
  const r = await api('DELETE', `/api/agents/${id}`);
  console.log(`  [cleanup] DELETE agent ${id} -> ${r.status}`);
}
for (const b of myBoards) {
  const r = await api('DELETE', `/api/boards/${b}`);
  console.log(`  [cleanup] DELETE board ${b} -> ${r.status}`);
}
const s3 = await state();
const left = s3.agents.filter((a) => mine.has(a.id)).map((a) => a.id);
console.log(`  [cleanup] remaining created agents: ${JSON.stringify(left)}; boards: ${JSON.stringify(s3.boards.map((b) => b.id))}`);
ws.close();

console.log('\n==== SUMMARY ====');
console.log(`elapsed ${Math.round((Date.now() - t0) / 1000)}s; WS events by type: ${JSON.stringify(wsEvents.reduce((m, e) => ((m[e.type] = (m[e.type] || 0) + 1), m), {}))}`);
console.log(`permissions approved: ${approved.length} ${red(JSON.stringify(approved)).slice(0, 600)}`);
let allPass = true;
for (const [k, v] of Object.entries(results)) {
  const p = v.fail.length === 0;
  allPass &&= p;
  console.log(`${p ? 'PASS' : 'FAIL'} ${k}: ${v.pass} ok${v.fail.length ? `; failed: ${red(v.fail.join(' | '))}` : ''}`);
}
process.exit(allPass ? 0 : 1);
