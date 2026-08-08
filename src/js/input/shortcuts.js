/**
 * shortcuts.js -- the keyboard binding table and its dispatcher.
 *
 * ONE SOURCE OF TRUTH
 * -------------------
 * A binding declares its chord, its group, its human label and what it does, in
 * one object. The dispatcher reads that table and so does the legend overlay, so
 * a shortcut cannot exist without appearing in the help, and the help cannot
 * describe a shortcut that is not wired up. The previous arrangement -- a
 * hand-written sentence in index.html listing the note keys -- had already
 * drifted from the code it described.
 *
 * WHY THESE CHORDS AND NOT THE OBVIOUS ONES
 * -----------------------------------------
 * The QWERTY note layout (keyboard.js) occupies almost the whole keyboard: four
 * rows of letters and digits are notes, and the arrow keys are octave and
 * velocity. That leaves far less room than it looks:
 *
 *   - the digits 1-0 and -= are SHARPS, so bare `1`/`2`/`3` cannot switch modes
 *   - the arrows are already octave/velocity, so bare arrows cannot change patch
 *   - `,` `.` `/` `[` `]` `\` `;` `'` are all natural or sharp keys
 *
 * keyboard.js bails out the moment ctrl, meta or alt is held (keyboard.js:131),
 * which makes anything with those modifiers free by construction. That is the
 * space the shortcuts live in, plus the few keys the note layout never claimed:
 * PageUp/PageDown, Escape, F1 and `?`.
 */

'use strict';

/** Modifier names accepted in a chord string, in canonical display order. */
const MODIFIERS = ['ctrl', 'shift', 'alt', 'meta'];

/** How a key name is written in the legend when the raw name is unfriendly. */
const KEY_LABELS = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
  Escape: 'Esc',
  ' ': 'Space',
};

/**
 * Pure function. Splits a chord string into its modifiers and its key.
 *
 * @param {string} chord - e.g. 'ctrl+shift+PageUp', 'Escape', '?'
 * @returns {{mods: string[], key: string}} mods are lowercase, key is verbatim
 *
 * @example parseChord('ctrl+PageDown')  // { mods: ['ctrl'], key: 'PageDown' }
 * @example parseChord('?')              // { mods: [], key: '?' }
 */
export function parseChord(chord) {
  const parts = chord.split('+');
  const key = parts.pop();
  return { mods: parts.map((m) => m.toLowerCase()), key };
}

/**
 * Pure function. Does this keyboard event match this chord exactly?
 *
 * Exactly, not loosely: a chord without `shift` does NOT match a shift-held
 * event. Otherwise `PageDown` would swallow `shift+PageDown` and the category
 * shortcut could never fire, since the plain one is tested first.
 *
 * The key comparison is case-insensitive so a binding can be written `?` or `f1`
 * without caring how the browser reports it.
 *
 * @param {KeyboardEvent} event
 * @param {string} chord
 * @returns {boolean}
 *
 * @example
 * // event = PageDown with no modifiers
 * matchesChord(event, 'PageDown')        // true
 * matchesChord(event, 'shift+PageDown')  // false
 */
export function matchesChord(event, chord) {
  const { mods, key } = parseChord(chord);

  const held = {
    ctrl: event.ctrlKey,
    shift: event.shiftKey,
    alt: event.altKey,
    meta: event.metaKey,
  };

  for (const m of MODIFIERS) {
    if (held[m] !== mods.includes(m)) return false;
  }
  return event.key.toLowerCase() === key.toLowerCase();
}

/**
 * Pure function. A chord as it should be shown to a person.
 *
 * @param {string} chord
 * @returns {string}
 *
 * @example formatChord('ctrl+shift+PageUp')  // 'Ctrl + Shift + PgUp'
 * @example formatChord('ArrowLeft')          // '←'
 */
export function formatChord(chord) {
  const { mods, key } = parseChord(chord);
  const shown = mods
    .map((m) => m.charAt(0).toUpperCase() + m.slice(1))
    .concat(KEY_LABELS[key] || (key.length === 1 ? key.toUpperCase() : key));
  return shown.join(' + ');
}

/**
 * Pure function. The first binding whose chord the event matches.
 *
 * Longer chords are tested first so a more specific binding always wins over a
 * less specific one regardless of the order they were declared in.
 *
 * @param {Array<object>} bindings
 * @param {KeyboardEvent} event
 * @returns {object|null}
 *
 * @example
 * // bindings = [{chord:'PageDown',…}, {chord:'shift+PageDown',…}]
 * // a shift-held PageDown event returns the shift+PageDown binding
 */
export function findBinding(bindings, event) {
  const bySpecificity = [...bindings].sort(
    (a, b) => parseChord(b.chord).mods.length - parseChord(a.chord).mods.length);

  return bySpecificity.find((b) => matchesChord(event, b.chord)) || null;
}

/**
 * Pure function. Groups bindings for display, preserving declaration order.
 *
 * @param {Array<object>} bindings
 * @returns {Map<string, Array<object>>} group name -> its bindings
 *
 * @example
 * groupBindings([{group:'Patch', label:'Next'}, {group:'Patch', label:'Prev'}])
 * // Map { 'Patch' => [ {…Next}, {…Prev} ] }
 */
export function groupBindings(bindings) {
  const groups = new Map();
  for (const b of bindings) {
    if (!groups.has(b.group)) groups.set(b.group, []);
    groups.get(b.group).push(b);
  }
  return groups;
}

/**
 * Command. Listens for the bindings and runs them. Returns a teardown.
 *
 * Registered on `window` in the CAPTURE phase, ahead of keyboard.js's own
 * bubble-phase listener, so a shortcut that shares a key with the note layout
 * wins and does not also sound a note. Nothing currently overlaps -- see the
 * header -- but a future binding that does should behave predictably.
 *
 * Typing in a text field is never a shortcut. The notation editor is a textarea
 * and would otherwise be unusable.
 *
 * @param {Array<object>} bindings - each {id, chord, group, label, run}
 * @param {object} ctx - passed to run(), the app's shortcut-facing surface
 * @returns {{destroy: () => void}}
 *
 * @example
 * const s = attachShortcuts(BINDINGS, app);
 * // ... later
 * s.destroy();
 */
export function attachShortcuts(bindings, ctx) {
  const onKeyDown = (e) => {
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable) {
      return;
    }

    const binding = findBinding(bindings, e);
    if (!binding) return;

    e.preventDefault();
    e.stopPropagation();
    binding.run(ctx);
  };

  window.addEventListener('keydown', onKeyDown, true);
  return { destroy: () => window.removeEventListener('keydown', onKeyDown, true) };
}
