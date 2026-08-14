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

/**
 * Command. Writes the packed resource archive into the engine's filesystem.
 *
 * Duplicated from surge-data.js on purpose: the worklet bundle is a concatenated
 * classic script with no module loader, so it cannot import. Kept deliberately
 * small for that reason -- see surge-data.js for the full rationale.
 *
 * @param {object} FS - the Emscripten filesystem
 * @param {Array<{p: string, o: number, n: number}>} files
 * @param {Uint8Array} bytes
 * @param {string} root - mount point
 */
function mountSurgeData(FS, files, bytes, root) {
  const mk = (path) => makeDirs(FS, path);
  mk(root);

  const dirs = new Set();
  for (const f of files) {
    const parts = f.p.split('/');
    parts.pop();
    let acc = '';
    for (const part of parts) { acc = acc ? `${acc}/${part}` : part; dirs.add(acc); }
  }
  // Parents before children: MEMFS has no mkdir -p.
  for (const d of [...dirs].sort((a, b) => a.split('/').length - b.split('/').length)) {
    mk(`${root}/${d}`);
  }

  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (const f of files) FS.writeFile(`${root}/${f.p}`, data.subarray(f.o, f.o + f.n));
}

/**
 * Pure function. Renders any thrown value as readable text.
 *
 * Emscripten's ErrnoError carries `errno` and no `message`, so the default
 * interpolation of it is the string "[object Object]" -- which says nothing at
 * all about what went wrong.
 *
 * @param {unknown} err
 * @returns {string}
 *
 * @example describeError(new Error('nope'))   // 'nope'
 * @example describeError({ errno: 44 })       // 'errno 44'
 */
function describeError(err) {
  if (!err) return String(err);
  if (err.message) return err.message;
  if (err.errno !== undefined) return `errno ${err.errno}${err.code ? ` (${err.code})` : ''}`;
  try { return JSON.stringify(err); } catch { return String(err); }
}

/**
 * Command. Creates every parent directory of an absolute MEMFS path.
 *
 * MEMFS has no mkdir -p, so the path is walked from the root down.
 *
 * @param {object} FS - the Emscripten filesystem
 * @param {string} path - absolute file path, e.g. '/SurgeXTData/a/b/Patch.fxp'
 */
function makeParentDirs(FS, path) {
  const parts = path.split('/').filter(Boolean);
  parts.pop(); // the filename

  let acc = '';
  for (const part of parts) {
    acc += `/${part}`;
    makeDirs(FS, acc);
  }
}

/**
 * Command. Creates `path` and any missing parents. Absolute paths only.
 *
 * Existence is TESTED rather than mkdir-and-catch-EEXIST. Emscripten only
 * populates ErrnoError's `.code` and `.message` when built with assertions, so
 * the engine module -- which is not -- raises a bare `{errno: 20}` that no
 * string comparison recognises. Testing first also means a real failure (a
 * permissions problem, a file where a directory should be) propagates loudly
 * instead of being swallowed by an over-broad catch.
 *
 * @param {object} FS - the Emscripten filesystem
 * @param {string} dir - absolute directory path
 *
 * @example makeDirs(FS, '/SurgeXTData/patches_3rdparty/A.Liv/Basses')
 */
function makeDirs(FS, dir) {
  if (FS.analyzePath(dir).exists) return;
  FS.mkdir(dir);
}

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

    const { wasmBinary, sampleRate: sr, dataPath, surgeData } = options.processorOptions;
    this.surgeData = surgeData;
    if (!wasmBinary) throw new Error('surge-worklet: wasmBinary was not supplied');

    // createSurgeEngine comes from the glue concatenated ahead of this file.
    //
    // The .catch is load-bearing: a rejection here happens inside the worklet's
    // constructor, where neither onprocessorerror nor the page's console sees
    // it. Without this the node simply stays silent forever with no diagnostic
    // anywhere -- which is the exact failure mode this project forbids.
    createSurgeEngine({ wasmBinary })
      .then((M) => this.onEngineReady(M, sr, dataPath || ''))
      .catch((err) => {
        this.port.postMessage({
          type: 'error',
          message: `Engine failed to start: ${err && (err.message || err)}`,
          stack: err && err.stack ? String(err.stack) : undefined,
        });
      });
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
      setMacro: c('sh_set_macro', null, ['number', 'number']),
      setParam: c('sh_set_param', null, ['number', 'number']),
      getParam: c('sh_get_param', 'number', ['number']),
      paramDisplay: c('sh_param_display', 'string', ['number']),
      metadata: c('sh_metadata_json', 'string', []),
      loadPatchPath: c('sh_load_patch_path', 'number', ['string', 'string']),
    };

    // Mount the resource tree BEFORE sh_init: SurgeStorage scans for wavetables
    // in its constructor, and the engine is what actually reads one when a patch
    // asks for it. Without this, wavetable patches load but sound wrong.
    if (this.surgeData) {
      mountSurgeData(M.FS, this.surgeData.files, this.surgeData.bytes, dataPath);
      this.surgeData = null; // release the copy; it is ~29 MB
    }

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
      case 'setMacro': sh.setMacro(msg.index | 0, msg.value); break;
      case 'setParam': sh.setParam(msg.index | 0, msg.value); break;

      case 'loadPatchPath': {
        // The archive is mounted here too, so the path alone is enough -- no
        // need to ship the bytes across from the main thread.
        const ok = sh.loadPatchPath(msg.path, msg.name);
        this.port.postMessage({ type: 'patchLoaded', name: msg.name, ok: !!ok });
        if (!ok) {
          this.port.postMessage({ type: 'error', message: `Surge refused patch "${msg.name}"` });
        }
        break;
      }

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
      // Patches fetched on demand land in directories that were never mounted
      // -- only the factory bank and wavetables are in the startup archive. A
      // bare writeFile into a missing directory fails with an ErrnoError whose
      // .message is undefined, which is a genuinely unhelpful thing to report.
      makeParentDirs(M.FS, path);
      M.FS.writeFile(path, new Uint8Array(bytes));
      const ok = this.sh.loadPatchPath(path, name);
      this.port.postMessage({ type: 'patchLoaded', name, ok: !!ok });
      if (!ok) this.port.postMessage({ type: 'error', message: `Surge refused patch "${name}"` });
    } catch (err) {
      this.port.postMessage({ type: 'error', message: `Loading "${name}" failed: ${describeError(err)}` });
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
