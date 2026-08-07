/**
 * verify_audio.mjs -- prove the WASM engine actually makes sound.
 *
 * A successful compile says nothing about whether Surge is synthesizing. This
 * loads the engine headlessly, plays a note, renders real samples, and reports
 * peak/RMS. It also writes a WAV so the output can be listened to rather than
 * merely measured.
 *
 * Silence is the dangerous failure here: a synth that renders zeros looks
 * exactly like a quiet patch. So this exits non-zero on silence rather than
 * printing a cheerful summary.
 *
 * Usage:  node tools/verify_audio.mjs
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE_RATE = 48000;
const RENDER_SECONDS = 2.0;
const CHUNK_FRAMES = 128; // matches the AudioWorklet render quantum
const MIDDLE_C = 60;
const VELOCITY = 100;
const NOTE_OFF_AT = 1.5; // seconds; leaves room to hear the release tail

// Below this peak we treat the render as silent. Chosen well under any audible
// signal but above pure denormal noise.
const SILENCE_PEAK_THRESHOLD = 1e-4;

// Empty on purpose. This test checks that the ENGINE synthesizes, using Surge's
// built-in init patch, whose oscillators need no wavetable from disk
// (configuration.xml and windows.wt are compiled into the binary). Mounting the
// ~480 MB resource tree is a separate concern, verified separately.
const DATA_PATH = '';

/**
 * Pure function. Encodes interleaved stereo float samples as a 16-bit PCM WAV.
 *
 * @param {Float32Array} left - left channel, length N
 * @param {Float32Array} right - right channel, length N
 * @param {number} sampleRate
 * @returns {Buffer} complete .wav file bytes
 *
 * @example wavFromStereo(new Float32Array([0,1]), new Float32Array([0,1]), 48000).length // 52
 */
function wavFromStereo(left, right, sampleRate) {
  const frames = left.length;
  const blockAlign = 2 * 2; // 2 channels * 16-bit
  const dataBytes = frames * blockAlign;
  const buf = Buffer.alloc(44 + dataBytes);

  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); // PCM header size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(2, 22); // channels
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * blockAlign, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);

  for (let i = 0; i < frames; i++) {
    for (const [ch, src] of [[0, left], [1, right]]) {
      const clamped = Math.max(-1, Math.min(1, src[i]));
      buf.writeInt16LE(Math.round(clamped * 32767), 44 + i * blockAlign + ch * 2);
    }
  }
  return buf;
}

/**
 * Pure function. Peak absolute value and RMS of a sample buffer.
 *
 * @param {Float32Array} samples
 * @returns {{peak: number, rms: number}}
 *
 * @example levels(new Float32Array([0.5, -1.0])) // { peak: 1, rms: 0.7905... }
 */
function levels(samples) {
  let peak = 0;
  let sumSq = 0;
  for (const s of samples) {
    const a = Math.abs(s);
    if (a > peak) peak = a;
    sumSq += s * s;
  }
  return { peak, rms: Math.sqrt(sumSq / (samples.length || 1)) };
}

/**
 * Query. Loads the Emscripten engine glue and returns its factory function.
 *
 * The glue ends in `module.exports = createSurgeEngine`, i.e. it is CommonJS.
 * But the root package.json declares "type": "module", so Node treats the .js
 * as ESM: `import()` yields no default and `require()` yields a namespace
 * object. Neither is callable, and the failure reads as the unhelpful
 * "createSurgeEngine is not a function".
 *
 * Evaluating the source with a CommonJS-shaped scope is the honest fix and
 * keeps it local to this harness -- the browser never hits this, because the
 * worklet bundle concatenates the glue as a plain script rather than importing it.
 *
 * @param {string} path - absolute path to surge-engine.js
 * @returns {Function} the module factory
 *
 * @example loadEngineFactory('/…/surge-engine.js') // async function createSurgeEngine()
 */
