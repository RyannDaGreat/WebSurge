/**
 * mode-pianoroll.js -- a real piano roll, driving Surge.
 *
 * THE ROLL IS NOT OURS
 * --------------------
 * The grid, the scrolling, the ruler, the keyboard gutter, note drag/resize/
 * select/delete, the loop markers and the play cursor all come from
 * `webaudio-pianoroll` by Tatsuya Shinyagaito (g200kg), vendored at
 * src/vendor/webaudio-pianoroll-0.6.0.js. This file is the seam between that
 * component and Surge, and nothing more. An earlier version of this mode was a
 * hand-rolled 16x13 cell grid; it was deleted, because a half-built piano roll
 * is worse than a finished one somebody else already wrote.
 *
 * WHAT THE COMPONENT DOES AND DOES NOT DO
 * ---------------------------------------
 * It is a UI plus a scheduler. It makes no sound at all. `play()` walks the
 * sequence and calls back with `{t, g, n}` -- note-on time, note-off time, note
 * number -- ahead of when they are due, and everything after that is ours.
 *
 * THE CLOCK, AND WHY IT IS NOT AN AudioContext
 * --------------------------------------------
 * `play(actx, callback, tick)` is documented to take an AudioContext, but the
 * pinned source touches it in exactly two places and both read `.currentTime`
 * (lines 168 and 213 of the vendored file) -- it never creates a node, never
 * connects anything, never schedules on the audio graph. It wants a clock.
 *
 * So it gets a clock, backed by `performance.now()`. Three reasons, in order of
 * how much they matter:
 *
 *  1. We have to turn its scheduled times into `setTimeout` delays, because
 *     `io.noteOn` posts to the worklet immediately and the worklet has no
 *     timestamped event queue to schedule into. Subtracting an audio-clock
 *     reading from a wall-clock deadline mixes two clocks that drift apart, and
 *     the error lands in the timing of every note. Using `performance.now()`
 *     for both sides makes that conversion exact.
 *  2. `io` -- {noteOn, noteOff, allNotesOff, setModeStatus} -- is the whole
 *     surface a mode gets, deliberately, and it does not include the app's
 *     AudioContext. Reaching through a global to get one would be going around
 *     the seam for a number we can compute.
 *  3. Constructing a second AudioContext costs a real output stream on some
 *     platforms, for a clock we would then only read.
 *
 * TIMING, HONESTLY
 * ----------------
 * Better than the grid this replaced, still not sample-accurate. The component
 * schedules from a monotonic clock instead of accumulating per-frame error, so
 * there is no drift over a long loop. But the final hop is `setTimeout` plus a
 * `postMessage` to the audio thread, so each note lands within a few
 * milliseconds of where it should and the amount varies. Good for writing and
 * hearing music; not a sequencer, and it must not be described as one.
 *
 * The fix is unchanged and is not in this file: a timestamped event queue inside
 * surge-worklet.js, so events are scheduled ahead in audio time and drained per
 * block. This mode already knows each note's deadline and would pass it through
 * without restructuring.
 *
 * WHAT WE FOUND OUT ABOUT THE COMPONENT, THAT ITS README DOES NOT SAY
 * ------------------------------------------------------------------
 *  - The README's default `editmode` is "gridmono"; the source's is "dragpoly".
 *    The source wins. We ask for "dragpoly" explicitly rather than rely on it.
 *  - `loop` is a declared attribute that is never read anywhere in the source.
 *    Playback ALWAYS loops from `markend` back to `markstart`. There is no
 *    one-shot mode and no end-of-sequence callback, so Play runs until Stop.
 *  - Note events carry no velocity. The sequence entries are `{t, n, g, f}` and
 *    the play callback gets `{t, g, n}`, so a per-note velocity cannot be
 *    recovered at playback time even if we stored one. Every note plays at
 *    VELOCITY. Imported MIDI velocities are parsed and then dropped here.
 *  - `stop()` clears its interval and nothing else: no note-offs, no cursor
 *    reset. Releasing what is sounding is the caller's job.
 *  - Properties are defined in `connectedCallback` from the element's
 *    attributes, so setting a property before the element is in the DOM has no
 *    effect. Attributes first, then append, then properties.
 *  - `ready()` finds its internal parts by child index (`root.children[1]`,
 *    `root.childNodes[2]`). Nothing may be inserted into the element.
 *  - It renders to a canvas, so its colours are strings it paints with and
 *    cannot be `currentColor`. They are computed from the skin's text colour at
 *    mount; see rgbaFrom below.
 *  - Its `<style>` is injected unscoped (the shadow-DOM path is commented out
 *    in the source), defining `.pianoroll`, `.marker` and four `#wac-*` ids.
 *    Checked: the app uses none of those names.
 *  - `disconnectedCallback` is empty. During a drag it holds window-level
 *    mousemove/mouseup listeners, which it removes on mouseup. A mode torn down
 *    mid-drag would leak them; destroy() cannot reach them.
 *
 * Licence: webaudio-pianoroll is Apache-2.0, which is one-way compatible with
 * this project's GPLv3.
 */

