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

const errors = [];
try {
for (const theme of ['light', 'dark']) {
  for (const [dev, vp] of [['desk', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: dev === 'desk' ? 1 : 2, colorScheme: theme });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`${base}/?mock=1`);
    await page.waitForSelector('.board');
    await page.waitForTimeout(1800);
    const tag = `wd-${dev}-${theme}`;
    await shot(page, `${tag}-board`);
    if (dev === 'phone') {
      await page.locator('.tab', { hasText: 'Working' }).click().catch(() => {});
    }
    await page.locator('.card', { hasText: 'api-routes' }).first().click();
    await page.waitForSelector('.panel .f-tool');
    await page.waitForTimeout(800);
    await shot(page, `${tag}-panel`);
    await page.locator('.panel button[aria-label="Close"]').click();
    if (dev === 'phone') await page.locator('.tab', { hasText: 'Needs' }).click().catch(() => {});
    await page.locator('.card', { hasText: 'fix-tests' }).first().click();
    await page.waitForSelector('.panel .feed');
    await page.waitForTimeout(600);
    await shot(page, `${tag}-panel-q`);
    await page.locator('.panel button[aria-label="Close"]').click();
    await page.locator('.new-btn').click();
    await page.waitForSelector('.dialog');
    await page.waitForTimeout(300);
    await shot(page, `${tag}-new-agent`);
    await page.keyboard.press('Escape');
    if (dev === 'phone') {
      await page.locator('.tab', { hasText: 'To do' }).click().catch(() => {}); // decided: Notes → To do
      await page.waitForTimeout(300);
      await shot(page, `${tag}-notes`);
    }
    await ctx.close();
  }
}
} finally {
  await browser.close();
  server.kill();
}
console.log(`page errors: ${errors.length}`, errors);
if (errors.length) process.exit(1);
console.log('VERIFY-DESIGN OK');
