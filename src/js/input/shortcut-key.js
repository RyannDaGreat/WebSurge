/**
 * shortcut-key.js -- the keyboard legend.
 *
 * "Key" as in the key to a map: what every binding does, in one place.
 *
 * GENERATED, NOT WRITTEN
 * ----------------------
 * Every row here comes from the same data the dispatcher runs -- the bindings
 * table in shortcuts.js and the row constants in keyboard.js. Nothing about a
 * shortcut is described twice, so the legend cannot fall out of step with the
 * behaviour. The thing it replaces was a hand-written sentence in index.html
 * that listed the note keys, and it had already gone stale.
 *
 * STYLING
 * -------
 * The shell (`#shortcut-key` / `#shortcut-key-box`) is in index.html so the skin
 * system dresses it exactly like the start overlay -- it is registered under the
 * same `overlay` / `overlayBox` regions. Everything built here uses
 * `currentColor`, `border-current` and opacity rather than named colours, so it
 * reads correctly on Frosted Glass and on Paper & Ink without either skin
 * needing to know it exists.
 */

'use strict';

import { NOTE_ROWS } from '../keyboard.js';
import { formatChord, groupBindings } from './shortcuts.js';

/** Utility classes for one key cap. Neutral so every skin can host it. */
const CAP = 'inline-flex min-w-6 items-center justify-center rounded border ' +
  'border-current/25 px-1.5 py-0.5 font-mono text-[11px] leading-none opacity-90';

/** Utility classes for a section heading. */
const HEADING = 'text-[10px] font-semibold uppercase tracking-[0.18em] opacity-50';

/**
 * Pure function. A key-cap element.
 *
 * @param {string} text - what is printed on the cap
 * @returns {HTMLElement}
 *
 * @example cap('PgDn')  // <kbd class="…">PgDn</kbd>
 */
function cap(text) {
  const el = document.createElement('kbd');
  el.className = CAP;
  el.textContent = text;
  return el;
}

/**
 * Pure function. One labelled row of key caps.
 *
 * @param {string} label - left-hand description
 * @param {string[]} keys - cap texts, in order
 * @returns {HTMLElement}
 *
 * @example row('White keys', ['z', 'x', 'c'])
 */
function row(label, keys) {
  const el = document.createElement('div');
  el.className = 'flex items-baseline gap-3 py-0.5';

  const name = document.createElement('span');
  name.className = 'w-32 shrink-0 text-xs opacity-70';
  name.textContent = label;
  el.append(name);

  const caps = document.createElement('span');
  caps.className = 'flex flex-wrap gap-1';
  for (const k of keys) caps.append(cap(k));
  el.append(caps);

  return el;
}

/**
 * Pure function. A titled block of rows.
 *
 * @param {string} title
 * @param {HTMLElement[]} rows
 * @returns {HTMLElement}
 */
function section(title, rows) {
  const el = document.createElement('section');
  el.className = 'flex flex-col gap-1';

  const h = document.createElement('h3');
  h.className = HEADING;
  h.textContent = title;
  el.append(h, ...rows);

  return el;
}

/**
 * Pure function. The note-layout section, read from keyboard.js's own rows.
 *
 * @returns {HTMLElement}
 *
 * @example
 * // Renders four rows: lower naturals, lower sharps, upper naturals, upper
 * // sharps -- whatever keyboard.js currently declares them to be.
 */
function notesSection() {
  return section('Notes', NOTE_ROWS.map((r) => row(r.label, r.keys)));
}

/**
 * Pure function. One section per binding group.
 *
 * @param {Array<object>} bindings
 * @returns {HTMLElement[]}
 *
 * @example
 * // bindings with group 'Patch' and group 'View' produce two sections
 */
function bindingSections(bindings) {
  return [...groupBindings(bindings)].map(([group, items]) =>
    section(group, items.map((b) => row(b.label, formatChord(b.chord).split(' + ')))));
}

/**
 * Command. Fills the legend and wires opening and closing.
 *
 * @param {Array<object>} bindings - the same table the dispatcher runs
 * @returns {{open: () => void, close: () => void, toggle: () => void}}
 *
 * @example
 * const legend = createShortcutKey(BINDINGS);
 * legend.toggle();   // bound to `?` and F1
 */
export function createShortcutKey(bindings) {
  const shell = document.getElementById('shortcut-key');
  const box = document.getElementById('shortcut-key-box');

  const title = document.createElement('h2');
  title.className = 'mb-1 text-lg font-semibold';
  title.textContent = 'Keyboard';

  const grid = document.createElement('div');
  grid.className = 'grid grid-cols-1 gap-x-10 gap-y-5 md:grid-cols-2';
  grid.append(notesSection(), ...bindingSections(bindings));

  const dismiss = document.createElement('p');
  dismiss.className = 'mt-1 text-xs opacity-60';
  dismiss.append('Press ', cap('Esc'), ' or click anywhere to close.');

  box.replaceChildren(title, grid, dismiss);
  box.classList.add('flex', 'flex-col', 'gap-4', 'max-h-[85vh]', 'overflow-auto');

  const close = () => { shell.hidden = true; };
  const open = () => { shell.hidden = false; };

  // Clicking the backdrop closes; clicking inside the panel does not.
  shell.addEventListener('click', (e) => { if (e.target === shell) close(); });
  box.addEventListener('click', (e) => e.stopPropagation());

  return {
    open,
    close,
    /** Command. Shows the legend if hidden, hides it if shown. */
    toggle() { shell.hidden = !shell.hidden; },
    /** Query. Is the legend currently open? */
    isOpen: () => !shell.hidden,
  };
}
