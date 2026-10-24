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
const cardsIn = (page, col) => page.locator(`.board[data-board] [data-col="${col}"] [data-card-id]`).evaluateAll((els) => els.map((e) => e.getAttribute('data-card-id')));

try {
  for (const scheme of ['light', 'dark']) {
    // ---------- desktop ----------
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: scheme });
    const page = await ctx.newPage();
    wire(page);
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(`${base}/?mock=1`);
    await page.waitForSelector('[data-board-tab="customers"]');
    const tabTxt = await page.locator('.wbd-tabs').innerText();
    ok(/Programs\s*\d+/.test(tabTxt) && /Customers\s*4/.test(tabTxt), `${scheme}: board tabs show counts (${tabTxt.replace(/\s+/g, ' ')})`);
    ok((await page.locator('.board[data-board="programs"] .col-notes').count()) > 0, `${scheme}: Notes column on Programs`);
    ok((await page.locator('[data-card-id="g4h2"] ').count()) === 1, `${scheme}: handoff program card on Programs`);
    ok((await page.locator('.wbd-for', { hasText: 'for acme-onboarding' }).count()) === 1, `${scheme}: "↳ for acme-onboarding" line on the program card`);
    if (scheme === 'light') await shot(page, 'wbd-desktop-programs');

    await page.locator('[data-board-tab="customers"]').click();
    await page.waitForSelector('.board[data-board="customers"]');
    ok(page.url().includes('#/board/customers'), `${scheme}: hash is #/board/customers`);
    ok((await page.evaluate(() => localStorage.getItem('tower.board'))) === 'customers', `${scheme}: active board in localStorage`);
    const heads = await page.locator('.board[data-board="customers"] .col-head').allInnerTexts();
    ok(heads.map((h) => h.replace(/\s*\d+$/, '').trim()).join('|') === 'Handling|Waiting on the customer|Asleep', `${scheme}: customer columns ${heads.map((h) => h.replace(/\s+/g, ' ')).join(' / ')}`);
    const h = await cardsIn(page, 'handling');
    ok(h.includes('k1a2') && h.includes('k3l5') && h.length === 2, `${scheme}: Handling = cust-acme + cust-lumen (${h})`);
    ok((await cardsIn(page, 'waiting')).join() === 'k2d7', `${scheme}: Waiting on the customer = cust-delta`);
    ok((await cardsIn(page, 'asleep')).join() === 'k4p9', `${scheme}: Asleep = cust-prisma`);
    ok((await page.locator('.wbd-card .wbd-cust', { hasText: 'cust-acme' }).count()) === 1, `${scheme}: customer shown as muted first line`);
    ok((await page.locator(".col-notes, .observed").count()) === 0, `${scheme}: no Notes / Observed on Customers`);
    await shot(page, `wbd-desktop-customers-${scheme}`);
    await page.reload();
    await page.waitForSelector('.board[data-board="customers"]');
    ok(true, `${scheme}: reload keeps Customers active`);

    if (scheme === 'light') {
      // handoff links: open the requester from the program card's line
      await page.locator('[data-board-tab="programs"]').click();
      await page.locator('.wbd-for', { hasText: 'for acme-onboarding' }).click();
      await page.waitForSelector('.panel .panel-name');
      ok((await page.locator('.panel .panel-name').innerText()).includes('acme-onboarding'), 'clicking "↳ for" opens the requester panel');
      const pl = await page.locator('.panel [data-testid="panel-links"]').count();
      if (pl) {
        ok((await page.locator('.panel [data-testid="panel-links"]').innerText()).includes('csv-export-accents'), 'panel lists Opened sessions');
        await shot(page, 'wbd-desktop-panel-links');
      } else console.log('  · PanelLinks not mounted in Panel.tsx yet (lead adds the JSX line); skipped');
      await page.keyboard.press('Escape');
      await page.locator('.panel button[aria-label="Close"]').first().click().catch(() => {});

      // create a board
      await page.locator('.wbd-tab-add').click();
      await page.locator('.dialog[aria-label="New board"] input').fill('Research');
      await page.locator('.dialog[aria-label="New board"] .btn-primary').click();
      await page.waitForSelector('[data-board-tab="research"].on');
      ok(page.url().includes('#/board/research'), 'new board created and active');
      ok((await page.locator('.board[data-board="research"] .col-head').count()) === 3, 'new board has 3 default columns');

      // launch onto Customers with a customer
      await page.locator('[data-board-tab="customers"]').click();
      await page.locator('.new-btn').first().click();
      await page.waitForSelector('.dialog[aria-label="New agent"]');
      ok((await page.locator('select[aria-label="Board"]').inputValue()) === 'customers', 'New agent board defaults to the active board');
      await page.locator('.dialog textarea').fill('Answer Nova Labs about their invoice');
      ok(await page.locator('.dialog[aria-label="New agent"] .btn-primary').isDisabled(), 'customer required on Customers board');
      await page.locator('input[aria-label="Customer"]').fill('cust-nova');
      await page.waitForTimeout(400);
      await shot(page, 'wbd-desktop-new-agent');
      await page.locator('.dialog[aria-label="New agent"] .btn-primary').click();
      await page.waitForSelector('.panel .panel-name');
      await page.locator('.panel button[aria-label="Close"]').first().click().catch(() => {});
      await page.waitForSelector('.board[data-board="customers"] .wbd-cust:has-text("cust-nova")');
      ok(true, 'launched agent lands on Customers with its customer line');

      // drag a card onto another tab
      await page.locator('[data-card-id="k2d7"]').dragTo(page.locator('[data-board-tab="research"]'));
      await page.waitForTimeout(400);
      ok((await page.locator('.board[data-board="customers"] [data-card-id="k2d7"]').count()) === 0, 'dragged card left Customers');
      await page.locator('[data-board-tab="research"]').click();
      await page.waitForSelector('.board[data-board="research"] [data-card-id="k2d7"]');
      ok(true, 'dragged card is on Research');
      // delete board: not empty -> disabled; move back then delete
      await page.locator('.wbd-tab-more').click();
      ok(await page.locator('.wbd-menu button').isDisabled(), 'Delete board disabled when not empty');
      await page.keyboard.press('Escape');
      await page.mouse.click(5, 880);
      await page.locator('[data-card-id="k2d7"]').dragTo(page.locator('[data-board-tab="customers"]'));
      await page.waitForTimeout(400);
      await page.locator('.wbd-tab-more').click();
      await page.locator('.wbd-menu button').click();
      await page.waitForSelector('[data-board-tab="research"]', { state: 'detached' });
      ok(true, 'empty board deleted');
    }
    await ctx.close();

    // ---------- phone ----------
    const pctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: scheme });
    const bp = await pctx.newPage();
    wire(bp);
    await bp.emulateMedia({ colorScheme: scheme });
    await bp.goto(`${base}/?mock=1#/board/customers`);
    await bp.waitForSelector('.board[data-board="customers"]');
    ok(true, `${scheme} phone: #/board/customers opens Customers`);
    await bp.waitForTimeout(300);
    await shot(bp, `wbd-phone-customers-${scheme}`);
    await bp.locator('[data-board-tab="programs"]').click();
    await bp.waitForSelector('.board[data-board="programs"]');
    await shot(bp, `wbd-phone-programs-${scheme}`);
    await pctx.close();
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