function loadEngineFactory(path) {
  const src = readFileSync(path, 'utf8');
  const module = { exports: {} };
  const fn = new Function('module', 'exports', 'require', '__dirname', '__filename', src);
  fn(module, module.exports, createRequire(import.meta.url), dirname(path), path);

  const factory = typeof module.exports === 'function' ? module.exports : module.exports.default;
  if (typeof factory !== 'function') {
    throw new Error(`${path} did not export a factory function`);
  }
  return factory;
}

const enginePath = join(REPO_ROOT, 'src/js/surge-engine.js');
const createSurgeEngine = loadEngineFactory(enginePath);

console.log('loading engine...');
const M = await createSurgeEngine();

const sh = {
  init: M.cwrap('sh_init', 'number', ['number', 'string']),
  paramCount: M.cwrap('sh_param_count', 'number', []),
  metadata: M.cwrap('sh_metadata_json', 'string', []),
  noteOn: M.cwrap('sh_note_on', null, ['number', 'number', 'number']),
  noteOff: M.cwrap('sh_note_off', null, ['number', 'number', 'number']),
  render: M.cwrap('sh_render', 'number', ['number', 'number', 'number']),
  blockSize: M.cwrap('sh_block_size', 'number', []),
  dataPath: M.cwrap('sh_data_path', 'string', []),
};

if (!sh.init(SAMPLE_RATE, DATA_PATH)) throw new Error('sh_init failed');

console.log(`  block size : ${sh.blockSize()}`);
console.log(`  data path  : ${sh.dataPath() || '(none)'}`);
console.log(`  parameters : ${sh.paramCount()}`);

const meta = JSON.parse(sh.metadata());
console.log(`  metadata   : ${meta.params.length} params`);
const withUiid = meta.params.filter((p) => p.uiid && p.uiid.length > 0);
console.log(`  with uiid  : ${withUiid.length} (these bind to layout.json connectors)`);
console.log('  samples    :', withUiid.slice(0, 5).map((p) => p.uiid).join(', '));

// Scratch buffers inside the wasm heap for the engine to render into.
const bytes = CHUNK_FRAMES * 4;
const ptrL = M._malloc(bytes);
const ptrR = M._malloc(bytes);

const totalFrames = Math.floor(SAMPLE_RATE * RENDER_SECONDS);
const outL = new Float32Array(totalFrames);
const outR = new Float32Array(totalFrames);

console.log(`\nplaying note ${MIDDLE_C} for ${NOTE_OFF_AT}s, rendering ${RENDER_SECONDS}s...`);
sh.noteOn(0, MIDDLE_C, VELOCITY);

let released = false;
for (let pos = 0; pos < totalFrames; pos += CHUNK_FRAMES) {
  if (!released && pos / SAMPLE_RATE >= NOTE_OFF_AT) {
    sh.noteOff(0, MIDDLE_C, 0);
    released = true;
  }
  const n = Math.min(CHUNK_FRAMES, totalFrames - pos);
  sh.render(ptrL, ptrR, n);
  outL.set(M.HEAPF32.subarray(ptrL / 4, ptrL / 4 + n), pos);
  outR.set(M.HEAPF32.subarray(ptrR / 4, ptrR / 4 + n), pos);
}

M._free(ptrL);
M._free(ptrR);

const l = levels(outL);
const r = levels(outR);
console.log(`\n  left  peak ${l.peak.toFixed(6)}  rms ${l.rms.toFixed(6)}`);
console.log(`  right peak ${r.peak.toFixed(6)}  rms ${r.rms.toFixed(6)}`);

const outDir = join(REPO_ROOT, '.claude_vlm_checks');
mkdirSync(outDir, { recursive: true });
const wavPath = join(outDir, 'verify_audio.wav');
writeFileSync(wavPath, wavFromStereo(outL, outR, SAMPLE_RATE));
console.log(`\n  wrote ${wavPath}`);

if (Math.max(l.peak, r.peak) < SILENCE_PEAK_THRESHOLD) {
  console.error('\nFAIL: engine rendered silence. The init patch should sound.');
  process.exit(1);
}
console.log('\nPASS: engine produced audio.');
