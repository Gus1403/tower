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
  ok((await page.locator('.cap:not(.cap-off)').count()) === 3, 'three capacity chips show available');
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
} finally {
  await browser.close();
}

console.log(`checks passed: ${checks}`);
console.log(`console errors: ${errors.length}`, errors);
console.log(`failed requests: ${failed.length}`, failed);
if (errors.length || failed.length) process.exit(1);
console.log('VERIFY LIVE OK');
