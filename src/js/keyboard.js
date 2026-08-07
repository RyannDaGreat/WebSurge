/**
 * keyboard.js -- computer keyboard as a piano.
 *
 * SPEC (from the user, verbatim):
 *   "qwertyuiop[]\ and zxcvbnm,./ to be major notes on my keyboard"
 *
 * Read as: those two rows are the NATURALS (white keys) -- a diatonic run each,
 * not a chromatic one. Sharps then sit on the row physically above, offset by
 * one key so each black key lands between the two naturals it belongs between,
 * exactly like a piano. That means there is deliberately NO sharp key above the
 * E->F and B->C gaps; those keys stay unbound rather than being packed with
 * notes, because a piano has a gap there and muscle memory depends on it.
 *
 *   1 2 3 4 5 6 7 8 9 0 - =      <- sharps for the upper row
 *    q w e r t y u i o p [ ] \   <- naturals from C4
 *
 *   a s d f g h j k l ; '        <- sharps for the lower row
 *    z x c v b n m , . /         <- naturals from C3
 */

'use strict';

/** Semitone offsets of the naturals within an octave: C D E F G A B. */
const NATURAL_SEMITONES = [0, 2, 4, 5, 7, 9, 11];

/** Naturals that have a black key immediately above them (C D _ F G A _). */
const HAS_SHARP_ABOVE = [true, true, false, true, true, true, false];

const LOWER_NATURALS = ['z', 'x', 'c', 'v', 'b', 'n', 'm', ',', '.', '/'];
const LOWER_SHARPS = ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', ';', "'"];
const UPPER_NATURALS = ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p', '[', ']', '\\'];
const UPPER_SHARPS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '='];

/** MIDI note for C3 / C4 in the scheme where middle C (C4) is 60. */
const LOWER_ROW_BASE = 48;
const UPPER_ROW_BASE = 60;

/**
 * Pure function. Builds the key -> MIDI note map for one pair of rows.
 *
 * Naturals are laid out diatonically from `base`. Each natural that has a black
 * key above it claims the sharp-row key one position to its right, mirroring the
 * physical offset of a piano's black keys.
 *
 * @param {string[]} naturals - keys forming the white-key run, left to right
 * @param {string[]} sharps - keys on the row above, left to right
 * @param {number} base - MIDI note of the first natural
 * @returns {Object<string, number>} map from lowercase key to MIDI note
 *
 * @example
 * // z is C3, s is C#3 (one key right of a, which sits above nothing),
 * // and c (E3) gets no sharp because E->F has no black key.
 * buildRowMap(['z','x','c'], ['a','s','d'], 48)
 * // { z: 48, s: 49, x: 50, d: 51, c: 52 }
 */
function buildRowMap(naturals, sharps, base) {
  const map = {};

  naturals.forEach((key, i) => {
    const octave = Math.floor(i / NATURAL_SEMITONES.length);
    const degree = i % NATURAL_SEMITONES.length;
    const note = base + octave * 12 + NATURAL_SEMITONES[degree];
    map[key] = note;

    if (HAS_SHARP_ABOVE[degree]) {
      const sharpKey = sharps[i + 1];
      if (sharpKey !== undefined) map[sharpKey] = note + 1;
    }
  });

  return map;
}

/**
 * Pure function. The complete default keyboard map, both rows.
 *
 * @returns {Object<string, number>} key -> MIDI note
 *
 * @example buildKeyMap()['z']  // 48  (C3)
 * @example buildKeyMap()['q']  // 60  (C4, middle C)
 * @example buildKeyMap()['s']  // 49  (C#3)
 * @example buildKeyMap()['k']  // undefined -- B->C has no black key
 */
export function buildKeyMap() {
  return {
    ...buildRowMap(LOWER_NATURALS, LOWER_SHARPS, LOWER_ROW_BASE),
    ...buildRowMap(UPPER_NATURALS, UPPER_SHARPS, UPPER_ROW_BASE),
  };
}

/** Furthest the octave shift may travel in either direction before notes leave MIDI range. */
const OCTAVE_LIMIT = 3;

/**
 * Attaches keyboard playing to the window.
 *
 * Command. Adds listeners and mutates internal held-note state.
 *
 * Handles the three things that otherwise produce stuck notes or wrong input:
 *   - key auto-repeat fires keydown repeatedly; retriggering on each would
 *     machine-gun the note, so held keys are tracked and repeats ignored
 *   - losing window focus never delivers keyup, so blur releases everything
 *   - typing in an input field must not play notes
 *
 * @param {object} handlers
 * @param {(note: number, velocity: number) => void} handlers.onNoteOn
 * @param {(note: number) => void} handlers.onNoteOff
 * @param {(info: {octave: number, velocity: number}) => void} [handlers.onStateChange]
 * @returns {{destroy: () => void, held: Set<number>}}
 */
export function attachKeyboard({ onNoteOn, onNoteOff, onStateChange }) {
  const keyMap = buildKeyMap();
  const heldKeys = new Map(); // physical key -> the MIDI note it triggered
  const held = new Set(); // sounding MIDI notes, for the on-screen keyboard

  let octaveShift = 0;
  let velocity = 100;

  const notify = () => onStateChange?.({ octave: octaveShift, velocity });

  /** Command. Releases every sounding note. Used on blur and on octave change. */
  const releaseAll = () => {
    for (const note of heldKeys.values()) {
      onNoteOff(note);
      held.delete(note);
    }
    heldKeys.clear();
  };

  const onKeyDown = (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;

    const key = e.key.toLowerCase();

    // Octave shift releases sounding notes first: their keyup would otherwise
    // compute a different note number and leave the original hanging forever.
    if (key === 'arrowleft' || key === 'arrowright') {
      const next = octaveShift + (key === 'arrowright' ? 1 : -1);
      if (Math.abs(next) <= OCTAVE_LIMIT) {
        releaseAll();
        octaveShift = next;
        notify();
      }
      e.preventDefault();
      return;
    }

    if (key === 'arrowup' || key === 'arrowdown') {
      velocity = Math.max(1, Math.min(127, velocity + (key === 'arrowup' ? 10 : -10)));
      notify();
      e.preventDefault();
      return;
    }

    const base = keyMap[key];
    if (base === undefined) return;

    e.preventDefault();
    if (heldKeys.has(key)) return; // auto-repeat

    const note = base + octaveShift * 12;
    if (note < 0 || note > 127) return;

    heldKeys.set(key, note);
    held.add(note);
    onNoteOn(note, velocity);
  };

  const onKeyUp = (e) => {
    const key = e.key.toLowerCase();
    const note = heldKeys.get(key);
    if (note === undefined) return;
    heldKeys.delete(key);
    held.delete(note);
    onNoteOff(note);
  };

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', releaseAll);

  notify();

  return {
    held,
    destroy() {
      releaseAll();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', releaseAll);
    },
  };
}
