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

import { execSync } from 'node:child_process';
execSync('npx vite build --outDir verify/out/dist-acc --emptyOutDir', { cwd: webDir, stdio: 'inherit' });
const server = spawn('npx', ['vite', 'preview', '--outDir', 'verify/out/dist-acc', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
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
};
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  wire(page);
  await page.goto(`${base}/?mock=1`);
  await page.waitForSelector('.card');
  await page.waitForTimeout(600);
  const needs = await page.locator('.card-needs_you').count();
  const title = await page.title();
  console.log('title:', JSON.stringify(title), 'needs_you cards:', needs);
  // the title counts agents needing you on every board; the visible board shows a subset
    ok(needs === 0 ? true : Number((/^\((\d+)\) /.exec(title) || [])[1]) >= needs, `title prefix counts needs_you across boards (≥ ${needs})`);
  const fav = await page.locator('link[rel~="icon"]').getAttribute('href');
  ok(fav && fav.startsWith('data:image/png'), 'favicon drawn on canvas');
  await page.screenshot({ path: path.join(out, 'wb-board-desktop.png') });
  await page.locator('button.accounts-btn').click() /* spec: one Accounts button replaces capacity chips */;
  await page.waitForSelector('.acc-panel');
  await page.waitForTimeout(250);
  const rows = await page.locator('.acc-row').count();
  console.log('account rows (filtered):', rows);
  ok(await page.locator('.acc-panel').isVisible(), 'Accounts button opens the panel'); // spec: per-kind chips removed
  await page.screenshot({ path: path.join(out, 'wb-accounts-kind-desktop.png') });
  if (await page.locator('.acc-all').count()) await page.locator('.acc-all').click();
  ok((await page.locator('.acc-group').count()) === 3, 'All accounts shows 3 groups');
  await page.locator('.acc-add summary').first().click();
  await page.screenshot({ path: path.join(out, 'wb-accounts-all-desktop.png') });
  await page.keyboard.press('Escape');
  await page.locator('.new-btn').click();
  await page.locator('.segmented button', { hasText: 'Claude' }).click();
  const sel = page.locator('select[aria-label="Account"]');
  if (await sel.count()) {
    const opts = await sel.locator('option').allTextContents(); // spec row 14: Account lives in a collapsed Advanced section
    console.log('account options:', opts);
    ok(opts[0].startsWith('Automatic'), 'account select defaults to Automatic');
  } else console.log('NOTE: no Claude accounts in mock -> select hidden');
  await page.screenshot({ path: path.join(out, 'wb-newagent-desktop.png') });
  await ctx.close();

  const pctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const p = await pctx.newPage();
  wire(p);
  await p.goto(`${base}/?mock=1`);
  await p.waitForSelector('.topbar');
  await p.waitForTimeout(500);
  await p.screenshot({ path: path.join(out, 'wb-board-phone.png') });
  await p.locator('button.accounts-btn').click() /* spec: one Accounts button replaces capacity chips */;
  await p.waitForSelector('.acc-panel');
  await p.waitForTimeout(300);
  await p.screenshot({ path: path.join(out, 'wb-accounts-phone.png') });
  const ow = await p.evaluate(() => document.documentElement.scrollWidth);
  ok(ow <= 390, `no horizontal overflow on phone (${ow})`);
  await pctx.close();
  ok(errors.length === 0, `no console errors ${JSON.stringify(errors)}`);
  console.log(`PASS ${checks} checks`);
} finally {
  await browser.close();
  server.kill();
}
