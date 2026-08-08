/**
 * roll-presets.js -- songs the piano roll can load.
 *
 * WHAT A PRESET IS
 * ----------------
 * A "roll document": everything the piano roll needs to be reset to a piece.
 *
 *   { name, bpm, timebase, grid, snap, notes: [{pitch, start, length}], note }
 *
 * `timebase` is ticks per BAR (webaudio-pianoroll's own unit), so a 4/4 tune
 * written in sixteenths has timebase 16 and a 3/8 tune has timebase 6. `pitch`
 * is a MIDI note number under scientific pitch notation, where 60 is C4 --
 * matching the component's default `octadj="-1"`.
 *
 * HONESTY IS A FIELD, NOT A README
 * --------------------------------
 * Every preset carries a `note` saying where it came from and how far it can be
 * trusted, and the UI shows it. This is not decoration. A melody written from
 * memory and presented as correct is a quiet lie, and the difference between
 * "verbatim from a published score" and "I built this from the standard form"
 * is exactly the thing a reader cannot recover from the note numbers.
 *
 * So: every tune here is either
 *   (a) transcribed from a specific published notation, cited in its `note`, or
 *   (b) constructed by us from a named convention, and says so, or
 *   (c) measured off an image, and says what was and was not legible.
 *
 * Melodies we could NOT verify were left out rather than approximated.
 * Greensleeves and Scarborough Fair are the two that got cut: Wikipedia's
 * Greensleeves score gives the key (A dorian), the metre (6/8) and the
 * single-eighth pickup on A, but its note-by-note rhythm was not readable from
 * what we could retrieve, and Scarborough Fair had no notated source at all.
 * Both are common enough that a half-remembered version would pass unnoticed,
 * which is the reason to be strict rather than the reason to relax.
 */

'use strict';

/** Sixteenth-note ticks per bar, for the 4/4 tunes. */
const BAR_16 = 16;
/** Sixteenth-note ticks per bar, for the 3/8 tunes. Six sixteenths is 3/8. */
const BAR_6 = 6;

/** Durations in sixteenth ticks. */
const SIXTEENTH = 1;
const EIGHTH = 2;
const QUARTER = 4;
const DOTTED_QUARTER = 6;
const HALF = 8;

/** MIDI note numbers used below, so the tunes read as music and not as integers. */
const C2 = 36;
const D2 = 38, F$2 = 42, G2 = 43, A2 = 45, B2 = 47;
const C3 = 48, D3 = 50, E3 = 52, F3 = 53, F$3 = 54, G3 = 55, A3 = 57, A$3 = 58;
const C4 = 60, D4 = 62, E4 = 64, F4 = 65, F$4 = 66, G4 = 67, G$4 = 68, A4 = 69;
const B4 = 71;
const C5 = 72, D5 = 74, D$5 = 75, E5 = 76, F$5 = 78;
const C6 = 84;

/**
 * Pure function. Lays a run of equal-length notes out end to end.
 *
 * Most of a written-out tune is "these pitches, one per beat", and spelling
 * that as explicit start offsets is where transcription errors hide.
 *
 * @param {number} start - tick of the first note
 * @param {number} length - ticks per note, and the step between them
 * @param {Array<number>} pitches - MIDI note numbers in order
 * @returns {Array<{pitch: number, start: number, length: number}>}
 *
 * @example run(0, 4, [60, 62, 64])
 * // [{pitch: 60, start: 0, length: 4},
 * //  {pitch: 62, start: 4, length: 4},
 * //  {pitch: 64, start: 8, length: 4}]
 *
 * @example run(16, 2, [67]).at(-1)  // {pitch: 67, start: 16, length: 2}
 */
export function run(start, length, pitches) {
  return pitches.map((pitch, i) => ({ pitch, start: start + i * length, length }));
}

/**
 * Pure function. Repeats a group of notes at a fixed tick interval.
 *
 * @param {Array<{pitch: number, start: number, length: number}>} notes - one statement
 * @param {number} times - how many statements
 * @param {number} every - tick interval between statement starts
 * @returns {Array<{pitch: number, start: number, length: number}>}
 *
 * @example repeat([{pitch: 60, start: 0, length: 4}], 2, 16)
 * // [{pitch: 60, start: 0, length: 4}, {pitch: 60, start: 16, length: 4}]
 *
 * @example repeat(run(0, 4, [60, 64]), 3, 8).length  // 6
 */
export function repeat(notes, times, every) {
  return Array.from({ length: times }, (_, i) =>
    notes.map((n) => ({ ...n, start: n.start + i * every }))).flat();
}

