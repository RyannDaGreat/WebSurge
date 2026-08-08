/**
 * piano.js -- a full 128-key MIDI keyboard across the width of the window.
 *
 * Two jobs:
 *   - show which notes are sounding, whichever way they were triggered
 *     (computer keyboard, mouse on the piano itself, or MIDI later)
 *   - be playable with the mouse, including glissando by dragging
 *
 * All 128 MIDI notes are shown, 0..127, which is 75 white keys and 53 black.
 * White keys tile the full width; black keys are absolutely positioned over the
 * boundaries between them, which is what makes the spacing look like a real
 * keyboard rather than evenly divided.
 */

'use strict';

/** Semitones within an octave that are white keys: C D E F G A B. */
const WHITE_SEMITONES = [0, 2, 4, 5, 7, 9, 11];

/** The full MIDI range. */
const MIDI_LOW = 0;
const MIDI_HIGH = 127;

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/**
 * Pure function. Is this MIDI note a white key?
 *
 * @param {number} note - MIDI note number
 * @returns {boolean}
 *
 * @example isWhite(60) // true  (C4)
 * @example isWhite(61) // false (C#4)
 */
export function isWhite(note) {
  return WHITE_SEMITONES.includes(note % 12);
}

/**
 * Pure function. Human-readable name for a MIDI note, with octave.
 *
 * Uses the convention where middle C (note 60) is C4, which is what Surge's own
 * keytrack display shows.
 *
 * @param {number} note
 * @returns {string}
 *
 * @example noteName(60) // 'C4'
 * @example noteName(0)  // 'C-1'
 * @example noteName(61) // 'C#4'
 */
export function noteName(note) {
  return `${NOTE_NAMES[note % 12]}${Math.floor(note / 12) - 1}`;
}

/**
 * Pure function. Layout for every key, as fractions of total width.
 *
 * White keys are laid out end to end. Each black key is centred on the boundary
 * between the two white keys it sits between, so the classic uneven grouping
 * falls out of the note pattern rather than being hard-coded.
 *
 * @returns {{white: Array<{note:number,x:number,w:number}>,
 *            black: Array<{note:number,x:number,w:number}>}}
 *           x and w are fractions of the total width, 0..1
 *
 * @example
 * const l = keyLayout();
 * l.white.length // 75
 * l.black.length // 53
 */
export function keyLayout() {
  const whiteNotes = [];
  for (let n = MIDI_LOW; n <= MIDI_HIGH; n++) if (isWhite(n)) whiteNotes.push(n);

  const unit = 1 / whiteNotes.length;
  const white = whiteNotes.map((note, i) => ({ note, x: i * unit, w: unit }));

  // A black key sits on the seam after the white key below it.
  const indexOfWhite = new Map(whiteNotes.map((n, i) => [n, i]));
  const blackWidth = unit * 0.62;

  const black = [];
  for (let n = MIDI_LOW; n <= MIDI_HIGH; n++) {
    if (isWhite(n)) continue;
    const seam = indexOfWhite.get(n - 1);
    if (seam === undefined) continue; // a black key with no white below it cannot be placed
    black.push({ note: n, x: (seam + 1) * unit - blackWidth / 2, w: blackWidth });
  }
  return { white, black };
}

/**
 * Builds the on-screen keyboard.
 *
 * Command: creates DOM inside `container` and wires pointer handlers.
 *
 * @param {HTMLElement} container
 * @param {object} handlers
 * @param {(note:number, velocity:number) => void} handlers.onNoteOn
 * @param {(note:number) => void} handlers.onNoteOff
 * @returns {{setHeld: (note:number, on:boolean) => void, clear: () => void}}
 */
export function createPiano(container, { onNoteOn, onNoteOff }) {
  const { white, black } = keyLayout();
  const els = new Map(); // note -> element

  container.textContent = '';
  container.classList.add('piano');

  /** Velocity for mouse-played notes; the computer keyboard supplies its own. */
  const MOUSE_VELOCITY = 100;

  const make = (k, kind) => {
    const el = document.createElement('div');
    el.className = `key ${kind}`;
    el.style.left = `${k.x * 100}%`;
    el.style.width = `${k.w * 100}%`;
    el.dataset.note = String(k.note);
    // Only C's are labelled; 128 labels would be unreadable at this width.
    if (k.note % 12 === 0) el.dataset.label = noteName(k.note);
    els.set(k.note, el);
    container.append(el);
    return el;
  };

  // White first so black keys paint over them.
  for (const k of white) make(k, 'white');
  for (const k of black) make(k, 'black');

  // ---- mouse play, with drag-to-glissando -------------------------------
  let mouseNote = null;

  const noteAt = (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || !el.dataset || el.dataset.note === undefined) return null;
    return Number(el.dataset.note);
  };

  const press = (note) => {
    if (note === null || note === mouseNote) return;
    if (mouseNote !== null) onNoteOff(mouseNote);
    mouseNote = note;
    onNoteOn(note, MOUSE_VELOCITY);
  };

  const release = () => {
    if (mouseNote === null) return;
    onNoteOff(mouseNote);
    mouseNote = null;
  };

  container.addEventListener('pointerdown', (e) => {
    container.setPointerCapture(e.pointerId);
    press(noteAt(e));
    e.preventDefault();
  });
  container.addEventListener('pointermove', (e) => {
    // Only glissando while a button is held.
    if (mouseNote !== null && e.buttons) press(noteAt(e));
  });
  container.addEventListener('pointerup', (e) => {
    release();
    container.releasePointerCapture?.(e.pointerId);
  });
  container.addEventListener('pointercancel', release);
  // A pointer leaving the window never delivers pointerup, which would leave a
  // note sounding forever.
  window.addEventListener('blur', release);

  return {
    /** Command. Lights or unlights a key. Ignores notes outside 0..127. */
    setHeld(note, on) {
      els.get(note)?.classList.toggle('held', on);
    },
    /** Command. Unlights everything. Used on panic and focus loss. */
    clear() {
      for (const el of els.values()) el.classList.remove('held');
    },
  };
}
