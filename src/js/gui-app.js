/**
 * gui-app.js -- drives Surge XT's real GUI on a canvas.
 *
 * There are two Surge instances, on purpose:
 *
 *   main thread   surge-gui.wasm    SurgeGUIEditor + its own SurgeSynthesizer.
 *                                   Draws the interface and owns parameter state.
 *   audio thread  surge-engine.wasm SurgeSynthesizer only. Makes the sound.
 *
 * They cannot be one object: the GUI needs the main thread (canvas, events) and
 * the DSP needs the audio thread (no jitter). They are the same Surge build, so
 * parameter indices line up exactly, and each frame we diff the GUI's parameter
 * block and post only what moved to the worklet.
 *
 * The pixels are Surge's own -- painted by Surge's paint code, with Surge's
 * embedded fonts, through the WASM ComponentPeer.
 */

'use strict';

import { attachKeyboard } from './keyboard.js';
import { buildPatchIndex, buildPatchTree } from './patches.js';
import { initThemePicker, dressGenerated } from './themes.js';
import { createModeRegistry } from './input/registry.js';
import { keyboardMode } from './input/mode-keyboard.js';
import { pianoRollMode } from './input/mode-pianoroll.js';
import { notationMode } from './input/mode-notation.js';
import { attachShortcuts } from './input/shortcuts.js';
import { BINDINGS } from './input/bindings.js';
import { createShortcutKey } from './input/shortcut-key.js';
import {
  fetchSurgeData, fetchRemoteIndex, fetchRemotePatch,
  unpackInto, writeFileInto, SURGE_DATA_ROOT,
} from './surge-data.js';
import { createPiano } from './piano.js';

const GUI_MODULE = './surge-gui.js';
const WORKLET_BUNDLE = 'js/surge-worklet-bundle.js';
const ENGINE_WASM = 'js/surge-engine.wasm';

/** Where Surge's resources are mounted inside each Emscripten filesystem. */
const DATA_PATH = SURGE_DATA_ROOT;

/** The input modes, in picker order. Also the registry's contents. */
const INPUT_MODES = [keyboardMode, pianoRollMode, notationMode];

const $ = (id) => document.getElementById(id);
const setStatus = (m) => { $('status').textContent = m; };

/**
 * Command. Shows the progress bar.
 *
 * @param {number|null} fraction - 0..1, or null for indeterminate (a request
 *        whose total size the server did not declare)
 */
function setProgress(fraction) {
  const bar = $('progress');
  bar.hidden = false;
  bar.classList.toggle('indeterminate', fraction === null);
  bar.style.setProperty('--progress', fraction === null ? 1 : Math.max(0, Math.min(1, fraction)));
}

/** Command. Hides the progress bar. */
function clearProgress() {
  $('progress').hidden = true;
}

function fail(message, err) {
  console.error(message, err || '');
  setStatus(`ERROR: ${message}`);
  const bar = $('error-bar');
  bar.textContent = message + (err ? ` -- ${err.message || err}` : '');
  bar.hidden = false;
}

/**
 * Pure function. Maps a browser KeyboardEvent to a JUCE key code.
 *
 * JUCE uses its own constants for non-printable keys; printable keys are just
 * their character code. Anything unmapped returns 0, which JUCE ignores.
 *
 * @param {KeyboardEvent} e
 * @returns {number} JUCE key code
 *
 * @example juceKeyCode({key: 'Escape'})    // 27
 * @example juceKeyCode({key: 'ArrowLeft'}) // 0x10002
 * @example juceKeyCode({key: 'a'})         // 97
 */
export function juceKeyCode(e) {
  // Values from juce::KeyPress.
  const SPECIAL = {
    Escape: 27, Backspace: 8, Tab: 9, Enter: 13, Delete: 0x10004,
    ArrowLeft: 0x10002, ArrowRight: 0x10003, ArrowUp: 0x10000, ArrowDown: 0x10001,
    Home: 0x10005, End: 0x10006, PageUp: 0x10007, PageDown: 0x10008,
    F1: 0x11000, F2: 0x11001, F3: 0x11002, F4: 0x11003,
  };
  if (SPECIAL[e.key] !== undefined) return SPECIAL[e.key];
  if (e.key && e.key.length === 1) return e.key.charCodeAt(0);
  return 0;
}

