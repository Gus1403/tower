// Headless verification of Wave B on the LIVE Tower deployment (eva-forge, tailnet HTTPS) with REAL agents.
// Token comes from env TOWER_TOKEN only — never written to files, and redacted from every log line.
import { mkdirSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const BASE = process.env.TOWER_BASE || 'https://eva-forge.tail1259c5.ts.net:8443';
const TOKEN = process.env.TOWER_TOKEN;
if (!TOKEN) {
  console.error('TOWER_TOKEN env var required');
  process.exit(2);
}
const red = (s) => String(s).split(TOKEN).join('***');
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'out');
mkdirSync(out, { recursive: true });

const errors = [];
const failed = [];
const softFails = [];
const notes = [];
const findings = [];
let checks = 0;
const ok = (cond, msg) => {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  checks++;
  console.log(`  ✓ ${msg}`);
};
const soft = async (name, fn) => {
  console.log(name);
  try {
    await fn();
  } catch (e) {
    softFails.push(`${name}: ${red(e.message)}`);
    console.log(`  ✗ ${name}: ${red(e.message)}`);
  }
};
const until = async (fn, ms, step = 2000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, step));
  }
  throw new Error(`timeout ${ms}ms`);
};

function cachedShell() {
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  if (!existsSync(root)) return undefined;
  for (const d of readdirSync(root).filter((x) => x.startsWith('chromium_headless_shell-')).sort().reverse()) {
    const p = path.join(root, d, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell');
    if (existsSync(p)) return p;
  }
}
const executablePath = existsSync(chromium.executablePath()) ? undefined : cachedShell();
const browser = await chromium.launch({ executablePath });
const wsUrls = [];
const wire = (page) => {
  page.on('console', (m) => m.type() === 'error' && errors.push(red(m.text())));
  page.on('pageerror', (e) => errors.push(red(String(e))));
  page.on('requestfailed', (r) => !/favicon/.test(r.url()) && failed.push(red(`${r.url()} ${r.failure()?.errorText}`)));
  page.on('response', (r) => r.status() >= 400 && !/favicon/.test(r.url()) && failed.push(red(`${r.url()} ${r.status()}`)));
  page.on('websocket', (w) => wsUrls.push(red(w.url())));
};
const shot = async (page, name) => {
  const f = path.join(out, `liveb-${name}.png`);
  await page.screenshot({ path: f });
  console.log(`  ▣ ${f}`);
};

const H = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
const api = async (method, p, body) => {
  const r = await fetch(`${BASE}${p}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  let j = null;
  try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
};
const getState = async () => (await api('GET', '/api/state')).json;
const agentById = async (id) => (await getState()).agents.find((x) => x.id === id);
const feedText = async (id) => {
  const f = (await api('GET', `/api/agents/${id}/feed`)).json || [];
  return f.map((x) => `${x.type}: ${x.text ?? x.title ?? ''} ${x.detail ?? ''} ${x.output ?? ''}`).join('\n');
};
const launched = new Set();

const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const wp = await ctx.newPage();
wire(wp);
// approve every pending permission row in the needs-you inbox (only agents launched by this script ask)
const approve = async (pg = wp) => {
  const b = pg.locator('.inbox-row .perm-actions button.btn-primary').first();
  if (await b.count()) await b.click({ timeout: 2000 }).catch(() => {});
};
const launchUI = async (kind, task, accountId) => {
  const before = new Set((await getState()).agents.map((x) => x.id));
  await wp.locator('.new-btn').click();
  await wp.waitForSelector('.dialog');
  await wp.locator('.segmented button', { hasText: kind }).click();
  if (accountId) await wp.locator('.dialog select[aria-label="Account"]').selectOption(accountId);
  await wp.locator('.dialog textarea').fill(task);
  await wp.locator('.dialog button', { hasText: 'Launch' }).click();
  await wp.waitForSelector('.panel', { timeout: 15000 });
  const id = await until(async () => (await getState()).agents.find((x) => !before.has(x.id) && x.source === 'tower')?.id, 15000, 500);
  launched.add(id);
  return id;
};
const openCard = async (id) => {
  await wp.keyboard.press('Escape');
  await wp.locator(`.bcard[data-card-id="${id}"] .card`).first().click().catch(async () => {
    await wp.locator(`.bcard[data-card-id="${id}"]`).first().click();
  });
  await wp.waitForSelector('.panel', { timeout: 8000 });
  await wp.waitForTimeout(500);
};
const waitDone = async (id, ms) =>
  until(async () => {
    await approve();
    const a = await agentById(id);
    if (a?.status === 'error') throw new Error(`agent ${id} error: ${a.error}`);
    return a?.status === 'done' && !(a.queued?.length) && !(a.questions?.length) ? a : null;
  }, ms, 1500);

let qId, noteAgentId, claudeId, noteId, claudeAcct;
try {
  // ---------- 1. HTTPS + WSS + service worker ----------
  await soft('1 https', async () => {
    ok(BASE.startsWith('https://'), `base is https (${BASE})`);
    await wp.goto(`${BASE}/?token=${TOKEN}`);
    await wp.waitForSelector('.topbar .cap', { timeout: 20000 });
    await wp.waitForTimeout(1500);
    ok(wp.url().startsWith('https://'), 'page loaded over https');
    ok(!wp.url().includes('token='), 'token stripped from the address bar');
    ok(await wp.evaluate(() => window.isSecureContext), 'window.isSecureContext');
    ok(wsUrls.some((u) => u.startsWith('wss://')), `WebSocket over wss (${wsUrls[0]?.replace(/\?.*/, '?…')})`);
    ok(await wp.locator('.reconnect').isHidden(), 'WS connected (no reconnecting pill)');
    const reg = await until(
      () => wp.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); return r ? r.scope : null; }),
      15000, 500,
    );
    ok(!!reg, `serviceWorker.getRegistration() -> registration (scope ${reg})`);
    console.log(`  · Notification.permission = ${await wp.evaluate(() => Notification.permission)}`);
    await shot(wp, 'desktop-board');
  });

  // ---------- launch the three real agents early (they run in parallel) ----------
  await soft('2a launch question agent (Devin)', async () => {
    qId = await launchUI(
      'Devin',
      'Run this exact shell command: tower ask --recommendation "Blue" "Which color should the main button be?" — then stop and wait; when you receive the answer, create button.txt containing the color and reply DONE.',
    );
    ok(!!qId, `question agent launched (${qId})`);
  });

  await soft('5a note via UI + Start with Devin (Automatic)', async () => {
    await wp.keyboard.press('Escape');
    await wp.locator('.col-notes .note-add').first().click();
    await wp.locator('.note-edit .note-title-in').fill('Hackathon README check');
    await wp.locator('.note-edit .note-body-in').fill('Reply with the word NOTE-OK');
    await wp.locator('.note-edit .btn-primary', { hasText: 'Add' }).click();
    const n = await until(async () => (await getState()).notes.find((x) => x.title === 'Hackathon README check' && !x.archived), 10000, 500);
    noteId = n.id;
    notes.push(n.id);
    ok(true, `note created via UI (${n.id})`);
    const card = wp.locator(`.note[data-note-id="${n.id}"]`);
    await card.waitFor({ timeout: 5000 });
    await shot(wp, 'note-created');
    const before = new Set((await getState()).agents.map((x) => x.id));
    await card.locator('.note-start').click();
    await wp.waitForSelector('.start-dialog');
    await wp.locator('.start-dialog .segmented button', { hasText: 'Devin' }).click();
    ok((await wp.locator('.start-dialog select.start-acct').inputValue()) === 'auto', 'Start dialog account = Automatic');
    await shot(wp, 'note-start-dialog');
    await wp.locator('.start-dialog .start-go').click();
    noteAgentId = await until(async () => (await getState()).agents.find((x) => !before.has(x.id) && x.source === 'tower')?.id, 15000, 500);
    launched.add(noteAgentId);
    const a = await agentById(noteAgentId);
    ok(a.kind === 'devin' && /Hackathon README check/.test(a.task) && /NOTE-OK/.test(a.task), 'note agent task = title + body');
  });

  await soft('7a launch Claude on a specific account', async () => {
    const st = await getState();
    const good = st.accounts.filter((x) => x.kind === 'claude' && x.loggedIn === true && (x.status ?? 'ok') === 'ok' && !x.excluded);
    ok(good.length >= 2, `≥2 usable logged-in claude accounts (${good.length})`);
    claudeAcct = good[0].id;
    claudeId = await launchUI('Claude', 'Reply PONG', claudeAcct);
    ok(true, `claude agent launched on ${claudeAcct} (${claudeId})`);
  });

  // ---------- 2. question via tower ask ----------
  let phoneDone = false;
  await soft('2b question inbox', async () => {
    await openCard(qId);
    await until(async () => {
      await approve();
      return (await wp.locator('.qinbox .q-row').count()) > 0;
    }, 240000, 1500);
    const a = await agentById(qId);
    ok(a.status === 'needs_you' && a.questions?.length === 1, `summary: status needs_you + 1 open question (${a.status})`);
    ok(a.questions[0].recommendation === 'Blue', 'question carries recommendation "Blue"');
    const row = wp.locator('.qinbox .q-row').first();
    ok(/Which color should the main button be\?/.test(await row.locator('.q-text').innerText()), 'q-row shows the question text');
    ok(/Blue/.test(await row.locator('.q-rec').innerText()), 'q-row shows the recommendation');
    await shot(wp, 'question-inbox');

    // ---------- 9. phone while the question is open ----------
    await soft('9 phone 390x844 (https)', async () => {
      const pc = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
      const pp = await pc.newPage();
      wire(pp);
      await pp.goto(`${BASE}/?token=${TOKEN}`);
      await pp.waitForSelector('.tabs', { timeout: 20000 });
      await pp.waitForTimeout(1500);
      const noOverflow = () => pp.evaluate(() => document.documentElement.scrollWidth <= 390);
      ok(await noOverflow(), 'phone board: no horizontal overflow');
      await shot(pp, 'phone-board');
      const pq = pp.locator('.qinbox .q-row').first();
      ok(await pq.isVisible(), 'phone: Questions inbox row visible');
      await pq.scrollIntoViewIfNeeded();
      await shot(pp, 'phone-question');
      ok(await noOverflow(), 'phone question row: no horizontal overflow');
      await pq.locator('.q-agent').click();
      await pp.waitForSelector('.panel', { timeout: 8000 });
      await pp.waitForTimeout(800);
      ok(await pp.locator('.panel .c-attach').isVisible(), 'phone sheet: paperclip (attach) visible in composer');
      ok(await noOverflow(), 'phone sheet: no horizontal overflow');
      await shot(pp, 'phone-sheet');
      await pc.close();
      phoneDone = true;
    });

    await row.locator('.q-use').click();
    ok((await row.locator('.q-input').inputValue()) === 'Blue', '"Use recommendation" fills Blue');
    await row.locator('.q-send').click();
    await until(async () => !((await agentById(qId))?.questions?.length), 10000, 500);
    ok(true, 'question removed after answering');
    await waitDone(qId, 240000);
    const ft = await feedText(qId);
    ok(/user_message: \[Answer to «Which color should the main button be\?»\] Blue/.test(ft), 'agent received "[Answer to «…»] Blue"');
    ok(/DONE/.test(ft), 'agent replied DONE');
    const cwd = (await agentById(qId)).cwd;
    const content = execFileSync('ssh', ['-o', 'BatchMode=yes', 'eva-forge', `cat ${JSON.stringify(cwd + '/button.txt')}`]).toString();
    ok(/blue/i.test(content), `button.txt on eva-forge contains "${content.trim()}"`);
    await openCard(qId);
    await shot(wp, 'question-answered');
  });

  // ---------- 4. "/" commands ----------
  // Devin's ACP server (devin acp) never sends available_commands_update (seen live and in probes/out), so a Devin
  // card has no commands: assert "/" degrades gracefully there and verify the menu on a Claude agent (section 7b).
  await soft('4a slash on Devin', async () => {
    const a = await agentById(qId);
    if ((a.commands?.length ?? 0) === 0) {
      findings.push('Devin agents never get summary.commands (devin acp sends no available_commands_update) -> no "/" menu on Devin cards');
      console.log('  ! FINDING: Devin summary.commands is empty/undefined (upstream: no available_commands_update)');
    }
    await openCard(qId);
    const ta = wp.locator('.panel .composer textarea');
    await ta.fill('');
    await ta.type('/');
    await wp.waitForTimeout(500);
    const open = await wp.locator('.panel .slash-menu').count();
    ok(open === ((a.commands?.length ?? 0) > 0 ? 1 : 0), `Devin: slash menu ${open ? 'opens' : 'stays closed (no commands), no empty popup'}`);
    await shot(wp, 'slash-devin');
    await ta.fill('');
  });
  const slashCheck = async (id, label) => {
    const a = await agentById(id);
    ok((a.commands?.length ?? 0) > 0, `${label}: summary.commands non-empty (${a.commands?.length})`);
    await openCard(id);
    const ta = wp.locator('.panel .composer textarea');
    await ta.fill('');
    await ta.type('/');
    await wp.waitForSelector('.panel .slash-menu', { timeout: 5000 });
    const n = await wp.locator('.panel .slash-menu .slash-item').count();
    ok(n >= 1, `slash menu opens with ${n} item(s)`);
    await shot(wp, 'slash-menu');
    await ta.press('Escape');
    await wp.waitForTimeout(300);
    ok((await wp.locator('.slash-menu').count()) === 0, 'Escape closes the slash menu');
    if (!(await wp.locator('.panel').count())) {
      findings.push('Escape in the "/" menu also closes the whole agent panel (Panel.tsx window keydown Escape -> openAgent(null))');
      console.log('  ! FINDING: Escape closed the agent panel too, not just the slash menu');
    } else ok(true, 'panel stays open after Escape (only the menu closed)');
    if (await ta.count()) await ta.fill('');
  };

  // ---------- 3. attachments ----------
  await soft('3 attachments', async () => {
    const tmp = path.join(os.tmpdir(), `tower-liveb-${process.pid}`);
    mkdirSync(tmp, { recursive: true });
    const f = path.join(tmp, 'notes.txt');
    writeFileSync(f, 'hello from the judge\n');
    if (!(await wp.locator('.panel .composer textarea').count())) await openCard(qId);
    await wp.locator('.panel input.c-file').setInputFiles(f);
    await wp.waitForSelector('.panel .att-chip.ok', { timeout: 15000 });
    ok(true, 'attachment chip uploaded (ok)');
    await wp.locator('.panel .composer textarea').fill('Read the attached file and reply with its contents.');
    await shot(wp, 'attachment-chip');
    await wp.locator('.panel .composer textarea').press('Enter');
    await until(async () => /Attached: attachments\/notes\.txt/.test(await feedText(qId)), 15000, 1000);
    ok(true, 'prompt carries "Attached: attachments/notes.txt"');
    await until(async () => (await agentById(qId))?.status !== 'done', 15000, 500).catch(() => {});
    await waitDone(qId, 240000);
    const f2 = (await api('GET', `/api/agents/${qId}/feed`)).json;
    const lastUser = f2.map((x) => x.type).lastIndexOf('user_message');
    const after = f2.slice(lastUser).filter((x) => x.type === 'agent_message').map((x) => x.text).join(' ');
    ok(/hello from the judge/.test(after), `agent replied with the file contents ("${after.slice(0, 80)}")`);
    await shot(wp, 'attachment-reply');
  });

  // ---------- 5. note agent done ----------
  await soft('5b note agent done', async () => {
    await waitDone(noteAgentId, 240000);
    ok(/NOTE-OK/.test(await feedText(noteAgentId)), 'note agent feed has NOTE-OK');
    const n = (await getState()).notes.find((x) => x.id === noteId);
    ok(!n || n.archived, `note archived/removed from Notes (${n ? 'archived' : 'removed'})`);
    await wp.keyboard.press('Escape');
    await wp.waitForTimeout(300);
    ok((await wp.locator(`.col-notes .note[data-note-id="${noteId}"]`).count()) === 0, 'note no longer shown in the Notes column');
    await openCard(noteAgentId);
    await shot(wp, 'note-agent-done');
  });

  // ---------- 6. archive + search ----------
  await soft('6 archive + search', async () => {
    await wp.keyboard.press('Escape');
    await wp.waitForTimeout(300);
    const card = wp.locator(`.bcard[data-card-id="${noteAgentId}"]`);
    await card.hover();
    await card.locator('.bcard-act').click();
    await until(async () => (await agentById(noteAgentId))?.archived === true, 10000, 500);
    ok(true, 'card archived (summary.archived)');
    await wp.waitForTimeout(400);
    ok((await card.count()) === 0, 'archived card left the board');
    await wp.locator('.archived-toggle').click();
    const item = wp.locator(`.archived-item[data-archived-id="${noteAgentId}"]`);
    await item.waitFor({ timeout: 5000 });
    ok(true, 'card listed under Archived');
    await item.scrollIntoViewIfNeeded();
    await shot(wp, 'archived');
    await item.locator('button', { hasText: 'Restore' }).click();
    await until(async () => (await agentById(noteAgentId))?.archived === false, 10000, 500);
    await wp.waitForTimeout(400);
    ok((await wp.locator(`.bcard[data-card-id="${noteAgentId}"]`).count()) === 1, 'restored card back on the board');
    const name = (await agentById(noteAgentId)).name;
    await wp.locator('.search-desk input').fill('Hackathon README');
    await wp.waitForTimeout(500);
    const visible = await wp.locator('.bcard').evaluateAll((els) => els.map((e) => e.getAttribute('data-card-id')));
    ok(visible.includes(noteAgentId), `search keeps the note agent card ("${name}")`);
    ok(!visible.includes(qId), 'search filters out the other agents');
    await shot(wp, 'search');
    await wp.locator('.search-desk input').fill('');
  });

  // ---------- 7. move to another account ----------
  await soft('7b move claude to another account', async () => {
    await waitDone(claudeId, 240000);
    const a0 = await agentById(claudeId);
    ok(a0.accountId === claudeAcct, `claude agent on chosen account ${claudeAcct}`);
    ok(/PONG/.test(await feedText(claudeId)), 'claude replied PONG');
    await soft('4b slash on Claude', () => slashCheck(claudeId, 'Claude'));
    await openCard(claudeId);
    await wp.locator('.panel button[aria-label="More"]').click();
    await wp.locator('.more-menu .more-move').click();
    await wp.waitForSelector('.move-picker .move-acc', { timeout: 5000 });
    const n = await wp.locator('.move-picker .move-acc').count();
    ok(n >= 1, `move picker lists ${n} other account(s)`);
    await shot(wp, 'move-picker');
    const before = new Set((await getState()).agents.map((x) => x.id));
    await wp.locator('.move-picker .move-acc').first().click();
    const newId = await until(async () => (await getState()).agents.find((x) => !before.has(x.id) && x.source === 'tower')?.id, 20000, 500);
    launched.add(newId);
    const nA = await agentById(newId);
    ok(/\(moved\)/.test(nA.name), `new agent name has "(moved)" ("${nA.name}")`);
    ok(nA.kind === 'claude' && nA.accountId && nA.accountId !== claudeAcct, `new agent on a different account (${nA.accountId})`);
    await waitDone(newId, 240000);
    ok(true, 'moved agent reached done');
    const old = await agentById(claudeId);
    ok(old.archived === true, `old card archived (status ${old.status})`);
    await shot(wp, 'moved-done');
  });

  // ---------- 8. tmux stays read-only ----------
  await soft('8 tmux read-only', async () => {
    const obs = (await getState()).agents.filter((x) => x.source === 'tmux');
    ok(obs.length > 0, `observed tmux cards present (${obs.length})`);
    ok(obs.every((x) => !x.interactive), 'no tmux card is interactive');
    await wp.keyboard.press('Escape');
    const tog = wp.locator('.observed-toggle:not(.archived-toggle)').first();
    if ((await tog.getAttribute('aria-expanded')) !== 'true') await tog.click();
    await wp.waitForTimeout(500);
    const cards = await wp.locator('.observed-grid .bcard').count();
    const hints = await wp.locator('.observed-grid .bcard .ro-hint').count();
    ok(cards > 0 && hints === cards, `every observed card shows the read-only hint (${hints}/${cards})`);
    ok((await wp.locator('.live-hint').count()) === 0, 'no "Live · click to type" hint anywhere');
    await wp.locator('.observed-grid .bcard .ro-hint').first().scrollIntoViewIfNeeded();
    await shot(wp, 'tmux-readonly');
    const r = await api('POST', `/api/agents/${obs[0].id}/send`, { text: '' });
    ok(r.status === 409, `POST /send on a tmux card -> ${r.status}`);
    await tog.click();
  });

  if (!phoneDone) softFails.push('9 phone: not run (question row never appeared)');
} finally {
  console.log('cleanup');
  for (const id of launched) {
    const r = await api('DELETE', `/api/agents/${id}`).catch((e) => ({ status: e.message }));
    console.log(`  DELETE agent ${id} -> ${r.status}`);
  }
  for (const id of notes) {
    const r = await api('DELETE', `/api/notes/${id}`).catch((e) => ({ status: e.message }));
    console.log(`  DELETE note ${id} -> ${r.status}`);
  }
  await browser.close();
}

// the tmux 409 probe is an intentional API call (node fetch), not a page request, so it is not in `failed`
console.log(`checks passed: ${checks}`);
console.log(`soft failures: ${softFails.length}`, softFails);
console.log(`findings (not failures): ${findings.length}`, findings);
console.log(`console errors: ${errors.length}`, errors);
console.log(`failed requests: ${failed.length}`, failed);
if (softFails.length || errors.length || failed.length) process.exit(1);
console.log('VERIFY LIVE B OK');
