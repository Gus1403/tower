// Headless verification of the Tower web UI in mock mode. Serves web/dist via `vite preview`.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, '..');
const out = path.join(here, 'out');
mkdirSync(out, { recursive: true });

const port = await new Promise((res) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => res(p));
  });
});

const server = spawn('npx', ['vite', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: webDir,
  stdio: ['ignore', 'pipe', 'pipe'],
});
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(base)).ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 150));
}

const errors = [];
const failed = [];
const apiHits = [];
let checks = 0;
const ok = (cond, msg) => {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  checks++;
  console.log(`  ✓ ${msg}`);
};

// Prefer the bundled browser; fall back to an already-cached headless shell (no download needed).
import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
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
  page.on('request', (r) => new URL(r.url()).pathname.startsWith('/api') && apiHits.push(r.url()));
  page.on('response', (r) => r.status() >= 400 && failed.push(`${r.url()} ${r.status()}`));
};
const shot = async (page, name) => {
  const f = path.join(out, `${name}.png`);
  await page.screenshot({ path: f });
  console.log(`  ▣ ${f}`);
};

try {
  // ---------- desktop ----------
  console.log('desktop 1440x900');
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  wire(page);
  await page.goto(`${base}/?mock=1`);
  await page.waitForSelector('.inbox:not([hidden]) .inbox-row');
  await page.waitForTimeout(1500);
  ok(await page.locator('.col-working .card').count() >= 2, 'working column has cards');
  ok((await page.locator('.inbox-row').count()) === 1, 'needs-you inbox shows 1 row');
  ok((await page.locator('.inbox-row').innerText()).includes('npm install vite@5.4.10'), 'inbox row shows the command detail');
  await shot(page, 'a-desktop-board');

  // allow once from inbox
  await page.locator('.inbox-row button', { hasText: 'Allow once' }).click();
  await page.waitForTimeout(50);
  ok(await page.locator('.inbox').isHidden(), 'inbox row disappears after Allow once');
  ok((await page.locator('.col-needs .card', { hasText: 'landing-page' }).count()) === 0, 'landing-page left the needs-you column');
  await page.waitForTimeout(800);
  ok((await page.locator('.col-working .card', { hasText: 'landing-page' }).count()) === 1, 'landing-page moved to Working');

  // open a panel with plan + tool calls
  await page.locator('.card', { hasText: 'api-routes' }).click();
  await page.waitForSelector('.panel .f-tool');
  await page.waitForTimeout(2600);
  ok((await page.locator('.panel .plan li').count()) === 5, 'panel shows the plan checklist');
  ok((await page.locator('.panel .f-tool').count()) >= 5, 'panel feed shows tool calls');
  ok(!(await page.locator('.panel .composer textarea').isDisabled()), 'composer enabled while working');
  ok((await page.locator('.panel .composer button', { hasText: 'Queue' }).count()) === 1, 'composer shows Queue while working');
  // change mode
  await page.locator('.panel select.sel-mode').selectOption('plan');
  await page.waitForTimeout(200);
  ok((await page.locator('.panel select.sel-mode').inputValue()) === 'plan', 'mode select changes mode');
  ok((await page.locator('.panel .ctx-label').innerText()).includes('% context'), 'context bar shows % context');
  // expand a tool call
  await page.locator('.panel button.f-tool').first().click();
  await page.waitForSelector('.panel .f-tool-out pre');
  ok((await page.locator('.panel .f-tool-out pre').first().innerText()).length > 0, 'tool call expands to show output');
  await shot(page, 'b-desktop-panel');
  await shot(page, 'wa-desktop-panel');

  // stop it, then prompt
  await page.locator('.panel button', { hasText: 'Stop' }).click();
  await page.waitForSelector('.panel .status-stopped');
  ok(true, 'Stop moves the agent to stopped');
  await page.keyboard.press('Escape');

  // docs (done) accepts a prompt
  await page.locator('.card', { hasText: 'docs' }).first().click();
  await page.waitForSelector('.panel .f-agent');
  await page.locator('.panel .composer textarea').fill('Add a troubleshooting section');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.panel .status-working');
  ok((await page.locator('.panel .bubble', { hasText: 'troubleshooting' }).count()) === 1, 'prompt shows as user bubble and agent goes working');
  // queue while working
  await page.locator('.panel .composer textarea').fill('Also add an FAQ');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.panel .qchip', { timeout: 1000 });
  ok((await page.locator('.panel .qchip', { hasText: 'FAQ' }).count()) === 1, 'queued chip appears while working');
  await shot(page, 'wa-desktop-queued');
  await page.waitForSelector('.panel .qchip', { state: 'detached', timeout: 30000 });
  await page.waitForSelector('.panel .bubble:has-text("Also add an FAQ")', { timeout: 3000 });
  ok(true, 'after the turn ends the chip disappears and a user bubble shows');
  await page.keyboard.press('Escape');

  // new agent dialog + launch
  await page.locator('.new-btn').click();
  await page.waitForSelector('.dialog');
  await page.locator('.segmented button', { hasText: 'Codex' }).click();
  await page.locator('.dialog textarea').fill('Add dark mode to the settings page and persist the choice');
  await page.locator('.dialog input').fill('dark-mode');
  await page.waitForTimeout(300);
  await shot(page, 'c-desktop-new-agent');
  await page.locator('.dialog button', { hasText: 'Launch' }).click();
  await page.waitForSelector('.panel .panel-name:has-text("dark-mode")');
  await page.waitForSelector('.panel .status-working', { timeout: 4000 });
  ok(true, 'launch opens the new agent panel and it starts working');
  await page.waitForTimeout(2500);
  await shot(page, 'b2-desktop-launched');
  await ctx.close();

  // ---------- phone ----------
  console.log('phone 390x844');
  const pctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const p = await pctx.newPage();
  wire(p);
  await p.goto(`${base}/?mock=1`);
  await p.waitForSelector('.inbox-row');
  await p.waitForTimeout(1200);
  ok(await p.locator('.tabs').isVisible(), 'phone shows tabs');
  ok((await p.locator('.tab.on').innerText()).startsWith('Needs you'), 'Needs you tab is first and selected');
  await shot(p, 'd-phone-board');
  await p.locator('.tab', { hasText: 'Working' }).click();
  await shot(p, 'd2-phone-working');
  await p.locator('.card', { hasText: 'refactor-auth' }).click();
  await p.waitForSelector('.panel .f-tool');
  await p.waitForTimeout(2000);
  await shot(p, 'e-phone-sheet');
  await p.locator('.panel .composer textarea').fill('Queue this on the phone please');
  await p.keyboard.press('Enter');
  await p.waitForSelector('.panel .qchip');
  await shot(p, 'wa-phone-panel');
  await pctx.close();

  // ---------- Wave B (wb2): questions, "/" menu, attachments, move ----------
  console.log('wave B desktop 1440x900');
  const bctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const b = await bctx.newPage();
  wire(b);
  await b.goto(`${base}/?mock=1`);
  await b.waitForSelector('.card');
  await b.waitForTimeout(800);
  const inInbox = (await b.locator('.qinbox .q-row').count()) > 0;
  console.log(`  (QuestionsInbox mounted in App: ${inInbox})`);
  await b.locator('.card', { hasText: 'fix-tests' }).click();
  await b.waitForSelector('.panel .q-row');
  await b.waitForTimeout(400);
  await shot(b, 'wb2-desktop-question');
  const qscope = inInbox ? '.qinbox' : '.panel';
  await b.locator(`${qscope} .q-use`).first().click();
  ok((await b.locator(`${qscope} .q-input`).first().inputValue()).startsWith('Make the backoff injectable'), 'Use recommendation fills the answer');
  await b.locator(`${qscope} .q-input`).first().press('Enter');
  await b.waitForSelector('.q-row', { state: 'detached', timeout: 1500 });
  ok((await b.locator('.q-row').count()) === 0, 'answered question row disappears');
  await b.waitForSelector('.panel .bubble:has-text("[Answer to")', { timeout: 3000 });
  ok(true, 'answer is delivered as a prompt');

  // "/" menu on the same (now working) agent
  const ta = b.locator('.panel .composer textarea');
  await ta.click();
  await ta.type('/');
  await b.waitForSelector('.panel .slash-menu');
  ok((await b.locator('.panel .slash-item').count()) >= 3, '"/" opens the commands menu');
  await ta.type('re');
  ok((await b.locator('.panel .slash-item').count()) === 1, 'menu filters as you type');
  await ta.press('Backspace');
  await ta.press('Backspace');
  await ta.press('ArrowDown');
  ok((await b.locator('.panel .slash-item.on .slash-name').innerText()) === '/review', 'ArrowDown moves the selection');
  await shot(b, 'wb2-desktop-slash');
  await ta.press('Enter');
  ok((await ta.inputValue()) === '/review ', 'Enter inserts "/review "');
  ok((await b.locator('.panel .slash-menu').count()) === 0, 'menu closes after insert');
  await ta.fill('');
  await b.keyboard.press('Escape');

  // attachment on a done agent
  await b.locator('.card', { hasText: 'docs' }).first().click();
  await b.waitForSelector('.panel .f-agent');
  await b.locator('.panel input.c-file').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello tower') });
  await b.waitForSelector('.panel .att-chip.ok');
  ok((await b.locator('.panel .att-chip').innerText()).includes('notes.txt'), 'attachment chip appears');
  await b.locator('.panel .composer textarea').fill('Use the attached notes');
  await shot(b, 'wb2-desktop-attach');
  await b.locator('.panel .composer textarea').press('Enter');
  await b.waitForSelector('.panel .bubble:has-text("Attached: attachments/notes.txt")', { timeout: 3000 });
  ok((await b.locator('.panel .att-chip').count()) === 0, 'attachment is sent with the prompt and the chip clears');
  await b.keyboard.press('Escape');

  // move flow
  await b.locator('.card', { hasText: 'migrate-db' }).first().click();
  await b.waitForSelector('.panel .limit-banner');
  ok((await b.locator('.panel .limit-text').innerText()).includes('hit its limit'), 'limit banner shows');
  await b.locator('.panel .limit-move').click();
  await b.waitForSelector('.panel .move-acc');
  ok((await b.locator('.panel .move-acc').count()) === 1, 'picker lists the other logged-in claude account only');
  await shot(b, 'wb2-desktop-move');
  await b.locator('.panel .move-acc', { hasText: 'claude-3' }).click();
  await b.waitForSelector('.panel .status-working', { timeout: 4000 });
  ok((await b.locator('.panel .limit-banner').count()) === 0, 'move opens the new agent panel (no limit banner)');
  ok((await b.locator('.panel .panel-name').innerText()) === 'migrate-db', 'new agent carries the same name');
  await b.waitForTimeout(1500);
  await shot(b, 'wb2-desktop-moved');
  await bctx.close();

  console.log('wave B phone 390x844');
  const bp = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true })).newPage();
  wire(bp);
  await bp.goto(`${base}/?mock=1`);
  await bp.waitForSelector('.tabs');
  await bp.waitForTimeout(800);
  await shot(bp, 'wb2-phone-board');
  await bp.locator('.tab', { hasText: 'Needs you' }).click();
  await bp.locator('.card', { hasText: 'fix-tests' }).click();
  await bp.waitForSelector('.panel .q-row');
  await bp.waitForTimeout(400);
  await shot(bp, 'wb2-phone-question');
  await bp.locator('.panel .composer textarea').fill('/');
  await bp.waitForSelector('.panel .slash-menu');
  await shot(bp, 'wb2-phone-slash');
  await bp.locator('.panel .composer textarea').fill('');
  await bp.locator('.panel input.c-file').setInputFiles({ name: 'screenshot-of-the-bug.png', mimeType: 'image/png', buffer: Buffer.from('png') });
  await bp.waitForSelector('.panel .att-chip.ok');
  await shot(bp, 'wb2-phone-attach');
  await bp.locator('.panel button[aria-label="Close"]').click();
  await bp.locator('.tab', { hasText: 'Done' }).click();
  await bp.locator('.card', { hasText: 'migrate-db' }).first().click();
  await bp.waitForSelector('.panel .limit-banner');
  await bp.locator('.panel .limit-move').click();
  await bp.waitForSelector('.panel .move-acc');
  await shot(bp, 'wb2-phone-move');
} finally {
  await browser.close();
  server.kill();
}

console.log(`checks passed: ${checks}`);
console.log(`console errors: ${errors.length}`, errors);
console.log(`failed requests: ${failed.length}`, failed);
console.log(`/api requests in mock mode: ${apiHits.length}`, apiHits);
if (errors.length || failed.length || apiHits.length) process.exit(1);
console.log('VERIFY OK');