class SurgeGuiApp {
  constructor() {
    this.gui = null;
    this.sg = null;
    this.canvas = null;
    this.ctx2d = null;
    this.imageData = null;
    this.node = null;
    this.audioCtx = null;

    this.paramCount = 0;
    this.paramPtr = 0;
    this.lastParams = null;
  }

  /** Command. Loads the GUI wasm and builds the real editor. */
  async startGui() {
    setStatus('loading Surge GUI...');
    const { default: createSurgeGui } = await import(GUI_MODULE);
    const M = await createSurgeGui();
    this.M = M;   // kept: patches fetched later are written into this filesystem
    this.gui = M;

    const c = (n, r, a) => M.cwrap(n, r, a);
    this.sg = {
      init: c('sgui_init', 'number', ['string']),
      width: c('sgui_width', 'number', []),
      height: c('sgui_height', 'number', []),
      render: c('sgui_render', 'number', []),
      pixels: c('sgui_pixels', 'number', []),
      invalidate: c('sgui_invalidate', null, []),
      mouse: c('sgui_mouse', null, ['number', 'number', 'number', 'number', 'number', 'number', 'number']),
      wheel: c('sgui_wheel', null, ['number', 'number', 'number', 'number', 'number', 'number', 'number']),
      key: c('sgui_key', 'number', ['number', 'number', 'number', 'number', 'number', 'number']),
      focus: c('sgui_focus', null, ['number']),
      paramCount: c('sgui_param_count', 'number', []),
      readParams: c('sgui_read_params', null, ['number']),
      loadPatch: c('sgui_load_patch_path', 'number', ['string', 'string']),
      setScale: c('sgui_set_scale', null, ['number']),
      getScale: c('sgui_get_scale', 'number', []),
      patchCount: c('sgui_patch_count', 'number', []),
      wtCount: c('sgui_wt_count', 'number', []),
      canvasWidth: c('sgui_canvas_width', 'number', []),
      canvasHeight: c('sgui_canvas_height', 'number', []),
    };

    // Mount BEFORE init: SurgeStorage scans for patches in its constructor, so
    // a tree that appears afterwards is invisible to Surge forever.
    setStatus('downloading Surge resources...');
    setProgress(0);
    const [surgeData, remotePaths] = await Promise.all([
      fetchSurgeData((received, total) => setProgress(total ? received / total : null)),
      fetchRemoteIndex(),
    ]);
    this.surgeData = surgeData;
    this.remoteCache = new Set();

    setStatus('mounting Surge resources...');
    clearProgress();
    this.patchIndex = buildPatchIndex(
      this.surgeData.files.map((f) => f.p), remotePaths, SURGE_DATA_ROOT);
    buildPatchTree($('patch-list'), this.patchIndex, (e) => this.loadPatch(e));

    // The skin was applied before these rows existed, so dress them now.
    dressGenerated();

    const mounted = unpackInto(M.FS, this.surgeData.files, this.surgeData.bytes);

    if (!this.sg.init(SURGE_DATA_ROOT)) {
      throw new Error('sgui_init failed -- the editor was not created');
    }

    // Surge's own view of its library, not ours. If this is zero the jog buttons
    // and Surge's patch browser are dead no matter what the sidebar shows.
    const found = this.sg.patchCount();
    console.info(`mounted ${mounted} files; Surge found ${found} patches, ` +
      `${this.sg.wtCount()} wavetables`);
    if (found === 0) {
      fail('Surge found no patches after mounting -- its browser and jog buttons will not work');
    }

    this.canvas = $('surge-canvas');
    this.ctx2d = this.canvas.getContext('2d', { alpha: false });

    // HiDPI on by default: render at the device's real pixel density so Surge's
    // SVG skin is re-rasterized sharp rather than upscaled.
    this.retina = true;
    this.zoom = 1.0;
    this.scale = 1.0;
    this.applyScale();

    this.paramCount = this.sg.paramCount();
    this.paramPtr = M._malloc(this.paramCount * 4);
    this.lastParams = new Float32Array(this.paramCount);

    this.attachInput();
    this.sg.invalidate();
    requestAnimationFrame(() => this.frame());

    setStatus(`Surge GUI ${this.canvas.width}x${this.canvas.height}, ${this.paramCount} parameters`);
    return { w: this.canvas.width, h: this.canvas.height };
  }

