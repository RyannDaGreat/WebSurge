#!/usr/bin/env python3
"""
Generate src/data/patches.json: the index the browser patch browser loads.

Surge ships thousands of .fxp patches across two banks. Shipping an index rather
than scanning at runtime means the page fetches one small JSON file and
downloads an individual patch only when the user picks it.

Desktop Surge builds an SQLite patch database for this; we cannot run that in the
browser, so the index is produced at build time instead.

Run:  uv run tools/gen_patch_index.py
"""

# /// script
# requires-python = ">=3.9"
# dependencies = ["fire"]
# ///

import json
import sys
from pathlib import Path

import fire

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = REPO_ROOT / "src" / "data"

# Directory name under src/data/ -> the bank label shown in the browser.
BANKS = {
    "patches_factory": "Factory",
    "patches_3rdparty": "3rd Party",
}


def patch_entry(fxp_path, bank_dir, bank_label):
    """
    Pure function. Describes one .fxp file as an index entry.

    Category is the patch's directory path relative to its bank, which is exactly
    how Surge organizes and displays them (e.g. "Basses", "Leads/Soft").

    Args:
        fxp_path (Path): absolute path to the .fxp
        bank_dir (Path): absolute path to the bank root
        bank_label (str): human-readable bank name

    Returns:
        dict: {name, category, bank, path}

    Examples:
        >>> # a patch at <bank>/Basses/Sub.fxp in the factory bank becomes:
        >>> # {'name': 'Sub', 'category': 'Basses',
        >>> #  'bank': 'Factory', 'path': 'data/patches_factory/Basses/Sub.fxp'}
    """
    rel_to_bank = fxp_path.relative_to(bank_dir)
    category = str(rel_to_bank.parent) if rel_to_bank.parent != Path(".") else "(root)"
    return {
        "name": fxp_path.stem,
        "category": category,
        "bank": bank_label,
        # Relative to src/, because that is the web root the page is served from.
        "path": str(fxp_path.relative_to(REPO_ROOT / "src")),
    }


def scan_bank(bank_name, bank_label):
    """
    Query. Reads one bank directory from disk and returns its index entries.

    Args:
        bank_name (str): directory name under src/data/
        bank_label (str): label for the browser

    Returns:
        list[dict]: entries, sorted by category then name

    Examples:
        >>> # scan_bank("patches_factory", "Factory")[0]["bank"]
        >>> # 'Factory'
    """
    bank_dir = DATA_DIR / bank_name
    if not bank_dir.is_dir():
        # Loud: a missing bank means patches silently vanish from the browser.
        print(f"WARNING: bank not staged, skipping: {bank_dir}", file=sys.stderr)
        return []

    entries = [patch_entry(p, bank_dir, bank_label) for p in bank_dir.rglob("*.fxp")]
    entries.sort(key=lambda e: (e["category"].lower(), e["name"].lower()))
    return entries


def main():
    """
    Command. Writes src/data/patches.json from the staged patch banks.

    Fails loudly if no patches were found at all, since an empty index would
    present in the UI as a merely-empty browser rather than a broken build.
    """
    if not DATA_DIR.is_dir():
        raise SystemExit(f"{DATA_DIR} does not exist. Run tools/stage_data.sh first.")

    patches = []
    for bank_name, bank_label in BANKS.items():
        found = scan_bank(bank_name, bank_label)
        print(f"  {bank_label:10s} {len(found):5d} patches")
        patches.extend(found)

    if not patches:
        raise SystemExit("No .fxp files found. Run tools/stage_data.sh first.")

    out = DATA_DIR / "patches.json"
    out.write_text(json.dumps({"patches": patches}, indent=None))

    categories = {(e["bank"], e["category"]) for e in patches}
    print(f"\nWrote {out.relative_to(REPO_ROOT)}")
    print(f"  {len(patches)} patches in {len(categories)} categories")
    print(f"  {out.stat().st_size / 1024:.0f} KiB")


if __name__ == "__main__":
    fire.Fire(main)
