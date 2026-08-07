/**
 * browser_test.mjs -- drive the real site in a real browser and prove it works.
 *
 * Checks, in order:
 *   1. the page loads with no console errors
 *   2. the engine starts and reports its parameters
 *   3. widgets are actually placed on the panel
 *   4. the patch browser is populated
 *   5. pressing a QWERTY key produces a note-on
 *   6. a patch loads
 * and screenshots the result for a VLM to inspect.
 *
 * Screenshots go to .claude_vlm_checks/, which is disposable.
 *
 * Run:  node tools/browser_test.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(REPO_ROOT, '.claude_vlm_checks');
const BASE_URL = process.env.SURGE_TEST_URL || 'http://localhost:8099';

const VIEWPORT = { width: 1400, height: 900 };
/** Generous: instantiating a 5.5 MB wasm module in a worklet is not instant. */
const ENGINE_TIMEOUT_MS = 60000;

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`);
};

mkdirSync(OUT_DIR, { recursive: true });

const browser = await puppeteer.launch({
  headless: 'new',
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    // Let AudioContext start without a real gesture and without an audio device.
    '--autoplay-policy=no-user-gesture-required',
    '--use-fake-device-for-media-stream',
    '--mute-audio',
  ],
});

const page = await browser.newPage();
await page.setViewport(VIEWPORT);

const consoleErrors = [];
const pageErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('requestfailed', (r) => consoleErrors.push(`request failed: ${r.url()}`));

console.log(`\nopening ${BASE_URL}`);
await page.goto(BASE_URL, { waitUntil: 'networkidle2', timeout: 30000 });

record('page loads', pageErrors.length === 0, pageErrors[0]);

// ---- layout.json reached the page --------------------------------------
const statusBefore = await page.$eval('#status', (el) => el.textContent);
record('layout loaded', /connectors/.test(statusBefore), statusBefore);

await page.screenshot({ path: join(OUT_DIR, '01-overlay.png') });

// ---- start the engine ---------------------------------------------------
await page.click('#start-btn');

let ready = false;
try {
  await page.waitForFunction(
    () => document.getElementById('overlay')?.hidden === true,
    { timeout: ENGINE_TIMEOUT_MS },
  );
  ready = true;
} catch {
  /* handled below with the status text as evidence */
}

const status = await page.$eval('#status', (el) => el.textContent);
record('engine started', ready, status);

// ---- the GUI actually rendered -----------------------------------------
const counts = await page.evaluate(() => ({
  widgets: document.querySelectorAll('#panel .w').length,
  sliders: document.querySelectorAll('#panel .slider').length,
  switches: document.querySelectorAll('#panel .switch').length,
  readouts: document.querySelectorAll('#panel .readout').length,
  bgLoaded: document.getElementById('panel-bg')?.naturalWidth || 0,
}));
record('panel background rendered', counts.bgLoaded === 913, `naturalWidth=${counts.bgLoaded}`);
record('widgets placed', counts.widgets > 100 && counts.widgets <= 200,
  `${counts.widgets} total (${counts.sliders} sliders, ${counts.switches} switches, ${counts.readouts} readouts)`);

// ---- patch browser ------------------------------------------------------
const patchCount = await page.evaluate(() =>
  document.querySelectorAll('#patch-list .patch').length);
record('patch browser populated', patchCount > 3000, `${patchCount} patches`);

await page.screenshot({ path: join(OUT_DIR, '02-full-page.png') });
const panel = await page.$('#panel');
if (panel) await panel.screenshot({ path: join(OUT_DIR, '03-panel.png') });

// ---- QWERTY note input --------------------------------------------------
// Intercept what the app posts to the audio thread; asserting on the message is
// the honest check, since headless Chrome has no speakers to listen to.
await page.evaluate(() => {
  window.__sent = [];
  const node = window.__surgeNode;
  if (node) {
    const orig = node.port.postMessage.bind(node.port);
    node.port.postMessage = (m, t) => { window.__sent.push(m); return orig(m, t); };
  }
});

await page.keyboard.down('q');
await new Promise((r) => setTimeout(r, 120));
await page.keyboard.up('q');
await new Promise((r) => setTimeout(r, 120));

const sent = await page.evaluate(() => window.__sent || []);
const noteOn = sent.find((m) => m.type === 'noteOn');
const noteOff = sent.find((m) => m.type === 'noteOff');
record("'q' sends noteOn for middle C (60)", noteOn?.key === 60,
  noteOn ? `key=${noteOn.key} vel=${noteOn.velocity}` : 'no noteOn seen');
record("releasing 'q' sends noteOff", !!noteOff, noteOff ? `key=${noteOff.key}` : 'none');

// ---- load a patch -------------------------------------------------------
const clicked = await page.evaluate(() => {
  const first = document.querySelector('#patch-list .patch');
  if (!first) return null;
  first.click();
  return first.textContent;
});
if (clicked) {
  await new Promise((r) => setTimeout(r, 2500));
  const afterPatch = await page.$eval('#status', (el) => el.textContent);
  record('patch loads', /^Patch: /.test(afterPatch), `${clicked} -> ${afterPatch}`);
  await page.screenshot({ path: join(OUT_DIR, '04-after-patch.png') });
} else {
  record('patch loads', false, 'no patch element to click');
}

record('no console errors', consoleErrors.length === 0,
  consoleErrors.slice(0, 3).join(' | ') || 'clean');

await browser.close();

writeFileSync(join(OUT_DIR, 'browser_test.json'), JSON.stringify(results, null, 2));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
console.log(`screenshots in ${OUT_DIR}`);
if (failed.length) {
  console.error(`\nFAILED: ${failed.map((f) => f.name).join(', ')}`);
  process.exit(1);
}
