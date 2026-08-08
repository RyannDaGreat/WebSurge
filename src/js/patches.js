/**
 * patches.js -- the patch browser.
 *
 * The browsable list is derived from the packed archive that is already mounted
 * into both wasm filesystems, so selecting a patch is a filesystem read rather
 * than a download. There is no separate index to drift out of sync with what
 * the deploy actually contains.
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
  const BANKS = { patches_factory: 'Factory', patches_3rdparty: '3rd Party' };
  const patches = [];

  for (const f of files) {
    if (!f.p.endsWith('.fxp')) continue;

    const parts = f.p.split('/');
    const bank = BANKS[parts[0]];
    if (!bank) continue;

    const name = parts[parts.length - 1].replace(/\.fxp$/, '');
    const category = parts.slice(1, -1).join('/') || '(root)';
    patches.push({ name, category, bank, path: `${root}/${f.p}` });
  }

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
