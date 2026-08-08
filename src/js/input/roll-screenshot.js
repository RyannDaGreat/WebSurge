/**
 * roll-screenshot.js -- read notes out of a picture of somebody else's piano roll.
 *
 * WHY THIS IS POSSIBLE AT ALL
 * ---------------------------
 * A DAW piano roll is not a photograph. It is a synthetic image with a small
 * fixed palette, axis-aligned rectangles of uniform fill, and a strictly regular
 * grid. That makes this ordinary image processing rather than computer vision:
 * threshold on the note colour, take connected components, and convert each
 * bounding box through two calibrations -- pixels per semitone vertically,
 * pixels per sixteenth horizontally.
 *
 * This was done once by hand, for the Claire bass line in roll-presets.js:
 * 58.0 px per bar, 3.625 px per sixteenth, 15.75 px per semitone, pitch axis
 * anchored on the keyboard labels. It worked, and the evidence it worked was
 * that snapping produced note gaps of exactly 8 or 16 ticks with no ragged
 * offsets. This file automates that measurement, and reports the same
 * alignment statistic so the reading can be judged rather than trusted.
 *
 * WHAT IT CANNOT RECOVER, EVER
 * ----------------------------
 * These are properties of the input, not gaps in the implementation, and the UI
 * says all of them out loud:
 *
 *  - Notes SCROLLED OUT of the screenshot are not in the image. No amount of
 *    processing invents them. A screenshot of bars 1-25 of a 60-bar song yields
 *    bars 1-25.
 *  - Two notes at the SAME PITCH that touch or overlap render as one rectangle
 *    and come back as one long note.
 *  - VELOCITY is not in the picture. Some editors tint or shade notes by
 *    velocity, but the mapping is undocumented, theme-dependent and often
 *    non-monotonic, so guessing it would be inventing data. Everything imports
 *    at one velocity.
 *  - The OCTAVE is a guess. The black/white key pattern pins the pitch CLASS
 *    exactly -- five black keys in twelve has only one alignment -- but every
 *    octave looks identical, so nothing in the pixels says which one. Worse,
 *    editors disagree: FL Studio's default naming puts middle C an octave above
 *    the MIDI convention. So the reading is centred near middle C and the caller
 *    is expected to offer an octave shift. `octaveConfidence` is always 'guess'.
 *  - Anything DRAWN OVER the notes -- a selection rectangle, a tooltip, the play
 *    cursor -- is a rectangle of the wrong colour and will be missed or merged.
 *
 * It is a best-effort reading of a picture. The `.mid` is always better.
 *
 * WHY NO DEPENDENCY
 * -----------------
 * The browser already decodes PNG/JPEG and already has a 2D canvas, so the only
 * thing missing is arithmetic over a pixel array. Everything here is pure
 * functions over `{data, width, height}` -- the shape of `ImageData` -- so the
 * whole pipeline runs and is tested outside a browser, on the real screenshot,
 * with no canvas at all.
 */

'use strict';

/** Semitone offsets from C that are black keys. Five of twelve, asymmetric. */
const BLACK_KEY_OFFSETS = [1, 3, 6, 8, 10];
const SEMITONES_PER_OCTAVE = 12;

/** Sixteenths in a bar. 4/4 with a sixteenth grid is the near-universal default. */
const DEFAULT_STEPS_PER_BAR = 16;

/** Where an unanchored reading is centred, since the octave is unknowable. */
const MIDDLE_C = 60;
const MIDI_NOTE_MIN = 0;
const MIDI_NOTE_MAX = 127;

/** Luminance below this is "ink", above this is "paper", when judging keys. */
const DARK_LUMA = 0.35;
const LIGHT_LUMA = 0.65;

/**
 * A column belongs to the keyboard gutter if this fraction of its pixels are
 * decisively dark or decisively light. Grid backgrounds are mid-tone, so they
 * fall well below it.
 */
const KEYBED_BIMODAL_FRACTION = 0.8;

/** The keybed cannot plausibly be wider than this fraction of the image. */
const MAX_KEYBED_FRACTION = 0.2;

/** Sampled this far into the keybed to classify a row as a black key. */
const KEYBED_SAMPLE_FRACTION = 0.3;

/** Colour histogram bucket size per channel. 16 buckets of 16 levels. */
const COLOUR_BUCKET = 16;

/** A colour must cover this fraction of the note area to be a candidate. */
const MIN_NOTE_COLOUR_FRACTION = 0.004;

/** How far a pixel may sit from the note colour, as a 0..1 RGB distance. */
const NOTE_COLOUR_TOLERANCE = 0.13;

/** Blocks smaller than this in either axis are noise, not notes. */
const MIN_BLOCK_WIDTH_PX = 2;
const MIN_BLOCK_HEIGHT_PX = 3;

