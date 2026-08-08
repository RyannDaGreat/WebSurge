/**
 * midi-file.js -- a Standard MIDI File reader, format 0 and 1.
 *
 * WHY THIS EXISTS
 * ---------------
 * A screenshot of a piano roll cannot be turned back into music: note labels
 * truncate, overlapping voices merge, and anything below a few pixels is a
 * guess. The MIDI file is the actual data. So the honest way to get somebody's
 * song into this piano roll is to read their `.mid`, not to eyeball their
 * screenshot.
 *
 * WHY IT IS NOT A DEPENDENCY
 * --------------------------
 * SMF is a small, frozen, 1988 format: a header chunk, then track chunks of
 * delta-time + event pairs. The whole reader is one file with no state. That is
 * cheaper than vendoring another library onto a page that already ships a 19 MB
 * wasm module.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * - No SMPTE (negative division) files. Those measure time in film frames
 *   rather than musical ticks; there is nothing sensible to put on a musical
 *   grid, so `parseMidi` throws rather than inventing a mapping.
 * - No tempo *changes*. Only the first tempo event is reported, because the
 *   piano roll has exactly one tempo. A file that ritardandos will import at
 *   its opening tempo, and `tempoChanges` says how many were ignored so the
 *   caller can say so out loud instead of silently mangling the timing.
 * - No channel/track separation in the output. Every note lands in one list,
 *   each tagged with its channel, because the roll is a single surface.
 *
 * TICKS
 * -----
 * Output positions are in the file's OWN division (ticks per quarter note),
 * unconverted. Rounding here would throw away the timing the file was written
 * with; the caller decides the grid it wants and converts once.
 */

'use strict';

const HEADER_CHUNK = 'MThd';
const TRACK_CHUNK = 'MTrk';

/** MThd always declares 6 bytes of payload: format, ntrks, division. */
const HEADER_PAYLOAD_BYTES = 6;

/** Bytes in a chunk's type tag, and in its big-endian length field. */
const CHUNK_TYPE_BYTES = 4;
const CHUNK_LENGTH_BYTES = 4;

/**
 * Tempo when a file carries no tempo meta event. Specified by SMF itself, so
 * this is the format's answer and not a guess of ours.
 */
const DEFAULT_TEMPO_BPM = 120;
const MICROSECONDS_PER_MINUTE = 60000000;

/** Status bytes. The low nibble of a channel status is the channel. */
const NOTE_OFF = 0x80;
const NOTE_ON = 0x90;
const STATUS_MASK = 0xf0;
const CHANNEL_MASK = 0x0f;
const STATUS_BIT = 0x80;

const META = 0xff;
const SYSEX_START = 0xf0;
const SYSEX_ESCAPE = 0xf7;

const META_TRACK_NAME = 0x03;
const META_TEMPO = 0x51;
const META_TEMPO_BYTES = 3;

/** Channel messages carrying one data byte; every other kind carries two. */
const PROGRAM_CHANGE = 0xc0;
const CHANNEL_PRESSURE = 0xd0;

/** A variable-length quantity uses 7 bits per byte, high bit = "more follows". */
const VLQ_VALUE_BITS = 7;
const VLQ_VALUE_MASK = 0x7f;
const VLQ_CONTINUE = 0x80;
const VLQ_MAX_BYTES = 4;

/**
 * Pure function. Reads a variable-length quantity.
 *
 * SMF stores delta times and meta lengths seven bits at a time, most
 * significant group first, with the high bit set on every byte but the last.
 *
 * @param {Uint8Array} bytes
 * @param {number} pos - index of the first byte of the quantity
 * @returns {{value: number, next: number}} value, and the index after it
 *
 * @example readVarInt(new Uint8Array([0x00]), 0)              // {value: 0, next: 1}
 * @example readVarInt(new Uint8Array([0x7f]), 0)              // {value: 127, next: 1}
 * @example readVarInt(new Uint8Array([0x81, 0x00]), 0)        // {value: 128, next: 2}
 * @example readVarInt(new Uint8Array([0xff, 0xff, 0x7f]), 0)  // {value: 2097151, next: 3}
 */
