/**
 * mode-pianoroll.js -- a step grid you draw notes into.
 *
 * Click a cell to place a note, drag across to lengthen it, click it again to
 * remove it. Play loops the pattern.
 *
 * TIMING, HONESTLY
 * ----------------
 * Playback is driven by requestAnimationFrame and sends note-on/note-off through
 * the same postMessage path the computer keyboard uses. That is fine for
 * sketching and audibly loose for anything else: the messages cross to the audio
 * thread whenever they cross, so a step can land a few milliseconds early or
 * late and the amount varies. It is NOT sample-accurate and must not be
 * described as a sequencer.
 *
 * Making it accurate needs a timestamped event queue inside the worklet, so that
 * events are scheduled ahead in audio time and drained per block rather than
 * played on arrival. That is a change to surge-worklet.js, not to this file, and
 * this mode will feed it unchanged when it exists.
 */

'use strict';

/** Rows, top to bottom, as semitone offsets above the grid's base note. */
const SEMITONES = [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0];

/** Columns in the pattern. Sixteen sixteenths is one 4/4 bar. */
const STEPS = 16;

/** Steps per beat, for turning BPM into a step duration. */
const STEPS_PER_BEAT = 4;

const DEFAULT_BPM = 110;
const MIN_BPM = 40;
const MAX_BPM = 240;

/** Base note of the lowest row. C4, so the grid sits where a sketch wants it. */
const DEFAULT_BASE_NOTE = 60;

const VELOCITY = 100;

const SECONDS_PER_MINUTE = 60;

/** Note names for the row gutter. */
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/**
 * Pure function. Milliseconds one step lasts at a tempo.
 *
 * @param {number} bpm
 * @returns {number} milliseconds
 *
 * @example stepMs(120)  // 125  -- a sixteenth at 120bpm
 * @example stepMs(60)   // 250
 */
export function stepMs(bpm) {
  return (SECONDS_PER_MINUTE * 1000) / (bpm * STEPS_PER_BEAT);
}

/**
 * Pure function. Is this semitone a black key?
 *
 * @param {number} semitone - offset from C, any sign
 * @returns {boolean}
 *
 * @example isBlack(1)   // true  (C#)
 * @example isBlack(12)  // false (C, an octave up)
 */
export function isBlack(semitone) {
  return [1, 3, 6, 8, 10].includes(((semitone % 12) + 12) % 12);
}