  /**
   * Command. Applies zoom x device-pixel-ratio and resizes the canvas to match.
   *
   * Two different sizes are in play and conflating them is the classic HiDPI
   * bug: the canvas BACKING STORE is physical pixels (what Surge renders), while
   * the CSS size is logical pixels (what the page lays out). Setting only the
   * former gives a huge canvas; only the latter gives a blurry one.
   *
   * Mouse mapping needs no change -- pos() already scales through
   * getBoundingClientRect, so it converts CSS pixels to canvas pixels for free.
   */
  applyScale() {
    const dpr = this.retina ? (window.devicePixelRatio || 1) : 1;
    const scale = this.zoom * dpr;

    this.sg.setScale(scale);

    // Logical: Surge's own coordinate space, and what CSS lays out.
    // Physical: what Surge actually rasterizes and what the canvas stores.
    const logicalW = this.sg.width();
    const logicalH = this.sg.height();
    const physW = this.sg.canvasWidth();
    const physH = this.sg.canvasHeight();
    if (physW <= 0 || physH <= 0) {
      throw new Error(`Editor reported a zero size (${physW}x${physH})`);
    }

    this.scale = scale;
    this.canvas.width = physW;
    this.canvas.height = physH;
    // CSS size is the logical size scaled by user zoom only -- NOT by dpr, or a
    // retina display would shrink the panel instead of sharpening it.
    this.canvas.style.width = `${Math.round(logicalW * this.zoom)}px`;
    this.canvas.style.height = `${Math.round(logicalH * this.zoom)}px`;
    this.imageData = this.ctx2d.createImageData(physW, physH);

    this.sg.invalidate();
    $('scale-info').textContent =
      `${Math.round(this.zoom * 100)}%${dpr !== 1 ? ` · ${dpr}x HiDPI` : ''} — ${physW}×${physH}`;
  }

  /** Command. Sets user zoom (1.0 = Surge's native size) and re-lays out. */
  setZoom(zoom) { this.zoom = zoom; this.applyScale(); }

  /** Command. Turns HiDPI rendering on or off and re-lays out. */
  setRetina(on) { this.retina = on; this.applyScale(); }

  /**
   * Command. One animation frame: repaint if dirty, then mirror parameters.
   */
  frame() {
    if (this.sg.render()) {
      const ptr = this.sg.pixels();
      const n = this.canvas.width * this.canvas.height * 4;
      this.imageData.data.set(this.gui.HEAPU8.subarray(ptr, ptr + n));
      this.ctx2d.putImageData(this.imageData, 0, 0);
    }
    this.syncParams();
    requestAnimationFrame(() => this.frame());
  }

  /**
   * Command. Sends parameters that changed in the GUI to the audio engine.
   *
   * Diffing rather than sending all 766 every frame keeps the worklet's message
   * port quiet; a full block would be ~3 KB per frame of pure noise.
   */
  syncParams() {
    if (!this.node || !this.paramCount) return;

    this.sg.readParams(this.paramPtr);
    const cur = this.gui.HEAPF32.subarray(this.paramPtr / 4, this.paramPtr / 4 + this.paramCount);

    for (let i = 0; i < this.paramCount; i++) {
      if (cur[i] !== this.lastParams[i]) {
        this.lastParams[i] = cur[i];
        this.node.port.postMessage({ type: 'setParam', index: i, value: cur[i] });
      }
    }
  }