'use strict';

import { PRESETS, barsFor } from './roll-presets.js';
import { parseMidi } from './midi-file.js';

/**
 * Where the vendored component is, resolved against THIS FILE's URL.
 *
 * Two levels up, not one: this module lives at js/input/, so `../vendor` would
 * resolve to js/vendor and 404. Same trap as mode-notation.js.
 *
 * Provenance -- webaudio-pianoroll 0.6.0, Apache-2.0, g200kg, repo commit
 * 523bc10e4b7e5d0a70b20caaeff5c14e4864c9de (2022-12-20). To refresh:
 *   curl -sSL -o src/vendor/webaudio-pianoroll-0.6.0.js \
 *     https://raw.githubusercontent.com/g200kg/webaudio-pianoroll/master/webaudio-pianoroll.js
 * sha256 940fedddb1b4997e2d92115bcb0169e55b870a94a42893a114d395e3a3de06d8
 */
const PIANOROLL_URL = '../../vendor/webaudio-pianoroll-0.6.0.js';

/** The custom element the vendored file defines. */
const ELEMENT_NAME = 'webaudio-pianoroll';

/** Which preset the mode opens on, so it is never an empty box. */
const STARTER_PRESET = 'Ode to Joy';

const MIN_BPM = 40;
const MAX_BPM = 240;

/** Every note plays at this velocity; the component carries none. See above. */
const VELOCITY = 100;

const MS_PER_SECOND = 1000;

/** 4/4 is assumed when converting a MIDI file's ticks-per-quarter into bars. */
const BEATS_PER_BAR = 4;

/** How far ahead the component hands us events, in seconds. */
const PRELOAD_SECONDS = 0.5;

/** Roll geometry, in px. Width is fitted to the panel between these bounds. */
const ROLL_HEIGHT_PX = 340;
const MIN_ROLL_WIDTH_PX = 460;
const MAX_ROLL_WIDTH_PX = 1180;
/** The wrapper's p-3 padding, both sides, subtracted from the panel width. */
const ROLL_INSET_PX = 24;

/** Bars visible at once before the roll scrolls horizontally. */
const VISIBLE_BARS = 4;

/** Vertical view: never show fewer semitones than this, and pad the fit. */
const MIN_PITCH_SPAN = 25;
const PITCH_PADDING = 2;

const MIDI_NOTE_MIN = 0;
const MIDI_NOTE_MAX = 127;

/**
 * Opacities the roll is painted with, all applied to the skin's text colour so
 * the roll reads the same on Frosted Glass as on Paper & Ink.
 */
const ALPHA_ROW_LIGHT = 0.06;
const ALPHA_ROW_DARK = 0.15;
const ALPHA_GRID = 0.25;
const ALPHA_NOTE = 0.7;
const ALPHA_NOTE_BORDER = 0.9;
const ALPHA_NOTE_SELECTED = 0.4;
const ALPHA_RULER_BG = 0.1;
const ALPHA_RULER_BORDER = 0.3;
const ALPHA_SELECT_AREA = 0.2;

/**
 * Pure function. Restates a CSS colour at a different opacity.
 *
 * The roll paints onto a canvas, so it needs literal colour strings and cannot
 * take `currentColor` or a Tailwind `/30` suffix. Everything it draws is
 * therefore the skin's own text colour at some opacity, which is what
 * `border-current/30` means elsewhere in the app, computed rather than declared.
 *
 * @param {string} color - any `rgb()`/`rgba()` string, as getComputedStyle returns
 * @param {number} alpha - 0..1
 * @returns {string} an `rgba()` string
 *
 * @example rgbaFrom('rgb(226, 232, 240)', 0.25)     // 'rgba(226, 232, 240, 0.25)'
 * @example rgbaFrom('rgba(15, 23, 42, 0.9)', 0.06)  // 'rgba(15, 23, 42, 0.06)'
 */
