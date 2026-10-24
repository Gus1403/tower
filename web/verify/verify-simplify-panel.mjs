// Verifies the panel / composer / New agent / Accounts simplification (mock mode). Screenshots: verify/out/wsb-*.png
import { spawn } from 'node:child_process';
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
const server = spawn('npx', ['vite', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: webDir, stdio: ['ignore', 'pipe', 'pipe'] });
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(base)).ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 150));
}

let checks = 0;
const errors = [];
const ok = (cond, msg) => {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  checks++;
  console.log(`  ✓ ${msg}`);
};
const shot = async (page, name) => {
  const f = path.join(out, `wsb-${name}.png`);
  await page.screenshot({ path: f });
  console.log(`  ▣ ${f}`);
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

async function open(theme, phone) {
  const ctx = await browser.newContext(
    phone ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 },
  );
  await ctx.addInitScript((t) => localStorage.setItem('tower.theme', t), theme);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`${base}/?mock=1`);
  await page.waitForSelector('.card');
  return { ctx, page };
}

try {
  for (const theme of ['light', 'dark']) {
    for (const phone of [false, true]) {
      const tag = `${phone ? 'phone' : 'desk'}-${theme}`;
      console.log(`\n${tag}`);
      const { ctx, page } = await open(theme, phone);
      await page.locator('.card', { hasText: 'api-routes' }).first().click();
      await page.waitForSelector('.panel .f-tool');
      await page.waitForTimeout(600);
      ok((await page.locator('.panel .panel-head .b-interrupt').count()) === 0, 'no Interrupt button in panel head');
      const sub = await page.locator('.panel .panel-sub').first().innerText();
      ok(!sub.includes('/'), `cwd shown as basename, not repeated ("${sub}")`);
      // composer busy → ONE primary Queue, no Interrupt & send
      await page.locator('.panel .composer textarea').fill('also add tests');
      ok((await page.locator('.panel .composer button', { hasText: 'Queue' }).count()) === 1, 'composer busy: one Queue button');
      ok((await page.locator('.panel .composer .c-interrupt').count()) === 0, 'composer busy: no Interrupt & send button');
      const ph = await page.locator('.panel .composer textarea').getAttribute('placeholder');
      ok(!/for when this turn ends/.test(ph), `placeholder simplified ("${ph}")`);
      await shot(page, `${tag}-panel`);
      await page.locator('.panel .composer textarea').fill('');
      // tool row: no raw JSON
      await page.locator('.panel button.f-tool').first().click();
      await page.waitForSelector('.panel .f-tool-out pre');
      const outTxt = await page.locator('.panel .f-tool-out').first().innerText();
      ok(!/^\s*[{[]/.test(outTxt) && !outTxt.includes('"command"'), 'expanded tool row shows output only (no raw JSON)');
      const rows = await page.locator('.panel .f-tool').allInnerTexts();
      ok(rows.every((t) => !t.includes('{"')), 'no raw JSON on tool rows');
      // ⋯ menu: Interrupt + Remove with inline confirm
      await page.locator('.panel button[aria-label="More"]').click();
      ok((await page.locator('.more-menu .more-interrupt').count()) === 1, '⋯ has Interrupt');
      ok((await page.locator('.more-menu .more-move', { hasText: 'Move to another account' }).count()) === 1, '⋯ has Move to another account');
      let dialogs = 0;
      page.on('dialog', (d) => {
        dialogs++;
        void d.dismiss();
      });
      await page.locator('.more-menu .more-danger').click();
      ok((await page.locator('.more-menu .more-confirm .more-remove').count()) === 1, 'Remove shows inline confirm');
      ok((await page.locator('.more-menu .more-keep').count()) === 1, 'inline confirm has Keep');
      ok(dialogs === 0, 'no window.confirm');
      await shot(page, `${tag}-more`);
      await page.locator('.more-menu .more-keep').click();
      ok((await page.locator('.more-menu .more-danger').count()) === 1, 'Keep cancels');
      await page.keyboard.press('Escape');
      await page.locator('.panel .icon-btn[aria-label="Close"]').click().catch(() => {});
      await page.waitForTimeout(200);

      // New agent dialog
      await page.locator('.new-btn:visible').first().click();
      await page.waitForSelector('.dialog[aria-label="New agent"]');
      await page.waitForTimeout(400);
      const order = await page.evaluate(() => {
        const d = document.querySelector('.dialog[aria-label="New agent"]');
        const t = d.querySelector('textarea');
        const seg = d.querySelector('.segmented');
        return !!(t.compareDocumentPosition(seg) & Node.DOCUMENT_POSITION_FOLLOWING);
      });
      ok(order, 'New agent: Task comes before the kind picker');
      const adv = page.locator('.dialog .na-advanced');
      if (await adv.count()) {
        ok(!(await adv.evaluate((e) => e.open)), 'Advanced collapsed by default');
        ok(await page.locator('.dialog select[aria-label="Account"]').isHidden(), 'Account hidden under Advanced');
      } else ok(true, 'no Advanced (single account)');
      await shot(page, `${tag}-new-agent`);
      if (await adv.count()) {
        await adv.locator('summary').click();
        ok((await page.locator('.dialog select[aria-label="Account"] option').first().innerText()) === 'Automatic', 'Account defaults to Automatic');
      }
      await page.keyboard.press('Escape');

      // Accounts panel copy
      await page.locator('.accounts-btn, button:has-text("Accounts")').first().click();
      await page.waitForSelector('.acc-panel');
      await page.waitForTimeout(400);
      const accTxt = await page.locator('.acc-panel').innerText();
      ok(!/\bExclude\b|\bInclude\b/.test(accTxt), 'Accounts: no Exclude/Include');
      ok(/Pause account|Resume/.test(accTxt), 'Accounts: Pause account / Resume');
      ok(/Reset limit/.test(accTxt) || !/At limit/.test(accTxt), 'Accounts: Reset limit on exhausted');
      ok(!/\bClear\b/.test(accTxt), 'Accounts: no "Clear"');
      await shot(page, `${tag}-accounts`);
      await ctx.close();
    }
  }
  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  console.log(`\nverify-simplify-panel: ${checks} checks passed`);
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill();
}
