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
  await page.waitForSelector('.col-working .card');
  await page.waitForTimeout(800);
  ok(await page.locator('.col-notes').isVisible(), 'notes column visible');
  await shot(page, 'wb3-desktop-board');

  // create a note
  const before = await page.locator('.col-notes .note:not(.note-edit)').count();
  await page.locator('.col-notes .note-add').click();
  await page.locator('.note-title-in').fill('Add dark mode to settings');
  await page.locator('.note-body-in').fill('Toggle in the settings page, persisted in localStorage.');
  await shot(page, 'wb3-desktop-note-edit');
  await page.locator('.note-edit .btn-primary').click();
  await page.waitForSelector('.col-notes .note:has-text("Add dark mode to settings")');
  ok((await page.locator('.col-notes .note:not(.note-edit)').count()) === before + 1, 'note created');

  // start it
  const workingBefore = await page.locator('.col-working .card').count();
  await page.locator('.col-notes .note', { hasText: 'Add dark mode to settings' }).locator('.note-start').click();
  await page.waitForSelector('.start-dialog');
  ok((await page.locator('.start-acct option').first().textContent()) === 'Automatic', 'account select has Automatic');
  await page.waitForTimeout(350);
  await shot(page, 'wb3-desktop-start');
  await page.locator('.start-dialog .start-go').click();
  await page.waitForSelector('.panel .panel-name');
  ok(!(await page.locator('.start-dialog').count()), 'start dialog closed');
  await page.waitForTimeout(300);
  ok((await page.locator('.col-working .card').count()) === workingBefore + 1, 'new agent appears in Working');
  await page.locator('.panel button[aria-label="Close"]').first().click();

  // archive a done card -> Archived -> restore
  const doneCard = page.locator('.col-done .bcard').first();
  const doneId = await doneCard.getAttribute('data-card-id');
  await doneCard.hover();
  await doneCard.locator('.bcard-act').click();
  await page.waitForTimeout(200);
  ok(!(await page.locator(`.board [data-card-id="${doneId}"]`).count()), 'archived card hidden from columns');
  await page.locator('.archived-toggle').click();
  await page.waitForSelector(`[data-archived-id="${doneId}"]`);
  ok((await page.locator('.archived-toggle').textContent()).includes('Archived (1)'), 'Archived (1) section');
  await page.locator('.archived').scrollIntoViewIfNeeded();
  await shot(page, 'wb3-desktop-archived');
  await page.locator(`[data-archived-id="${doneId}"] button`).click();
  await page.waitForTimeout(200);
  ok((await page.locator(`.board [data-card-id="${doneId}"]`).count()) === 1, 'restored card back on the board');
  await page.evaluate(() => window.scrollTo(0, 0));

  // search
  const allCards = await page.locator('.board .card').count();
  await page.keyboard.press('/');
  ok(await page.evaluate(() => document.activeElement?.closest('.search-desk') != null), '/ focuses search');
  await page.keyboard.type('dark mode');
  await page.waitForTimeout(150);
  const filtered = await page.locator('.board .card').count();
  ok(filtered >= 1 && filtered < allCards, `search filters (${allCards} -> ${filtered})`);
  await shot(page, 'wb3-desktop-search');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  ok((await page.locator('.board .card').count()) === allCards, 'Esc clears search');

  // J/K
  await page.locator('.wordmark').click();
  await page.keyboard.press('j');
  await page.keyboard.press('j');
  ok((await page.locator('.kfocus').count()) === 1, 'J sets a focus ring');
  const f1 = await page.locator('.kfocus').first().getAttribute('data-card-id') ?? await page.locator('.kfocus').first().getAttribute('data-note-id');
  await page.keyboard.press('j');
  const f2 = await page.locator('.kfocus').first().getAttribute('data-card-id') ?? await page.locator('.kfocus').first().getAttribute('data-note-id');
  ok(f1 !== f2, `J moves focus (${f1} -> ${f2})`);
  await page.keyboard.press('k');
  const f3 = await page.locator('.kfocus').first().getAttribute('data-card-id') ?? await page.locator('.kfocus').first().getAttribute('data-note-id');
  ok(f3 === f1, 'K moves back');
  await shot(page, 'wb3-desktop-focus');
  // move focus onto an agent card and press Enter
  while (!(await page.locator('.bcard.kfocus').count())) await page.keyboard.press('j');
  const fid = await page.locator('.bcard.kfocus').getAttribute('data-card-id');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.panel');
  ok((await page.locator('.card.selected').count()) === 1, `Enter opens focused card ${fid}`);
  await page.keyboard.press('j');
  await page.waitForTimeout(150);
  const fid2 = await page.locator('.bcard.kfocus').getAttribute('data-card-id');
  ok(fid2 !== fid && (await page.locator(`[data-card-id="${fid2}"] .card.selected`).count()) === 1, 'J inside the panel opens the next card');
  await page.keyboard.press('Escape');

  // interactive tmux card
  await page.locator('.observed-toggle').first().click();
  ok((await page.locator('.ro-hint').count()) >= 1, 'non-interactive observed card shows read-only hint');
  await page.locator('[data-card-id="t1x9"] .card').click();
  await page.waitForSelector('.tmux-panel .tmux-screen');
  await page.waitForFunction(() => document.querySelector('.tmux-screen')?.textContent?.includes('Claude Code'));
  ok(true, 'TmuxPanel shows a screen');
  ok((await page.locator('.tmux-key').count()) === 6, '6 key buttons');
  await page.locator('.tmux-input').fill('status please');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.tmux-confirm');
  ok((await page.locator('.tmux-confirm').textContent()).includes('This types into a live session. Send?'), 'first send asks to confirm'); // spec row 22 (SB's TmuxPanel copy)
  await shot(page, 'wb3-desktop-tmux-confirm');
  await page.locator('.tmux-dontask input').check();
  await page.locator('.tmux-confirm .btn-primary').click();
  await page.waitForFunction(() => document.querySelector('.tmux-screen')?.textContent?.includes('> status please'));
  ok(true, 'send reaches the screen');
  await page.locator('.tmux-input').fill('again');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.tmux-screen')?.textContent?.includes('> again'));
  ok(!(await page.locator('.tmux-confirm').count()), "Don't ask again skips the confirm");
  await page.waitForTimeout(1700);
  await shot(page, 'wb3-desktop-tmux');
  await page.locator('.tmux-panel button[aria-label="Close"]').click();
  await ctx.close();

  // ---------- phone ----------
  console.log('phone 390x844');
  const pctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const bp = await pctx.newPage();
  wire(bp);
  await bp.goto(`${base}/?mock=1`);
  await bp.waitForSelector('.tabs');
  await bp.waitForTimeout(800);
  const sw = await bp.evaluate(() => document.documentElement.scrollWidth);
  ok(sw <= 390, `no horizontal overflow at 390 (scrollWidth ${sw})`);
  await shot(bp, 'wb3-phone-board');
  // decided spec: Notes → "To do" with a single "+ Note" (row 12: no body "+ Note" row; the head button adds)
  await bp.locator('.tab', { hasText: 'To do' }).click();
  ok(await bp.locator('.col-notes').isVisible(), 'To do is a tab on phone');
  await bp.locator('.col-notes .note-add').click();
  await bp.locator('.note-title-in').fill('Write release notes');
  await bp.locator('.note-edit .btn-primary').click();
  await bp.waitForSelector('.col-notes .note:has-text("Write release notes")');
  await shot(bp, 'wb3-phone-notes');
  await bp.locator('.col-notes .note', { hasText: 'Write release notes' }).locator('.note-start').click();
  await bp.waitForSelector('.start-dialog');
  await bp.waitForTimeout(350);
  await shot(bp, 'wb3-phone-start');
  await bp.locator('.start-go').click();
  await bp.waitForSelector('.panel .panel-name');
  ok(true, 'phone: note started, panel opens');
  await bp.locator('.panel button[aria-label="Close"]').first().click();
  await bp.locator('.search-phone input').fill('canary');
  await bp.waitForTimeout(150);
  await shot(bp, 'wb3-phone-search');
  await bp.locator('.search-phone input').fill('');
  await bp.locator('.observed-toggle').first().click();
  await bp.locator('[data-card-id="t1x9"] .card').click();
  await bp.waitForSelector('.tmux-panel .tmux-screen');
  await bp.waitForTimeout(400);
  await shot(bp, 'wb3-phone-tmux');
  await pctx.close();
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
