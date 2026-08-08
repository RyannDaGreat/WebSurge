/**
 * surge-data.js -- mounts Surge's factory resources into a wasm filesystem.
 *
 * Surge builds its patch and wavetable lists by SCANNING A DIRECTORY, in
 * SurgeStorage's constructor. Handing it individual files on demand is not
 * enough: without a real tree in place before the synth is constructed, the
 * patch list is empty, and an empty list is why the Category/Patch jog buttons
 * silently do nothing (SurgeSynthesizerIO.cpp:49 returns early on size 0).
 *
 * The tree arrives as one archive rather than 842 separate requests. Both wasm
 * modules -- the GUI and the audio engine -- need the same tree, so the bytes
 * are fetched once here and unpacked into each.
 */

'use strict';

/** Where Surge is told to look, via the SURGE_DATA_HOME environment variable. */
export const SURGE_DATA_ROOT = '/SurgeXTData';

const INDEX_URL = 'data/surge-data.json';
const BLOB_URL = 'data/surge-data.bin';

/**
 * Query. Fetches the packed factory data.
 *
 * Throws rather than returning empty on failure: a missing archive means every
 * patch silently disappears, which looks like a working site with a short list.
 *
 * @returns {Promise<{files: Array<{p: string, o: number, n: number}>, bytes: Uint8Array}>}
 */
export async function fetchSurgeData() {
  const [indexRes, blobRes] = await Promise.all([fetch(INDEX_URL), fetch(BLOB_URL)]);

  if (!indexRes.ok) throw new Error(`${INDEX_URL} -> HTTP ${indexRes.status}. Run tools/pack_data.py`);
  if (!blobRes.ok) throw new Error(`${BLOB_URL} -> HTTP ${blobRes.status}. Run tools/pack_data.py`);

  const index = await indexRes.json();
  const bytes = new Uint8Array(await blobRes.arrayBuffer());

  if (!index.files || index.files.length === 0) {
    throw new Error('Surge data archive is empty');
  }
  return { files: index.files, bytes };
}

/**
 * Pure function. Every directory that must exist for these paths, parents first.
 *
 * MEMFS has no mkdir -p, and creating a child before its parent fails, so the
 * set has to be emitted shallowest-first.
 *
 * @param {Array<{p: string}>} files
 * @returns {string[]} directory paths relative to the root, parents before children
 *
 * @example
 * directoriesFor([{p: 'wavetables/Basic/Sine.wt'}])
 * // ['wavetables', 'wavetables/Basic']
 */
export function directoriesFor(files) {
  const dirs = new Set();

  for (const f of files) {
    const parts = f.p.split('/');
    parts.pop(); // drop the filename
    let acc = '';
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      dirs.add(acc);
    }
  }
  // Shallower paths sort before deeper ones because '/' raises the length.
  return [...dirs].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
}

/**
 * Command. Writes the archive into an Emscripten filesystem under `root`.
 *
 * @param {object} FS - the module's FS object
 * @param {Array<{p: string, o: number, n: number}>} files
 * @param {Uint8Array} bytes - the packed blob
 * @param {string} [root] - mount point, default SURGE_DATA_ROOT
 * @returns {number} how many files were written
 */
export function unpackInto(FS, files, bytes, root = SURGE_DATA_ROOT) {
  try {
    FS.mkdir(root);
  } catch (err) {
    // EEXIST is fine and expected on a second call; anything else is not, and
    // swallowing it would leave Surge scanning a directory that is not there.
    if (err && err.errno !== undefined && err.code !== 'EEXIST') throw err;
  }

  for (const dir of directoriesFor(files)) {
    try {
      FS.mkdir(`${root}/${dir}`);
    } catch (err) {
      if (err && err.code !== 'EEXIST') throw err;
    }
  }

  for (const f of files) {
    FS.writeFile(`${root}/${f.p}`, bytes.subarray(f.o, f.o + f.n));
  }
  return files.length;
}