export function rgbaFrom(color, alpha) {
  const parts = color.match(/-?[\d.]+/g);
  if (!parts || parts.length < 3) {
    throw new Error(`Cannot read a colour out of "${color}" to tint the piano roll`);
  }
  const [r, g, b] = parts;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Pure function. Turns our note list into webaudio-pianoroll's sequence array.
 *
 * Its entries are `{t: startTick, n: noteNumber, g: lengthTicks}` plus `f`, the
 * selected flag its drawing code reads. Sorted by tick because `findNextEv`
 * scans forward and stops at the first event at or after the cursor, so an
 * unsorted sequence silently drops notes during playback.
 *
 * @param {Array<{pitch: number, start: number, length: number}>} notes
 * @returns {Array<{t: number, n: number, g: number, f: number}>}
 *
 * @example toSequence([{pitch: 60, start: 4, length: 2}])
 * // [{t: 4, n: 60, g: 2, f: 0}]
 *
 * @example toSequence([{pitch: 64, start: 8, length: 4}, {pitch: 60, start: 0, length: 4}])
 * // [{t: 0, n: 60, g: 4, f: 0}, {t: 8, n: 64, g: 4, f: 0}]
 */
export function toSequence(notes) {
  return notes
    .map((n) => ({ t: n.start, n: n.pitch, g: n.length, f: 0 }))
    .sort((a, b) => a.t - b.t || a.n - b.n);
}

/**
 * Pure function. The vertical view window that fits a note list.
 *
 * `yoffset` is the note number at the BOTTOM edge of the roll and `yrange` the
 * number of semitones shown, so a piece is framed by finding its lowest note
 * and counting up. Narrow pieces get widened to MIN_PITCH_SPAN rather than
 * zoomed until three rows fill the panel.
 *
 * @param {Array<{pitch: number}>} notes
 * @returns {{yoffset: number, yrange: number}}
 *
 * @example pitchWindow([{pitch: 60}, {pitch: 72}])  // {yoffset: 58, yrange: 25}
 * @example pitchWindow([])                          // {yoffset: 48, yrange: 25}
 *
 * @example
 * // a four-octave piece is shown whole, not clipped to the minimum span
 * pitchWindow([{pitch: 36}, {pitch: 84}])  // {yoffset: 34, yrange: 53}
 */
export function pitchWindow(notes) {
  if (!notes.length) {
    // Middle of the keyboard, where a sketch wants to start drawing.
    return { yoffset: 48, yrange: MIN_PITCH_SPAN };
  }
  const pitches = notes.map((n) => n.pitch);
  const lo = Math.min(...pitches) - PITCH_PADDING;
  const hi = Math.max(...pitches) + PITCH_PADDING;

  const span = Math.max(MIN_PITCH_SPAN, hi - lo + 1);
  const centre = (lo + hi) / 2;
  const bottom = Math.round(centre - span / 2);

  return {
    yoffset: Math.min(Math.max(MIDI_NOTE_MIN, bottom), MIDI_NOTE_MAX - span),
    yrange: span,
  };
}

/**
 * Pure function. Turns a parsed MIDI file into a roll document.
 *
 * The file's own division becomes the roll's tick resolution, so import is
 * lossless: a 480-ticks-per-quarter file gets timebase 1920 and every onset
 * lands exactly where it was written, with no quantisation. 4/4 is assumed --
 * the file's time-signature meta event is not read, so a 3/4 piece will import
 * with correct note positions and misplaced bar lines.
 *
 * @param {object} midi - what parseMidi returned
 * @param {string} label - shown in the preset picker, normally the file name
 * @returns {{name, bpm, timebase, grid, snap, notes, note}} a roll document
 *
 * @example
 * midiToDoc({division: 480, tempoBpm: 90, tempoChanges: 0, unterminated: 0,
 *            notes: [{pitch: 60, start: 0, length: 480, velocity: 64}]}, 'x.mid')
 * // {name: 'x.mid', bpm: 90, timebase: 1920, grid: 480, snap: 120,
 * //  notes: [{pitch: 60, start: 0, length: 480}],
 * //  note: 'Imported from x.mid: 1 notes, 480 ticks per quarter, 90.0 bpm.'}
 */
export function midiToDoc(midi, label) {
  const timebase = midi.division * BEATS_PER_BAR;
  const caveats = [];
  if (midi.tempoChanges) {
    caveats.push(`${midi.tempoChanges} later tempo change(s) ignored -- the roll has one tempo`);
  }
  if (midi.unterminated) {
    caveats.push(`${midi.unterminated} note(s) were never released and end at the last event`);
  }

  return {
    name: label,
    bpm: midi.tempoBpm,
    timebase,
    grid: midi.division,
    snap: Math.max(1, Math.round(midi.division / BEATS_PER_BAR)),
    notes: midi.notes.map((n) => ({ pitch: n.pitch, start: n.start, length: n.length })),
    note: `Imported from ${label}: ${midi.notes.length} notes, ${midi.division} ticks `
      + `per quarter, ${midi.tempoBpm.toFixed(1)} bpm.`
      + (caveats.length ? ` Caveats: ${caveats.join('; ')}.` : '')
      + ' Velocities were read but the roll cannot play them; every note sounds at '
      + `velocity ${VELOCITY}.`,
  };
}

/**
 * Query. Loads the vendored component once and resolves when it is registered.
 *
 * It is a plain script that calls `customElements.define` at top level rather
 * than a module, so there is nothing to import; the signal that it is ready is
 * the element being defined. The promise is cached on the module so a second
 * mount does not refetch, and so two mounts cannot race into a double
 * `define()` -- which throws, unlike a duplicate import.
 *
 * @returns {Promise<void>}
 */
let pianorollPromise = null;
function loadPianoroll() {
  if (pianorollPromise) return pianorollPromise;

  pianorollPromise = new Promise((resolve, reject) => {
    if (customElements.get(ELEMENT_NAME)) { resolve(); return; }

    const script = document.createElement('script');
    script.src = new URL(PIANOROLL_URL, import.meta.url).href;
    script.onload = () => {
      if (!customElements.get(ELEMENT_NAME)) {
        reject(new Error(`${script.src} loaded but defined no <${ELEMENT_NAME}>`));
      } else {
        resolve();
      }
    };
    script.onerror = () => reject(new Error(`Could not load ${script.src}`));
    document.head.append(script);
  });
  return pianorollPromise;
}

export const pianoRollMode = {
  id: 'pianoroll',
  label: 'Piano roll',
  hint: 'Drag to draw notes, drag their edges to resize. Space plays the loop.',

  /**
   * Command. Builds the roll, its transport, the preset picker and MIDI import.
   *
   * @param {HTMLElement} container
   * @param {object} io - {noteOn, noteOff, allNotesOff, setModeStatus}
   * @returns {Promise<{destroy: () => void, shortcuts: Array<object>}>}
   */
  async mount(container, io) {
    const wrap = document.createElement('div');
    wrap.className = 'flex flex-col gap-2 p-3';
    container.append(wrap);

    const loading = document.createElement('p');
    loading.className = 'text-xs opacity-60';
    loading.textContent = 'Loading piano roll…';
    wrap.append(loading);

    await loadPianoroll();
    loading.remove();

    // ---- transport -------------------------------------------------------
    const bar = document.createElement('div');
    bar.className = 'flex flex-wrap items-center gap-3 text-xs';

    const playBtn = document.createElement('button');
    playBtn.className = 'rounded border border-current/30 px-3 py-1 font-semibold '
      + 'transition hover:opacity-80';
    playBtn.textContent = '▶ Play';

    const tempo = document.createElement('input');
    tempo.type = 'range';
    tempo.min = String(MIN_BPM);
    tempo.max = String(MAX_BPM);
    tempo.className = 'w-28 accent-current';

    const tempoLabel = document.createElement('span');
    tempoLabel.className = 'w-16 font-mono opacity-70';

    const presetSelect = document.createElement('select');
    presetSelect.className = 'rounded border border-current/30 bg-transparent px-2 py-1';
    for (const preset of PRESETS) {
      const option = document.createElement('option');
      option.value = preset.name;
      option.textContent = preset.name;
      presetSelect.append(option);
    }

    // A file input styled as a button: the raw control cannot be made to sit on
    // twelve different skins, but a label wrapping a hidden input can.
    const midiInput = document.createElement('input');
    midiInput.type = 'file';
    midiInput.accept = '.mid,.midi,audio/midi';
    midiInput.className = 'hidden';

    const midiLabel = document.createElement('label');
    midiLabel.className = 'cursor-pointer rounded border border-current/30 px-3 py-1 '
      + 'transition hover:opacity-80';
    midiLabel.textContent = 'Import MIDI…';
    midiLabel.append(midiInput);

    const clearBtn = document.createElement('button');
    clearBtn.className = 'rounded border border-current/30 px-3 py-1 transition hover:opacity-80';
    clearBtn.textContent = 'Clear';

    const count = document.createElement('span');
    count.className = 'font-mono opacity-60';

    bar.append(playBtn, tempo, tempoLabel, presetSelect, midiLabel, clearBtn, count);

    // Where each preset says what it is and is not. See roll-presets.js.
    const provenance = document.createElement('p');
    provenance.className = 'text-[11px] leading-snug opacity-60';

    // ---- the roll --------------------------------------------------------
    const rollHost = document.createElement('div');
    rollHost.className = 'overflow-auto rounded border border-current/20';

    const fg = getComputedStyle(container).color;
    const width = Math.min(
      MAX_ROLL_WIDTH_PX,
      Math.max(MIN_ROLL_WIDTH_PX, (container.clientWidth || MIN_ROLL_WIDTH_PX) - ROLL_INSET_PX),
    );

    // Attributes, not properties: the component reads these once, in
    // connectedCallback, to seed the properties it then defines.
    const roll = document.createElement(ELEMENT_NAME);
    for (const [key, value] of Object.entries({
      width,
      height: ROLL_HEIGHT_PX,
      editmode: 'dragpoly',
      xscroll: 1,
      yscroll: 1,
      wheelzoom: 1,
      preload: PRELOAD_SECONDS,
      collt: rgbaFrom(fg, ALPHA_ROW_LIGHT),
      coldk: rgbaFrom(fg, ALPHA_ROW_DARK),
      colgrid: rgbaFrom(fg, ALPHA_GRID),
      colnote: rgbaFrom(fg, ALPHA_NOTE),
      colnoteborder: rgbaFrom(fg, ALPHA_NOTE_BORDER),
      colnotesel: rgbaFrom(fg, ALPHA_NOTE_SELECTED),
      colnoteselborder: rgbaFrom(fg, ALPHA_NOTE_BORDER),
      colrulerbg: rgbaFrom(fg, ALPHA_RULER_BG),
      colrulerfg: fg,
      colrulerborder: rgbaFrom(fg, ALPHA_RULER_BORDER),
      colselarea: rgbaFrom(fg, ALPHA_SELECT_AREA),
    })) {
      roll.setAttribute(key, String(value));
    }
    rollHost.append(roll);
    wrap.append(bar, provenance, rollHost);

    // ---- playback --------------------------------------------------------
    /**
     * The clock handed to `roll.play()`. See the file header for why this is
     * `performance.now()` and not an AudioContext.
     */
    const clock = { get currentTime() { return performance.now() / MS_PER_SECOND; } };

    /** Pending note-on/note-off timers, so Stop can cancel what is in flight. */
    const timers = new Set();

    /**
     * Pitches currently sounding, counted rather than flagged: the same pitch
     * can legitimately be on twice at once, and a Set would let the first
     * release forget the second note, leaving it hanging after Stop.
     */
    const sounding = new Map();

    let playing = false;

    const scheduleAt = (seconds, run) => {
      const delay = Math.max(0, seconds * MS_PER_SECOND - performance.now());
      const id = setTimeout(() => { timers.delete(id); run(); }, delay);
      timers.add(id);
    };

    const onPlayEvent = (ev) => {
      scheduleAt(ev.t, () => {
        io.noteOn(ev.n, VELOCITY);
        sounding.set(ev.n, (sounding.get(ev.n) ?? 0) + 1);
      });
      scheduleAt(ev.g, () => {
        io.noteOff(ev.n);
        const held = (sounding.get(ev.n) ?? 0) - 1;
        if (held > 0) sounding.set(ev.n, held);
        else sounding.delete(ev.n);
      });
    };

    const releaseAll = () => {
      for (const note of sounding.keys()) io.noteOff(note);
      sounding.clear();
    };

    const stop = () => {
      playing = false;
      roll.stop();
      for (const id of timers) clearTimeout(id);
      timers.clear();
      releaseAll();
      roll.locate(roll.markstart);
      playBtn.textContent = '▶ Play';
      io.setModeStatus('');
    };

    const start = () => {
      if (!roll.sequence.length) {
        io.setModeStatus('nothing to play — draw some notes or pick a preset');
        return;
      }
      playing = true;
      playBtn.textContent = '■ Stop';
      io.setModeStatus(`${roll.tempo} bpm · ${roll.markend / roll.timebase} bars · loops`);
      roll.play(clock, onPlayEvent, roll.markstart);
    };

    // ---- loading a document ----------------------------------------------
    const describe = () => {
      count.textContent = `${roll.sequence.length} notes · `
        + `${roll.markend / roll.timebase} bars`;
    };

    /**
     * Command. Resets the roll to a document. See roll-presets.js for the shape.
     */
    const load = (doc) => {
      const wasPlaying = playing;
      stop();

      roll.timebase = doc.timebase;
      roll.grid = doc.grid;
      roll.snap = doc.snap;
      roll.tempo = doc.bpm;
      roll.sequence = toSequence(doc.notes);
      roll.markstart = 0;
      roll.markend = barsFor(doc.notes, doc.timebase);
      roll.xoffset = 0;
      roll.xrange = VISIBLE_BARS * doc.timebase;

      const view = pitchWindow(doc.notes);
      roll.yoffset = view.yoffset;
      roll.yrange = view.yrange;

      roll.locate(0);
      roll.redraw();

      tempo.value = String(Math.round(doc.bpm));
      tempoLabel.textContent = `${Math.round(doc.bpm)} bpm`;
      provenance.textContent = doc.note;
      describe();

      if (wasPlaying) start();
    };

    // ---- MIDI import -----------------------------------------------------
    /**
     * Command. Reads the chosen file into the roll.
     *
     * A parse failure is shown in the UI AND rethrown: the message is what the
     * person needs, the stack is what we need, and swallowing either would mean
     * a file that silently does nothing.
     */
    const importMidi = async () => {
      const file = midiInput.files?.[0];
      if (!file) return;
      provenance.textContent = `Reading ${file.name}…`;

      const buffer = await file.arrayBuffer();
      let doc;
      try {
        doc = midiToDoc(parseMidi(buffer), file.name);
      } catch (err) {
        provenance.textContent = `Could not import ${file.name}: ${err.message}`;
        throw err;
      }

      // Imports are not presets; say so rather than leaving a stale name selected.
      presetSelect.selectedIndex = -1;
      load(doc);
    };

    // ---- wiring ----------------------------------------------------------
    const onPlayClick = () => (playing ? stop() : start());

    const onPresetChange = () => {
      const preset = PRESETS.find((p) => p.name === presetSelect.value);
      if (!preset) throw new Error(`No piano-roll preset named "${presetSelect.value}"`);
      load(preset);
    };

    const onTempoInput = () => {
      roll.tempo = Number(tempo.value);
      tempoLabel.textContent = `${tempo.value} bpm`;
      if (playing) { stop(); start(); }   // tick2time is fixed when play() starts
    };

    const onClear = () => {
      stop();
      roll.sequence = [];
      roll.redraw();
      describe();
      provenance.textContent = 'Cleared. Drag on the roll to draw notes.';
    };

    const onMidiChange = () => { void importMidi(); };

    playBtn.addEventListener('click', onPlayClick);
    presetSelect.addEventListener('change', onPresetChange);
    tempo.addEventListener('input', onTempoInput);
    clearBtn.addEventListener('click', onClear);
    midiInput.addEventListener('change', onMidiChange);

    const starter = PRESETS.find((p) => p.name === STARTER_PRESET);
    if (!starter) throw new Error(`Starter preset "${STARTER_PRESET}" is not in PRESETS`);
    presetSelect.value = starter.name;
    load(starter);

    return {
      /** Contributed while this mode is mounted. */
      shortcuts: [{
        id: 'roll-play',
        chord: ' ',
        group: 'Piano roll',
        label: 'Play / stop the loop',
        run: onPlayClick,
      }],

      destroy() {
        stop();
        playBtn.removeEventListener('click', onPlayClick);
        presetSelect.removeEventListener('change', onPresetChange);
        tempo.removeEventListener('input', onTempoInput);
        clearBtn.removeEventListener('click', onClear);
        midiInput.removeEventListener('change', onMidiChange);
        wrap.remove();
      },
    };
  },
};
