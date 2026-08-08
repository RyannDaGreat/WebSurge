/**
 * bindings.js -- what every shortcut is and what it does.
 *
 * The single table. shortcuts.js runs it; shortcut-key.js renders it. Adding a
 * binding here makes it both live and documented, and there is nowhere to add
 * one that does only half of that.
 *
 * `run` receives the app. Keeping the verbs on the app rather than inline here
 * means the same actions stay reachable from a menu, a MIDI controller or a test
 * without going through a synthetic keyboard event.
 *
 * On the chords themselves: the QWERTY note layout claims all four letter rows,
 * the digits, and the arrow keys, so the obvious choices are not available --
 * see the header of shortcuts.js for the full reasoning. PageUp/PageDown, Esc,
 * F1 and `?` are the keys the note layout never took; anything with Ctrl is free
 * because keyboard.js ignores modified keys entirely.
 */

'use strict';

export const BINDINGS = [
  {
    id: 'patch-next',
    chord: 'PageDown',
    group: 'Patch',
    label: 'Next patch',
    run: (app) => app.stepPatch(1),
  },
  {
    id: 'patch-prev',
    chord: 'PageUp',
    group: 'Patch',
    label: 'Previous patch',
    run: (app) => app.stepPatch(-1),
  },
  {
    id: 'category-next',
    chord: 'shift+PageDown',
    group: 'Patch',
    label: 'Next category',
    run: (app) => app.stepCategory(1),
  },
  {
    id: 'category-prev',
    chord: 'shift+PageUp',
    group: 'Patch',
    label: 'Previous category',
    run: (app) => app.stepCategory(-1),
  },
  {
    id: 'patch-random',
    chord: 'ctrl+r',
    group: 'Patch',
    label: 'Random patch',
    run: (app) => app.randomPatch(),
  },

  {
    id: 'panic',
    chord: 'Escape',
    group: 'Playing',
    label: 'Close this, or panic',
    run: (app) => app.escape(),
  },

  {
    id: 'mode-keyboard',
    chord: 'ctrl+1',
    group: 'Input mode',
    label: 'Computer keyboard',
    run: (app) => app.setInputMode('keyboard'),
  },
  {
    id: 'mode-pianoroll',
    chord: 'ctrl+2',
    group: 'Input mode',
    label: 'Piano roll',
    run: (app) => app.setInputMode('pianoroll'),
  },
  {
    id: 'mode-notation',
    chord: 'ctrl+3',
    group: 'Input mode',
    label: 'Notation',
    run: (app) => app.setInputMode('notation'),
  },

  {
    id: 'help',
    chord: '?',
    group: 'View',
    label: 'This legend',
    run: (app) => app.toggleShortcutKey(),
  },
  {
    id: 'help-f1',
    chord: 'F1',
    group: 'View',
    label: 'This legend',
    run: (app) => app.toggleShortcutKey(),
  },
];