/** Grid-line detection: a line must be this much darker than its neighbours. */
const LINE_CONTRAST = 0.04;

/** Plausible bounds for the two calibrations, in pixels. */
const MIN_SEMITONE_PX = 3;
const MAX_SEMITONE_PX = 60;
const MIN_BAR_PX = 12;

/** Quarter notes per bar, when the image gives no way to tell the bars apart. */
const BEATS_PER_BAR = 4;

/** How many fine grid lines a bar might span. */
const BAR_PERIOD_CANDIDATES = [2, 3, 4, 6, 8, 12, 16];

/** A periodic line class must be this much stronger than the rest to be bars. */
const MIN_BAR_STRENGTH_RATIO = 1.25;

/**
 * A block edge counts as on-grid within this many pixels. Deliberately in
 * pixels, not in steps: a screenshot at 3.6 px per sixteenth cannot place an
 * edge more precisely than its own antialiasing, so a step-relative tolerance
 * would call a perfectly good reading misaligned.
 */
const EDGE_TOLERANCE_PX = 1.5;

/** Below this share of edges on-grid, the reading is flagged as approximate. */
const GOOD_ALIGNMENT = 0.75;

/**
 * Pure function. Perceptual luminance of an RGB triple, 0..1.
 *
 * @param {number} r - 0..255
 * @param {number} g - 0..255
 * @param {number} b - 0..255
 * @returns {number} 0..1
 *
 * @example luminance(0, 0, 0)        // 0
 * @example luminance(255, 255, 255)  // 1
 * @example luminance(255, 0, 0).toFixed(3)  // '0.299'
 */
export function luminance(r, g, b) {
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/**
 * Pure function. Reads one pixel as [r, g, b].
 *
 * @param {{data: ArrayLike<number>, width: number}} image - ImageData-shaped
 * @param {number} x
 * @param {number} y
 * @returns {Array<number>} [r, g, b], each 0..255
 *
 * @example pixel({data: [1, 2, 3, 255], width: 1}, 0, 0)  // [1, 2, 3]
 */
export function pixel(image, x, y) {
  const i = (y * image.width + x) * 4;
  return [image.data[i], image.data[i + 1], image.data[i + 2]];
}

/**
 * Pure function. Fits a regular grid to noisy positions by least squares.
 *
 * Grid lines and note edges are measured to the nearest pixel, so consecutive
 * gaps alternate (15, 16, 15, 16, ...) around a fractional true spacing. Taking
 * the median gap would round that to 15 or 16 and the error would accumulate
 * across the image -- at 25 bars, a quarter-pixel error per bar is six pixels,
 * nearly two sixteenths. So: index each position by the median gap, then
 * least-squares fit `position = origin + index * spacing` over those integers,
 * which recovers the fractional spacing from the full span.
 *
 * This is how the Claire measurement got 58.0 px per bar and 15.75 px per
 * semitone rather than 58 and 16.
 *
 * @param {Array<number>} positions - sorted, at least two
 * @returns {{origin: number, spacing: number, residual: number}}
 *   residual is the mean absolute deviation from the fitted grid, in pixels
 *
 * @example
 * // exact spacing of 10 is recovered exactly, with no residual
 * fitGrid([0, 10, 20, 30])  // {origin: 0, spacing: 10, residual: 0}
 *
 * @example
 * // pixel-rounded samples of a 15.75 grid recover a fractional spacing rather
 * // than collapsing to the integer 15 or 16 that every gap looks like
 * fitGrid([0, 16, 32, 47, 63]).spacing  // 15.7
 *
 * @example
 * // a missing line is fine: indices come from the gaps, so a hole is skipped
 * fitGrid([0, 10, 30, 40]).spacing  // 10
 */
export function fitGrid(positions) {
  if (positions.length < 2) {
    throw new Error(`fitGrid needs at least two positions, got ${positions.length}`);
  }
  const gaps = positions.slice(1).map((p, i) => p - positions[i]).sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  if (!(median > 0)) {
    throw new Error(`fitGrid found a median gap of ${median}; positions are not distinct`);
  }

  // The initial estimate must be the TRIMMED MEAN of the gaps, not the median.
  // A true spacing of 14.56 shows up as gaps alternating 15, 15, 14, 15, ... and
  // the median rounds that to 15 -- which over a hundred lines mis-indexes the
  // last one by three whole slots and lands the fit on 15.02 instead. Averaging
  // recovers the fraction. Gaps far from the median are dropped first so that a
  // missing line, which shows up as a double gap, does not inflate the mean.
  const kept = gaps.filter((g) => g > median * 0.5 && g < median * 1.5);
  const step = kept.length ? kept.reduce((a, b) => a + b, 0) / kept.length : median;

  // Index each position against that step, so holes do not shift later
  // positions by one slot.
  const indices = positions.map((p) => Math.round((p - positions[0]) / step));

  const n = positions.length;
  const meanI = indices.reduce((a, b) => a + b, 0) / n;
  const meanP = positions.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let k = 0; k < n; k++) {
    num += (indices[k] - meanI) * (positions[k] - meanP);
    den += (indices[k] - meanI) ** 2;
  }
  const spacing = den === 0 ? step : num / den;
  const origin = meanP - spacing * meanI;
  const residual = positions
    .reduce((sum, p, k) => sum + Math.abs(p - (origin + spacing * indices[k])), 0) / n;

  return { origin, spacing, residual };
}

