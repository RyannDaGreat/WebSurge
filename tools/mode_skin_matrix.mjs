/**
 * mode_skin_matrix.mjs -- open every input mode under every skin.
 *
 * WHY THIS EXISTS
 * ---------------
 * The piano roll shipped broken on most skins and passed its own tests, because
 * every one of those tests ran on whatever skin happened to be default. It
 * paints onto a canvas, so it cannot use `currentColor` and instead reads the
 * skin's computed text colour -- and Tailwind v4 emits `oklch()`, which the
 * colour handling did not understand. One skin worked. The rest threw.
 *
 * Anything that reads computed style has this failure shape: correct under the
 * skin you happened to test, broken under the other fourteen. Modes x skins is
 * the only honest coverage, and at 4 x 15 it is cheap.
 *
 * Run:  node tools/mode_skin_matrix.mjs [url]
 */

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(REPO_ROOT, '.claude_vlm_checks');
const BASE_URL = process.argv[2] || 'http://127.0.0.1:8899/index.html';

/** Instantiating a 19 MB wasm module is not instant. */
const READY_TIMEOUT_MS = 120000;
/** Enough for a mode to mount, including the lazy-loaded ones. */
const MOUNT_MS = 1500;

/**
 * Console noise that is known, understood, and not ours.
 *
 * Kept deliberately narrow. The point of this harness is to catch errors, so an
 * over-broad filter here would defeat it -- each entry names one specific
 * message and why it is tolerated.
 *
 *  - tailwindcss: the browser build probes for this specifier and 404s before
 *    falling back to its bundled copy. See index.html; removing the @import
 *    unstyles every skin.
 *  - DialogTitle: Radix's own a11y warning, emitted by signal's Dialog usage
 *    inside the vendored build. Upstream's code and upstream's call to make;
 *    the editor mounts and works. Patching it would mean editing their
 *    components, which is exactly what we are not doing.
 */
const IGNORED_ERROR = /tailwindcss|`DialogContent` requires a `DialogTitle`/;

mkdirSync(OUT_DIR, { recursive: true });

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage',
         '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});

const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 1000 });

const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.click('#start-btn');
await page.waitForFunction(
  () => /ready |Patch:/i.test(document.getElementById('status').textContent),
  { timeout: READY_TIMEOUT_MS });

const skins = await page.$$eval('#theme-select option', (o) => o.map((x) => x.value));
const modes = await page.$$eval('#mode-select option', (o) => o.map((x) => x.value));

console.log(`${modes.length} modes x ${skins.length} skins = ${modes.length * skins.length} combinations\n`);

const failures = [];

for (const skin of skins) {
  await page.select('#theme-select', skin);
  const row = [];

  for (const mode of modes) {
    errors.length = 0;

    // setInputMode catches and reports rather than throwing, so the error bar
    // is the honest signal -- an exception here would be too kind.
    await page.evaluate((m) => window.__app.setInputMode(m), mode);
    await new Promise((r) => setTimeout(r, MOUNT_MS));

    const bar = await page.$eval('#error-bar', (el) => (el.hidden ? '' : el.textContent));
    const mounted = await page.evaluate(() => window.__app.modes.activeId());
    const thrown = errors.filter((e) => !IGNORED_ERROR.test(e));

    const ok = !bar && mounted === mode && thrown.length === 0;
    row.push(`${ok ? '.' : 'X'}${mode}`);

    if (!ok) {
      failures.push({ skin, mode, bar, mounted, thrown: thrown.slice(0, 2) });
      // Clear the bar so the next combination is not blamed for this one.
      await page.evaluate(() => { document.getElementById('error-bar').hidden = true; });
    }
  }
  console.log(`${skin.padEnd(12)} ${row.join('  ')}`);
}

if (failures.length) {
  console.log(`\n${failures.length} FAILED:\n`);
  for (const f of failures) {
    console.log(`  ${f.skin} / ${f.mode}`);
    if (f.bar) console.log(`    error bar: ${f.bar}`);
    if (f.mounted !== f.mode) console.log(`    mounted instead: ${f.mounted}`);
    for (const t of f.thrown) console.log(`    threw: ${t}`);
  }
  await page.screenshot({ path: join(OUT_DIR, 'mode_skin_failure.png') });
} else {
  console.log('\nall combinations mounted cleanly');
}

await browser.close();
process.exit(failures.length ? 1 : 0);