  /** Command. Routes canvas pointer/key events into Surge. */
  attachInput() {
    const cv = this.canvas;

    // Canvas CSS size may differ from its pixel size on a scaled display, so
    // map through the bounding rect rather than assuming 1:1.
    // Canvas pixels are PHYSICAL; JUCE works in LOGICAL coordinates. Dividing by
    // the render scale is what keeps clicks landing on the right control once
    // zoom or HiDPI is on -- without it every hit is offset by the scale factor.
    const pos = (e) => {
      const r = cv.getBoundingClientRect();
      const s = this.scale || 1;
      return [
        ((e.clientX - r.left) * (cv.width / r.width)) / s,
        ((e.clientY - r.top) * (cv.height / r.height)) / s,
      ];
    };
    const mods = (e) => [e.shiftKey ? 1 : 0, e.ctrlKey ? 1 : 0, e.altKey ? 1 : 0];

    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture(e.pointerId);
      const [x, y] = pos(e);
      this.sg.mouse(1, x, y, e.buttons, ...mods(e));
      e.preventDefault();
    });
    cv.addEventListener('pointermove', (e) => {
      const [x, y] = pos(e);
      this.sg.mouse(0, x, y, e.buttons, ...mods(e));
    });
    const up = (e) => {
      const [x, y] = pos(e);
      this.sg.mouse(2, x, y, e.buttons, ...mods(e));
      cv.releasePointerCapture?.(e.pointerId);
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);

    cv.addEventListener('wheel', (e) => {
      const [x, y] = pos(e);
      this.sg.wheel(x, y, e.deltaX, e.deltaY, ...mods(e));
      e.preventDefault();
    }, { passive: false });

    // Right-click opens Surge's own context menus, so suppress the browser one.
    cv.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('focus', () => this.sg.focus(1));
    window.addEventListener('blur', () => this.sg.focus(0));
  }

  /** Command. Connects the audio engine in an AudioWorklet. */
  async startAudio() {
    this.audioCtx = new AudioContext();
    await this.audioCtx.resume();

    if (!this.audioCtx.audioWorklet) {
      throw new Error(
        `AudioWorklet needs a secure context (origin ${location.origin}). ` +
        `Use ./run_server.sh, which serves HTTPS, or open on http://localhost.`,
      );
    }

    const [wasmBinary] = await Promise.all([
      fetch(ENGINE_WASM).then((r) => {
        if (!r.ok) throw new Error(`${ENGINE_WASM} -> HTTP ${r.status}`);
        return r.arrayBuffer();
      }),
      this.audioCtx.audioWorklet.addModule(WORKLET_BUNDLE),
    ]);

    this.node = new AudioWorkletNode(this.audioCtx, 'surge-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: {
        wasmBinary,
        sampleRate: this.audioCtx.sampleRate,
        dataPath: DATA_PATH,
        // The engine needs the same tree: it is what actually reads a wavetable
        // when a patch asks for one.
        surgeData: { files: this.surgeData.files, bytes: this.surgeData.bytes },
      },
    });
    this.node.onprocessorerror = (e) => fail('Audio processor crashed', e);
    this.node.port.onmessage = (e) => {
      if (e.data.type === 'error') fail(e.data.message);
    };
    this.node.connect(this.audioCtx.destination);

    window.__surgeNode = this.node;
    window.__surgeGui = this;
  }

  /**
   * Command. Wires note input: computer keyboard and the on-screen piano.
   *
   * Both go through noteOn/noteOff below rather than talking to the worklet
   * directly, so the piano lights up for either source and there is exactly one
   * place where a note becomes sound.
   */
  async attachKeys() {
    this.piano = createPiano($('piano'), {
      onNoteOn: (note, velocity) => this.noteOn(note, velocity),
      onNoteOff: (note) => this.noteOff(note),
    });

    // 128 keys that did not exist when the skin was applied.
    dressGenerated();

    // The only channel an input mode has to make sound. Modes never reach the
    // worklet, the synth or the piano directly, which is what lets a new one be
    // added without touching anything here.
    this.io = {
      noteOn: (note, velocity) => this.noteOn(note, velocity),
      noteOff: (note) => this.noteOff(note),
      allNotesOff: () => this.panic(),
      setModeStatus: (text) => { $('kb-state').textContent = text; },
    };

    this.modes = createModeRegistry(INPUT_MODES, this.io, $('mode-panel'));

    const picker = $('mode-select');
    picker.disabled = false;
    picker.addEventListener('change', () => this.setInputMode(picker.value));

    this.shortcutKey = createShortcutKey(BINDINGS);
    this.shortcuts = attachShortcuts(BINDINGS, this);

    await this.setInputMode(keyboardMode.id);
  }

  /**
   * Command. Switches note-input mode, tearing the previous one down.
   *
   * @param {string} id - 'keyboard' | 'pianoroll' | 'notation'
   */
  async setInputMode(id) {
    try {
      await this.modes.activate(id);
      $('mode-select').value = id;
      dressGenerated();
    } catch (err) {
      fail(`Could not switch to input mode "${id}"`, err);
    }
  }

  /** Command. Shows or hides the keyboard legend. */
  toggleShortcutKey() {
    this.shortcutKey.toggle();
  }

  /**
   * Command. What Escape does, which depends on what is on screen.
   *
   * Dismissing the thing in front of you is what Escape means everywhere else,
   * so the legend takes priority. Panic is what is left when nothing is open --
   * and panic while a modal is up is not what anyone pressing Escape wanted.
   */
  escape() {
    if (this.shortcutKey?.isOpen()) {
      this.shortcutKey.close();
      return;
    }
    this.panic();
  }

  /** Command. Silences everything sounding, whatever started it. */
  panic() {
    this.node?.port.postMessage({ type: 'allNotesOff' });
    this.piano?.clear();
  }

  /**
   * Command. Loads the patch `delta` places from the current one.
   *
   * Steps the flat sorted index rather than the DOM, so it is unaffected by
   * which categories happen to be expanded or filtered. Wraps at both ends --
   * there is no useful "you are at the end" state for 3559 patches.
   *
   * @param {number} delta - +1 for next, -1 for previous
   */
  stepPatch(delta) {
    const list = this.patchIndex?.patches;
    if (!list || list.length === 0) return;

    const at = this.patchAt === undefined ? -1 : this.patchAt;
    this.selectPatchAt((at + delta + list.length) % list.length);
  }

  /**
   * Command. Loads the first patch of the category `delta` places away.
   *
   * @param {number} delta - +1 for next, -1 for previous
   */
  stepCategory(delta) {
    const list = this.patchIndex?.patches;
    if (!list || list.length === 0) return;

    const here = list[this.patchAt ?? 0];
    const key = (p) => `${p.bank}/${p.category}`;

    // Walk until the category changes, then keep walking backwards to the
    // FIRST patch of it -- stepping back one should land at the top of the
    // previous category, not its last entry.
    let i = this.patchAt ?? 0;
    for (let n = 0; n < list.length; n++) {
      i = (i + delta + list.length) % list.length;
      if (key(list[i]) !== key(here)) break;
    }
    while (key(list[(i - 1 + list.length) % list.length]) === key(list[i]) && i > 0) i--;

    this.selectPatchAt(i);
  }

  /** Command. Loads a patch at random. */
  randomPatch() {
    const list = this.patchIndex?.patches;
    if (!list || list.length === 0) return;
    this.selectPatchAt(Math.floor(Math.random() * list.length));
  }

  /**
   * Command. Loads the patch at `index` and moves the sidebar selection to it.
   *
   * The sidebar row is found by path rather than position because the tree is
   * nested and its DOM order, while matching, is not something to depend on.
   *
   * @param {number} index - into this.patchIndex.patches
   */
  selectPatchAt(index) {
    const entry = this.patchIndex.patches[index];
    this.patchAt = index;

    const list = $('patch-list');
    list.querySelector('.patch.selected')?.classList.remove('selected');

    const rows = [...list.querySelectorAll('.patch')];
    const row = rows[index];
    if (row) {
      row.classList.add('selected');
      // Open the ancestors, or a jog into a collapsed category selects a row
      // nobody can see.
      for (let el = row.parentElement; el; el = el.parentElement) {
        if (el.tagName === 'DETAILS') el.open = true;
      }
      row.scrollIntoView({ block: 'nearest' });
    }

    this.loadPatch(entry);
  }

  /** Command. Sounds a note and lights its key. */
  noteOn(note, velocity) {
    this.node?.port.postMessage({ type: 'noteOn', channel: 0, key: note, velocity });
    this.piano?.setHeld(note, true);
  }

  /** Command. Releases a note and unlights its key. */
  noteOff(note) {
    this.node?.port.postMessage({ type: 'noteOff', channel: 0, key: note, velocity: 0 });
    this.piano?.setHeld(note, false);
  }

  /** Command. Loads a patch into BOTH instances so picture and sound agree. */
  /**
   * Command. Loads a patch that is already in both filesystems.
   *
   * No fetch and no byte transfer: the archive mounted at startup is present in
   * the GUI module and the worklet alike, so both can be handed the same path
   * and let Surge's own loader read it.
   */
  async loadPatch(entry) {
    // Keep the jog position in step with sidebar clicks, so PageDown after a
    // click continues from what was clicked rather than from wherever the last
    // jog left off.
    const at = this.patchIndex?.patches.indexOf(entry);
    if (at !== undefined && at >= 0) this.patchAt = at;

    setStatus(`loading ${entry.name}...`);
    try {
      // A remote patch has to exist in BOTH filesystems before either Surge is
      // asked for it -- the engine loads by path just like the GUI does.
      if (entry.remote && !this.remoteCache.has(entry.archivePath)) {
        setProgress(null);
        const bytes = await fetchRemotePatch(entry.archivePath);

        writeFileInto(this.M.FS, entry.archivePath, bytes);
        // The worklet has its own heap, so the bytes are copied over rather than
        // shared. `loadPatch` writes them there and loads in one step.
        this.node?.port.postMessage(
          { type: 'loadPatch', path: entry.path, name: entry.name, bytes: bytes.buffer.slice(0) });

        this.remoteCache.add(entry.archivePath);
        clearProgress();

        const ok = this.sg.loadPatch(entry.path, entry.name);
        this.sg.invalidate();
        setStatus(ok ? `Patch: ${entry.name}` : `Surge refused patch: ${entry.name}`);
        if (!ok) fail(`Surge refused the patch "${entry.name}"`);
        return;
      }

      const ok = this.sg.loadPatch(entry.path, entry.name);
      this.node?.port.postMessage({ type: 'loadPatchPath', path: entry.path, name: entry.name });

      this.sg.invalidate();
      setStatus(ok ? `Patch: ${entry.name}` : `Surge refused patch: ${entry.name}`);
      if (!ok) fail(`Surge refused the patch "${entry.name}"`);
    } catch (err) {
      clearProgress();
      fail(`Could not load patch "${entry.name}"`, err);
    }
  }
}

