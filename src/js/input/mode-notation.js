/**
 * mode-notation.js -- write music as text, hear it on Surge.
 *
 * The source language is ABC (https://abcnotation.com), rendered to a real
 * staff by abcjs. Typing updates the score live; Play walks the tune and sends
 * its notes through the app's note seam, so it comes out of Surge with whatever
 * patch is loaded rather than through abcjs's own sampled synth.
 *
 * WHY ABC AND NOT A SCORE EDITOR
 * ------------------------------
 * Because it is text. It diffs, it pastes, it round-trips through a chat
 * message, and a tune is a few lines rather than a file format. The editor half
 * is deliberately a code editor rather than a notation GUI.
 *
 * LOADING
 * -------
 * abcjs is 472 KB and is `import()`ed on first mount, not at page load. Most
 * visitors will never open this mode, and the page already pays for a 19 MB wasm
 * module.
 *
 * TIMING
 * ------
 * abcjs's TimingCallbacks drives playback from a browser timer, and the notes
 * reach the audio thread by postMessage. Same caveat as the piano roll: good
 * enough to hear the tune, not sample-accurate, and it will feed the worklet's
 * timestamped queue unchanged once that exists.
 */

'use strict';

/**
 * Where the vendored library is, resolved against THIS FILE's URL.
 *
 * Two levels up, not one: this module lives at js/input/, so `../vendor` would
 * resolve to js/vendor and 404.
 */
const ABCJS_URL = '../../vendor/abcjs-basic-6.4.4.min.js';

/** Quarter notes per minute for playback. */
const DEFAULT_QPM = 120;
const MIN_QPM = 40;
const MAX_QPM = 240;

/** A short tune so the mode is never an empty box. */
const STARTER_ABC = `X:1
T:Scratch
M:4/4
L:1/8
K:Cmaj
|:"C"CDEF GABc|"G"cBAG FEDC:|
|:"Am"A2 c2 e2 c2|"F"F2 A2 c2 A2:|`;

/**
 * Query. Loads abcjs once and hands back the global it defines.
 *
 * It is a UMD bundle, so it attaches to `window` rather than exporting. The
 * promise is cached on the module so a second mount does not refetch.
 *
 * @returns {Promise<object>} the ABCJS global
 */
let abcjsPromise = null;
function loadAbcjs() {
  if (abcjsPromise) return abcjsPromise;

  abcjsPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = new URL(ABCJS_URL, import.meta.url).href;
    script.onload = () => {
      if (!window.ABCJS) reject(new Error('abcjs loaded but defined no ABCJS global'));
      else resolve(window.ABCJS);
    };
    script.onerror = () => reject(new Error(`Could not load ${script.src}`));
    document.head.append(script);
  });
  return abcjsPromise;
}

/**
 * Pure function. Line numbers for a block of text, one per line.
 *
 * @param {string} text
 * @returns {string} newline-separated numbers
 *
 * @example lineNumbers('a\nb\nc')  // '1\n2\n3'
 * @example lineNumbers('')         // '1'
 */
export function lineNumbers(text) {
  const count = text.split('\n').length;
  return Array.from({ length: count }, (_, i) => i + 1).join('\n');
}