export const pianoRollMode = {
  id: 'pianoroll',
  label: 'Piano roll',
  hint: 'Click cells to place notes. Space plays the loop.',

  /**
   * Command. Builds the grid and its transport.
   *
   * @param {HTMLElement} container
   * @param {object} io - {noteOn, noteOff, allNotesOff, setModeStatus}
   * @returns {Promise<{destroy: () => void}>}
   */
  async mount(container, io) {
    /** Which cells are filled: a Set of `${row}:${step}` keys. */
    const filled = new Set();
    const cells = new Map();

    let bpm = DEFAULT_BPM;
    let playing = false;
    let rafId = null;
    let stepIndex = 0;
    let lastStepAt = 0;
    const sounding = new Set();

    // ---- transport -------------------------------------------------------
    const bar = document.createElement('div');
    bar.className = 'flex items-center gap-3 pb-2 text-xs';

    const playBtn = document.createElement('button');
    playBtn.className = 'rounded border border-current/30 px-3 py-1 font-semibold ' +
      'transition hover:opacity-80';
    playBtn.textContent = '▶ Play';

    const tempo = document.createElement('input');
    tempo.type = 'range';
    tempo.min = String(MIN_BPM);
    tempo.max = String(MAX_BPM);
    tempo.value = String(bpm);
    tempo.className = 'w-32 accent-current';

    const tempoLabel = document.createElement('span');
    tempoLabel.className = 'w-16 font-mono opacity-70';
    tempoLabel.textContent = `${bpm} bpm`;

    const clearBtn = document.createElement('button');
    clearBtn.className = 'rounded border border-current/30 px-3 py-1 transition hover:opacity-80';
    clearBtn.textContent = 'Clear';

    bar.append(playBtn, tempo, tempoLabel, clearBtn);

    // ---- grid ------------------------------------------------------------
    const grid = document.createElement('div');
    grid.className = 'inline-grid gap-px select-none';
    grid.style.gridTemplateColumns = `2.5rem repeat(${STEPS}, minmax(0, 1.4rem))`;

    const noteFor = (row) => DEFAULT_BASE_NOTE + SEMITONES[row];

    SEMITONES.forEach((semi, rowIndex) => {
      const gutter = document.createElement('div');
      gutter.className = 'pr-2 text-right font-mono text-[10px] leading-5 opacity-50';
      gutter.textContent = `${NAMES[((semi % 12) + 12) % 12]}${Math.floor(noteFor(rowIndex) / 12) - 1}`;
      grid.append(gutter);

      for (let step = 0; step < STEPS; step++) {
        const cell = document.createElement('button');
        cell.dataset.key = `${rowIndex}:${step}`;
        // Beat boundaries get a stronger edge so 4/4 is readable at a glance.
        const beatEdge = step % STEPS_PER_BEAT === 0 ? 'border-l-current/40' : 'border-l-current/10';
        cell.className = 'h-5 border-l transition-colors ' + beatEdge + ' ' +
          (isBlack(semi) ? 'bg-current/8' : 'bg-current/15');
        cells.set(cell.dataset.key, cell);
        grid.append(cell);
      }
    });

    const paint = () => {
      for (const [key, cell] of cells) {
        cell.classList.toggle('bg-current/70', filled.has(key));
      }
    };

    // ---- drawing ---------------------------------------------------------
    let drawing = null; // 'add' | 'remove', fixed at pointerdown

    const cellAt = (target) => (target instanceof HTMLElement ? target.dataset.key : undefined);

    const applyAt = (key) => {
      if (!key) return;
      if (drawing === 'add') filled.add(key);
      else filled.delete(key);
      paint();
    };

    const onPointerDown = (e) => {
      const key = cellAt(e.target);
      if (!key) return;
      // Whether a drag adds or removes is decided by the first cell, so dragging
      // across a mixed run does not flip each cell it crosses.
      drawing = filled.has(key) ? 'remove' : 'add';
      applyAt(key);

      // Capture is an optimisation for dragging, not a requirement for the
      // click that just happened. A synthetic event -- from a test, or from
      // assistive tech -- carries no live pointer and throws here, which would
      // otherwise take down the handler after the cell was already filled.
      if (grid.hasPointerCapture || e.isTrusted) {
        try {
          grid.setPointerCapture(e.pointerId);
        } catch {
          // No active pointer to capture; dragging just will not track.
        }
      }
      e.preventDefault();
    };

    const onPointerMove = (e) => {
      if (!drawing || !e.buttons) return;
      // Capture retargets events to the grid, so hit-test by coordinate.
      applyAt(cellAt(document.elementFromPoint(e.clientX, e.clientY)));
    };

    const onPointerUp = () => { drawing = null; };

    grid.addEventListener('pointerdown', onPointerDown);
    grid.addEventListener('pointermove', onPointerMove);
    grid.addEventListener('pointerup', onPointerUp);
    grid.addEventListener('pointercancel', onPointerUp);

    // ---- playback --------------------------------------------------------
    const releaseAll = () => {
      for (const note of sounding) io.noteOff(note);
      sounding.clear();
    };

    const highlight = (index) => {
      for (const [key, cell] of cells) {
        cell.classList.toggle('ring-1', playing && Number(key.split(':')[1]) === index);
        cell.classList.toggle('ring-current/60', playing && Number(key.split(':')[1]) === index);
      }
    };

    const advance = (now) => {
      if (!playing) return;

      if (now - lastStepAt >= stepMs(bpm)) {
        lastStepAt = now;
        releaseAll();

        SEMITONES.forEach((_, rowIndex) => {
          if (!filled.has(`${rowIndex}:${stepIndex}`)) return;
          const note = noteFor(rowIndex);
          io.noteOn(note, VELOCITY);
          sounding.add(note);
        });

        highlight(stepIndex);
        stepIndex = (stepIndex + 1) % STEPS;
      }
      rafId = requestAnimationFrame(advance);
    };

    const stop = () => {
      playing = false;
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = null;
      releaseAll();
      highlight(-1);
      playBtn.textContent = '▶ Play';
      io.setModeStatus('');
    };

    const start = () => {
      playing = true;
      stepIndex = 0;
      lastStepAt = 0;
      playBtn.textContent = '■ Stop';
      io.setModeStatus(`${bpm} bpm · ${STEPS} steps`);
      rafId = requestAnimationFrame(advance);
    };

    playBtn.addEventListener('click', () => (playing ? stop() : start()));
    clearBtn.addEventListener('click', () => { filled.clear(); paint(); });
    tempo.addEventListener('input', () => {
      bpm = Number(tempo.value);
      tempoLabel.textContent = `${bpm} bpm`;
      if (playing) io.setModeStatus(`${bpm} bpm · ${STEPS} steps`);
    });

    const wrap = document.createElement('div');
    wrap.className = 'flex flex-col overflow-auto p-3';
    wrap.append(bar, grid);
    container.append(wrap);
    paint();

    return {
      /** Contributed while this mode is mounted. */
      shortcuts: [{
        id: 'roll-play',
        chord: ' ',
        group: 'Piano roll',
        label: 'Play / stop the loop',
        run: () => (playing ? stop() : start()),
      }],

      destroy() {
        stop();
        grid.removeEventListener('pointerdown', onPointerDown);
        grid.removeEventListener('pointermove', onPointerMove);
        grid.removeEventListener('pointerup', onPointerUp);
        grid.removeEventListener('pointercancel', onPointerUp);
        wrap.remove();
      },
    };
  },
};
