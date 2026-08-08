/**
 * mode-signal.js -- ryohey's signal, driving Surge.
 *
 * THE EDITOR IS NOT OURS, AND IT IS NOT A COMPONENT EITHER
 * -------------------------------------------------------
 * signal (https://github.com/ryohey/signal, MIT, by ryohey) is a full MIDI
 * sequencer: a WebGL piano roll, an arrange view, a tempo graph, automation
 * lanes, MIDI import and export. All of that is theirs and none of it is
 * reimplemented here. The difference from mode-pianoroll.js is that
 * webaudio-pianoroll is a custom element you can `document.createElement`, and
 * signal is not: it is a React application with no npm package, no web
 * component and no embed API. `packages/` was checked -- `@signal-app/player`
 * and `@signal-app/core` are private workspace packages holding the engine and
 * the data model, not a mountable editor.
 *
 * So it is used the only way an application can be used: built, and put in an
 * iframe. The build is committed at src/vendor/signal/ because GitHub Pages
 * serves src/ verbatim and cannot run a Vite build; `./setup.sh signal`
 * regenerates it from a pinned commit plus patches/signal-embed.patch.
 *
 * WHAT WE HOOKED, AND WHY IT IS ONE LINE THERE AND ONE FILE HERE
 * -------------------------------------------------------------
 * signal's playback engine fans every MIDI event out through a `SynthOutput`
 * interface -- two methods, `activate()` and `sendEvent(event, delayTime,
 * timestampNow, trackId)` -- and `GroupOutput` holds a list of them. That list
 * is how signal already supports playing to a real MIDI port instead of its own
 * SoundFont, so it is a seam upstream built on purpose, not one we prised open.
 * Everything audible goes through it: transport playback, note previews while
 * you draw, the piano gutter, instrument auditions.
 *
 * Our patch adds one more implementation of that interface -- ParentPortOutput,
 * which posts each event to `window.parent` -- and selects it inside
 * `updateOutputDevices` in signal's stores/reactions.ts, which is the function
 * that owns the output list. Not in the constructor that appears to build the
 * list: a mobx autorun replaces the whole array immediately afterwards, so an
 * output pushed there receives exactly 16 events and then nothing, forever. That
 * is written up in the patch header and in manifest §14.1, because the symptom
 * looks like a broken bridge rather than a bypassed one.
 *
 * No editor code is touched. The piano roll, the note model, the WebGL renderer,
 * the gestures, the arrange view and the tempo editor are all upstream's.
 *
 * This file is the other half: it receives those posts and turns them into
 * `io.noteOn` / `io.noteOff`.
 *
 * TIMING
 * ------
 * Each message carries `delayMs`, how long from the moment it was posted until
 * the event is due. It is relative on purpose: `performance.now()` is measured
 * from each browsing context's own time origin, so a timestamp from the iframe
 * would be a reading from a clock this frame does not share. A relative figure
 * needs no shared clock, and is what `setTimeout` wants anyway.
 *
 * Accuracy is the same as the piano roll's and no better: signal schedules
 * ~100 ms ahead, and the last hop here is `setTimeout` plus a `postMessage` to
 * the audio thread, so notes land within a few milliseconds of where they should
 * and the amount varies. Good for writing and hearing music. Not a sequencer,
 * and it must not be called one. The fix is the same one named in
 * mode-pianoroll.js: a timestamped event queue inside surge-worklet.js. This
 * mode already knows each note's deadline and would pass it straight through.
 *
 * WHAT DOES NOT REACH SURGE, AND WHY
 * ----------------------------------
 * `io` is `{noteOn, noteOff, allNotesOff, setModeStatus}` and that is the whole
 * surface a mode gets -- deliberately, see registry.js. So of everything signal
 * sends, only note-on and note-off can be delivered:
 *
 *  - **Pitch bend, CC lanes, aftertouch, program changes** are dropped. This is
 *    the biggest gap, because signal has full automation lanes for them and
 *    Surge's worklet already understands `pitchBend` and `cc` messages (see
 *    manifest §15). Nothing sends them yet, and widening `io` is the fix.
 *  - **Channels collapse.** signal is 16-channel multi-track; this is one Surge
 *    instance playing one patch. A four-track arrangement plays as four parts on
 *    the same patch, and drums on channel 10 play as pitches.
 *  - **Velocity survives.** Unlike the webaudio-pianoroll mode, which has no
 *    per-note velocity to send at all, signal's velocities come through.
 *  - The metronome does not reach us: signal routes it to a separate output and
 *    it is off by default.
 *
 * TWO THINGS THE PATCH TURNS OFF, RESTATED HERE BECAUSE THEY ARE VISIBLE
 * ---------------------------------------------------------------------
 *  - No Firebase, no sign-in, no cloud open/save. This is a static site; an
 *    account would be broken and inappropriate. File > Open/Save still work --
 *    they are local, via the File System Access API, and MIDI import/export are
 *    the interesting paths anyway.
 *  - No Google Fonts, so signal's UI renders in system fonts rather than Inter.
 *    Cosmetic, and the price of making no third-party requests.
 *
 * Licence: signal is MIT, one-way compatible with this project's GPLv3 -- we may
 * ship it under the GPL, they could not ship us under the MIT. Its notice
 * travels with the build at src/vendor/signal/LICENSE, and the commit it was
 * built from is in src/vendor/signal/PROVENANCE.txt.
 */

