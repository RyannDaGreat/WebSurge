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
 *
 * WHAT IS IN THE ARCHIVE, AND WHAT IS NOT
 * ---------------------------------------
 * Only the banks Surge must see at construction time: the factory patches and
 * the wavetables. The 3rd-party bank is 2920 patches / 241 MB, and putting it
 * here would mean waiting for a 271 MB download before the first note. Those
 * patches are fetched individually when the user picks one -- see
 * `fetchRemotePatch`. The whole library is offered either way; the difference is
 * only whether the bytes arrive up front or on click.
 */

'use strict';

/** Where Surge is told to look, via the SURGE_DATA_HOME environment variable. */
export const SURGE_DATA_ROOT = '/SurgeXTData';

const INDEX_URL = 'data/surge-data.json';
const BLOB_URL = 'data/surge-data.bin';

/** Paths of the patches served as ordinary files rather than packed. */
const REMOTE_URL = 'data/surge-remote.json';

/** Where those files live, relative to the page. */
const REMOTE_BASE = 'data/';

/**
 * Query. Fetches the packed factory data.
 *
 * Throws rather than returning empty on failure: a missing archive means every
 * patch silently disappears, which looks like a working site with a short list.
 *
 * @param {(received: number, total: number) => void} [onProgress] - called as
 *        bytes arrive. `total` is 0 when the server sends no Content-Length.
 * @returns {Promise<{files: Array<{p: string, o: number, n: number}>, bytes: Uint8Array}>}
 */
export async function fetchSurgeData(onProgress) {
  const [indexRes, blobRes] = await Promise.all([fetch(INDEX_URL), fetch(BLOB_URL)]);

  if (!indexRes.ok) throw new Error(`${INDEX_URL} -> HTTP ${indexRes.status}. Run tools/pack_data.py`);
  if (!blobRes.ok) throw new Error(`${BLOB_URL} -> HTTP ${blobRes.status}. Run tools/pack_data.py`);

  const index = await indexRes.json();
  const bytes = new Uint8Array(await readWithProgress(blobRes, onProgress));

  if (!index.files || index.files.length === 0) {
    throw new Error('Surge data archive is empty');
  }
  return { files: index.files, bytes };
}

/**
 * Query. Reads a response body, reporting progress as it goes.
 *
 * The archive is ~29 MB, which is several seconds on a normal connection with
 * nothing on screen. `response.arrayBuffer()` cannot report progress, so the
 * body is drained a chunk at a time instead.
 *
 * Falls back to `arrayBuffer()` where streams are unavailable -- the download
 * still works, it just cannot be shown as a bar.
 *
 * @param {Response} response
 * @param {(received: number, total: number) => void} [onProgress]
 * @returns {Promise<ArrayBuffer>}
 */
async function readWithProgress(response, onProgress) {
  const total = Number(response.headers.get('Content-Length')) || 0;
  if (!onProgress || !response.body?.getReader) return response.arrayBuffer();

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(received, total);
  }

  const out = new Uint8Array(received);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out.buffer;
}

/**
 * Query. Paths of every patch served on demand rather than packed.
 *
 * Returns an empty list if the manifest is absent, because the on-demand bank is
 * optional: a deploy without it still has the whole factory library. A failed
 * FETCH of a manifest that does exist still throws.
 *
 * @returns {Promise<string[]>} archive-relative paths, e.g. 'patches_3rdparty/Pads/Big.fxp'
 */
export async function fetchRemoteIndex() {
  const res = await fetch(REMOTE_URL);
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`${REMOTE_URL} -> HTTP ${res.status}`);

  const index = await res.json();
  return index.files || [];
}

/**
 * Query. Fetches one on-demand patch.
 *
 * @param {string} archivePath - path relative to the data root
 * @returns {Promise<Uint8Array>}
 */
export async function fetchRemotePatch(archivePath) {
  const url = REMOTE_BASE + archivePath.split('/').map(encodeURIComponent).join('/');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Command. Writes one file into a wasm filesystem, creating parent directories.
 *
 * Used for patches that arrive after the initial mount. MEMFS has no mkdir -p,
 * so the parents are walked explicitly.
 *
 * @param {object} FS - the module's FS object
 * @param {string} archivePath - path relative to the root
 * @param {Uint8Array} bytes
 * @param {string} [root]
 */
export function writeFileInto(FS, archivePath, bytes, root = SURGE_DATA_ROOT) {
  const parts = archivePath.split('/');
  parts.pop(); // the filename

  let acc = root;
  for (const part of parts) {
    acc += `/${part}`;
    makeDirs(FS, acc);
  }
  FS.writeFile(`${root}/${archivePath}`, bytes);
}

/**
 * Command. Creates `path` and any missing parents. Absolute paths only.
 *
 * Existence is TESTED rather than mkdir-and-catch-EEXIST. Emscripten only
 * populates ErrnoError's `.code` and `.message` when built with assertions, so
 * the engine module -- which is not -- raises a bare `{errno: 20}` that no
 * string comparison recognises. Testing first also means a real failure (a
 * permissions problem, a file where a directory should be) propagates loudly
 * instead of being swallowed by an over-broad catch.
 *
 * @param {object} FS - the Emscripten filesystem
 * @param {string} dir - absolute directory path
 *
 * @example makeDirs(FS, '/SurgeXTData/patches_3rdparty/A.Liv/Basses')
 */
export function makeDirs(FS, dir) {
  if (FS.analyzePath(dir).exists) return;
  FS.mkdir(dir);
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
  makeDirs(FS, root);
  for (const dir of directoriesFor(files)) makeDirs(FS, `${root}/${dir}`);

  for (const f of files) {
    FS.writeFile(`${root}/${f.p}`, bytes.subarray(f.o, f.o + f.n));
  }
  return files.length;
}