export const notationMode = {
  id: 'notation',
  label: 'Notation',
  hint: 'ABC notation. The score updates as you type; Play sends it to Surge.',

  /**
   * Command. Builds the editor, the score and the transport.
   *
   * @param {HTMLElement} container
   * @param {object} io - {noteOn, noteOff, allNotesOff, setModeStatus}
   * @returns {Promise<{destroy: () => void}>}
   */
  async mount(container, io) {
    const wrap = document.createElement('div');
    wrap.className = 'flex h-full min-h-0 flex-col gap-2 p-3';
    container.append(wrap);

    const loading = document.createElement('p');
    loading.className = 'text-xs opacity-60';
    loading.textContent = 'Loading notation engine…';
    wrap.append(loading);

    const ABCJS = await loadAbcjs();
    loading.remove();

    // ---- transport -------------------------------------------------------
    const bar = document.createElement('div');
    bar.className = 'flex items-center gap-3 text-xs';

    const playBtn = document.createElement('button');
    playBtn.className = 'rounded border border-current/30 px-3 py-1 font-semibold ' +
      'transition hover:opacity-80';
    playBtn.textContent = '▶ Play';

    const tempo = document.createElement('input');
    tempo.type = 'range';
    tempo.min = String(MIN_QPM);
    tempo.max = String(MAX_QPM);
    tempo.value = String(DEFAULT_QPM);
    tempo.className = 'w-32 accent-current';

    const tempoLabel = document.createElement('span');
    tempoLabel.className = 'w-16 font-mono opacity-70';
    tempoLabel.textContent = `${DEFAULT_QPM} qpm`;

    const problem = document.createElement('span');
    problem.className = 'font-mono text-[11px] opacity-70';

    bar.append(playBtn, tempo, tempoLabel, problem);

    // ---- editor: mono, gutter, no wrapping. A code editor, not a text box. --
    const editorWrap = document.createElement('div');
    editorWrap.className = 'flex min-h-40 overflow-hidden rounded border border-current/20 ' +
      'bg-current/5 font-mono text-[12px] leading-5';

    const gutter = document.createElement('pre');
    gutter.className = 'select-none border-r border-current/15 bg-current/5 px-2 py-2 ' +
      'text-right leading-5 opacity-40';

    const editor = document.createElement('textarea');
    editor.spellcheck = false;
    editor.className = 'min-h-40 flex-1 resize-y bg-transparent px-3 py-2 leading-5 ' +
      'outline-none placeholder:opacity-40';
    editor.value = STARTER_ABC;

    editorWrap.append(gutter, editor);

    // ---- score -----------------------------------------------------------
    const score = document.createElement('div');
    score.className = 'min-h-24 overflow-auto rounded bg-white p-2';

    wrap.append(bar, editorWrap, score);

    // ---- rendering -------------------------------------------------------
    let tune = null;

    const render = () => {
      gutter.textContent = lineNumbers(editor.value);

      const warnings = [];
      const rendered = ABCJS.renderAbc(score, editor.value, {
        responsive: 'resize',
        add_classes: true,
        warnings_id: null,
        wrap: { minSpacing: 1.8, maxSpacing: 2.7, preferredMeasuresPerLine: 4 },
      });

      tune = rendered[0] || null;
      if (tune && tune.warnings) warnings.push(...tune.warnings);

      // ABC is forgiving, so most mistakes surface as warnings rather than
      // errors. Showing them is the difference between "why is that bar wrong"
      // and knowing which line abcjs objected to.
      problem.textContent = warnings.length ? `${warnings.length} warning(s)` : '';
      problem.title = warnings.join('\n');
    };

    editor.addEventListener('input', render);
    render();

    // ---- playback --------------------------------------------------------
    let timer = null;
    const sounding = new Set();

    const releaseAll = () => {
      for (const note of sounding) io.noteOff(note);
      sounding.clear();
    };

    const stop = () => {
      if (timer) { timer.stop(); timer = null; }
      releaseAll();
      playBtn.textContent = '▶ Play';
      io.setModeStatus('');
    };

    const start = () => {
      if (!tune) return;
      stop();

      // REQUIRED before TimingCallbacks, and easy to miss: renderAbc only does
      // the visual pass, so the timing events it yields carry empty
      // `midiPitches`. setUpAudio runs the audio pass that fills them in.
      // Without it playback runs, fires the right number of events at the right
      // times, and plays nothing -- measured: 17 events, 0 with pitches.
      //
      // We want the note numbers, not abcjs's own sampled synth, which is never
      // started; the notes go to Surge.
      tune.setUpAudio({ qpm: Number(tempo.value) });

      timer = new ABCJS.TimingCallbacks(tune, {
        qpm: Number(tempo.value),

        // Fires once per musical event with the pitches starting there. Each
        // event releases what the previous one started, which is why a held
        // note across events retriggers rather than sustaining -- ABC ties are
        // not modelled here.
        eventCallback: (ev) => {
          if (!ev) { stop(); return; }   // null marks the end of the tune
          releaseAll();
          for (const p of ev.midiPitches || []) {
            const velocity = Math.round((p.volume ?? 1) * 100);
            io.noteOn(p.pitch, velocity);
            sounding.add(p.pitch);
          }
        },
      });

      timer.start();
      playBtn.textContent = '■ Stop';
      io.setModeStatus(`${tempo.value} qpm`);
    };

    playBtn.addEventListener('click', () => (timer ? stop() : start()));
    tempo.addEventListener('input', () => {
      tempoLabel.textContent = `${tempo.value} qpm`;
      if (timer) { stop(); start(); }   // TimingCallbacks fixes qpm at construction
    });

    return {
      shortcuts: [{
        id: 'notation-play',
        chord: ' ',
        group: 'Notation',
        label: 'Play / stop the tune',
        run: () => (timer ? stop() : start()),
      }],

      destroy() {
        stop();
        editor.removeEventListener('input', render);
        wrap.remove();
      },
    };
  },
};
