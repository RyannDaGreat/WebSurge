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
import { loadPatchIndex, buildPatchTree } from './patches.js';

const GUI_MODULE = './surge-gui.js';
const WORKLET_BUNDLE = 'js/surge-worklet-bundle.js';
const ENGINE_WASM = 'js/surge-engine.wasm';

/** Where Surge's resources are mounted inside each Emscripten filesystem. */
const DATA_PATH = '/SurgeXTData';

const $ = (id) => document.getElementById(id);
const setStatus = (m) => { $('status').textContent = m; };

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
    this.gui = M;

    const c = (n, r, a) => M.cwrap(n, r, a);
    this.sg = {
      init: c('sgui_init', 'number', []),
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
    };

    if (!this.sg.init()) throw new Error('sgui_init failed -- the editor was not created');

    const w = this.sg.width();
    const h = this.sg.height();
    if (w <= 0 || h <= 0) throw new Error(`Editor reported a zero size (${w}x${h})`);

    this.canvas = $('surge-canvas');
    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx2d = this.canvas.getContext('2d', { alpha: false });
    this.imageData = this.ctx2d.createImageData(w, h);

    this.paramCount = this.sg.paramCount();
    this.paramPtr = M._malloc(this.paramCount * 4);
    this.lastParams = new Float32Array(this.paramCount);

    this.attachInput();
    this.sg.invalidate();
    requestAnimationFrame(() => this.frame());

    setStatus(`Surge GUI ${w}x${h}, ${this.paramCount} parameters`);
    return { w, h };
  }

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
    const pos = (e) => {
      const r = cv.getBoundingClientRect();
      return [
        (e.clientX - r.left) * (cv.width / r.width),
        (e.clientY - r.top) * (cv.height / r.height),
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
      processorOptions: { wasmBinary, sampleRate: this.audioCtx.sampleRate, dataPath: DATA_PATH },
    });
    this.node.onprocessorerror = (e) => fail('Audio processor crashed', e);
    this.node.port.onmessage = (e) => {
      if (e.data.type === 'error') fail(e.data.message);
    };
    this.node.connect(this.audioCtx.destination);

    window.__surgeNode = this.node;
    window.__surgeGui = this;
  }

  /** Command. Wires the computer keyboard to note input. */
  attachKeys() {
    attachKeyboard({
      onNoteOn: (note, velocity) =>
        this.node?.port.postMessage({ type: 'noteOn', channel: 0, key: note, velocity }),
      onNoteOff: (note) =>
        this.node?.port.postMessage({ type: 'noteOff', channel: 0, key: note, velocity: 0 }),
      onStateChange: ({ octave, velocity }) => {
        $('kb-state').textContent = `octave ${octave >= 0 ? '+' : ''}${octave} · vel ${velocity}`;
      },
    });
  }

  /** Command. Loads a patch into BOTH instances so picture and sound agree. */
  async loadPatch(entry) {
    setStatus(`loading ${entry.name}...`);
    try {
      const res = await fetch(entry.path);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());

      // GUI instance: write into its filesystem and let Surge parse the fxp.
      this.gui.FS.writeFile('/tmp/patch.fxp', bytes);
      const ok = this.sg.loadPatch('/tmp/patch.fxp', entry.name);

      // Audio instance: same bytes, its own filesystem.
      const copy = bytes.slice().buffer;
      this.node?.port.postMessage(
        { type: 'loadPatch', path: '/tmp/patch.fxp', name: entry.name, bytes: copy }, [copy]);

      this.sg.invalidate();
      setStatus(ok ? `Patch: ${entry.name}` : `Surge refused patch: ${entry.name}`);
      if (!ok) fail(`Surge refused the patch "${entry.name}"`);
    } catch (err) {
      fail(`Could not load patch "${entry.name}"`, err);
    }
  }
}

/* ------------------------------------------------------------------ */

const app = new SurgeGuiApp();

async function main() {
  loadPatchIndex()
    .then((index) => buildPatchTree($('patch-list'), index, (e) => app.loadPatch(e)))
    .catch((err) => fail('Could not load the patch index', err));

  $('start-btn').addEventListener('click', async () => {
    $('start-btn').disabled = true;
    try {
      await app.startGui();
      await app.startAudio();
      app.attachKeys();
      $('overlay').hidden = true;
      setStatus(`ready -- ${app.paramCount} parameters`);
    } catch (err) {
      fail('Could not start Surge', err);
      $('start-btn').disabled = false;
    }
  });

  $('panic-btn').addEventListener('click', () =>
    app.node?.port.postMessage({ type: 'allNotesOff' }));
}

main();