/**
 * Pure function. Width of the piano-keyboard gutter down the left edge.
 *
 * Keyboard columns are almost entirely black or white; grid columns are
 * mid-tone. So the gutter is the leading run of columns whose pixels are
 * decisively one or the other.
 *
 * @param {object} image - ImageData-shaped
 * @returns {number} width in px, 0 if there is no keyboard
 *
 * @example
 * // a black column, a white column, then mid-grey grid. Note the image has to
 * // be wide enough that MAX_KEYBED_FRACTION allows a 2px gutter at all.
 * const px = (n, v) => Array.from({length: n * 4}, (_, i) => (i % 4 === 3 ? 255 : v));
 * findKeybedWidth({width: 16, height: 1,
 *   data: [...px(1, 0), ...px(1, 255), ...px(14, 128)]})  // 2
 *
 * @example
 * // no keyboard at all: every column is mid-tone
 * findKeybedWidth({width: 16, height: 1,
 *   data: Array.from({length: 64}, (_, i) => (i % 4 === 3 ? 255 : 128))})  // 0
 */
export function findKeybedWidth(image) {
  const limit = Math.floor(image.width * MAX_KEYBED_FRACTION);
  for (let x = 0; x < limit; x++) {
    let decisive = 0;
    for (let y = 0; y < image.height; y++) {
      const [r, g, b] = pixel(image, x, y);
      const luma = luminance(r, g, b);
      if (luma < DARK_LUMA || luma > LIGHT_LUMA) decisive++;
    }
    if (decisive / image.height < KEYBED_BIMODAL_FRACTION) return x;
  }
  return limit;
}

/**
 * Pure function. Positions of dark horizontal or vertical lines, with strength.
 *
 * A grid line is a row/column darker than the running background. Comparing
 * each line against the median of the whole strip -- rather than a fixed
 * threshold -- is what lets the same code find pale lines on a light theme and
 * faint ones on a dark theme.
 *
 * @param {Array<number>} profile - mean luminance per row (or per column)
 * @returns {Array<{position: number, strength: number}>} local minima, sorted
 *
 * @example
 * // dips at index 1 and 4 against a bright background
 * findLines([1, 0.5, 1, 1, 0.5, 1]).map((l) => l.position)  // [1, 4]
 *
 * @example
 * // a flat profile has no lines
 * findLines([1, 1, 1, 1])  // []
 */
export function findLines(profile) {
  const sorted = [...profile].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const lines = [];

  for (let i = 1; i < profile.length - 1; i++) {
    const v = profile[i];
    if (median - v < LINE_CONTRAST) continue;
    // A local minimum, taking the left edge of a plateau so a 2px line counts once.
    if (v <= profile[i - 1] && v < profile[i + 1]) {
      lines.push({ position: i, strength: median - v });
    }
  }
  return lines;
}

/**
 * Pure function. Mean luminance of each column across a row range.
 *
 * @param {object} image - ImageData-shaped
 * @param {number} x0 - inclusive
 * @param {number} x1 - exclusive
 * @returns {Array<number>} one value per column in [x0, x1)
 *
 * @example columnProfile({width: 2, height: 1, data: [0,0,0,255, 255,255,255,255]}, 0, 2)  // [0, 1]
 */
export function columnProfile(image, x0, x1) {
  const out = [];
  for (let x = x0; x < x1; x++) {
    let sum = 0;
    for (let y = 0; y < image.height; y++) {
      const [r, g, b] = pixel(image, x, y);
      sum += luminance(r, g, b);
    }
    out.push(sum / image.height);
  }
  return out;
}

/**
 * Pure function. Mean luminance of each row across a column range.
 *
 * @param {object} image - ImageData-shaped
 * @param {number} x0 - inclusive
 * @param {number} x1 - exclusive
 * @returns {Array<number>} one value per row
 *
 * @example rowProfile({width: 1, height: 2, data: [0,0,0,255, 255,255,255,255]}, 0, 1)  // [0, 1]
 */
