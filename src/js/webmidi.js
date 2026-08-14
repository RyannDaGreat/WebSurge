/**
 * webmidi.js -- hardware MIDI in.
 *
 * NOT AN INPUT MODE, ON PURPOSE
 * -----------------------------
 * The modes in js/input/ are mutually exclusive because they are ways of
 * *composing* — you are either drawing in a roll or typing notes, not both. A
 * MIDI keyboard is not that. It should work whatever is on screen, including
 * while a sequence plays, exactly as it would on a hardware synth. So this
 * attaches once at startup and stays attached, alongside the active mode.
 *
 * WHAT IT SENDS
 * -------------
 * Note on/off, pitch bend and continuous controllers, all through the app's
 * `io`. It deliberately does NOT interpret the controllers: CC 1 is not
 * translated into "mod wheel", and no CC is mapped to a macro here. Surge
 * already does that, per patch, and better — its modulation matrix is what
 * decides that this patch's mod wheel opens the filter and that one's macro 3 is
 * called "How Messy?". Re-deciding it in JavaScript would override the patch.
 *
 * A running-status caveat that does not apply: Web MIDI delivers whole messages,
 * so unlike a MIDI file there is no running status to reassemble.
 */

'use strict';

/** Status nibbles, after masking off the channel. */
const NOTE_OFF = 0x80;
const NOTE_ON = 0x90;
const CONTROL_CHANGE = 0xb0;
const PITCH_BEND = 0xe0;

/** Pitch bend arrives as two 7-bit halves, centred at 8192. */
const BEND_CENTRE = 8192;
const SEVEN_BITS = 7;

/**
 * Pure function. Decodes one MIDI message into something the app can act on.
 *
 * Returns null for anything we do not forward, rather than guessing: system
 * messages, aftertouch, program change and clock all arrive here and are not
 * ours to interpret.
 *
 * A note-on with velocity 0 is a note-off. This is not an edge case — it is how
 * a great many controllers and sequencers release notes, and treating it as a
 * note-on produces a stuck note at zero volume, which is silent and therefore
 * invisible until the voice count runs out.
 *
 * @param {Uint8Array|number[]} data - the raw MIDI bytes
 * @returns {{kind: string, channel: number, a?: number, b?: number}|null}
 *
 * @example decodeMidi([0x90, 60, 100])  // { kind:'noteOn',  channel:0, a:60, b:100 }
 * @example decodeMidi([0x90, 60, 0])    // { kind:'noteOff', channel:0, a:60, b:0 }
 * @example decodeMidi([0xb0, 1, 64])    // { kind:'cc',      channel:0, a:1,  b:64 }
 * @example decodeMidi([0xe0, 0, 64])    // { kind:'pitchBend', channel:0, a:0 }
 * @example decodeMidi([0xf8])           // null  (clock)
 */
export function decodeMidi(data) {
  if (!data || data.length < 2) return null;

  const status = data[0] & 0xf0;
  const channel = data[0] & 0x0f;

  switch (status) {
    case NOTE_ON:
      // Velocity 0 means release. See above.
      return data[2] > 0
        ? { kind: 'noteOn', channel, a: data[1], b: data[2] }
        : { kind: 'noteOff', channel, a: data[1], b: 0 };

    case NOTE_OFF:
      return { kind: 'noteOff', channel, a: data[1], b: data[2] ?? 0 };

    case CONTROL_CHANGE:
      return { kind: 'cc', channel, a: data[1], b: data[2] ?? 0 };

    case PITCH_BEND:
      // 14 bits, LSB first, re-centred to the signed range Surge expects.
      return {
        kind: 'pitchBend',
        channel,
        a: ((data[2] << SEVEN_BITS) | data[1]) - BEND_CENTRE,
      };

    default:
      return null;
  }
}

/**
 * Command. Connects every MIDI input and keeps connecting as they appear.
 *
 * Resolves to a handle even when there is nothing to connect, because "no MIDI
 * devices" is the normal case and not a failure. It rejects only when the
 * browser HAS Web MIDI and refuses it — a denied permission prompt is a real
 * answer and should be reported, not swallowed.
 *
 * Web MIDI needs a secure context, which the site already requires for
 * AudioWorklet, so there is no new deployment constraint.
 *
 * @param {object} io - {noteOn, noteOff, pitchBend, cc}
 * @param {(text: string) => void} onStatus - called with a short device summary
 * @returns {Promise<{destroy: () => void, supported: boolean, names: string[]}>}
 *
 * @example
 * const midi = await attachWebMidi(app.io, (t) => console.log(t));
 * midi.supported   // false in Safari and Firefox as of 2026
 * midi.names       // ['Arturia KeyStep']
 */
export async function attachWebMidi(io, onStatus) {
  if (!navigator.requestMIDIAccess) {
    onStatus('no Web MIDI in this browser');
    return { destroy: () => {}, supported: false, names: [] };
  }

  // sysex is not requested: we forward none of it, and asking for it turns a
  // silent grant into a permission prompt on some browsers.
  const access = await navigator.requestMIDIAccess({ sysex: false });

  const onMessage = (event) => {
    const m = decodeMidi(event.data);
    if (!m) return;

    switch (m.kind) {
      case 'noteOn': io.noteOn(m.a, m.b); break;
      case 'noteOff': io.noteOff(m.a); break;
      case 'cc': io.cc(m.channel, m.a, m.b); break;
      case 'pitchBend': io.pitchBend(m.channel, m.a); break;
      default: break;   // decodeMidi already filtered these out
    }
  };

  const attached = new Set();

  const connectAll = () => {
    for (const input of access.inputs.values()) {
      if (attached.has(input)) continue;
      input.onmidimessage = onMessage;
      attached.add(input);
    }
    const names = [...attached].map((i) => i.name);
    onStatus(names.length ? `MIDI: ${names.join(', ')}` : 'MIDI: no devices');
    return names;
  };

  const names = connectAll();

  // Devices get plugged in after the page loads far more often than before it.
  access.onstatechange = connectAll;

  return {
    supported: true,
    names,
    destroy() {
      for (const input of attached) input.onmidimessage = null;
      attached.clear();
      access.onstatechange = null;
    },
  };
}