/**
 * Pure function. Total length of a note list, rounded up to a whole bar.
 *
 * The piano roll's end marker has to sit on a bar line or the loop limps.
 *
 * @param {Array<{start: number, length: number}>} notes
 * @param {number} timebase - ticks per bar
 * @returns {number} ticks
 *
 * @example barsFor([{start: 0, length: 4}], 16)   // 16  -- one bar
 * @example barsFor([{start: 60, length: 4}], 16)  // 64  -- four bars
 * @example barsFor([], 16)                        // 16  -- never zero-length
 */
export function barsFor(notes, timebase) {
  const end = notes.reduce((max, n) => Math.max(max, n.start + n.length), 0);
  return Math.max(1, Math.ceil(end / timebase)) * timebase;
}

// ---------------------------------------------------------------------------
// Ode to Joy
//
// Beethoven, Symphony No. 9 finale theme. Bars 1-4 are the Wikipedia "Ode to
// Joy" article's LilyPond incipit verbatim -- `\key g \major`, then
// `b' b c d | d c b a | g g a b | b4. a8 a2 |`. Bars 5-8 are the answering
// phrase, identical until the cadence, which falls `a4. g8 g2` instead.
// ---------------------------------------------------------------------------
const ODE_PHRASE = [
  ...run(0, QUARTER, [B4, B4, C5, D5]),
  ...run(16, QUARTER, [D5, C5, B4, A4]),
  ...run(32, QUARTER, [G4, G4, A4, B4]),
];

const ODE_TO_JOY = [
  ...ODE_PHRASE,
  { pitch: B4, start: 48, length: DOTTED_QUARTER },
  { pitch: A4, start: 54, length: EIGHTH },
  { pitch: A4, start: 56, length: HALF },
  ...ODE_PHRASE.map((n) => ({ ...n, start: n.start + 64 })),
  { pitch: A4, start: 112, length: DOTTED_QUARTER },
  { pitch: G4, start: 118, length: EIGHTH },
  { pitch: G4, start: 120, length: HALF },
];

// ---------------------------------------------------------------------------
// Für Elise, opening
//
// Beethoven, WoO 59. Transcribed from the Wikipedia article's LilyPond incipit:
//
//   \partial 8 e''16 dis''
//   e'' dis'' e'' b' d'' c''
//   a'8 r16 c' e' a'
//   b'8 r16 e' gis' b'
//   c''8 r16 e' e'' dis''
//   e'' dis'' e'' b' d'' c''
//
// 3/8, so six sixteenths per bar -- and every bar above sums to exactly six,
// which is the check that the reading is right. The one-eighth anacrusis is
// placed at the end of an incomplete opening bar, hence the first note at
// tick 4 rather than 0.
//
// The final A4 is the downbeat of the next bar: the incipit's last line is
// character-for-character its second line, and the bar after that line is
// `a'8`, so the resolution is the source's own, not ours. Nothing past that
// downbeat is included.
// ---------------------------------------------------------------------------
const FUR_ELISE = [
  // anacrusis
  { pitch: E5, start: 4, length: SIXTEENTH },
  { pitch: D$5, start: 5, length: SIXTEENTH },
  // e'' dis'' e'' b' d'' c''
  ...run(6, SIXTEENTH, [E5, D$5, E5, B4, D5, C5]),
  // a'8 r16 c' e' a'
  { pitch: A4, start: 12, length: EIGHTH },
  ...run(15, SIXTEENTH, [C4, E4, A4]),
  // b'8 r16 e' gis' b'
  { pitch: B4, start: 18, length: EIGHTH },
  ...run(21, SIXTEENTH, [E4, G$4, B4]),
  // c''8 r16 e' e'' dis''
  { pitch: C5, start: 24, length: EIGHTH },
  ...run(27, SIXTEENTH, [E4, E5, D$5]),
  // e'' dis'' e'' b' d'' c''
  ...run(30, SIXTEENTH, [E5, D$5, E5, B4, D5, C5]),
  // a'8 -- downbeat resolution
  { pitch: A4, start: 36, length: EIGHTH },
];

// ---------------------------------------------------------------------------
// Pachelbel, Canon in D
//
// From the Wikipedia "Pachelbel's Canon" LilyPond score, verbatim:
//   ground bass  `\repeat unfold 5 { d4 a b fis | g d g a | }`
//   canon subject `fis4 e d cis | b a b cis |`  then  `d cis b a | g fis g e |`
// All quarter notes, 4/4, D major. The violin enters after two bars (`R1*2`).
//
// The score's third violin phrase is eighth notes -- `d8 fis a g fis d fis e |
// d b d a' g b a g |` -- and is NOT included: its LilyPond relative octaves
// were ambiguous to us, and guessing at octaves is the thing this file exists
// to avoid.
// ---------------------------------------------------------------------------
const PACHELBEL_BASS = run(0, QUARTER, [D3, A2, B2, F$2, G2, D2, G2, A2]);

