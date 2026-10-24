// Focused check of the workspace polish in mock mode: tmux draft clearing, stale older-page recovery,
// late pagination, Markdown tables, "Files & links", demo-mode hiding, phone Send alignment, Back focus.
// Serves web/dist with Vite spawned directly (no npx), so kill() stops the actual preview process.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, '..');
const out = path.join(here, 'out', 'workspace-polish');
mkdirSync(out, { recursive: true });

const port = await new Promise((res) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => res(p));
  });
});
const server = spawn(process.execPath, [path.join(webDir, 'node_modules/vite/bin/vite.js'), 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: webDir, stdio: ['ignore', 'ignore', 'inherit'] });
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
const open = async (viewport, colorScheme, storage = {}, extra = {}) => {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, colorScheme, ...extra });
  await ctx.addInitScript((kv) => {
    for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v);
  }, storage);
  const page = await ctx.newPage();
  wire(page);
  return { ctx, page };
};
const sendViaConfirm = async (page, text) => {
  const ta = page.locator('.ws .tmux-input');
  await ta.fill(text);
  await ta.press('Enter');
  await page.locator('.ws .tmux-confirm button', { hasText: 'Send' }).click();
};

try {
  // ---------- desktop light: table, files & links, whitespace send, Back focus ----------
  console.log('desktop 1440x900 light');
  {
    const { ctx, page } = await open({ width: 1440, height: 900 }, 'light');
    await page.goto(`${base}/?mock=1`);
    await page.waitForSelector('.col .card');
    await page.locator('[data-card-id="t3w5"] .card').click();
    await page.waitForSelector('.ws .md-table');
    const table = page.locator('.ws .md-table').first();
    ok((await table.locator('thead th').count()) === 4, 'table renders 4 header cells');
    ok((await table.locator('tbody tr').count()) === 4, 'table renders 4 body rows');
    ok((await table.locator('thead th').nth(1).evaluate((el) => el.style.textAlign)) === 'right', 'delimiter alignment applies (Events right-aligned)');
    ok((await table.locator('tbody tr').nth(1).locator('code').innerText()) === 'customer | null', 'escaped pipe stays inside the code cell');
    ok((await table.locator('a[href^="https://dashboard.stripe.com"]').count()) === 1, 'safe link in a cell is a link');
    ok((await table.locator('a[href^="javascript"]').count()) === 0, 'javascript: link is not rendered as a link');
    ok((await table.locator('script').count()) === 0 && (await table.innerText()).includes('<script>alert(1)</script>'), 'raw HTML in a cell stays text');
    await table.scrollIntoViewIfNeeded();
    await shot(page, 'desktop-light-table');

    // whitespace around the text: the confirmed send goes out trimmed and the composer clears
    await sendViaConfirm(page, '  composer check  ');
    await page.waitForFunction(() => document.querySelector('.ws .tmux-input')?.value === '');
    ok((await page.locator('.ws .tmux-input').inputValue()) === '', 'successful send of "  composer check  " clears the composer');
    ok((await page.locator('.ws .ws-send-err').count()) === 0, 'no send error after a successful send');
    await page.locator('.ws button[aria-label^="Next session"]').click();
    await page.waitForFunction(() => !location.hash.endsWith('/session/t3w5'));
    await page.locator('.ws button[aria-label^="Previous session"]').click();
    await page.waitForFunction(() => location.hash.endsWith('/session/t3w5'));
    await page.waitForSelector('.ws .tmux-input');
    ok((await page.locator('.ws .tmux-input').inputValue()) === '', 'sent draft does not come back after switching sessions');

    // Back returns focus to the card that was open
    await page.locator('.ws button[aria-label="Back to board"]').click();
    await page.waitForSelector('.ws', { state: 'detached' });
    await page.waitForTimeout(100);
    ok(await page.evaluate(() => !!document.activeElement?.closest('[data-card-id="t3w5"]')), 'Back focuses the card that was open');

    // read-only session with a same-origin file link
    await page.goto(`${base}/?mock=1#/board/programs/session/t2y4`);
    await page.waitForSelector('.ws .ws-convo .f-agent');
    const sec = page.locator('.ws-aside .ws-sec', { has: page.locator('.ws-sec-title', { hasText: 'Files & links' }) });
    ok((await sec.count()) === 1, 'context section is labeled "Files & links"');
    ok((await sec.locator('a[href="/files/review-lane/review-report.md"]').count()) === 1, 'same-origin file link is clickable');
    ok((await sec.locator('a').count()) === 2, 'both links render');
    await shot(page, 'desktop-light-files-links');
    await ctx.close();
  }

  // ---------- desktop dark: late pagination, stale older page, failed send keeps the draft ----------
  console.log('desktop 1440x900 dark (late-history, stale-older, send-fail)');
  {
    const { ctx, page } = await open({ width: 1440, height: 900 }, 'dark', { 'tower.mock.ws': 'late-history,stale-older,send-fail' });
    await page.goto(`${base}/?mock=1#/board/programs/session/t3w5`);
    await page.waitForSelector('.ws .ws-tab');
    await page.locator('.ws .ws-tab', { hasText: 'Conversation' }).click();
    await page.waitForSelector('.ws .ws-notice h3:has-text("No conversation history")');
    ok(true, 'first latest response without history shows the unavailable state');
    await page.waitForSelector('.ws .ws-convo .f-agent', { timeout: 15000 });
    await page.waitForSelector('.ws .ws-older-btn');
    ok(true, 'history that arrives later gets "Load earlier messages" (cursor set on the first available page)');
    const before = await page.locator('.ws .ws-convo .f-agent').count();
    await page.locator('.ws .ws-older-btn').click();
    await page.waitForSelector('.ws .ws-gone');
    ok((await page.locator('.ws .ws-gone').innerText()).includes('The transcript was rotated'), 'stale older page shows its reason');
    ok((await page.locator('.ws .ws-older-btn').count()) === 0, 'no "Load earlier" button while the cursor is stale');
    ok((await page.locator('.ws .ws-convo .f-agent').count()) === before, 'visible history is kept, nothing silently dropped');
    await shot(page, 'desktop-dark-stale-older');
    await page.locator('.ws .ws-gone button', { hasText: 'Reload latest' }).click();
    await page.waitForSelector('.ws .ws-gone', { state: 'detached' });
    await page.waitForSelector('.ws .ws-older-btn');
    ok(true, 'Reload latest clears the notice and restores paging from the newest page');

    const failText = ' [fail] keep this draft ';
    await sendViaConfirm(page, failText);
    await page.waitForSelector('.ws .ws-send-err');
    ok((await page.locator('.ws .ws-send-err').innerText()).includes('Not sent: The session did not accept input'), 'failed send shows the reason');
    ok((await page.locator('.ws .tmux-input').inputValue()) === failText, 'failed send keeps the exact draft');
    await shot(page, 'desktop-dark-send-failed');
    await ctx.close();
  }

  // ---------- demo mode: nothing behind the masked name ----------
  console.log('desktop 1440x900 light, demo mode');
  {
    const { ctx, page } = await open({ width: 1440, height: 900 }, 'light', { 'tower.demo': '1' });
    await page.goto(`${base}/?mock=1#/board/programs/session/t3w5`);
    await page.waitForSelector('.ws .ws-hidden');
    await page.waitForTimeout(800);
    const text = await page.locator('.ws').innerText();
    ok((await page.locator('.ws .ws-name').innerText()).includes('session'), 'name is masked');
    ok((await page.locator('.ws .ws-hidden h3').innerText()) === 'Details hidden in demo mode', 'hidden-details state is shown');
    ok(!/Stripe|billing|webhook|eva-forge|\.desk/i.test(text), 'no history, context, folder or screen text leaks');
    ok((await page.locator('.ws .ws-tab, .ws .tmux-screen, .ws .ws-convo, .ws .tmux-input').count()) === 0, 'no conversation, terminal or composer is mounted');
    ok((await page.locator('.ws .ws-foot-note').innerText()).includes('Sending is off in demo mode'), 'send is disabled in demo mode');
    await shot(page, 'desktop-light-demo-hidden');
    await ctx.close();
  }

  // ---------- phone dark: table scrolls inside the message, Send on the right ----------
  console.log('phone 390x844 dark');
  {
    const { ctx, page } = await open({ width: 390, height: 844 }, 'dark', {}, { isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
    await page.goto(`${base}/?mock=1#/board/programs/session/t3w5`);
    await page.waitForSelector('.ws .md-table');
    const wrap = page.locator('.ws .md-table-wrap').first();
    await wrap.scrollIntoViewIfNeeded();
    const m = await wrap.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, right: el.getBoundingClientRect().right }));
    ok(m.sw > m.cw, `phone table scrolls horizontally inside the message (${m.sw} > ${m.cw})`);
    ok(m.right <= 390, `phone table stays inside the viewport (right ${Math.round(m.right)})`);
    const sw = await page.evaluate(() => document.documentElement.scrollWidth);
    ok(sw <= 390, `phone: no page overflow (${sw})`);
    await page.locator('.ws .tmux-input').fill('hi');
    const send = await page.locator('.ws .c-send').boundingBox();
    const box = await page.locator('.ws .tmux-composer').boundingBox();
    ok(box.x + box.width - (send.x + send.width) < 16, `phone Send sits on the right (gap ${Math.round(box.x + box.width - (send.x + send.width))}px)`);
    await shot(page, 'phone-dark-table');
    await wrap.evaluate((el) => (el.scrollLeft = el.scrollWidth));
    await shot(page, 'phone-dark-table-scrolled');
    await ctx.close();
  }
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