export function rowProfile(image, x0, x1) {
  const out = [];
  for (let y = 0; y < image.height; y++) {
    let sum = 0;
    for (let x = x0; x < x1; x++) {
      const [r, g, b] = pixel(image, x, y);
      sum += luminance(r, g, b);
    }
    out.push(sum / (x1 - x0));
  }
  return out;
}

/**
 * Pure function. Finds the background and note-block colours in a region.
 *
 * Coarse-quantises the region's colours and counts them. The background is
 * whatever is most common. The note colour is the most distant *populous*
 * colour from it -- notes are deliberately high-contrast against the grid, and
 * requiring a minimum share rejects antialiasing fringes and one-off UI chrome.
 *
 * @param {object} image - ImageData-shaped
 * @param {{x0: number, x1: number, y0: number, y1: number}} region
 * @returns {{background: Array<number>, note: Array<number>, noteFraction: number}}
 *   colours as [r, g, b] bucket centres
 *
 * @example
 * // three-quarters dark background, one-quarter bright note colour. The result
 * // is the BUCKET CENTRE, so 240 reads back as 248.
 * const img = {width: 4, height: 1, data: [
 *   20, 20, 20, 255, 20, 20, 20, 255, 20, 20, 20, 255, 200, 240, 200, 255]};
 * findPalette(img, {x0: 0, x1: 4, y0: 0, y1: 1}).note  // [200, 248, 200]
 */
export function findPalette(image, region) {
  const counts = new Map();
  let total = 0;

  for (let y = region.y0; y < region.y1; y++) {
    for (let x = region.x0; x < region.x1; x++) {
      const [r, g, b] = pixel(image, x, y);
      const key = (Math.floor(r / COLOUR_BUCKET) << 16)
        | (Math.floor(g / COLOUR_BUCKET) << 8)
        | Math.floor(b / COLOUR_BUCKET);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      total++;
    }
  }
  if (!total) throw new Error('findPalette was given an empty region');

  const centre = (key) => [
    ((key >> 16) & 0xff) * COLOUR_BUCKET + COLOUR_BUCKET / 2,
    ((key >> 8) & 0xff) * COLOUR_BUCKET + COLOUR_BUCKET / 2,
    (key & 0xff) * COLOUR_BUCKET + COLOUR_BUCKET / 2,
  ];

  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const background = centre(ranked[0][0]);

  let note = null;
  let noteCount = 0;
  let best = -1;
  for (const [key, count] of ranked) {
    if (count / total < MIN_NOTE_COLOUR_FRACTION) continue;
    const c = centre(key);
    const d = Math.hypot(c[0] - background[0], c[1] - background[1], c[2] - background[2]);
    if (d > best) { best = d; note = c; noteCount = count; }
  }
  if (!note) throw new Error('No colour in the image is common enough to be note blocks');

  return { background, note, noteFraction: noteCount / total };
}

/**
 * Pure function. Marks pixels close to the note colour.
 *
 * @param {object} image - ImageData-shaped
 * @param {{x0: number, x1: number, y0: number, y1: number}} region
 * @param {Array<number>} colour - [r, g, b] to match
 * @returns {{mask: Uint8Array, width: number, height: number}} region-local mask
 *
 * @example
 * const img = {width: 2, height: 1, data: [200, 240, 200, 255, 20, 20, 20, 255]};
 * [...noteMask(img, {x0: 0, x1: 2, y0: 0, y1: 1}, [200, 240, 200]).mask]  // [1, 0]
 */
export function noteMask(image, region, colour) {
  const width = region.x1 - region.x0;
  const height = region.y1 - region.y0;
  const mask = new Uint8Array(width * height);
  const tolerance = NOTE_COLOUR_TOLERANCE * 255 * Math.sqrt(3);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(image, region.x0 + x, region.y0 + y);
      const d = Math.hypot(r - colour[0], g - colour[1], b - colour[2]);
      if (d <= tolerance) mask[y * width + x] = 1;
    }
  }
  return { mask, width, height };
}

/**
 * Pure function. Bounding boxes of the connected runs in a mask.
 *
 * Four-connected, iterative. Recursion would blow the stack on a 1.2-megapixel
 * screenshot where a held chord is one component thousands of pixels wide.
 *
 * @param {{mask: Uint8Array, width: number, height: number}} m
 * @returns {Array<{x0: number, x1: number, y0: number, y1: number, area: number}>}
 *   x1/y1 inclusive
 *
 * @example
 * // two separate 1px blobs in a 3x1 strip
 * connectedBoxes({mask: Uint8Array.from([1, 0, 1]), width: 3, height: 1})
 * // [{x0: 0, x1: 0, y0: 0, y1: 0, area: 1}, {x0: 2, x1: 2, y0: 0, y1: 0, area: 1}]
 *
 * @example
 * // an L shape is ONE four-connected component, and its box covers the bend --
 * // which is also why two same-pitch notes that touch come back as one note
 * connectedBoxes({mask: Uint8Array.from([1, 0, 1, 1]), width: 2, height: 2})
 * // [{x0: 0, x1: 1, y0: 0, y1: 1, area: 3}]
 */