/* ------------------------------------------------------------------ */

const app = new SurgeGuiApp();

// Exposed for the browser tests in tools/ and .frenzy/, which drive the real
// page rather than a mock. Nothing in the app reads this.
window.__app = app;

async function main() {
  // Before anything else: the start overlay is the first thing on screen, and
  // without a skin applied the page renders as unstyled default HTML.
  initThemePicker($('theme-select'));

  // Fill the input picker now rather than in attachKeys(), which does not run
  // until Start is pressed -- the toolbar showed an empty dropdown until then.
  // Disabled until there is an engine to send notes to.
  const picker = $('mode-select');
  picker.disabled = true;
  for (const mode of INPUT_MODES) {
    const option = document.createElement('option');
    option.value = mode.id;
    option.textContent = mode.label;
    picker.append(option);
  }

  $('start-btn').addEventListener('click', async () => {
    $('start-btn').disabled = true;
    try {
      await app.startGui();
      await app.startAudio();
      await app.attachKeys();
      $('overlay').hidden = true;
      setStatus(`ready -- ${app.paramCount} parameters`);
    } catch (err) {
      fail('Could not start Surge', err);
      $('start-btn').disabled = false;
    }
  });

  $('zoom-select').addEventListener('change', (e) => {
    try { app.setZoom(parseFloat(e.target.value)); }
    catch (err) { fail('Could not change zoom', err); }
  });

  $('retina-toggle').addEventListener('change', (e) => {
    try { app.setRetina(e.target.checked); }
    catch (err) { fail('Could not change HiDPI setting', err); }
  });

  $('panic-btn').addEventListener('click', () => app.panic());
}

main();
