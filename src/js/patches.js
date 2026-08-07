/**
 * patches.js -- the patch browser.
 *
 * Surge ships thousands of .fxp patches across a factory bank and a 3rd-party
 * bank. They are far too large to preload, so only a generated index is fetched
 * at startup and the individual .fxp is downloaded when the user picks it.
 */

'use strict';

const PATCH_INDEX_URL = 'data/patches.json';

/**
 * Query. Fetches the generated patch index.
 *
 * Throws rather than returning an empty list on failure: an empty patch browser
 * that looks merely "unpopulated" would hide a broken deployment.
 *
 * @returns {Promise<{patches: Array<{name: string, category: string, bank: string, path: string}>}>}
 */
export async function loadPatchIndex() {
  const res = await fetch(PATCH_INDEX_URL);
  if (!res.ok) {
    throw new Error(`${PATCH_INDEX_URL} -> HTTP ${res.status}. Run tools/gen_patch_index.py`);
  }
  return res.json();
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