export function connectedBoxes(m) {
  const { mask, width, height } = m;
  const seen = new Uint8Array(width * height);
  const boxes = [];
  const stack = new Int32Array(width * height);

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;

    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    let x0 = width;
    let x1 = -1;
    let y0 = height;
    let y1 = -1;
    let area = 0;

    while (top > 0) {
      const i = stack[--top];
      const x = i % width;
      const y = (i - x) / width;
      area++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;

      if (x > 0 && mask[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack[top++] = i - 1; }
      if (x < width - 1 && mask[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack[top++] = i + 1; }
      if (y > 0 && mask[i - width] && !seen[i - width]) {
        seen[i - width] = 1; stack[top++] = i - width;
      }
      if (y < height - 1 && mask[i + width] && !seen[i + width]) {
        seen[i + width] = 1; stack[top++] = i + width;
      }
    }
    boxes.push({ x0, x1, y0, y1, area });
  }
  return boxes;
}

/**
 * Pure function. Which pitch class sits on which row, from the keyboard pattern.
 *
 * Every octave of a keyboard looks the same, so the octave is unknowable -- but
 * the five-in-twelve black key pattern is asymmetric, so its rotation is not.
 * Testing all twelve alignments of the observed black/white sequence against the
 * real pattern gives the pitch class of every row exactly.
 *
 * @param {Array<boolean>} isBlack - one per row, top row first
 * @returns {{phase: number, agreement: number}}
 *   `phase` is the pitch class of the TOP row; agreement is 0..1
 *
 * @example
 * // one octave read top-down from B: B A# A G# G F# F E D# D C# C
 * keyPatternPhase([false, true, false, true, false, true, false,
 *                  false, true, false, true, false])
 * // {phase: 11, agreement: 1}
 *
 * @example
 * // a run starting on C, descending: C B A# A
 * keyPatternPhase([false, false, true, false]).phase  // 0
 */
export function keyPatternPhase(isBlack) {
  const black = new Set(BLACK_KEY_OFFSETS);
  let bestPhase = 0;
  let bestScore = -1;

  for (let phase = 0; phase < SEMITONES_PER_OCTAVE; phase++) {
    let score = 0;
    for (let row = 0; row < isBlack.length; row++) {
      // Rows descend in pitch as they go down the image.
      const pc = (((phase - row) % SEMITONES_PER_OCTAVE) + SEMITONES_PER_OCTAVE)
        % SEMITONES_PER_OCTAVE;
      if (black.has(pc) === isBlack[row]) score++;
    }
    if (score > bestScore) { bestScore = score; bestPhase = phase; }
  }
  return { phase: bestPhase, agreement: isBlack.length ? bestScore / isBlack.length : 0 };
}

/**
 * Pure function. Finds how many fine grid lines make one bar.
 *
 * Bar lines are drawn heavier than beat lines, but thresholding on strength does
 * not find them: a real roll also draws HALF-bar lines at an intermediate
 * weight, so the strengths are not two clusters but three, and any global
 * threshold either splits the bar lines or swallows the half-bars. Measured on
 * the reference screenshot: beat lines 0.045-0.084, half-bars around 0.09-0.12,
 * bar lines 0.135-0.172.
 *
 * Periodicity separates them where brightness cannot. Bar lines are every k-th
 * line for some small k, so for each candidate k and phase this compares the
 * mean strength of that residue class against everything else. The true period
 * maximises the ratio: a smaller k dilutes the class with weaker lines, and a
 * larger k leaves some bar lines outside it, raising the baseline. On the
 * reference image k=2 scores 1.64, k=8 scores 1.69, and k=4 -- correct -- scores
 * 1.92.
 *
 * @param {Array<{position: number, strength: number}>} lines
 * @param {{origin: number, spacing: number}} fine - the fitted fine line grid
 * @returns {{period: number, phase: number, ratio: number}|null}
 *   null when no periodic subset stands out, i.e. all lines are drawn alike
 *
 * @example
 * // every 4th line is twice as strong: period 4, and the ratio says so
 * const lines = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
 *   {position: i * 10, strength: i % 4 === 0 ? 0.2 : 0.1}));
 * findBarPeriod(lines, {origin: 0, spacing: 10}).period          // 4
 * findBarPeriod(lines, {origin: 0, spacing: 10}).phase           // 0
 * findBarPeriod(lines, {origin: 0, spacing: 10}).ratio.toFixed(2)  // '2.00'
 *
 * @example
 * // uniform strengths: nothing to find
 * findBarPeriod([0, 1, 2, 3].map((i) => ({position: i * 10, strength: 0.1})),
 *               {origin: 0, spacing: 10})  // null
 */
export function findBarPeriod(lines, fine) {
  const indexed = lines.map((l) => ({
    ...l,
    index: Math.round((l.position - fine.origin) / fine.spacing),
  }));
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

  let best = null;
  for (const period of BAR_PERIOD_CANDIDATES) {
    for (let phase = 0; phase < period; phase++) {
      const inClass = indexed.filter((l) => ((l.index % period) + period) % period === phase);
      const outClass = indexed.filter((l) => ((l.index % period) + period) % period !== phase);
      if (inClass.length < 2 || !outClass.length) continue;

      const ratio = mean(inClass.map((l) => l.strength)) / mean(outClass.map((l) => l.strength));
      if (!best || ratio > best.ratio) best = { period, phase, ratio };
    }
  }
  return best && best.ratio >= MIN_BAR_STRENGTH_RATIO ? best : null;
}

/**
 * Query. Calibrates both axes of a piano-roll screenshot.
 *
 * Not pure only because it reads the image; it mutates nothing.
 *
 * @param {object} image - ImageData-shaped
 * @returns {object} calibration and the diagnostics behind it
 */
export function calibrate(image) {
  const warnings = [];

  const keybedWidth = findKeybedWidth(image);
  if (!keybedWidth) {
    warnings.push('No piano keyboard found down the left edge, so pitches are '
      + 'positioned by row spacing alone and the pitch class may be wrong. '
      + 'Crop the screenshot to include the keyboard for an exact reading.');
  }

  const gridX0 = keybedWidth;
  const region = { x0: gridX0, x1: image.width, y0: 0, y1: image.height };

  // ---- vertical: bar lines, then the sixteenth ----------------------------
  const cols = findLines(columnProfile(image, gridX0, image.width))
    .map((l) => ({ ...l, position: l.position + gridX0 }));
  if (cols.length < 2) {
    throw new Error('Found no vertical grid lines, so the time axis cannot be calibrated. '
      + 'Is this a piano-roll screenshot?');
  }

  // Fit the fine line grid first, then work out which of those lines are bars.
  const fine = fitGrid(cols.map((l) => l.position));
  const bars = findBarPeriod(cols, fine);

  let barFit;
  if (bars) {
    // Re-fit over just the bar lines: their longer baseline gives a better
    // spacing than multiplying the fine spacing by the period.
    const barLines = cols
      .filter((l) => {
        const i = Math.round((l.position - fine.origin) / fine.spacing);
        return ((i % bars.period) + bars.period) % bars.period === bars.phase;
      })
      .map((l) => l.position);
    barFit = barLines.length >= 2
      ? fitGrid(barLines)
      : { ...fine, spacing: fine.spacing * bars.period };
  } else {
    // Every line is drawn alike, so nothing marks the bars. Assume the visible
    // grid is beats, which is the common default at moderate zoom -- but say so,
    // because if it is really sixteenths the tempo will read four times fast.
    barFit = { ...fine, spacing: fine.spacing * BEATS_PER_BAR };
    warnings.push('All grid lines are drawn with the same weight, so bar lines could not be '
      + 'identified. Assuming the visible lines are beats. If they are sixteenths, every '
      + 'note is four times too long and the tempo needs dividing by four.');
  }

  if (barFit.spacing < MIN_BAR_PX) {
    throw new Error(`Bar lines came out ${barFit.spacing.toFixed(1)} px apart, too close to be `
      + 'bars. The screenshot may be zoomed too far out to read.');
  }
  const stepWidth = barFit.spacing / DEFAULT_STEPS_PER_BAR;

  // ---- horizontal: semitone rows -----------------------------------------
  const rows = findLines(rowProfile(image, gridX0, image.width)).map((l) => l.position);
  if (rows.length < 2) {
    throw new Error('Found no horizontal row lines, so the pitch axis cannot be calibrated.');
  }
  const rowFit = fitGrid(rows);
  if (rowFit.spacing < MIN_SEMITONE_PX || rowFit.spacing > MAX_SEMITONE_PX) {
    throw new Error(`Semitone rows came out ${rowFit.spacing.toFixed(1)} px apart, outside the `
      + `plausible ${MIN_SEMITONE_PX}-${MAX_SEMITONE_PX} px range.`);
  }

  // ---- pitch class from the keyboard -------------------------------------
  let phase = 0;
  let phaseAgreement = 0;
  if (keybedWidth) {
    const sampleX = Math.max(1, Math.floor(keybedWidth * KEYBED_SAMPLE_FRACTION));
    const isBlack = [];
    for (let row = 0; ; row++) {
      const y = Math.round(rowFit.origin + (row + 0.5) * rowFit.spacing);
      if (y >= image.height) break;
      if (y < 0) continue;
      const [r, g, b] = pixel(image, sampleX, y);
      isBlack.push(luminance(r, g, b) < DARK_LUMA);
    }
    const found = keyPatternPhase(isBlack);
    phase = found.phase;
    phaseAgreement = found.agreement;
    if (phaseAgreement < 1) {
      warnings.push(`The keyboard's black/white pattern matched at only `
        + `${Math.round(phaseAgreement * 100)}%, so the pitch class may be off. `
        + 'A taller crop of the keyboard reads more reliably.');
    }
  }

  return {
    keybedWidth,
    region,
    barWidth: barFit.spacing,
    barOrigin: barFit.origin,
    stepWidth,
    stepsPerBar: DEFAULT_STEPS_PER_BAR,
    semitoneHeight: rowFit.spacing,
    rowOrigin: rowFit.origin,
    barResidual: barFit.residual,
    rowResidual: rowFit.residual,
    barPeriod: bars,
    fineSpacing: fine.spacing,
    phase,
    phaseAgreement,
    lineCount: { vertical: cols.length, horizontal: rows.length },
    warnings,
  };
}

/**
 * Pure function. Converts note-block boxes into notes, given a calibration.
 *
 * Pitch comes from which semitone row a box's centre falls in; start and length
 * come from dividing by the step width and rounding. Rounding rather than
 * flooring matters: a block drawn one pixel short of its slot should land on the
 * slot, not one before it.
 *
 * The octave is chosen, not measured -- see the file header. The reading is
 * shifted bodily so its median pitch is as close to middle C as a whole number
 * of octaves allows.
 *
 * @param {Array<object>} boxes - from connectedBoxes, in region coordinates
 * @param {object} cal - from calibrate
 * @returns {{notes: Array<object>, alignment: number, topPitch: number}}
 *   notes are {pitch, start, length}; alignment is the fraction of block edges
 *   that landed within a quarter-step of the grid, the same statistic that
 *   validated the hand measurement
 *
 * @example
 * // one box, 4 steps wide, on the top row: becomes a 4-step note
 * const cal = {keybedWidth: 0, barWidth: 64, barOrigin: 0, stepWidth: 4,
 *              semitoneHeight: 10, rowOrigin: 0, phase: 0, region: {x0: 0, y0: 0}};
 * boxesToNotes([{x0: 0, x1: 15, y0: 0, y1: 9, area: 160}], cal).notes
 * // [{pitch: 60, start: 0, length: 4}]
 */
export function boxesToNotes(boxes, cal) {
  const raw = [];
  let aligned = 0;

  for (const box of boxes) {
    const absX0 = box.x0 + cal.region.x0;
    const absX1 = box.x1 + 1 + cal.region.x0;
    const centreY = box.y0 + (box.y1 - box.y0) / 2 + cal.region.y0;

    const startExact = (absX0 - cal.barOrigin) / cal.stepWidth;
    const start = Math.round(startExact);
    if (Math.abs(startExact - start) * cal.stepWidth <= EDGE_TOLERANCE_PX) aligned++;

    const length = Math.max(1, Math.round((absX1 - absX0) / cal.stepWidth));
    const row = Math.floor((centreY - cal.rowOrigin) / cal.semitoneHeight);
    raw.push({ row, start, length });
  }

  if (!raw.length) return { notes: [], alignment: 0, topPitch: MIDDLE_C };

  // Pitch class is exact; the octave is a guess centred on middle C.
  const rows = raw.map((n) => n.row).sort((a, b) => a - b);
  const medianRow = rows[Math.floor(rows.length / 2)];
  const pitchOf = (row, topPitch) => topPitch - row;

  let topPitch = cal.phase;
  while (pitchOf(medianRow, topPitch) < MIDDLE_C - SEMITONES_PER_OCTAVE / 2) {
    topPitch += SEMITONES_PER_OCTAVE;
  }
  while (pitchOf(medianRow, topPitch) >= MIDDLE_C + SEMITONES_PER_OCTAVE / 2) {
    topPitch -= SEMITONES_PER_OCTAVE;
  }

  // Same pitch, same slot, twice means one block was split by something drawn
  // over it. Keep the longer reading rather than emitting a double trigger.
  const byKey = new Map();
  for (const n of raw) {
    const pitch = pitchOf(n.row, topPitch);
    if (pitch < MIDI_NOTE_MIN || pitch > MIDI_NOTE_MAX) continue;
    const key = `${pitch}:${n.start}`;
    const kept = byKey.get(key);
    if (!kept || n.length > kept.length) byKey.set(key, { pitch, start: n.start, length: n.length });
  }

  const notes = [...byKey.values()].sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  return { notes, alignment: aligned / boxes.length, topPitch };
}

/**
 * Query. Reads a piano-roll screenshot into notes. The whole pipeline.
 *
 * @param {object} image - ImageData-shaped {data, width, height}
 * @returns {{notes, calibration, palette, blockCount, alignment, warnings}}
 *   notes are {pitch, start, length} in sixteenth steps
 */
export function readScreenshot(image) {
  const cal = calibrate(image);
  const palette = findPalette(image, cal.region);
  const mask = noteMask(image, cal.region, palette.note);

  const boxes = connectedBoxes(mask).filter((box) =>
    box.x1 - box.x0 + 1 >= MIN_BLOCK_WIDTH_PX && box.y1 - box.y0 + 1 >= MIN_BLOCK_HEIGHT_PX);
  if (!boxes.length) {
    throw new Error('Found the grid but no note blocks. If the notes are a similar colour to '
      + 'the background, this reader cannot separate them.');
  }

  const { notes, alignment, topPitch } = boxesToNotes(boxes, cal);
  const warnings = [...cal.warnings];
  if (alignment < GOOD_ALIGNMENT) {
    // Not necessarily a mis-scaled axis: it also happens when the music simply
    // is not quantised to sixteenths, or when the screenshot is zoomed out far
    // enough that a sixteenth is only a few pixels wide and antialiasing costs
    // more precision than the grid has. Say which, by quoting the scale.
    warnings.push(`Only ${Math.round(alignment * 100)}% of note edges landed on the sixteenth `
      + `grid, at ${cal.stepWidth.toFixed(2)} px per sixteenth. Short notes may be a step out. `
      + 'Either the music is not quantised to sixteenths, or the screenshot is too zoomed out '
      + 'to place them exactly; a wider zoom in the source editor reads better.');
  }

  return {
    notes,
    calibration: { ...cal, topPitch },
    palette,
    blockCount: boxes.length,
    alignment,
    warnings,
  };
}

/**
 * Command. Decodes an image file into ImageData via a canvas.
 *
 * The only impure step in the file, and the only one that needs a browser: the
 * browser already decodes PNG and JPEG, so this borrows its decoder rather than
 * shipping one.
 *
 * @param {Blob} file - an image file from a file input or a paste
 * @returns {Promise<ImageData>}
 */
export async function decodeImage(file) {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Could not get a 2D canvas context to read the screenshot');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

/**
 * Pure function. Turns a screenshot reading into a roll document.
 *
 * Ends at the same shape the MIDI importer produces, so both feed the one code
 * path into `roll.sequence`.
 *
 * @param {object} reading - from readScreenshot
 * @param {string} label - normally the file name
 * @param {number} bpm - tempo to attach; a screenshot carries none
 * @returns {object} a roll document
 *
 * @example
 * // the honesty note names what a picture cannot carry
 * const doc = screenshotToDoc(
 *   {notes: [{pitch: 60, start: 0, length: 4}], blockCount: 1, alignment: 1,
 *    calibration: {barWidth: 58, stepWidth: 3.625, semitoneHeight: 15.75,
 *                  stepsPerBar: 16, phaseAgreement: 1}, warnings: []},
 *   'shot.png', 96);
 * doc.notes                  // [{pitch: 60, start: 0, length: 4}]
 * doc.timebase               // 16
 * doc.note.includes('octave')  // true
 */
export function screenshotToDoc(reading, label, bpm) {
  const cal = reading.calibration;
  const measured = `${cal.barWidth.toFixed(1)} px per bar, `
    + `${cal.stepWidth.toFixed(2)} px per sixteenth, `
    + `${cal.semitoneHeight.toFixed(2)} px per semitone`;

  return {
    name: label,
    bpm,
    timebase: cal.stepsPerBar,
    grid: cal.stepsPerBar / 4,
    snap: 1,
    notes: reading.notes.map((n) => ({ ...n })),
    note: `Read from the image ${label}: ${reading.notes.length} notes from `
      + `${reading.blockCount} blocks (${measured}; `
      + `${Math.round(reading.alignment * 100)}% of edges on the grid). `
      + 'This is a best-effort reading of a picture, NOT the song: the octave is a '
      + 'guess (the key pattern fixes the pitch class, but every octave looks alike '
      + 'and FL names middle C an octave high), same-pitch overlaps merged into '
      + 'single notes, velocity is not in an image, and anything scrolled out of '
      + 'frame was never there to read. The .mid file is always better.'
      + (reading.warnings.length ? ` Warnings: ${reading.warnings.join(' ')}` : ''),
  };
}