const PACHELBEL = [
  ...repeat(PACHELBEL_BASS, 4, 32),
  ...run(32, QUARTER, [F$5, E5, D5, C5 + 1]),   // fis4 e d cis
  ...run(48, QUARTER, [B4, A4, B4, C5 + 1]),    // b a b cis
  ...run(64, QUARTER, [D5, C5 + 1, B4, A4]),    // d cis b a
  ...run(80, QUARTER, [G4, F$4, G4, E4]),       // g fis g e
];

// ---------------------------------------------------------------------------
// Twinkle, Twinkle, Little Star
//
// The nursery-rhyme setting of "Ah! vous dirai-je, maman" (French, c. 1761),
// in C major: six quarters and a half per phrase, AABB'A form.
// ---------------------------------------------------------------------------
const twinkleLine = (start, pitches, last) => [
  ...run(start, QUARTER, pitches),
  { pitch: last, start: start + pitches.length * QUARTER, length: HALF },
];

const TWINKLE = [
  ...twinkleLine(0, [C4, C4, G4, G4, A4, A4], G4),
  ...twinkleLine(32, [F4, F4, E4, E4, D4, D4], C4),
  ...twinkleLine(64, [G4, G4, F4, F4, E4, E4], D4),
  ...twinkleLine(96, [G4, G4, F4, F4, E4, E4], D4),
  ...twinkleLine(128, [C4, C4, G4, G4, A4, A4], G4),
  ...twinkleLine(160, [F4, F4, E4, E4, D4, D4], C4),
];

// ---------------------------------------------------------------------------
// 12-bar blues in A
//
// CONSTRUCTED, not transcribed. The 12-bar blues is a form rather than a
// tune, so there is nothing to be faithful to: this is the standard
// I-I-I-I-IV-IV-I-I-V-IV-I-V chorus, with the usual root-fifth-sixth-fifth
// boogie figure in eighths over each root.
// ---------------------------------------------------------------------------
const BLUES_ROOTS = [A2, A2, A2, A2, D3, D3, A2, A2, E3, D3, A2, E3];
const BOOGIE_INTERVALS = [0, 7, 9, 7, 0, 7, 9, 7];

const BLUES = BLUES_ROOTS.flatMap((root, bar) =>
  run(bar * BAR_16, EIGHTH, BOOGIE_INTERVALS.map((i) => root + i)));

// ---------------------------------------------------------------------------
// Arpeggio étude
//
// CONSTRUCTED. Am-F-C-G, one bar each, root-third-fifth-octave in sixteenths,
// four times per bar. A finger exercise for the roll and for the patch, not a
// piece by anybody.
// ---------------------------------------------------------------------------
const ETUDE_CHORDS = [
  [A3, C4, E4, A4],
  [F3, A3, C4, F4],
  [C3, E3, G3, C4],
  [G2, B2, D3, G3],
];

const ETUDE = ETUDE_CHORDS.flatMap((chord, bar) =>
  repeat(run(bar * BAR_16, SIXTEENTH, chord), 4, chord.length * SIXTEENTH));

// ---------------------------------------------------------------------------
// Four on the floor
//
// CONSTRUCTED, and a rhythm rather than a tune: a kick on every quarter, an
// offbeat eighth, and a backbeat accent on beats 2 and 4. It is written as
// pitches because that is all this roll can send, so it reads as a drum
// pattern only under a drum patch; under a lead patch it is a bass ostinato.
// ---------------------------------------------------------------------------
const FOUR_ON_FLOOR = repeat([
  ...run(0, QUARTER, [C2, C2, C2, C2]).map((n) => ({ ...n, length: EIGHTH })),
  ...run(2, QUARTER, [C6, C6, C6, C6]).map((n) => ({ ...n, length: SIXTEENTH })),
  { pitch: C4, start: 4, length: SIXTEENTH },
  { pitch: C4, start: 12, length: SIXTEENTH },
], 2, BAR_16);

// ---------------------------------------------------------------------------
// Claire (bass sketch)
//
// MEASURED OFF A SCREENSHOT, and only partly. See the `note` below and the
// report: this is the bass register of .frenzy/ref/claire.png and nothing
// else. It is here because it is what the image actually supports, not
// because it is the song.
//
// Method: the note rectangles were detected by colour, the grid was recovered
// from the bar-line spacing (58.0 px per bar, so 3.625 px per sixteenth), and
// pitches came from the C3/C4/C5/C6 keyboard labels (15.75 px per semitone).
// The bass blocks land on every eighth sixteenth with lengths just under
// eight, i.e. one note per half bar, and snapping to that grid produced gaps
// of only 8 or 16 ticks across all 20 bars -- no ragged offsets, which is the
// evidence that the reading is right rather than merely plausible.
// ---------------------------------------------------------------------------
const CLAIRE_BASS = [
  ...run(0, HALF, [F3, A3, A$3, C4, A3, G3, F3, F$3]),
  ...run(64, BAR_16, [G3, A3, A$3, C4]),
  ...run(128, HALF, [G3, A$3, A3, G3, A3, F$3, G3, F$3]),
  ...run(192, HALF, [F3, A3, A$3, G3, F3, F$3, G3, C3]),
  ...run(256, HALF, [F3, A3, A$3, C4, A3, G3, F3]),
];

