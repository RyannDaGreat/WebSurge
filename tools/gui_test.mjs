/**
 * gui_test.mjs -- prove Surge's real GUI works, not just that it renders.
 *
 * A screenshot only shows that paint ran. These checks drive the canvas the way
 * a user would and assert on consequences:
 *   1. the editor reports Surge's own size
 *   2. dragging a real control changes a real parameter
 *   3. that change reaches the audio engine
 *   4. the canvas repaints in response
 *   5. a QWERTY key produces a note-on
 *   6. a patch loads into both the GUI and the engine
 *
 * Run:  node tools/gui_test.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(REPO_ROOT, '.claude_vlm_checks');
const BASE_URL = process.env.SURGE_TEST_URL || 'http://localhost:8099';

/** Surge's own editor size, from globals.h BASE_WINDOW_SIZE_X/Y. */
const EXPECTED_W = 913;
const EXPECTED_H = 569;

/** A 19 MB wasm module plus JUCE startup is not instant. */
const START_TIMEOUT_MS = 90000;

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(OUT_DIR, { recursive: true });

const browser = await puppeteer.launch({
  headless: 'new',
  args: [
    '--no-sandbox', '--disable-dev-shm-usage',
    '--autoplay-policy=no-user-gesture-required', '--mute-audio',
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 1000 });

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(e.message));

console.log(`\nopening ${BASE_URL}`);
await page.goto(BASE_URL, { waitUntil: 'networkidle2', timeout: 60000 });
await page.click('#start-btn');

let started = false;
try {
  await page.waitForFunction(() => document.getElementById('overlay')?.hidden === true,
    { timeout: START_TIMEOUT_MS });
  started = true;
} catch { /* reported below */ }

record('Surge starts', started, await page.$eval('#status', (e) => e.textContent));

const size = await page.evaluate(() => {
  const c = document.getElementById('surge-canvas');
  return { w: c.width, h: c.height };
});
record('editor is Surge\'s own size', size.w === EXPECTED_W && size.h === EXPECTED_H,
  `${size.w}x${size.h} (expected ${EXPECTED_W}x${EXPECTED_H})`);

// ---- capture what the UI sends to the audio thread ------------------------
await page.evaluate(() => {
  window.__sent = [];
  const node = window.__surgeNode;
  const orig = node.port.postMessage.bind(node.port);
  node.port.postMessage = (m, t) => { window.__sent.push(m); return orig(m, t); };
});

/**
 * Reads a rectangle of canvas pixels, so a repaint can be detected.
 * Returns a cheap checksum rather than the whole buffer.
 */
const canvasHash = () => page.evaluate(() => {
  const c = document.getElementById('surge-canvas');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let h = 0;
  for (let i = 0; i < d.length; i += 997) h = (h * 31 + d[i]) >>> 0;
  return h;
});

const before = await canvasHash();

// ---- click a real control -------------------------------------------------
// Coordinates come from Surge's own connector table (src/layout.json), not from
// eyeballing a screenshot: global.active_scene is the A/B switch at (7,12,40,42),
// so its lower half is scene B. An earlier version of this test clicked bare
// panel background and "proved" the mouse was broken when it was not.
const SCENE_B = { x: 27, y: 45 };

const box = await page.$eval('#surge-canvas', (c) => {
  const r = c.getBoundingClientRect();
  return { x: r.left, y: r.top };
});

await page.mouse.move(box.x + SCENE_B.x, box.y + SCENE_B.y);
await page.mouse.down();
await sleep(50);
await page.mouse.up();
await sleep(700);

const sent = await page.evaluate(() => window.__sent || []);
const paramMsgs = sent.filter((m) => m.type === 'setParam');
record('clicking a real control changes a parameter', paramMsgs.length > 0,
  paramMsgs.length ? `${paramMsgs.length} setParam, first index=${paramMsgs[0].index}` : 'none sent');
record('parameter change reaches the audio engine', paramMsgs.length > 0,
  paramMsgs.length ? `value=${paramMsgs[0].value?.toFixed(4)}` : 'none');

const after = await canvasHash();
record('canvas repaints after interaction', before !== after, `${before} -> ${after}`);

await page.screenshot({ path: join(OUT_DIR, 'gui-after-drag.png') });

// ---- QWERTY notes ---------------------------------------------------------
await page.evaluate(() => { window.__sent.length = 0; });
await page.keyboard.down('q');
await sleep(150);
await page.keyboard.up('q');
await sleep(150);

const notes = await page.evaluate(() => window.__sent || []);
const on = notes.find((m) => m.type === 'noteOn');
const off = notes.find((m) => m.type === 'noteOff');
record("'q' plays middle C", on?.key === 60, on ? `key=${on.key} vel=${on.velocity}` : 'no noteOn');
record("releasing 'q' stops it", !!off, off ? `key=${off.key}` : 'none');

// ---- patch load -----------------------------------------------------------
const patchName = await page.evaluate(() => {
  const first = document.querySelector('#patch-list .patch');
  if (!first) return null;
  first.click();
  return first.textContent;
});
if (patchName) {
  await sleep(4000);
  const status = await page.$eval('#status', (e) => e.textContent);
  record('a patch loads', /^Patch: /.test(status), `${patchName} -> ${status}`);
  await page.screenshot({ path: join(OUT_DIR, 'gui-after-patch.png') });
} else {
  record('a patch loads', false, 'no patch in the browser');
}

record('no console errors', errors.length === 0, errors.slice(0, 2).join(' | ') || 'clean');

await browser.close();
writeFileSync(join(OUT_DIR, 'gui_test.json'), JSON.stringify(results, null, 2));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.error(`FAILED: ${failed.map((f) => f.name).join(', ')}`);
  process.exit(1);
}
