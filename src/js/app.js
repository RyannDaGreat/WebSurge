/**
 * app.js -- wires the Surge engine, its real GUI, the patch browser and the
 * computer keyboard together.
 *
 * Startup order matters and is not arbitrary:
 *   1. An AudioContext cannot start without a user gesture, so everything waits
 *      behind the overlay.
 *   2. The .wasm must be fetched here on the main thread -- AudioWorkletGlobalScope
 *      has no fetch -- and handed to the worklet as bytes.
 *   3. The GUI is built only after the engine reports its parameter table, since
 *      controls bind by ui_identifier and that table is the source of truth.
 */

'use strict';

import { createWidget, PANEL_WIDTH, PANEL_HEIGHT } from './widgets.js';
import { attachKeyboard } from './keyboard.js';
import { loadPatchIndex, buildPatchTree } from './patches.js';

const WORKLET_BUNDLE = 'js/surge-worklet-bundle.js';
const ENGINE_WASM = 'js/surge-engine.wasm';
const LAYOUT_URL = 'layout.json';

/** Where Surge's factory resources are mounted inside the Emscripten filesystem. */
const DATA_PATH = '/SurgeXTData';

/** How often to pull parameter values back from the engine, in ms. */
const PARAM_POLL_MS = 120;

const $ = (id) => document.getElementById(id);
const setStatus = (msg) => { $('status').textContent = msg; };

/**
 * Command. Reports a failure to the user instead of leaving a dead interface.
 *
 * Silent failure is the specific hazard in a synthesizer: a broken engine and a
 * quiet patch look identical. Everything that can fail routes here.
 */
function fail(message, err) {
  console.error(message, err || '');
  setStatus(`ERROR: ${message}`);
  $('error-bar').textContent = message + (err ? ` -- ${err.message || err}` : '');
  $('error-bar').hidden = false;
}

class SurgeApp {
  constructor() {
    this.ctx = null;
    this.node = null;
    this.params = [];
    this.byIndex = new Map();
    this.widgets = new Map(); // param index -> element
    this.connectors = new Map();
    this.keyboard = null;
  }

  /** Command. Fetches the connector table dumped from Surge's skin model. */
  async loadLayout() {
    const res = await fetch(LAYOUT_URL);
    if (!res.ok) throw new Error(`${LAYOUT_URL} -> HTTP ${res.status}`);
    const layout = await res.json();
    for (const c of layout.connectors) this.connectors.set(c.id, c);
    return layout;
  }

  /**
   * Command. Boots audio. Must be called from a user gesture.
   */
  async start() {
    this.ctx = new AudioContext();
    await this.ctx.resume();

    // AudioWorklet is only exposed in a SECURE CONTEXT. Browsers treat
    // http://localhost as secure but a plain-http LAN address as insecure, so
    // over the LAN `audioWorklet` is simply undefined -- which otherwise
    // surfaces as an opaque "Cannot read properties of undefined (reading
    // 'addModule')". Say what is actually wrong and how to fix it.
    if (!this.ctx.audioWorklet) {
      throw new Error(
        `AudioWorklet is unavailable because this page is not a secure context ` +
        `(origin ${location.origin}). Serve over HTTPS -- run ./run_server.sh --tls -- ` +
        `or open the site on http://localhost, which browsers treat as secure.`,
      );
    }

    setStatus('loading engine...');
    const [wasmBinary] = await Promise.all([
      fetch(ENGINE_WASM).then((r) => {
        if (!r.ok) throw new Error(`${ENGINE_WASM} -> HTTP ${r.status}`);
        return r.arrayBuffer();
      }),
      this.ctx.audioWorklet.addModule(WORKLET_BUNDLE),
    ]);

    this.node = new AudioWorkletNode(this.ctx, 'surge-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { wasmBinary, sampleRate: this.ctx.sampleRate, dataPath: DATA_PATH },
    });

    // Exposed so tools/browser_test.mjs can observe the messages the UI sends
    // to the audio thread. Headless Chrome has no speakers, so asserting on the
    // control messages is the only honest way to test note input end to end.
    window.__surgeNode = this.node;

    this.node.port.onmessage = (e) => this.onWorkletMessage(e.data);
    this.node.onprocessorerror = (e) => fail('Audio processor crashed', e);
    this.node.connect(this.ctx.destination);