'use strict';

/**
 * The built editor, resolved against THIS FILE's URL.
 *
 * Two levels up, not one: this module lives at js/input/, so `../vendor` would
 * resolve to js/vendor and 404. Same trap as mode-pianoroll.js.
 */
const SIGNAL_URL = '../../vendor/signal/edit.html';

/**
 * The message type ParentPortOutput posts. Must match the constant in
 * patches/signal-embed.patch; if they ever drift, nothing arrives and this mode
 * is a silent editor, so the patch is the only place it may be changed.
 */
const SYNTH_OUTPUT_MESSAGE = 'signal:synth-output';

/**
 * How tall the editor gets. signal lays out a toolbar, a piano roll and an
 * automation pane stacked vertically and is cramped in much less than this.
 */
const PANEL_HEIGHT_PX = 620;

/**
 * MIDI controller numbers that mean "stop everything". Sent on all 16 channels
 * by signal's transport whenever it stops or seeks.
 */
const CC_ALL_SOUNDS_OFF = 120;
const CC_ALL_NOTES_OFF = 123;

/**
 * Pure function. What one of signal's MIDI events means in terms of `io`.
 *
 * Reduces the MIDI event vocabulary to the three things a mode can actually do,
 * plus `ignore` for the rest. Two details are not obvious from the event names:
 *
 *  - A note-on with velocity 0 is a note-off. This is real MIDI, not a quirk --
 *    running-status encoders emit releases that way and signal's own exporter
 *    will produce them from an imported file. Passing it through as a note-on
 *    would leave Surge holding that note until the next panic.
 *  - `allOff` covers only the two "stop" controllers. Every other controller,
 *    pitch bend and program change is `ignore` because `io` has nowhere to put
 *    it; see the file header.
 *
 * @param {object} event - a midifile-ts event minus deltaTime, as signal sends
 * @returns {{kind: 'on'|'off'|'allOff'|'ignore', note?: number, velocity?: number}}
 *
 * @example noteCommandFor({type: 'channel', subtype: 'noteOn', channel: 0, noteNumber: 60, velocity: 100})
 * // {kind: 'on', note: 60, velocity: 100}
 *
 * @example noteCommandFor({type: 'channel', subtype: 'noteOff', channel: 0, noteNumber: 60, velocity: 0})
 * // {kind: 'off', note: 60}
 *
 * @example
 * // velocity 0 is a release, whatever the subtype says
 * noteCommandFor({type: 'channel', subtype: 'noteOn', channel: 3, noteNumber: 72, velocity: 0})
 * // {kind: 'off', note: 72}
 *
 * @example
 * // the transport's stop message
 * noteCommandFor({type: 'channel', subtype: 'controller', channel: 0, controllerType: 123, value: 0})
 * // {kind: 'allOff'}
 *
 * @example
 * // an automation lane we cannot deliver
 * noteCommandFor({type: 'channel', subtype: 'pitchBend', channel: 0, value: 4096})
 * // {kind: 'ignore'}
 */
export function noteCommandFor(event) {
  if (event.type !== 'channel') return { kind: 'ignore' };

  switch (event.subtype) {
    case 'noteOn':
      return event.velocity > 0
        ? { kind: 'on', note: event.noteNumber, velocity: event.velocity }
        : { kind: 'off', note: event.noteNumber };
    case 'noteOff':
      return { kind: 'off', note: event.noteNumber };
    case 'controller':
      return event.controllerType === CC_ALL_NOTES_OFF
        || event.controllerType === CC_ALL_SOUNDS_OFF
        ? { kind: 'allOff' }
        : { kind: 'ignore' };
    default:
      return { kind: 'ignore' };
  }
}