export function readVarInt(bytes, pos) {
  let value = 0;
  for (let used = 0; used < VLQ_MAX_BYTES; used++) {
    if (pos + used >= bytes.length) {
      throw new Error(`MIDI: variable-length value at byte ${pos} runs past end of file`);
    }
    const byte = bytes[pos + used];
    value = (value << VLQ_VALUE_BITS) | (byte & VLQ_VALUE_MASK);
    if (!(byte & VLQ_CONTINUE)) return { value, next: pos + used + 1 };
  }
  throw new Error(`MIDI: variable-length value at byte ${pos} exceeds ${VLQ_MAX_BYTES} bytes`);
}

/**
 * Pure function. Reads a big-endian unsigned integer.
 *
 * @param {Uint8Array} bytes
 * @param {number} pos
 * @param {number} width - number of bytes
 * @returns {number}
 *
 * @example readUint(new Uint8Array([0x01, 0xe0]), 0, 2)  // 480
 * @example readUint(new Uint8Array([0x00, 0x00, 0x00, 0x06]), 0, 4)  // 6
 */
export function readUint(bytes, pos, width) {
  if (pos + width > bytes.length) {
    throw new Error(`MIDI: ${width}-byte integer at ${pos} runs past end of file`);
  }
  let value = 0;
  for (let i = 0; i < width; i++) value = value * 256 + bytes[pos + i];
  return value;
}

/**
 * Pure function. Reads a four-character chunk tag as ASCII.
 *
 * @param {Uint8Array} bytes
 * @param {number} pos
 * @returns {string}
 *
 * @example readChunkType(new Uint8Array([77, 84, 104, 100]), 0)  // 'MThd'
 * @example readChunkType(new Uint8Array([77, 84, 114, 107]), 0)  // 'MTrk'
 */
export function readChunkType(bytes, pos) {
  let out = '';
  for (let i = 0; i < CHUNK_TYPE_BYTES; i++) out += String.fromCharCode(bytes[pos + i]);
  return out;
}

/**
 * Pure function. How many data bytes a channel status byte is followed by.
 *
 * @param {number} status - a status byte, 0x80..0xef
 * @returns {number} 1 or 2
 *
 * @example channelDataBytes(0x90)  // 2  -- note on: key, velocity
 * @example channelDataBytes(0xc3)  // 1  -- program change: program
 * @example channelDataBytes(0xd0)  // 1  -- channel pressure: pressure
 */
export function channelDataBytes(status) {
  const kind = status & STATUS_MASK;
  return kind === PROGRAM_CHANGE || kind === CHANNEL_PRESSURE ? 1 : 2;
}

/**
 * Pure function. Turns note-on/note-off pairs into held notes.
 *
 * A note-on with velocity 0 is a note-off; that spelling is common enough that
 * treating it otherwise produces a file of zero-length notes. Same-pitch
 * overlaps are matched last-on-to-first-off (a stack), which is what a
 * sustaining instrument does.
 *
 * Anything still held when the events run out is closed at the final tick and
 * counted, so the caller can report it rather than silently dropping it.
 *
 * @param {Array<{tick: number, status: number, d1: number, d2: number}>} events
 *   note events only, sorted by tick
 * @returns {{notes: Array<object>, unterminated: number}}
 *   notes are {pitch, start, length, velocity, channel}
 *
 * @example
 * // one middle C, a quarter note long at 480 ticks per quarter
 * pairNotes([
 *   {tick: 0,   status: 0x90, d1: 60, d2: 100},
 *   {tick: 480, status: 0x80, d1: 60, d2: 0},
 * ])
 * // {notes: [{pitch: 60, start: 0, length: 480, velocity: 100, channel: 0}],
 * //  unterminated: 0}
 *
 * @example
 * // an unclosed note is closed at the last tick seen, and counted
 * pairNotes([{tick: 0, status: 0x90, d1: 64, d2: 80}])
 * // {notes: [{pitch: 64, start: 0, length: 0, velocity: 80, channel: 0}],
 * //  unterminated: 1}
 */
