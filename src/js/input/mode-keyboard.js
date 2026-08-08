/**
 * mode-keyboard.js -- the computer keyboard as a note source.
 *
 * A thin adapter. All the real work -- the diatonic row layout, octave and
 * velocity shifting, auto-repeat suppression, releasing held notes before an
 * octave shift so keyup cannot strand them -- already lives in keyboard.js and
 * is unchanged. This exists so that behaviour can be switched off, which it
 * previously could not be: attachKeyboard() has always returned a destroy() and
 * gui-app.js discarded the return value, so there was no way to stop listening.
 */

'use strict';

import { attachKeyboard } from '../keyboard.js';

export const keyboardMode = {
  id: 'keyboard',
  label: 'Computer keyboard',
  hint: 'Bottom two rows are white keys; the row above each plays the sharps.',

  /**
   * Command. Starts listening for note keys.
   *
   * @param {HTMLElement} container - unused; this mode has no UI of its own,
   *        since its interface is the physical keyboard and the piano strip
   *        already shows what is held
   * @param {object} io - {noteOn, noteOff, allNotesOff, setModeStatus}
   * @returns {Promise<{destroy: () => void}>}
   */
  async mount(container, io) {
    const kb = attachKeyboard({
      onNoteOn: (note, velocity) => io.noteOn(note, velocity),
      onNoteOff: (note) => io.noteOff(note),
      onStateChange: ({ octave, velocity }) =>
        io.setModeStatus(`octave ${octave >= 0 ? '+' : ''}${octave} · vel ${velocity}`),
    });

    return {
      destroy() {
        kb.destroy();
        io.setModeStatus('');
      },
    };
  },
};
