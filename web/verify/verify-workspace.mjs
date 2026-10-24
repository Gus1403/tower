// Headless verification of the session workspace in mock mode. Serves web/dist via `vite preview`.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, '..');
const out = path.join(here, 'out', 'workspace');
mkdirSync(out, { recursive: true });

const port = await new Promise((res) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => res(p));
  });
});
const server = spawn(process.execPath, [path.join(webDir, 'node_modules/vite/bin/vite.js'), 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: webDir, stdio: ['ignore', 'pipe', 'pipe'] });
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
const browser = await chromium.launch();
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
const visible = (page, sel) => page.locator(sel).first().isVisible();

try {
  // ---------- desktop, light ----------
  console.log('desktop 1440x700 light');
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 700 }, deviceScaleFactor: 2, colorScheme: 'light' });
  const page = await ctx.newPage();
  wire(page);
  await page.goto(`${base}/?mock=1`);
  await page.waitForSelector('.col .card');
  await page.waitForTimeout(600);

  // board state to preserve: a search filter and a scroll position
  await page.locator('.search-desk input').fill('e');
  await page.waitForTimeout(150);
  await page.evaluate(() => window.scrollTo(0, 120));
  const scrollBefore = await page.evaluate(() => window.scrollY);

  await page.locator('[data-card-id="a1d3"] .card').click();
  await page.waitForSelector('.ws .f-tool');
  ok(await visible(page, '.ws'), 'ACP session opens the full-page workspace');
  ok(!(await page.locator('.board-view').isVisible()), 'board is hidden while the workspace is open');
  ok((await page.locator('.board-view[inert]').count()) === 1, 'hidden board is inert');
  ok((await page.locator('.ws .ws-name').innerText()) === 'api-routes', 'header shows the session name');
  ok((await page.locator('.ws .ws-tab').count()) === 0, 'ACP session has no terminal tab');
  ok((await page.locator('.ws .ws-aside .plan li').count()) === 5, 'context shows the plan');
  ok((await page.locator('.ws select.sel-mode').count()) === 1, 'mode selector is kept');
  ok((await page.locator('.ws .ctx-label').innerText()).includes('% context'), 'context usage is kept');
  ok(page.url().includes('/session/a1d3'), 'URL hash names the open session');
  const proseSize = await page.locator('.ws .f-agent').first().evaluate((el) => getComputedStyle(el).fontSize);
  ok(proseSize === '15px', `agent prose is 15px (${proseSize})`);
  const colW = await page.locator('.ws .ws-convo .ws-col').evaluate((el) => el.getBoundingClientRect().width);
  ok(colW <= 900 && colW > 700, `reading column is capped near 900px (${Math.round(colW)})`);
  await page.waitForTimeout(1500);
  await shot(page, 'desktop-light-acp');

  // per-session drafts: type, switch, come back
  const ta = page.locator('.ws .composer textarea');
  await ta.fill('draft for api-routes');
  await page.locator('.ws button[aria-label^="Next session"]').click();
  await page.waitForFunction(() => !location.hash.includes('/session/a1d3'));
  const otherId = await page.evaluate(() => /\/session\/([^/]+)$/.exec(location.hash)?.[1]);
  const otherVal = await page.locator('.ws textarea').first().inputValue();
  ok(otherVal === '', `next session (${otherId}) starts with its own empty draft`);
  await page.locator('.ws button[aria-label^="Previous session"]').click();
  await page.waitForFunction(() => location.hash.endsWith('/session/a1d3'));
  ok((await page.locator('.ws .composer textarea').inputValue()) === 'draft for api-routes', 'draft comes back when returning to the session');
  await ta.fill('');

  // browser Back returns to the board with filter + scroll intact
  await page.goBack();
  await page.waitForSelector('.ws', { state: 'detached' });
  ok(await page.locator('.board-view').isVisible(), 'browser Back returns to the board');
  ok((await page.locator('.search-desk input').inputValue()) === 'e', 'board search filter is preserved');
  const scrollAfter = await page.evaluate(() => window.scrollY);
  // live cards keep moving in the mock, and scroll anchoring follows them; the check is that the board did not reset
  ok(scrollBefore > 0 && scrollAfter > 0, `board scroll is kept, not reset (${scrollBefore} → ${scrollAfter})`);
  await page.locator('.search-desk input').fill('');

  // Enter sends, Shift+Enter adds a line (done agent)
  await page.locator('.card', { hasText: 'docs' }).first().click();
  await page.waitForSelector('.ws .f-agent');
  await ta.click();
  await page.keyboard.type('first line');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('second line');
  ok((await ta.inputValue()) === 'first line\nsecond line', 'Shift+Enter inserts a new line');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.ws .bubble:has-text("second line")');
  ok((await ta.inputValue()) === '', 'Enter sends and clears the composer');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.ws', { state: 'detached' });
  ok(!page.url().includes('/session/'), 'Escape closes the workspace and clears the session from the URL');

  // observed tmux session with saved conversation
  await page.locator('[data-card-id="t3w5"] .card').click();
  await page.waitForSelector('.ws .ws-tab');
  await page.waitForSelector('.ws .ws-convo .f-agent');
  ok((await page.locator('.ws .ws-tab.on').innerText()).startsWith('Conversation'), 'tmux session opens on Conversation when history exists');
  ok((await page.locator('.ws .ws-tab').count()) === 2, 'Conversation and Terminal tabs');
  ok((await page.locator('.ws-aside .ws-pending li').count()) === 2, 'context lists pending decisions');
  ok((await page.locator('.ws-aside').textContent()).includes('Latest delivery'), 'context shows latest delivery');
  ok((await page.locator('.ws-aside .ws-links a').count()) === 2, 'context shows links');
  const countBefore = await page.locator('.ws .ws-convo .f-agent').count();
  const convo = page.locator('.ws .ws-convo');
  ok((await convo.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)) < 5, 'conversation starts at the newest message');
  await shot(page, 'desktop-light-tmux-conversation');
  // load older without jumping: the first visible message keeps its screen position
  // scrolling near the top loads the previous page; measure a visible message right after the scroll
  const anchorId = await page.evaluate(() => {
    const el = document.querySelector('.ws .ws-convo');
    el.scrollTop = 30;
    const box = el.getBoundingClientRect();
    const r = [...el.querySelectorAll('.f-agent')].find((x) => x.getBoundingClientRect().top >= box.top);
    r.setAttribute('data-anchor', '1');
    return r.getBoundingClientRect().top;
  });
  await page.waitForFunction((n) => document.querySelectorAll('.ws .ws-convo .f-agent').length > n, countBefore);
  const anchorAfter = await page.locator('[data-anchor="1"]').evaluate((el) => el.getBoundingClientRect().top);
  ok(Math.abs(anchorAfter - anchorId) < 4, `older messages load without moving the reader (${Math.round(anchorId)} → ${Math.round(anchorAfter)})`);
  ok((await page.locator('.ws .ws-convo .f-agent').count()) > countBefore, 'older messages were prepended');
  // tool rows expand
  await page.locator('.ws .ws-convo button.f-tool').last().click();
  await page.waitForSelector('.ws .f-tool-out pre');
  ok(true, 'tool row expands');

  // terminal tab
  await page.locator('.ws .ws-tab', { hasText: 'Terminal' }).click();
  await page.waitForFunction(() => document.querySelector('.ws .tmux-screen')?.textContent?.includes('Claude Code'));
  ok((await page.locator('.ws .tmux-key').count()) === 6, 'terminal shows the 6 key buttons');
  const pre = page.locator('.ws .tmux-screen');
  ok((await pre.evaluate((el) => getComputedStyle(el).whiteSpace)) === 'pre', 'terminal keeps original width by default on desktop');
  ok((await pre.evaluate((el) => el.scrollWidth > el.clientWidth)), 'long lines scroll horizontally at original width');
  await page.locator('.ws .ws-chip').click();
  ok((await pre.evaluate((el) => getComputedStyle(el).whiteSpace)) === 'pre-wrap', 'wrap toggle soft-wraps lines');
  const preBox = await pre.boundingBox();
  ok(preBox.height < 700 && preBox.width > 1000, `terminal is wide and bounded in the viewport (${Math.round(preBox.width)}×${Math.round(preBox.height)})`);
  await shot(page, 'desktop-light-tmux-terminal');
  // guarded send: confirm appears, and switching session clears it
  const tin = page.locator('.ws .tmux-input');
  await tin.fill('status please');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.ws .tmux-confirm');
  ok((await page.locator('.tmux-confirm').textContent()).includes('This types into a live session. Send?'), 'send into tmux still asks to confirm');
  await shot(page, 'desktop-light-tmux-confirm');
  await page.locator('.tmux-confirm .btn-primary').click();
  await page.waitForFunction(() => document.querySelector('.ws .tmux-screen')?.textContent?.includes('> status please'));
  ok((await tin.inputValue()) === '', 'confirmed send reaches the screen and clears the composer');
  await tin.fill('pending text');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.ws .tmux-confirm');
  await page.locator('.ws button[aria-label^="Next session"]').click();
  await page.waitForFunction(() => !location.hash.endsWith('/session/t3w5'));
  ok((await page.locator('.tmux-confirm').count()) === 0, 'switching sessions clears the pending confirmation');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.ws', { state: 'detached' });

  // observed tmux session without saved history: terminal is the fallback, never a fake chat
  await page.locator('.observed-toggle').first().click();
  await page.locator('[data-card-id="t1x9"] .card').click();
  await page.waitForSelector('.ws .tmux-screen');
  ok((await page.locator('.ws .ws-tab.on').innerText()).startsWith('Terminal'), 'no history: opens on Terminal');
  ok((await page.locator('.ws .ws-tab', { hasText: 'Conversation' }).innerText()).includes('unavailable'), 'Conversation tab says unavailable');
  await page.locator('.ws .ws-tab', { hasText: 'Conversation' }).click();
  ok((await page.locator('.ws .ws-notice h3').innerText()).includes('No conversation history'), 'Conversation explains there is no history');
  ok((await page.locator('.ws .ws-convo .f-agent').count()) === 0, 'terminal text is not turned into chat messages');
  await shot(page, 'desktop-light-tmux-unavailable');
  await page.keyboard.press('Escape');

  // read-only observed session: history shown, terminal explicitly off, composer read-only
  await page.locator('[data-card-id="t2y4"] .card').click();
  await page.waitForSelector('.ws .ws-convo .f-agent');
  ok((await page.locator('.ws .ws-foot-note').innerText()).includes('Read-only'), 'read-only session has no input');
  await page.locator('.ws .ws-tab', { hasText: 'Terminal' }).click();
  ok((await page.locator('.ws .ws-notice h3').innerText()).includes('Terminal view is off'), 'read-only terminal tab explains it is off');
  await page.keyboard.press('Escape');
  await ctx.close();

  // ---------- desktop, dark ----------
  console.log('desktop 1440x900 dark');
  const dctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'dark' });
  const d = await dctx.newPage();
  wire(d);
  await d.goto(`${base}/?mock=1#/board/programs/session/t3w5`);
  await d.waitForSelector('.ws .ws-convo .f-agent');
  ok(true, 'deep link to a session opens it on load');
  await d.waitForTimeout(500);
  await shot(d, 'desktop-dark-tmux-conversation');
  await d.locator('.ws .ws-tab', { hasText: 'Terminal' }).click();
  await d.waitForFunction(() => document.querySelector('.ws .tmux-screen')?.textContent?.includes('Claude Code'));
  await shot(d, 'desktop-dark-tmux-terminal');
  await d.locator('.ws button[aria-label="Back to board"]').click();
  await d.locator('.card', { hasText: 'landing-page' }).first().click();
  await d.waitForSelector('.ws .panel-perm');
  await d.waitForTimeout(400);
  await shot(d, 'desktop-dark-acp-permission');
  await dctx.close();

  // ---------- phone ----------
  console.log('phone 390x844');
  const pctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: 'light' });
  const p = await pctx.newPage();
  wire(p);
  await p.goto(`${base}/?mock=1`);
  await p.waitForSelector('.tabs');
  await p.waitForTimeout(500);
  await p.locator('.card', { hasText: 'refactor-auth' }).click();
  await p.waitForSelector('.ws .f-tool');
  ok(await p.locator('.ws button[aria-label="Back to board"]').isVisible(), 'phone: Back is visible');
  ok(!(await p.locator('.ws-aside').isVisible()), 'phone: context is collapsed by default');
  let sw = await p.evaluate(() => document.documentElement.scrollWidth);
  ok(sw <= 390, `phone: no horizontal overflow (${sw})`);
  await p.waitForTimeout(800);
  await shot(p, 'phone-light-acp');
  await p.locator('.ws .ws-ctx-btn').click();
  ok(await p.locator('.ws-aside').isVisible(), 'phone: context opens in place');
  ok(await p.locator('.ws button[aria-label="Back to board"]').isVisible(), 'phone: Back stays reachable with context open');
  await shot(p, 'phone-light-context');
  await p.locator('.ws .ws-ctx-btn').click();
  await p.locator('.ws button[aria-label="Back to board"]').click();
  await p.waitForSelector('.ws', { state: 'detached' });
  await p.locator('[data-card-id="t3w5"] .card').click();
  await p.waitForSelector('.ws .ws-convo .f-agent');
  await shot(p, 'phone-light-tmux-conversation');
  await p.locator('.ws .ws-tab', { hasText: 'Terminal' }).click();
  await p.waitForFunction(() => document.querySelector('.ws .tmux-screen')?.textContent?.includes('Claude Code'));
  sw = await p.evaluate(() => document.documentElement.scrollWidth);
  ok(sw <= 390, `phone terminal: no page overflow (${sw})`);
  await shot(p, 'phone-light-tmux-terminal');
  await pctx.close();

  const dp = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: 'dark' })).newPage();
  wire(dp);
  await dp.goto(`${base}/?mock=1#/board/programs/session/c9p4`);
  await dp.waitForSelector('.ws .q-row');
  await dp.waitForTimeout(500);
  await shot(dp, 'phone-dark-acp-question');
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