export function pairNotes(events) {
  const held = new Map();   // `${channel}:${pitch}` -> array of open notes
  const notes = [];
  let lastTick = 0;

  const keyOf = (channel, pitch) => `${channel}:${pitch}`;

  for (const ev of events) {
    lastTick = ev.tick;
    const channel = ev.status & CHANNEL_MASK;
    const kind = ev.status & STATUS_MASK;
    const pitch = ev.d1;
    const key = keyOf(channel, pitch);

    const isRelease = kind === NOTE_OFF || (kind === NOTE_ON && ev.d2 === 0);
    if (isRelease) {
      const stack = held.get(key);
      if (!stack || !stack.length) continue;   // a release with no onset: nothing to close
      const note = stack.pop();
      note.length = ev.tick - note.start;
      continue;
    }

    const note = { pitch, start: ev.tick, length: 0, velocity: ev.d2, channel };
    notes.push(note);
    if (!held.has(key)) held.set(key, []);
    held.get(key).push(note);
  }

  let unterminated = 0;
  for (const stack of held.values()) {
    for (const note of stack) {
      note.length = lastTick - note.start;
      unterminated++;
    }
  }

  notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  return { notes, unterminated };
}

/**
 * Pure function. Reads one MTrk chunk's events onto an absolute tick timeline.
 *
 * Handles running status, where a repeated status byte is omitted and the
 * previous one still applies. Skipping that is the classic way to produce a
 * parser that works on files from one sequencer and garbage on files from
 * another, because it is an encoder's choice whether to use it.
 *
 * @param {Uint8Array} bytes - the whole file
 * @param {number} start - index of the first byte after the chunk length
 * @param {number} end - index one past the chunk's last byte
 * @returns {{noteEvents: Array<object>, tempos: Array<number>, name: string|null}}
 *   tempos are microseconds per quarter note, in file order
 *
 * @example
 * // MTrk payload: delta 0, note-on C4 vel 100; delta 0x60, running-status release
 * const b = new Uint8Array([0x00, 0x90, 0x3c, 0x64, 0x60, 0x3c, 0x00]);
 * parseTrack(b, 0, b.length).noteEvents.length  // 2
 */
export function parseTrack(bytes, start, end) {
  const noteEvents = [];
  const tempos = [];
  let name = null;

  let pos = start;
  let tick = 0;
  let runningStatus = 0;

  while (pos < end) {
    const delta = readVarInt(bytes, pos);
    tick += delta.value;
    pos = delta.next;
    if (pos >= end) break;

    let status = bytes[pos];
    if (status & STATUS_BIT) {
      pos++;
      // Meta and SysEx do not set running status; channel messages do.
      if (status !== META && status !== SYSEX_START && status !== SYSEX_ESCAPE) {
        runningStatus = status;
      }
    } else {
      if (!runningStatus) {
        throw new Error(`MIDI: data byte ${status} at ${pos} with no running status`);
      }
      status = runningStatus;
    }

    if (status === META) {
      const type = bytes[pos++];
      const len = readVarInt(bytes, pos);
      pos = len.next;
      if (type === META_TEMPO) {
        if (len.value !== META_TEMPO_BYTES) {
          throw new Error(`MIDI: tempo event at ${pos} has ${len.value} bytes, expected 3`);
        }
        tempos.push(readUint(bytes, pos, META_TEMPO_BYTES));
      } else if (type === META_TRACK_NAME && name === null) {
        name = String.fromCharCode(...bytes.subarray(pos, pos + len.value));
      }
      pos += len.value;
      continue;
    }

    if (status === SYSEX_START || status === SYSEX_ESCAPE) {
      const len = readVarInt(bytes, pos);
      pos = len.next + len.value;
      continue;
    }

    const width = channelDataBytes(status);
    const d1 = bytes[pos];
    const d2 = width === 2 ? bytes[pos + 1] : 0;
    pos += width;

    const kind = status & STATUS_MASK;
    if (kind === NOTE_ON || kind === NOTE_OFF) {
      noteEvents.push({ tick, status, d1, d2 });
    }
  }

  return { noteEvents, tempos, name };
}

