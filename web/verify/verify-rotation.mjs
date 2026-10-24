// Headless verification of Wave C (account rotation) in mock mode. Serves a fresh build via `vite preview`.
import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
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

execSync('npx vite build --outDir verify/out/dist-rot --emptyOutDir', { cwd: webDir, stdio: 'inherit' });
const server = spawn('npx', ['vite', 'preview', '--outDir', 'verify/out/dist-rot', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
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
let checks = 0;
const ok = (cond, msg) => {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  checks++;
  console.log(`  ✓ ${msg}`);
};

// Prefer the bundled browser; fall back to an already-cached headless shell (no download needed).
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
};
const row = (page, id) => page.locator(`.acc-row[data-account="${id}"]`);

try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  wire(page);
  await page.goto(`${base}/?mock=1`);
  await page.waitForSelector('.card');
  await page.waitForTimeout(500);

  // moved badge on the agent card
  const moved = page.locator('.card .card-moved');
  ok((await moved.count()) >= 1, 'a card shows the moved badge');
  const movedText = await moved.first().innerText();
  console.log('moved badge:', JSON.stringify(movedText));
  ok(movedText === 'Moved from Claude · ~/.claude-5', 'moved badge names the old account label');
  await page.screenshot({ path: path.join(out, 'wc-board-desktop.png') });

  // open the full accounts panel
  await page.locator('button.cap').first().click();
  await page.waitForSelector('.acc-panel');
  await page.locator('.acc-all').click();
  await page.waitForTimeout(250);
  const counts = await page.locator('.acc-count').allInnerTexts();
  console.log('group counts:', counts);
  ok(counts.includes('2 of 4 available') && counts.includes('1 of 2 available'), '"N of M available" per kind');
  ok((await page.locator('.acc-rotate-help').innerText()).includes('moves the agent to the next available account'), 'auto-rotate explanation shown');

  // statuses + sort
  const claudeOrder = await page.locator('.acc-group').nth(1).locator('.acc-row').evaluateAll((els) => els.map((e) => e.getAttribute('data-account')));
  console.log('claude order:', claudeOrder);
  ok(JSON.stringify(claudeOrder) === JSON.stringify(['claude-12', 'claude-3', 'claude-5', 'claude-7']), 'sorted available → at limit → logged out');
  ok((await row(page, 'claude-5').locator('.acc-badge').innerText()) === 'At limit', 'exhausted shows At limit');
  const reset = await row(page, 'claude-5').locator('.acc-reset').innerText();
  console.log('countdown:', reset);
  ok(/^back in (39|40)m$/.test(reset), 'countdown from resetAt');
  ok((await row(page, 'codex-2').locator('.acc-badge').innerText()) === 'Paused', 'excluded badge');
  ok((await row(page, 'claude-7').locator('.acc-badge').innerText()) === 'Logged out', 'logged out badge');
  ok((await row(page, 'claude-7').locator('.acc-cmd code').innerText()).includes('claude /login'), 'logged out shows login command');
  ok((await row(page, 'claude-7').locator('.acc-copy').count()) === 1, 'login command has Copy');
  ok((await row(page, 'claude-12').locator('button', { hasText: 'Reset limit' }).count()) === 0, 'Clear only on exhausted');

  // activity
  const acts = await page.locator('.acc-act-item').count();
  ok(acts === 4, `activity shows 4 seeded entries (${acts})`);
  await page.screenshot({ path: path.join(out, 'wc-accounts-desktop.png') });

  // auto-rotate toggle
  const sw = page.locator('.acc-switch');
  ok((await sw.getAttribute('aria-checked')) === 'true', 'auto-rotate starts on');
  await sw.click();
  await page.waitForTimeout(200);
  ok((await sw.getAttribute('aria-checked')) === 'false', 'auto-rotate toggles off');
  await sw.click();
  await page.waitForTimeout(200);
  ok((await sw.getAttribute('aria-checked')) === 'true', 'auto-rotate toggles back on');

  // exclude then include
  await row(page, 'claude-3').locator('button', { hasText: 'Pause account' }).click();
  await page.waitForTimeout(250);
  ok((await row(page, 'claude-3').locator('.acc-badge').innerText()) === 'Paused', 'Pause → Paused');
  ok((await page.locator('.acc-count').allInnerTexts()).includes('1 of 4 available'), 'count drops to 1 of 4');
  await row(page, 'claude-3').locator('button', { hasText: 'Resume' }).click();
  await page.waitForTimeout(250);
  ok((await row(page, 'claude-3').locator('.acc-badge').innerText()) === 'Available', 'Include → Available');

  // clear the exhausted one
  await row(page, 'claude-5').locator('button', { hasText: 'Reset limit' }).click();
  await page.waitForTimeout(250);
  ok((await row(page, 'claude-5').locator('.acc-badge').innerText()) === 'Available', 'Clear → Available');
  ok((await row(page, 'claude-5').locator('.acc-reset').count()) === 0, 'countdown gone after Clear');
  const acts2 = await page.locator('.acc-act-item').count();
  ok(acts2 === 7, `activity grew by excluded+included+cleared (${acts2})`);
  ok((await page.locator('.acc-act-item').first().innerText()).includes('available again'), 'newest activity first');
  await page.screenshot({ path: path.join(out, 'wc-accounts-after-desktop.png') });
  await page.locator('.acc-body').evaluate((el) => (el.scrollTop = el.scrollHeight));
  await page.waitForTimeout(100);
  await page.screenshot({ path: path.join(out, 'wc-activity-desktop.png') });
  await ctx.close();

  // phone
  const pctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const p = await pctx.newPage();
  wire(p);
  await p.goto(`${base}/?mock=1`);
  await p.waitForSelector('.topbar');
  await p.waitForTimeout(500);
  await p.screenshot({ path: path.join(out, 'wc-board-phone.png') });
  ok((await p.locator('.card .card-moved').count()) >= 1, 'moved badge on phone');
  await p.locator('button.cap').nth(1).click();
  await p.waitForSelector('.acc-panel');
  await p.waitForTimeout(300);
  await p.screenshot({ path: path.join(out, 'wc-accounts-claude-phone.png') });
  await p.locator('.acc-all').click();
  await p.waitForTimeout(200);
  await p.screenshot({ path: path.join(out, 'wc-accounts-phone.png') });
  await p.locator('.acc-body').evaluate((el) => (el.scrollTop = el.scrollHeight));
  await p.waitForTimeout(100);
  await p.screenshot({ path: path.join(out, 'wc-activity-phone.png') });
  const ow = await p.evaluate(() => document.documentElement.scrollWidth);
  ok(ow <= 390, `no horizontal overflow on phone (${ow})`);
  const panelOw = await p.locator('.acc-body').evaluate((el) => el.scrollWidth - el.clientWidth);
  ok(panelOw <= 0, `no horizontal overflow inside the panel (${panelOw})`);
  await pctx.close();
  ok(errors.length === 0, `no console errors ${JSON.stringify(errors)}`);
  console.log(`PASS ${checks} checks`);
} finally {
  await browser.close();
  server.kill();
}
