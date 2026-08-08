/**
 * skin_shots.mjs -- screenshot every skin so they can be looked at.
 *
 * A skin is 31 Tailwind class strings. Tailwind's browser build compiles what it
 * finds in the DOM and SILENTLY IGNORES a class it cannot parse -- an arbitrary
 * value with an unescaped space, or a v3 spelling like `bg-[size:...]` where v4
 * wants `bg-size-[...]`, produces no rule and no error. So a skin file can look
 * perfect and render as nothing.
 *
 * That is why this exists and why it captures pixels rather than asserting on
 * class attributes: the class being present is not evidence that it did anything.
 *
 * Run:  node tools/skin_shots.mjs [url]
 */

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(REPO_ROOT, '.claude_vlm_checks', 'skins');
const BASE_URL = process.argv[2] || 'http://127.0.0.1:8899/index.html';

const VIEWPORT = { width: 1400, height: 900 };
/** Instantiating a 19 MB wasm module is not instant. */
const READY_TIMEOUT_MS = 120000;
/** Long enough for Tailwind's browser build to compile the swapped classes. */
const REPAINT_MS = 700;

mkdirSync(OUT_DIR, { recursive: true });

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage',
         '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});

const page = await browser.newPage();
await page.setViewport(VIEWPORT);

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message}`));
page.on('requestfailed', (r) => errors.push(`REQFAIL ${r.url()}`));

await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.click('#start-btn');
await page.waitForFunction(
  () => /ready |Patch:/i.test(document.getElementById('status').textContent),
  { timeout: READY_TIMEOUT_MS });

// Open a category so the sidebar shows rows -- an empty sidebar hides most of
// what distinguishes one skin from another.
await page.evaluate(() => {
  const bank = document.querySelector('#patch-list .bank');
  if (bank) { bank.open = true; const c = bank.querySelector('.category'); if (c) c.open = true; }
});

const skins = await page.evaluate(() => [...document.getElementById('theme-select').options]
  .map((o) => ({ value: o.value, label: o.textContent })));

console.log(`${skins.length} skins\n`);

for (const { value, label } of skins) {
  await page.select('#theme-select', value);
  await new Promise((r) => setTimeout(r, REPAINT_MS));

  // What the skin actually achieved, measured from computed style rather than
  // from the class list -- an uncompiled class leaves the default behind.
  const probe = await page.evaluate(() => {
    const cs = (sel, prop) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el)[prop] : '(missing)';
    };
    return {
      bodyBg: cs('body', 'backgroundColor'),
      bodyFont: cs('body', 'fontFamily').split(',')[0],
      toolbarRadius: cs('#toolbar', 'borderRadius'),
      sidebarW: cs('#patch-list', 'width'),
      mainDir: cs('#main', 'flexDirection'),
      pianoH: cs('#piano', 'height'),
      // Truncation check. The toolbar gained an Input picker after the skins
      // were designed, and #status is the flex-1 element that gives way first.
      // A skin whose toolbar is too greedy shows "r.." where the status was.
      statusPx: (() => document.getElementById('status').clientWidth)(),
    };
  });

  const file = join(OUT_DIR, `${value}.png`);
  await page.screenshot({ path: file });
  console.log(`${label.padEnd(16)} bg=${probe.bodyBg.padEnd(22)} ` +
    `font=${probe.bodyFont.padEnd(12)} side=${probe.sidebarW.padEnd(7)} ` +
    `dir=${probe.mainDir.padEnd(12)} piano=${probe.pianoH.padEnd(6)} ` +
    `status=${probe.statusPx}px${probe.statusPx < 80 ? '  <-- TOO NARROW' : ''}`);
}

console.log(`\n-> ${OUT_DIR}`);
console.log(errors.length ? `ERRORS:\n${errors.slice(0, 10).join('\n')}` : 'no console errors');

await browser.close();