/**
 * Pure function. Parses a Standard MIDI File into a flat note list.
 *
 * @param {ArrayBuffer|Uint8Array} buffer - the file's bytes
 * @returns {{format: number, division: number, trackCount: number,
 *            tempoBpm: number, tempoChanges: number, unterminated: number,
 *            names: Array<string>, notes: Array<object>}}
 *   `division` is ticks per quarter note; note `start`/`length` are in those
 *   ticks. `tempoChanges` counts tempo events beyond the first, which are
 *   ignored. `notes` are {pitch, start, length, velocity, channel}.
 *
 * @example
 * // A minimal format-0 file: 480 ticks/quarter, one quarter-note middle C.
 * const bytes = new Uint8Array([
 *   0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xe0,
 *   0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 8,
 *   0x00, 0x90, 0x3c, 0x64, 0x83, 0x60, 0x80, 0x3c, 0x00,
 * ]);
 * parseMidi(bytes).division   // 480
 * parseMidi(bytes).tempoBpm   // 120  -- no tempo event, so the SMF default
 * parseMidi(bytes).notes[0]   // {pitch: 60, start: 0, length: 480, velocity: 100, channel: 0}
 */
export function parseMidi(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);

  if (bytes.length < CHUNK_TYPE_BYTES + CHUNK_LENGTH_BYTES + HEADER_PAYLOAD_BYTES) {
    throw new Error(`MIDI: file is ${bytes.length} bytes, too short to hold a header`);
  }
  const tag = readChunkType(bytes, 0);
  if (tag !== HEADER_CHUNK) {
    throw new Error(`MIDI: file starts with "${tag}", not "${HEADER_CHUNK}" -- not a MIDI file`);
  }

  const headerLen = readUint(bytes, CHUNK_TYPE_BYTES, CHUNK_LENGTH_BYTES);
  let pos = CHUNK_TYPE_BYTES + CHUNK_LENGTH_BYTES;
  const format = readUint(bytes, pos, 2);
  const trackCount = readUint(bytes, pos + 2, 2);
  const division = readUint(bytes, pos + 4, 2);
  // Header chunks are allowed to be longer than 6 bytes; the extra is reserved.
  pos += headerLen;

  if (format !== 0 && format !== 1) {
    throw new Error(`MIDI: format ${format} is not supported, only 0 and 1`);
  }
  // A negative division (high bit set) means SMPTE frames, not musical ticks.
  if (division & 0x8000 || division === 0) {
    throw new Error(
      `MIDI: division ${division} is SMPTE frame-based, which has no musical grid to import onto`,
    );
  }

  const noteEvents = [];
  const tempos = [];
  const names = [];

  while (pos + CHUNK_TYPE_BYTES + CHUNK_LENGTH_BYTES <= bytes.length) {
    const type = readChunkType(bytes, pos);
    const len = readUint(bytes, pos + CHUNK_TYPE_BYTES, CHUNK_LENGTH_BYTES);
    const body = pos + CHUNK_TYPE_BYTES + CHUNK_LENGTH_BYTES;
    const bodyEnd = Math.min(body + len, bytes.length);

    // Unknown chunk types are required to be skipped, not rejected.
    if (type === TRACK_CHUNK) {
      const track = parseTrack(bytes, body, bodyEnd);
      noteEvents.push(...track.noteEvents);
      tempos.push(...track.tempos);
      if (track.name) names.push(track.name);
    }
    pos = body + len;
  }

  if (!noteEvents.length) {
    throw new Error('MIDI: parsed successfully but the file contains no notes');
  }

  // Format 1 splits one piece across parallel tracks, each starting at tick 0,
  // so merging means re-sorting the whole thing onto one timeline.
  noteEvents.sort((a, b) => a.tick - b.tick);
  const { notes, unterminated } = pairNotes(noteEvents);

  return {
    format,
    division,
    trackCount,
    tempoBpm: tempos.length
      ? MICROSECONDS_PER_MINUTE / tempos[0]
      : DEFAULT_TEMPO_BPM,
    tempoChanges: Math.max(0, tempos.length - 1),
    unterminated,
    names,
    notes,
  };
}
