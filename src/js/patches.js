/**
 * patches.js -- the patch browser.
 *
 * The list comes from two places, and the browser deliberately does not
 * distinguish between them beyond one flag:
 *
 *   - the packed archive already mounted into both wasm filesystems, so
 *     selecting one of those patches is a filesystem read, not a download
 *   - a manifest of patches served as ordinary files, fetched when picked
 *
 * The split exists only because the 3rd-party bank is 241 MB and cannot go in a
 * startup download. Both kinds end up as the same shape of entry, and the only
 * difference downstream is that a `remote` entry needs its bytes fetched and
 * written into the filesystem before Surge is asked to load it.
 */

'use strict';

/**
 * Pure function. Turns the packed-archive file list into browsable patch entries.
 *
 * There is no separate patch index any more. The archive already lists every
 * file, and deriving the browser from it means the sidebar cannot advertise a
 * patch the deploy does not contain -- a whole class of 404-on-click bugs that
 * a second, independently generated index invites.
 *
 * `path` is where the file lives in the MOUNTED filesystem, not a URL: the
 * patch is loaded from there rather than fetched, since Surge already has it.
 *
 * @param {Array<{p: string}>} files - entries from surge-data.json
 * @param {string} root - the mount point
 * @returns {{patches: Array<{name:string, category:string, bank:string, path:string}>}}
 *
 * @example
 * patchesFromArchive([{p: 'patches_factory/Basses/Sub.fxp'}], '/SurgeXTData')
 * // { patches: [ { name: 'Sub', category: 'Basses', bank: 'Factory',
 * //                path: '/SurgeXTData/patches_factory/Basses/Sub.fxp' } ] }
 */
export function patchesFromArchive(files, root) {
  return buildPatchIndex(files.map((f) => f.p), [], root);
}

/** Directory name under the data root -> the label shown in the sidebar. */
const BANKS = { patches_factory: 'Factory', patches_3rdparty: '3rd Party' };

/**
 * Pure function. Builds the full browsable index from both sources.
 *
 * `path` is always where the file lives in the wasm filesystem, never a URL --
 * remote patches are written to exactly that path once fetched, so by the time
 * Surge is asked to load one there is no difference between the two kinds.
 *
 * @param {string[]} mounted - archive-relative paths already in the filesystem
 * @param {string[]} remote - archive-relative paths fetched on demand
 * @param {string} root - the mount point
 * @returns {{patches: Array<{name:string, category:string, bank:string,
 *            path:string, remote:boolean, archivePath:string}>}}
 *
 * @example
 * buildPatchIndex(['patches_factory/Basses/Sub.fxp'],
 *                 ['patches_3rdparty/Pads/Big.fxp'], '/SurgeXTData')
 * // { patches: [
 * //     { name:'Sub', category:'Basses', bank:'Factory', remote:false,
 * //       path:'/SurgeXTData/patches_factory/Basses/Sub.fxp', … },
 * //     { name:'Big', category:'Pads',   bank:'3rd Party', remote:true,  … } ] }
 */
export function buildPatchIndex(mounted, remote, root) {
  const patches = [];

  const add = (archivePath, isRemote) => {
    if (!archivePath.endsWith('.fxp')) return;

    const parts = archivePath.split('/');
    const bank = BANKS[parts[0]];
    if (!bank) return;

    patches.push({
      name: parts[parts.length - 1].replace(/\.fxp$/, ''),
      category: parts.slice(1, -1).join('/') || '(root)',
      bank,
      path: `${root}/${archivePath}`,
      archivePath,
      remote: isRemote,
    });
  };

  for (const path of mounted) add(path, false);
  for (const path of remote) add(path, true);

  patches.sort((a, b) =>
    a.bank.localeCompare(b.bank) ||
    a.category.toLowerCase().localeCompare(b.category.toLowerCase()) ||
    a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

  return { patches };
}

/**
 * Pure function. Groups a flat patch list into bank -> category -> patches.
 *
 * @param {Array<object>} patches
 * @returns {Map<string, Map<string, Array<object>>>}
 *
 * @example
 * groupPatches([{bank:'factory', category:'Basses', name:'Sub'}])
 * // Map { 'factory' => Map { 'Basses' => [ {…} ] } }
 */
export function groupPatches(patches) {
  const banks = new Map();
  for (const p of patches) {
    if (!banks.has(p.bank)) banks.set(p.bank, new Map());
    const cats = banks.get(p.bank);
    if (!cats.has(p.category)) cats.set(p.category, []);
    cats.get(p.category).push(p);
  }
  return banks;
}

/**
 * Command. Renders the patch tree into `container` and wires selection.
 *
 * Categories are collapsed by default -- with thousands of patches an expanded
 * tree is unusable, and building every row up front would stall the page.
 *
 * @param {HTMLElement} container
 * @param {{patches: Array<object>}} index
 * @param {(entry: object) => void} onSelect
 */
export function buildPatchTree(container, index, onSelect) {
  container.textContent = '';
  const banks = groupPatches(index.patches);

  const count = index.patches.length;
  const header = document.createElement('div');
  header.className = 'patch-count';
  header.textContent = `${count} patches`;
  container.append(header);

  const filter = document.createElement('input');
  filter.type = 'search';
  filter.placeholder = 'Filter patches...';
  filter.className = 'patch-filter';
  container.append(filter);

  const tree = document.createElement('div');
  tree.className = 'patch-tree';
  container.append(tree);

  for (const [bank, categories] of banks) {
    const bankEl = document.createElement('details');
    bankEl.className = 'bank';
    const bankSummary = document.createElement('summary');
    bankSummary.textContent = `${bank} (${[...categories.values()].reduce((n, a) => n + a.length, 0)})`;
    bankEl.append(bankSummary);

    for (const [category, entries] of categories) {
      const catEl = document.createElement('details');
      catEl.className = 'category';
      const catSummary = document.createElement('summary');
      catSummary.textContent = `${category} (${entries.length})`;
      catEl.append(catSummary);

      for (const entry of entries) {
        const item = document.createElement('button');
        item.className = 'patch';
        item.textContent = entry.name;
        item.addEventListener('click', () => {
          tree.querySelector('.patch.selected')?.classList.remove('selected');
          item.classList.add('selected');
          onSelect(entry);
        });
        catEl.append(item);
      }
      bankEl.append(catEl);
    }
    tree.append(bankEl);
  }

  /** Minimum characters before filtering, so one keystroke does not expand everything. */
  const MIN_FILTER_CHARS = 2;

  filter.addEventListener('input', () => {
    const q = filter.value.trim().toLowerCase();
    const active = q.length >= MIN_FILTER_CHARS;

    for (const item of tree.querySelectorAll('.patch')) {
      const hit = !active || item.textContent.toLowerCase().includes(q);
      item.hidden = !hit;
    }
    // Open containers that still have visible children; close the rest.
    for (const det of tree.querySelectorAll('details')) {
      const hasVisible = [...det.querySelectorAll('.patch')].some((p) => !p.hidden);
      det.open = active && hasVisible;
      det.hidden = active && !hasVisible;
    }
  });
}
