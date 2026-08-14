/**
 * wheels.js -- the pitch bend and mod wheels, and the patch's macro knobs.
 *
 * WHY THESE ARE NOT JUST MORE SLIDERS
 * -----------------------------------
 * A synth's expressive controls are the ones that are not saved with the patch:
 * you bend a note *while* playing it. Surge has them all as modulation sources —
 * pitch bend, mod wheel, breath, expression, aftertouch — and 8 **macros** whose
 * meaning each patch defines for itself. That is why a loaded patch shows
 * "How Messy?" and "Ring Mod" instead of "Macro 3" and "Macro 4".
 *
 * WHAT IS AND IS NOT INTERPRETED HERE
 * -----------------------------------
 * Nothing is interpreted. The wheels send MIDI CC 1 and pitch bend verbatim, and
 * what those *do* is decided by the patch's own modulation routing — a patch that
 * does not route the mod wheel will correctly do nothing when you move it,
 * exactly as on hardware.
 *
 * The macro knobs do NOT send a CC. Surge does not map CC 41-48 to macros by
 * default; assuming it did cost a round, and the symptom was instructive — the
 * knobs moved, the CCs were delivered, and not one of the 766 parameters
 * changed. `setMacroParameter01` is the real API.
 *
 * The macro labels are read back from Surge (`sgui_macro_name`) rather than
 * numbered, so they say what the patch says.
 *
 * PITCH BEND SPRINGS BACK
 * -----------------------
 * On release, because a real pitch wheel is sprung and leaving a note detuned
 * because you let go of the mouse elsewhere is a bug, not a feature. The mod
 * wheel does not, because a real one does not.
 */

'use strict';

/** MIDI CC 1 is the mod wheel, by universal convention. */
const CC_MOD_WHEEL = 1;

const CC_MAX = 127;

/**
 * Macro knobs are 0..1 internally, so the slider counts steps and divides.
 * Surge does NOT map CC 41-48 to macros by default -- that was an assumption,
 * and it cost a round: the knobs moved and no parameter changed.
 */
const MACRO_STEPS = 1000;

/** Pitch bend is 14-bit signed around zero. */
const BEND_MIN = -8192;
const BEND_MAX = 8191;

/** Every control here is on channel 1. */
const CHANNEL = 0;

/** Slider geometry, as Tailwind classes rather than px. */
const SLIDER = 'h-1.5 w-24 cursor-pointer appearance-none rounded-full bg-current/20 ' +
  'accent-current [&::-webkit-slider-thumb]:size-3 ' +
  '[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full ' +
  '[&::-webkit-slider-thumb]:bg-current';

const LABEL = 'flex flex-col gap-0.5 text-[10px] uppercase tracking-wider opacity-60';

/**
 * Pure function. Builds one labelled range control.
 *
 * @param {object} spec
 * @param {string} spec.label - shown above the slider
 * @param {number} spec.min
 * @param {number} spec.max
 * @param {number} spec.value - initial position
 * @param {string} [spec.title] - tooltip
 * @returns {{el: HTMLElement, input: HTMLInputElement}}
 *
 * @example
 * const { el, input } = slider({ label: 'Mod', min: 0, max: 127, value: 0 });
 * input.value  // '0'
 */
export function slider({ label, min, max, value, title }) {
  const el = document.createElement('label');
  el.className = LABEL;
  if (title) el.title = title;

  const text = document.createElement('span');
  text.textContent = label;

  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.value = String(value);
  input.className = SLIDER;

  el.append(text, input);
  return { el, input };
}

/**
 * Command. Builds the wheels and macro knobs into `container`.
 *
 * Macro labels come from Surge, so this must run after the synth exists. It
 * re-reads them on `refresh()`, which the app calls after a patch load —
 * otherwise the knobs would keep the previous patch's names, which is worse than
 * no names at all because it is confidently wrong.
 *
 * @param {HTMLElement} container
 * @param {object} io - needs {pitchBend, cc, macro}
 * @param {object} sg - the GUI module's cwrapped exports, for macro names
 * @returns {{refresh: () => void, destroy: () => void}}
 *
 * @example
 * const w = createWheels($('wheels'), app.io, app.sg);
 * w.refresh();   // after loading a patch, to pick up its macro names
 */
export function createWheels(container, io, sg) {
  container.textContent = '';

  // ---- pitch bend: sprung ---------------------------------------------------
  const bend = slider({
    label: 'Bend', min: BEND_MIN, max: BEND_MAX, value: 0,
    title: 'Pitch bend. Springs back to centre on release, like a real wheel.',
  });

  const sendBend = () => io.pitchBend(CHANNEL, Number(bend.input.value));
  const releaseBend = () => {
    bend.input.value = '0';
    sendBend();
  };

  bend.input.addEventListener('input', sendBend);
  bend.input.addEventListener('pointerup', releaseBend);
  bend.input.addEventListener('keyup', releaseBend);
  // A pointer released outside the slider never fires pointerup on it, which
  // would leave the note bent with the thumb visually back at centre.
  window.addEventListener('blur', releaseBend);

  // ---- mod wheel: stays where you put it ----------------------------------
  const mod = slider({
    label: 'Mod', min: 0, max: CC_MAX, value: 0,
    title: `Mod wheel (CC ${CC_MOD_WHEEL}). What it does is up to the patch.`,
  });
  mod.input.addEventListener('input',
    () => io.cc(CHANNEL, CC_MOD_WHEEL, Number(mod.input.value)));

  const wrap = document.createElement('div');
  wrap.className = 'flex items-end gap-3';
  wrap.append(bend.el, mod.el);

  // ---- macros: labelled by the patch --------------------------------------
  const macros = [];
  const count = sg.macroCount();

  for (let i = 0; i < count; i++) {
    const knob = slider({ label: `M${i + 1}`, min: 0, max: MACRO_STEPS, value: 0 });
    knob.input.addEventListener('input',
      () => io.macro(i, Number(knob.input.value) / MACRO_STEPS));
    macros.push(knob);
    wrap.append(knob.el);
  }

  container.append(wrap);

  /** Command. Re-reads the macro names AND values from the loaded patch. */
  const refresh = () => {
    macros.forEach((knob, i) => {
      // The patch carries its own macro positions, so show those rather than
      // leaving every knob at zero and lying about the patch's state.
      knob.input.value = String(Math.round(sg.getMacro(i) * MACRO_STEPS));

      const name = sg.macroName(i).trim();
      const label = knob.el.firstElementChild;
      label.textContent = name || `M${i + 1}`;
      knob.el.title = name
        ? `${name} — macro ${i + 1}, named by this patch`
        : `Macro ${i + 1}, unnamed in this patch`;
    });
  };

  refresh();

  return {
    refresh,
    destroy() {
      window.removeEventListener('blur', releaseBend);
      container.textContent = '';
    },
  };
}