    setStatus('starting engine...');
  }

  /** Command. Handles a message from the audio thread. */
  onWorkletMessage(msg) {
    switch (msg.type) {
      case 'ready':
        this.onEngineReady(JSON.parse(msg.metadata));
        break;
      case 'params':
        this.applyParamValues(msg.values);
        break;
      case 'metadata':
        this.refreshMetadata(JSON.parse(msg.metadata));
        break;
      case 'patchLoaded':
        setStatus(msg.ok ? `Patch: ${msg.name}` : `Patch failed: ${msg.name}`);
        break;
      case 'error':
        fail(msg.message);
        break;
      default:
        console.warn('unhandled worklet message', msg);
    }
  }

  /** Command. Builds the interface once the engine has reported its parameters. */
  onEngineReady(meta) {
    this.params = meta.params;
    for (const p of this.params) this.byIndex.set(p.index, p);

    this.buildGui();
    this.attachInput();

    setStatus(`ready -- ${this.params.length} parameters, ${this.widgets.size} controls`);
    $('overlay').hidden = true;

    setInterval(() => this.node.port.postMessage(
      { type: 'requestParams', count: this.params.length }), PARAM_POLL_MS);
  }

  /**
   * Command. Instantiates a widget for every parameter that has a connector.
   *
   * Parameters without one are counted and reported rather than ignored: a
   * growing unplaced count is how we would notice Surge adding controls that
   * this GUI does not yet draw.
   */
  buildGui() {
    const panel = $('panel');
    const onChange = (index, value) =>
      this.node.port.postMessage({ type: 'setParam', index, value });

    /*
     * A connector is a PLACE on the panel, and several parameters can share one.
     * Surge has two scenes and six LFOs per scene, but only one filter-cutoff
     * slider and one LFO display; the desktop plugin points that single control
     * at whichever scene and LFO is currently selected.
     *
     * Creating a widget per parameter therefore stacks 12 LFO displays and two
     * of every scene control on the same pixels -- which is exactly what the
     * first render did. Bind one widget per connector instead, to the first
     * parameter claiming it, which is scene A. Following the scene/LFO
     * selection is tracked on the backburner.
     */
    const taken = new Map(); // uiid -> param index that owns the widget
    let unplaced = 0;
    let shared = 0;

    for (const p of this.params) {
      const conn = this.connectors.get(p.uiid);
      if (!conn) { unplaced++; continue; }
      if (taken.has(p.uiid)) { shared++; continue; }
      taken.set(p.uiid, p.index);

      const el = createWidget(p, conn, this.connectors, onChange);
      panel.append(el);
      this.widgets.set(p.index, el);
    }

    console.info(`${this.widgets.size} controls placed, ` +
      `${shared} parameters share a connector, ${unplaced} have none`);
    if (unplaced > 0) $('unplaced').textContent = `${unplaced} unplaced`;
  }

  /** Command. Pushes fresh engine values into the widgets. */
  applyParamValues(values) {
    for (const [index, el] of this.widgets) {
      const v = values[index];
      if (v !== undefined) el.setValue?.(v);
    }
  }

  /** Command. Rebuilds cached metadata after a patch or type change renames things. */
  refreshMetadata(meta) {
    this.params = meta.params;
    for (const p of this.params) {
      this.byIndex.set(p.index, p);
      this.widgets.get(p.index)?.setDisplay?.(p.display);
    }
  }

  /** Command. Connects the computer keyboard and the on-screen note buttons. */
  attachInput() {
    const send = (type, extra) => this.node.port.postMessage({ type, channel: 0, ...extra });

    this.keyboard = attachKeyboard({
      onNoteOn: (note, velocity) => send('noteOn', { key: note, velocity }),
      onNoteOff: (note) => send('noteOff', { key: note, velocity: 0 }),
      onStateChange: ({ octave, velocity }) => {
        $('kb-state').textContent = `octave ${octave >= 0 ? '+' : ''}${octave} · velocity ${velocity}`;
      },
    });
  }

  /**
   * Command. Loads a patch by fetching its .fxp and handing the bytes to Surge.
   *
   * The browser never parses the fxp format; Surge's own loader does, on the
   * audio thread, after the bytes are written into its filesystem.
   */
  async loadPatch(entry) {
    setStatus(`loading ${entry.name}...`);
    try {
      const res = await fetch(entry.path);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = await res.arrayBuffer();
      this.node.port.postMessage(
        { type: 'loadPatch', path: `/tmp/patch.fxp`, name: entry.name, bytes }, [bytes]);
      // Names and value formatting change with the patch, so re-pull metadata.
      setTimeout(() => this.node.port.postMessage({ type: 'requestMetadata' }), 200);
    } catch (err) {
      fail(`Could not load patch "${entry.name}"`, err);
    }
  }
}

/* ------------------------------------------------------------------ */

const app = new SurgeApp();

async function main() {
  const panel = $('panel');
  panel.style.width = `${PANEL_WIDTH}px`;
  panel.style.height = `${PANEL_HEIGHT}px`;

  try {
    const layout = await app.loadLayout();
    setStatus(`layout: ${layout.connectors.length} connectors -- click to start audio`);
  } catch (err) {
    fail('Could not load layout.json', err);
    return;
  }

  // The patch index is independent of audio, so populate the browser up front.
  loadPatchIndex()
    .then((index) => buildPatchTree($('patch-list'), index, (entry) => app.loadPatch(entry)))
    .catch((err) => fail('Could not load the patch index', err));

  $('start-btn').addEventListener('click', async () => {
    $('start-btn').disabled = true;
    try {
      await app.start();
    } catch (err) {
      fail('Could not start audio', err);
      $('start-btn').disabled = false;
    }
  });

  $('panic-btn').addEventListener('click', () =>
    app.node?.port.postMessage({ type: 'allNotesOff' }));
}

main();
