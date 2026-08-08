/**
 * registry.js -- one active note-input mode at a time.
 *
 * WHAT A MODE IS
 * --------------
 * A way of turning human intent into note-on and note-off. The QWERTY keyboard
 * is one. A piano roll is another. A notation editor is a third. They have
 * almost nothing in common internally, so the only thing this file insists on is
 * the shape of the seam:
 *
 *   {
 *     id:    'keyboard',
 *     label: 'Computer keyboard',
 *     hint:  'one line shown under the picker',
 *     async mount(container, io) -> { destroy(), shortcuts? }
 *   }
 *
 * `io` is the app's note surface -- {noteOn, noteOff, allNotesOff} -- and is the
 * ONLY channel a mode has to make sound. A mode never touches the synth, the
 * worklet or the piano directly.
 *
 * WHY MOUNT IS ASYNC
 * ------------------
 * So a mode can `import()` a heavy dependency the first time it is chosen rather
 * than at page load. The notation mode pulls in abcjs; nobody who never opens it
 * should pay for it, on a page that already downloads a 19 MB wasm module.
 *
 * TEARDOWN IS MANDATORY, NOT POLITE
 * ---------------------------------
 * Every mount returns a destroy(). Modes register window-level listeners, and a
 * mode that is switched away from but keeps listening produces the worst class
 * of bug here: two input sources firing at once, notes that stick because the
 * handler that would release them is gone, and no error anywhere. This is not
 * hypothetical -- attachKeyboard() has always returned a destroy() and the app
 * discarded it, and createPiano() leaked a window blur listener.
 */

'use strict';

/**
 * Command. Builds a registry over a list of modes.
 *
 * Nothing is mounted until `activate` is called, so construction is cheap and
 * order-independent.
 *
 * @param {Array<object>} modes - mode descriptors, in picker order
 * @param {object} io - {noteOn, noteOff, allNotesOff} handed to each mode
 * @param {HTMLElement} container - where the active mode builds its UI
 * @returns {{activate, activeId, modes, current, destroy}}
 *
 * @example
 * const reg = createModeRegistry([keyboardMode, pianoRollMode], app.io, el);
 * await reg.activate('keyboard');
 * reg.activeId()            // 'keyboard'
 * reg.current().shortcuts   // bindings this mode contributes, if any
 */
export function createModeRegistry(modes, io, container) {
  const byId = new Map(modes.map((m) => [m.id, m]));

  let activeId = null;
  let mounted = null;

  /**
   * Command. Tears down the current mode and mounts another.
   *
   * Silences anything still sounding first. A mode is under no obligation to
   * release its own notes on the way out -- a held piano-roll note has no
   * keyup coming -- so the registry does it rather than trusting each mode.
   *
   * @param {string} id
   * @returns {Promise<void>}
   */
  async function activate(id) {
    const mode = byId.get(id);
    if (!mode) {
      throw new Error(`Unknown input mode "${id}" -- have: ${[...byId.keys()].join(', ')}`);
    }
    if (id === activeId) return;

    io.allNotesOff();

    if (mounted) {
      mounted.destroy();
      mounted = null;
    }
    container.textContent = '';

    mounted = await mode.mount(container, io);
    if (!mounted || typeof mounted.destroy !== 'function') {
      throw new Error(`Input mode "${id}" did not return a destroy() from mount()`);
    }
    activeId = id;
  }

  return {
    activate,

    /** Query. The id of the mounted mode, or null before the first activate. */
    activeId: () => activeId,

    /** Query. The mode descriptors, in picker order. */
    modes: () => modes,

    /** Query. What the active mode's mount() returned, or null. */
    current: () => mounted,

    /** Command. Unmounts whatever is active. Safe to call twice. */
    destroy() {
      if (mounted) mounted.destroy();
      mounted = null;
      activeId = null;
    },
  };
}