/**
 * The preset table, in dropdown order.
 *
 * @type {Array<{name: string, bpm: number, timebase: number, grid: number,
 *               snap: number, notes: Array<object>, note: string}>}
 */
export const PRESETS = [
  {
    name: 'Ode to Joy',
    bpm: 100,
    timebase: BAR_16,
    grid: QUARTER,
    snap: SIXTEENTH,
    notes: ODE_TO_JOY,
    note: 'Bars 1-4 verbatim from the Wikipedia "Ode to Joy" LilyPond incipit '
      + '(G major). Bars 5-8 are the answering phrase: the same three bars with '
      + 'the standard a4. g8 g2 cadence.',
  },
  {
    name: 'Für Elise (opening)',
    bpm: 68,
    timebase: BAR_6,
    grid: EIGHTH,
    snap: SIXTEENTH,
    notes: FUR_ELISE,
    note: 'Transcribed from the Wikipedia LilyPond incipit, 3/8. Every bar sums '
      + 'to exactly six sixteenths, which checks the reading. Stops at the A4 '
      + 'downbeat after bar 5; nothing beyond the incipit was added.',
  },
  {
    name: 'Canon in D (bass + subject)',
    bpm: 56,
    timebase: BAR_16,
    grid: QUARTER,
    snap: SIXTEENTH,
    notes: PACHELBEL,
    note: 'Ground bass x4 and the canon subject\'s first two phrases, both '
      + 'verbatim from the Wikipedia LilyPond score at its own tempo (quarter '
      + '= 56). The eighth-note third phrase is omitted -- its relative octaves '
      + 'were ambiguous.',
  },
  {
    name: 'Twinkle, Twinkle, Little Star',
    bpm: 100,
    timebase: BAR_16,
    grid: QUARTER,
    snap: SIXTEENTH,
    notes: TWINKLE,
    note: 'The traditional C-major setting of "Ah! vous dirai-je, maman", '
      + 'AABB\'A. Simple enough to state without a source: six quarters and a '
      + 'half per phrase.',
  },
  {
    name: '12-bar blues in A',
    bpm: 96,
    timebase: BAR_16,
    grid: QUARTER,
    snap: SIXTEENTH,
    notes: BLUES,
    note: 'CONSTRUCTED, not transcribed. The standard 12-bar chorus '
      + '(I-I-I-I-IV-IV-I-I-V-IV-I-V) with the usual root-fifth-sixth boogie '
      + 'figure. A form, so there is no original to be unfaithful to.',
  },
  {
    name: 'Arpeggio étude',
    bpm: 120,
    timebase: BAR_16,
    grid: QUARTER,
    snap: SIXTEENTH,
    notes: ETUDE,
    note: 'CONSTRUCTED. Am-F-C-G in sixteenth arpeggios. A finger exercise for '
      + 'the roll and a way to hear a patch move, not a piece by anybody.',
  },
  {
    name: 'Four on the floor',
    bpm: 124,
    timebase: BAR_16,
    grid: QUARTER,
    snap: SIXTEENTH,
    notes: FOUR_ON_FLOOR,
    note: 'CONSTRUCTED. A rhythm, not a tune. Reads as a drum pattern only '
      + 'under a drum patch; under a lead patch it is a bass ostinato.',
  },
  {
    name: 'Claire (bass sketch)',
    bpm: 96,
    timebase: BAR_16,
    grid: QUARTER,
    snap: SIXTEENTH,
    notes: CLAIRE_BASS,
    note: 'NOT the song -- only its bass. Measured off .frenzy/ref/claire.png: '
      + '35 notes over 20 bars, the C3-C4 register, which is the only part whose '
      + 'FL labels are legible. The 400-odd notes above it are truncated to ".." '
      + 'at that resolution and are NOT here. Pitches assume C4 = 60; FL\'s '
      + 'default display names middle C an octave higher, so the real file may '
      + 'sit an octave below this. Load the .mid or .flp to get the actual song.',
  },
  {
    name: 'Blank (4 bars)',
    bpm: 110,
    timebase: BAR_16,
    grid: QUARTER,
    snap: SIXTEENTH,
    notes: [],
    note: 'Empty. Four bars of nothing to draw into.',
  },
];
