/**
 * worklet-prelude.js -- globals the Emscripten runtime expects that
 * AudioWorkletGlobalScope does not provide.
 *
 * build.sh concatenates this AHEAD of the Emscripten glue. It must therefore
 * define things eagerly, before any glue code runs.
 *
 * AudioWorkletGlobalScope is intentionally minimal: it is not a Window and not
 * a Worker, so Emscripten classifies it as a "shell" environment and reaches
 * for a handful of globals that simply are not there. Each shim below exists
 * because its absence was observed to break startup, not defensively.
 *
 * Everything is guarded with `typeof x === 'undefined'` so that if a future
 * browser does supply one of these, the real implementation wins.
 */

'use strict';

/*
 * Present the worklet as a Worker.
 *
 * The glue classifies its environment as:
 *     ENVIRONMENT_IS_WEB    = !!globalThis.window
 *     ENVIRONMENT_IS_WORKER = !!globalThis.WorkerGlobalScope
 *     ENVIRONMENT_IS_NODE   = !!globalThis.process?.versions?.node
 * A worklet satisfies none of them, so it falls through to the "shell" path --
 * which is written for d8/spidermonkey and reaches for `os`, `read`, `quit`
 * and friends. Chasing those shims one at a time is a losing game.
 *
 * A worklet is genuinely worker-like: same off-main-thread model, same absence
 * of a DOM. Declaring WorkerGlobalScope makes the glue take its worker branch,
 * which needs only `self.location.href` -- and never fetches anything, because
 * the .wasm is handed in as bytes from the main thread.
 */
if (typeof WorkerGlobalScope === 'undefined') {
  globalThis.WorkerGlobalScope = function WorkerGlobalScope() {};
}
if (typeof self === 'undefined') {
  globalThis.self = globalThis;
}
if (typeof location === 'undefined') {
  globalThis.location = { href: '', pathname: '', search: '', origin: '' };
}
if (typeof self.location === 'undefined') {
  self.location = globalThis.location;
}

/*
 * Emscripten routes getentropy()/std::random_device to crypto.getRandomValues,
 * and AudioWorkletGlobalScope exposes no crypto object.
 *
 * Math.random is NOT a cryptographic source, and this shim would be wrong for
 * anything security-sensitive. Nothing here is: Surge consumes this entropy to
 * seed noise generators and random LFO/S&H modulation, where the only
 * requirement is that successive runs differ. It is used for nothing else --
 * there is no key material, no nonce, no token anywhere in a synthesizer.
 */
if (typeof crypto === 'undefined') {
  globalThis.crypto = {
    getRandomValues(array) {
      for (let i = 0; i < array.length; i++) {
        array[i] = (Math.random() * 0x100000000) >>> 0;
      }
      return array;
    },
  };
}

// Emscripten times startup with performance.now(). The worklet scope exposes
// only `currentTime` (seconds, on the audio clock) and `currentFrame`. The
// audio clock is monotonic, which is all that is required here.
if (typeof performance === 'undefined') {
  globalThis.performance = {
    now: () => (typeof currentTime === 'number' ? currentTime * 1000 : 0),
  };
}
