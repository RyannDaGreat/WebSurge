/**
 * surge-worklet.js -- AudioWorkletProcessor that runs the Surge engine.
 *
 * CONSTRAINTS THIS FILE EXISTS TO WORK AROUND
 * -------------------------------------------
 * AudioWorkletGlobalScope is a hostile environment for WASM:
 *   - no `fetch` and no XMLHttpRequest, so the .wasm cannot be loaded here
 *   - no ES module `import`, so the Emscripten glue cannot be imported
 *   - no `await` at top level in the constructor path
 *   - neither `window` nor `WorkerGlobalScope` is defined
 *
 * The standard resolution, and the one used here:
 *   1. build.sh concatenates the Emscripten glue (surge-engine.js) in front of
 *      this file to produce surge-worklet-bundle.js, so both share one global
 *      scope and no import is needed.
 *   2. The main thread fetches the .wasm bytes itself and posts the ArrayBuffer
 *      in via processor options, so the glue never tries to load anything.
 *
 * Audio runs on the realtime thread; anything slow here is an audible glitch.
 * Patch loading is therefore explicitly NOT done on this thread -- see below.
 */

'use strict';

/** Render quantum fixed by the Web Audio spec. Surge's internal block is 32, which divides it evenly. */
const QUANTUM = 128;

class SurgeProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    this.ready = false;
    this.engine = null;
    this.sh = null;
    this.ptrL = 0;
    this.ptrR = 0;

    // Queued messages that arrived before the engine finished instantiating.
    // Dropping them would silently lose the first notes the user plays.
    this.pending = [];

    this.port.onmessage = (e) => this.onMessage(e.data);

    const { wasmBinary, sampleRate: sr, dataPath } = options.processorOptions;
    if (!wasmBinary) throw new Error('surge-worklet: wasmBinary was not supplied');

    // createSurgeEngine comes from the glue concatenated ahead of this file.
    createSurgeEngine({ wasmBinary }).then((M) => this.onEngineReady(M, sr, dataPath || ''));
  }

  /**
   * Command. Binds the C API and drains anything queued during startup.
   * Mutates this.engine/this.sh and allocates render buffers in the wasm heap.
   */
  onEngineReady(M, sr, dataPath) {
    this.engine = M;
    const c = (name, ret, args) => M.cwrap(name, ret, args);

    this.sh = {
      init: c('sh_init', 'number', ['number', 'string']),
      render: c('sh_render', 'number', ['number', 'number', 'number']),
      noteOn: c('sh_note_on', null, ['number', 'number', 'number']),
      noteOff: c('sh_note_off', null, ['number', 'number', 'number']),
      allNotesOff: c('sh_all_notes_off', null, []),
      pitchBend: c('sh_pitch_bend', null, ['number', 'number']),
      cc: c('sh_cc', null, ['number', 'number', 'number']),
      setParam: c('sh_set_param', null, ['number', 'number']),
      getParam: c('sh_get_param', 'number', ['number']),
      paramDisplay: c('sh_param_display', 'string', ['number']),
      metadata: c('sh_metadata_json', 'string', []),
      loadPatchPath: c('sh_load_patch_path', 'number', ['string', 'string']),
    };

    if (!this.sh.init(sr, dataPath)) throw new Error('surge-worklet: sh_init failed');

    this.ptrL = M._malloc(QUANTUM * 4);
    this.ptrR = M._malloc(QUANTUM * 4);
    this.ready = true;

    for (const msg of this.pending) this.handle(msg);
    this.pending.length = 0;

    this.port.postMessage({ type: 'ready', metadata: this.sh.metadata() });
  }

  /** Command. Buffers messages until the engine exists, then dispatches them. */
  onMessage(msg) {
    if (!this.ready) {
      this.pending.push(msg);
      return;
    }
    this.handle(msg);
  }

  /**
   * Command. Applies one control message to the engine.
   *
   * Unknown message types throw rather than being ignored: a silently dropped
   * message would present as "the GUI does nothing", which is far harder to
   * diagnose than a console error.
   */
  handle(msg) {
    const sh = this.sh;
    switch (msg.type) {
      case 'noteOn': sh.noteOn(msg.channel | 0, msg.key | 0, msg.velocity | 0); break;
      case 'noteOff': sh.noteOff(msg.channel | 0, msg.key | 0, msg.velocity | 0); break;
      case 'allNotesOff': sh.allNotesOff(); break;
      case 'pitchBend': sh.pitchBend(msg.channel | 0, msg.value | 0); break;
      case 'cc': sh.cc(msg.channel | 0, msg.cc | 0, msg.value | 0); break;
      case 'setParam': sh.setParam(msg.index | 0, msg.value); break;

      case 'loadPatch':
        // The .fxp bytes are written into the Emscripten filesystem and handed to
        // Surge's own loader, so the browser never reimplements the fxp format.
        this.loadPatch(msg.path, msg.name, msg.bytes);
        break;

      case 'requestParams':
        this.port.postMessage({ type: 'params', values: this.readAllParams(msg.count) });
        break;

      case 'requestMetadata':
        this.port.postMessage({ type: 'metadata', metadata: sh.metadata() });
        break;

      default:
        throw new Error(`surge-worklet: unknown message type '${msg.type}'`);
    }
  }

  /**
   * Command. Writes patch bytes into MEMFS and asks Surge to load them.
   *
   * Reports success or failure back to the main thread. A patch that fails to
   * load must never present as silence -- the UI surfaces the error.
   */
  loadPatch(path, name, bytes) {
    const M = this.engine;
    try {
      M.FS.writeFile(path, new Uint8Array(bytes));
      const ok = this.sh.loadPatchPath(path, name);
      this.port.postMessage({ type: 'patchLoaded', name, ok: !!ok });
      if (!ok) this.port.postMessage({ type: 'error', message: `Surge refused patch "${name}"` });
    } catch (err) {
      this.port.postMessage({ type: 'error', message: `Loading "${name}" failed: ${err.message}` });
    }
  }

  /**
   * Query. Current normalized values of the first `count` parameters.
   * @returns {Float32Array}
   */
  readAllParams(count) {
    const out = new Float32Array(count);
    for (let i = 0; i < count; i++) out[i] = this.sh.getParam(i);
    return out;
  }

  /**
   * Command. Renders one quantum. Called on the realtime audio thread.
   *
   * Returns true to stay alive even while silent -- returning false would let
   * the browser garbage-collect the node and the synth would go permanently mute.
   */
  process(inputs, outputs) {
    const out = outputs[0];
    if (!this.ready) return true; // still starting up; emit the silence the caller pre-zeroed

    const n = out[0].length;
    this.sh.render(this.ptrL, this.ptrR, n);

    const heap = this.engine.HEAPF32;
    const l = this.ptrL >> 2;
    const r = this.ptrR >> 2;
    out[0].set(heap.subarray(l, l + n));
    if (out.length > 1) out[1].set(heap.subarray(r, r + n));

    return true;
  }
}

registerProcessor('surge-processor', SurgeProcessor);