export const signalMode = {
  id: 'signal',
  label: 'signal (MIDI editor)',
  hint: "ryohey's signal, playing through Surge. Notes only — its automation "
    + 'lanes cannot reach the engine yet.',

  /**
   * Command. Frames the built editor and wires its MIDI output to `io`.
   *
   * @param {HTMLElement} container
   * @param {object} io - {noteOn, noteOff, allNotesOff, setModeStatus}
   * @returns {Promise<{destroy: () => void}>}
   */
  async mount(container, io) {
    const wrap = document.createElement('div');
    wrap.className = 'flex flex-col gap-2 p-3';
    container.append(wrap);

    const status = document.createElement('p');
    status.className = 'text-xs opacity-60';
    status.textContent = 'Loading signal…';

    // What this mode is and is not, on the page rather than only in this
    // comment: the limits below are the kind a person discovers by drawing an
    // automation lane and hearing nothing happen.
    const provenance = document.createElement('p');
    provenance.className = 'text-[11px] leading-snug opacity-60';
    provenance.textContent = 'signal by ryohey (MIT), built from source and served from this '
      + 'site — see vendor/signal/PROVENANCE.txt. Its notes play through the loaded Surge patch. '
      + 'Pitch bend, CC lanes and program changes are not forwarded, all 16 channels collapse onto '
      + 'the one patch, and its cloud features are switched off. Keyboard shortcuts belong to '
      + 'whichever of the two has focus, so click outside the editor before using Ctrl+1…4.';

    const frame = document.createElement('iframe');
    frame.src = new URL(SIGNAL_URL, import.meta.url).href;
    frame.title = 'signal MIDI editor';
    frame.className = 'w-full rounded border border-current/20';
    frame.style.height = `${PANEL_HEIGHT_PX}px`;
    // Not sandboxed: this is our own same-origin build, and the two tokens it
    // would need -- allow-scripts and allow-same-origin -- together remove the
    // protection anyway. It is same-origin on purpose, so postMessage can be
    // pinned to this origin instead of "*" at both ends.
    frame.allow = 'autoplay';

    wrap.append(status, provenance, frame);

    /** Pending note-on/note-off timers, so teardown can cancel what is in flight. */
    const timers = new Set();

    /**
     * Pitches currently sounding, counted rather than flagged. signal is
     * 16-channel and they all collapse onto one Surge, so the same pitch really
     * can be on twice at once; a Set would let the first release forget the
     * second note and leave it hanging. Same reasoning as mode-pianoroll.js.
     */
    const sounding = new Map();

    let notesPlayed = 0;

    const scheduleIn = (delayMs, run) => {
      const id = setTimeout(() => { timers.delete(id); run(); }, Math.max(0, delayMs));
      timers.add(id);
    };

    const releaseAll = () => {
      for (const note of sounding.keys()) io.noteOff(note);
      sounding.clear();
    };

    const apply = (command) => {
      switch (command.kind) {
        case 'on':
          io.noteOn(command.note, command.velocity);
          sounding.set(command.note, (sounding.get(command.note) ?? 0) + 1);
          notesPlayed += 1;
          io.setModeStatus(`${notesPlayed} notes played`);
          break;
        case 'off': {
          io.noteOff(command.note);
          const held = (sounding.get(command.note) ?? 0) - 1;
          if (held > 0) sounding.set(command.note, held);
          else sounding.delete(command.note);
          break;
        }
        case 'allOff':
          releaseAll();
          break;
        case 'ignore':
          break;
        default:
          throw new Error(`noteCommandFor returned an unknown kind "${command.kind}"`);
      }
    };

    /**
     * Command. Handles one message from the editor.
     *
     * Two checks before trusting anything: it must come from our own frame, and
     * it must be our message type -- this listener is on `window`, which every
     * other frame and extension on the page can also post to.
     *
     * A message that IS ours but malformed throws rather than being skipped. It
     * can only mean the patch and this file have drifted apart, and the symptom
     * of skipping would be an editor that silently makes no sound.
     */
    const onMessage = (ev) => {
      if (ev.source !== frame.contentWindow) return;
      if (ev.data?.type !== SYNTH_OUTPUT_MESSAGE) return;

      const { event, delayMs } = ev.data;
      if (!event || typeof delayMs !== 'number') {
        throw new Error(
          `${SYNTH_OUTPUT_MESSAGE} message is missing event or delayMs -- `
          + 'patches/signal-embed.patch and mode-signal.js have drifted apart',
        );
      }

      const command = noteCommandFor(event);
      if (command.kind === 'ignore') return;
      scheduleIn(delayMs, () => apply(command));
    };

    window.addEventListener('message', onMessage);

    // Resolve on load so the registry does not report the mode as mounted while
    // the panel is still blank, and so a 404 on the build is loud rather than an
    // empty box. 2.4 MB of JavaScript takes a moment.
    await new Promise((resolve, reject) => {
      frame.addEventListener('load', resolve, { once: true });
      frame.addEventListener('error', () => reject(new Error(`Could not load ${frame.src}`)), { once: true });
    });

    status.textContent = 'signal is ready. Draw notes and press play, or click its keyboard.';
    io.setModeStatus('');

    return {
      destroy() {
        window.removeEventListener('message', onMessage);
        for (const id of timers) clearTimeout(id);
        timers.clear();
        releaseAll();
        // Removing the iframe discards the editor's React tree, its AudioContext
        // and any unsaved song with it. There is nowhere to persist a song to on
        // a static site, and signal's own autosave to localStorage brings it back
        // on the next mount.
        wrap.remove();
        io.setModeStatus('');
      },
    };
  },
};
