// Headless verification of the LIVE Tower deployment (eva-forge over Tailscale).
// Token comes from env TOWER_TOKEN only — never written to files or URLs on disk.
import { mkdirSync, existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const BASE = process.env.TOWER_BASE || 'http://100.86.145.23:4747';
const TOKEN = process.env.TOWER_TOKEN;
if (!TOKEN) {
  console.error('TOWER_TOKEN env var required');
  process.exit(2);
}
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'out');
mkdirSync(out, { recursive: true });

const errors = [];
const failed = [];
let checks = 0;
const ok = (cond, msg) => {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  checks++;
  console.log(`  ✓ ${msg}`);
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
const wire = (page) => {
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('requestfailed', (r) => failed.push(`${r.url()} ${r.failure()?.errorText}`));
  page.on('response', (r) => r.status() >= 400 && failed.push(`${r.url()} ${r.status()}`));
};
const shot = async (page, name) => {
  const f = path.join(out, `${name}.png`);
  await page.screenshot({ path: f });
  console.log(`  ▣ ${f}`);
};
const waitStatus = async (page, sel, ms) =>
  page.waitForSelector(sel, { timeout: ms });

try {
  // ---------- pre-checks over the API ----------
  console.log('api pre-checks');
  const state = await (
    await fetch(`${BASE}/api/state`, { headers: { authorization: `Bearer ${TOKEN}` } })
  ).json();
  const observed = state.agents.filter((a) => a.source === 'tmux');
  ok(state.capacity.length === 3, 'capacity lists 3 kinds');
  ok(
    state.capacity.every((c) => c.available === true),
    'all capacity chips available',
  );
  ok(observed.length > 0, `observed tmux cards present (${observed.length})`);
  ok(
    observed.every((a) => /^(Claude Code|Codex|Devin) session \d+$/.test(a.name)),
    'all observed names are redacted "<Kind> session <n>"',
  );
  ok(
    observed.every((a) => !/cust-|eva-|lead-/i.test(a.name + a.task)),
    'no real session names leak into name/task',
  );

  // ---------- desktop ----------
  console.log('desktop 1440x900');
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  wire(page);
  await page.goto(`${BASE}/?token=${TOKEN}`);
  await page.waitForSelector('.topbar .cap', { timeout: 15000 });
  await page.waitForTimeout(2000);
  ok(await page.locator('.reconnect').isHidden(), 'WS connected (no reconnecting pill)');
  ok((await page.locator('.cap:not(.cap-off):not(.cap-all)').count()) === 3, 'three capacity chips show available');
  ok(await page.locator('.observed-toggle').isVisible(), 'Observed (tmux) section present');
  ok(await page.locator('.observed-grid').isHidden(), 'Observed section collapsed by default');
  const boardText = await page.locator('.observed-toggle').innerText();
  ok(!/cust-/.test(boardText), 'observed toggle shows no session names');
  await shot(page, 'live-desktop-board');

  // expand observed once to check the dense grid, then collapse
  await page.locator('.observed-toggle').click();
  await page.waitForTimeout(300);
  await shot(page, 'live-desktop-observed-open');
  ok(
    !/cust-|lead-/.test(await page.locator('.observed-grid').innerText()),
    'observed grid shows only redacted names',
  );
  await page.locator('.observed-toggle').click();

  // launch a Devin agent through the UI
  await page.locator('.new-btn').click();
  await page.waitForSelector('.dialog');
  await page.locator('.segmented button', { hasText: 'Devin' }).click();
  await page
    .locator('.dialog textarea')
    .fill('Create a file notes.txt with three ideas for a hackathon demo, using a shell command, then reply DONE.');
  await shot(page, 'live-desktop-new-agent');
  await page.locator('.dialog button', { hasText: 'Launch' }).click();
  await page.waitForSelector('.panel', { timeout: 15000 });
  ok(true, 'agent panel opened after launch');

  // wait for the needs-you inbox row (devin accept-edits asks for shell commands)
  await page.waitForSelector('.inbox:not([hidden]) .inbox-row', { timeout: 120000 });
  ok(true, 'needs-you inbox row appeared');
  await shot(page, 'live-desktop-inbox');
  await page.locator('.inbox-row .perm-actions button.btn-primary').first().click();
  await page.waitForSelector('.inbox:not([hidden]) .inbox-row', { state: 'detached', timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(500);
  ok((await page.locator('.inbox-row').count()) === 0, 'inbox row disappeared after Allow');

  // wait for done
  await waitStatus(page, '.panel .status-done', 120000);
  ok(true, 'agent reached Done');
  await page.waitForSelector('.panel .f-tool', { timeout: 10000 });
  await page.waitForTimeout(800);
  ok((await page.locator('.panel .f-agent').count()) >= 1, 'feed has agent message');
  ok((await page.locator('.panel .f-tool').count()) >= 1, 'feed has tool calls');
  await shot(page, 'live-desktop-feed');

  // stop via the panel Stop button
  await page.locator('.panel button', { hasText: 'Stop' }).click();
  await page.waitForSelector('.panel .status-stopped', { timeout: 15000 });
  ok(true, 'Stop button moved agent to stopped');
  await shot(page, 'live-desktop-stopped');
  await ctx.close();

  // ---------- phone ----------
  console.log('phone 390x844');
  const pctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  const p = await pctx.newPage();
  wire(p);
  await p.goto(`${BASE}/?token=${TOKEN}`);
  await p.waitForSelector('.topbar .cap', { timeout: 15000 });
  await p.waitForTimeout(1500);
  ok(await p.locator('.tabs').isVisible(), 'phone shows tabs');
  await shot(p, 'live-phone-board');
  // open the stopped agent via the Done tab (default tab may be empty/hidden)
  await p.locator('.tab', { hasText: 'Done' }).click();
  await p.locator('.board .card:visible').first().click();
  await p.waitForSelector('.panel', { timeout: 8000 });
  await p.waitForTimeout(800);
  await shot(p, 'live-phone-sheet');
  await pctx.close();

  // ---------- WAVE A ----------
  console.log('wave A');
  const H = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
  const getState = async () => (await fetch(`${BASE}/api/state`, { headers: H })).json();
  const agentById = async (id) => (await getState()).agents.find((x) => x.id === id);
  const launched = [];
  const softFails = [];
  const soft = async (name, fn) => {
    try { await fn(); } catch (e) { softFails.push(`${name}: ${e.message}`); console.log(`  ✗ ${name}: ${e.message}`); }
  };
  const until = async (fn, ms, step = 2000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, step)); }
    throw new Error(`timeout ${ms}ms`);
  };
  const allowAll = async (pg, ms) => {
    // click Allow on inbox rows until the panel reaches done
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await pg.locator('.panel .status-done').count()) return;
      const b = pg.locator('.inbox-row .perm-actions button.btn-primary').first();
      if (await b.count()) await b.click().catch(() => {});
      await pg.waitForTimeout(1000);
    }
    throw new Error('not done in time');
  };
  const launchUI = async (pg, kind, task, accountPick) => {
    const before = new Set((await getState()).agents.map((x) => x.id));
    await pg.locator('.new-btn').click();
    await pg.waitForSelector('.dialog');
    await pg.locator('.segmented button', { hasText: kind }).click();
    if (accountPick) await accountPick(pg);
    await pg.locator('.dialog textarea').fill(task);
    await pg.locator('.dialog button', { hasText: 'Launch' }).click();
    await pg.waitForSelector('.panel', { timeout: 15000 });
    const id = await until(async () => (await getState()).agents.find((x) => !before.has(x.id) && x.source === 'tower')?.id, 15000, 500);
    launched.push(id);
    return id;
  };

  const wctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  let wp = await wctx.newPage();
  wire(wp);
  await wp.goto(`${BASE}/?token=${TOKEN}`);
  await wp.waitForSelector('.topbar .cap', { timeout: 15000 });

  // a. accounts
  await soft('a accounts', async () => {
    const st = await until(async () => { const s = await getState(); return (s.accounts || []).some((x) => x.kind === 'claude' && x.loggedIn === true) ? s : null; }, 90000, 5000);
    const acc = st.accounts;
    const n = (k) => acc.filter((x) => x.kind === k).length;
    ok(n('claude') >= 10, `≥10 claude accounts (${n('claude')})`);
    ok(n('codex') >= 3, `≥3 codex accounts (${n('codex')})`);
    ok(n('devin') === 1, `1 devin account (${n('devin')})`);
    ok(acc.every((x) => !/@/.test(`${x.id} ${x.label} ${x.detail ?? ''}`)), 'no emails in account ids/labels/details');
    ok(acc.some((x) => x.kind === 'claude' && x.loggedIn === true), 'a claude account is loggedIn');
    await wp.locator('.caps button.cap-all').click();
    await wp.waitForSelector('.acc-line', { timeout: 5000 });
    const rows = await wp.locator('.acc-line').count();
    await shot(wp, 'livea-accounts');
    await wp.keyboard.press('Escape');
    await wp.waitForTimeout(400);
    if (await wp.locator('.acc-line').count()) await wp.locator('.acc-scrim').click({ position: { x: 5, y: 450 } }).catch(() => {});
    ok(rows >= 20, `Accounts panel lists all accounts (${rows} rows)`);
    await shot(wp, 'livea-topbar');
  });

  // b + c. devin with queue and controls
  let devinId;
  await soft('b queue', async () => {
    devinId = await launchUI(wp, 'Devin', 'Write a file plan.md with a 5-step plan for a todo app using a shell command, then reply DONE.');
    await until(async () => ['working', 'needs_you'].includes((await agentById(devinId))?.status), 60000, 500);
    await wp.locator('.panel .composer textarea').fill('Also add a step about testing.');
    await wp.locator('.panel .composer textarea').press('Enter');
    await wp.waitForSelector('.panel .qchip', { timeout: 10000 });
    ok(true, 'queued chip appeared');
    await shot(wp, 'livea-queued');
    const t0 = Date.now();
    // approve until the queued prompt is sent (user bubble count 2) and agent done
    await until(async () => {
      const b = wp.locator('.inbox-row .perm-actions button.btn-primary').first();
      if (await b.count()) await b.click().catch(() => {});
      const a = await agentById(devinId);
      return a?.status === 'done' && !(a.queued?.length) && (await wp.locator('.panel .f-user').count()) >= 2;
    }, 240000, 1500);
    ok(true, `queued prompt sent and agent done (${Math.round((Date.now() - t0) / 1000)}s)`);
    await shot(wp, 'livea-queue-final');
  });
  await soft('c controls', async () => {
    const a = await agentById(devinId);
    const mode = wp.locator('.panel select[aria-label="Mode"]');
    ok(await mode.count() === 1, 'mode select exists');
    const opts = await mode.locator('option').evaluateAll((os) => os.map((o) => o.value));
    ok(opts.length >= 2, `mode lists ${opts.length} modes`);
    const target = opts.find((v) => v !== a.mode);
    await mode.selectOption(target);
    await until(async () => (await agentById(devinId))?.mode === target, 15000, 500);
    ok(true, `mode changed to ${target} (summary.mode)`);
    ok((await wp.locator('.panel .ctrl select').count()) >= 2, 'a config select exists besides mode');
    const st = await agentById(devinId);
    ok(!!st.usage, 'summary.usage present');
    ok(/\d+% context/.test(await wp.locator('.panel .ctx-label').innerText()), 'context bar shows %');
    await wp.locator('.panel button.f-tool').first().click();
    await wp.waitForSelector('.panel .f-tool-out', { timeout: 5000 });
    ok(true, 'tool call expands with output');
    await shot(wp, 'livea-controls');
  });

  // d. claude on a specific account
  await soft('d claude account', async () => {
    const st = await getState();
    const acct = st.accounts.find((x) => x.kind === 'claude' && x.loggedIn === true);
    const id = await launchUI(wp, 'Claude', 'Reply with the word PONG.', async (pg) => {
      await pg.locator('.dialog select[aria-label="Account"]').selectOption(acct.id);
    });
    await until(async () => (await agentById(id))?.status === 'done', 180000, 1500).catch(async (e) => { await allowAll(wp, 1000).catch(() => {}); throw e; });
    ok((await agentById(id)).accountId === acct.id, `summary.accountId === chosen (${acct.id})`);
    await shot(wp, 'livea-claude-pong');
  });

  // e. interrupt
  let intId;
  await soft('e interrupt', async () => {
    intId = await launchUI(wp, 'Devin', 'Count from 1 to 200 in a shell loop with sleep 0.2 between numbers, then reply DONE.');
    await until(async () => {
      const b = wp.locator('.inbox-row .perm-actions button.btn-primary').first();
      if (await b.count()) await b.click().catch(() => {});
      const a = await agentById(intId);
      return a?.status === 'working' && (await wp.locator('.panel .b-interrupt').count()) > 0 && (await wp.locator('.inbox-row').count()) === 0;
    }, 120000, 1000);
    await wp.waitForTimeout(3000);
    await wp.locator('.panel .b-interrupt').click();
    const a = await until(async () => { const x = await agentById(intId); return x?.status === 'done' ? x : null; }, 30000, 500);
    ok(a.stopReason === 'cancelled', `interrupt -> done stopReason=${a.stopReason}`);
    await shot(wp, 'livea-interrupted');
    await wp.locator('.panel .composer textarea').fill('Reply OK');
    await wp.locator('.panel .composer textarea').press('Enter');
    await until(async () => { const x = await agentById(intId); return x?.status === 'done' && x.stopReason !== 'cancelled'; }, 120000, 1000);
    ok(true, 'follow-up after interrupt reached done');
  });

  // f. persistence + resume
  await soft('f resume', async () => {
    const { execSync } = await import('node:child_process');
    execSync("ssh -o BatchMode=yes eva-forge 'systemctl --user restart tower.service'", { stdio: 'inherit' });
    await until(async () => { try { return (await fetch(`${BASE}/api/state`, { headers: H })).ok; } catch { return false; } }, 60000, 1000);
    await wp.close();
    wp = await wctx.newPage();
    wire(wp);
    await wp.goto(`${BASE}/?token=${TOKEN}`);
    await wp.waitForSelector('.topbar .cap', { timeout: 15000 });
    const st = await getState();
    const mine = st.agents.filter((x) => launched.includes(x.id));
    ok(mine.length === launched.length, `persisted cards present (${mine.length}/${launched.length})`);
    ok(mine.every((x) => x.status === 'stopped' && x.resumable), 'all persisted cards stopped + resumable');
    await wp.locator(`.card`, { hasText: (await agentById(devinId)).name }).first().click();
    await wp.waitForSelector('.panel .composer-resume button', { timeout: 8000 });
    await shot(wp, 'livea-resume-before');
    await wp.locator('.panel .composer-resume button', { hasText: 'Resume' }).click();
    await until(async () => (await agentById(devinId))?.status === 'done', 120000, 1000);
    ok(true, 'Resume -> done');
    await wp.locator('.panel .composer textarea').fill('What file did you create?');
    await wp.locator('.panel .composer textarea').press('Enter');
    await until(async () => {
      const b = wp.locator('.inbox-row .perm-actions button.btn-primary').first();
      if (await b.count()) await b.click().catch(() => {});
      const a = await agentById(devinId);
      return a?.status === 'done' && (await wp.locator('.panel .f-user').count()) >= 3;
    }, 120000, 1500);
    const last = await wp.locator('.panel .f-agent').last().innerText();
    ok(/plan\.md/i.test(last), `resumed agent remembers file: "${last.slice(0, 80)}"`);
    await shot(wp, 'livea-resumed');
  });

  // g. remove via ⋯
  await soft('g remove', async () => {
    const id = intId ?? launched[launched.length - 1];
    const name = (await agentById(id)).name;
    await wp.locator('.card', { hasText: name }).first().click();
    await wp.waitForSelector('.panel');
    wp.once('dialog', (d) => d.accept());
    await wp.locator('.panel button[aria-label="More"]').click();
    await wp.locator('.more-menu button', { hasText: 'Remove card' }).click();
    await until(async () => !(await agentById(id)), 15000, 500);
    await wp.waitForTimeout(500);
    ok((await wp.locator('.card', { hasText: name }).count()) === 0, 'card removed from board and state');
    launched.splice(launched.indexOf(id), 1);
  });

  // h. phone
  await soft('h phone', async () => {
    const pc = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    const pp = await pc.newPage();
    wire(pp);
    await pp.goto(`${BASE}/?token=${TOKEN}`);
    await pp.waitForSelector('.tabs', { timeout: 15000 });
    await pp.waitForTimeout(1000);
    ok(await pp.evaluate(() => document.documentElement.scrollWidth <= 390), 'phone board no horizontal overflow');
    await shot(pp, 'livea-phone-board');
    await pp.locator('.tab', { hasText: 'Done' }).click();
    await pp.locator('.board .card:visible').first().click();
    await pp.waitForSelector('.panel', { timeout: 8000 });
    await pp.waitForTimeout(600);
    const box = await pp.locator('.panel .panel-row').boundingBox();
    const x = await pp.locator('.panel button[aria-label="Close"]').boundingBox();
    ok(x.y < box.y + 40, 'close ✕ on first header line');
    ok(await pp.evaluate(() => document.documentElement.scrollWidth <= 390), 'phone sheet no horizontal overflow');
    await shot(pp, 'livea-phone-sheet');
    await pc.close();
  });

  // cleanup: remove every agent launched here
  for (const id of launched) await fetch(`${BASE}/api/agents/${id}`, { method: 'DELETE', headers: H }).catch(() => {});
  await wctx.close();
  console.log(`wave A soft failures: ${softFails.length}`, softFails);
  if (softFails.length) process.exitCode = 1;
} finally {
  await browser.close();
}

console.log(`checks passed: ${checks}`);
console.log(`console errors: ${errors.length}`, errors);
console.log(`failed requests: ${failed.length}`, failed);
if (errors.length || failed.length || process.exitCode) process.exit(1);
console.log('VERIFY LIVE OK');
