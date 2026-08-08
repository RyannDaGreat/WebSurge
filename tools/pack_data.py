#!/usr/bin/env python3
"""
Pack Surge's factory resources into one archive the browser fetches once.

WHY AN ARCHIVE
--------------
Surge builds its patch list by scanning a directory (`refreshPatchlistAddDir`),
and reads the actual bytes when a patch loads. Both need a real filesystem, so
the tree has to exist inside each wasm module's MEMFS.

Fetching it as loose files would be 639 patches plus ~90 wavetables = hundreds of
HTTP requests on every page load. One archive plus one index is two requests.

Emscripten's own --preload-file does something similar, but it bakes the data
into a single module. We have two modules (GUI and engine) that both need the
same tree, and preloading twice would double both the download and the memory.
This way the bytes are fetched once and unpacked into each.

Run:  uv run tools/pack_data.py
"""

# /// script
# requires-python = ">=3.9"
# dependencies = ["fire"]
# ///

import json
from pathlib import Path

import fire

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = REPO_ROOT / "src" / "data"

# Only the banks that are committed for deployment. The 3rd-party banks are
# 241 MB and stay out; Surge simply lists fewer patches without them.
BANKS = ["patches_factory", "wavetables"]

BIN_NAME = "surge-data.bin"
INDEX_NAME = "surge-data.json"

# Banks too large to put in the startup archive. Their patches are served as
# ordinary files and fetched when the user picks one.
#
# All 3559 patches in one archive would be a 271 MB download before the page can
# make a sound. Splitting keeps startup at ~29 MB while still offering the whole
# library: the factory bank is mounted up front so Surge's own browser works
# immediately, and the 3rd-party bank streams in on demand.
REMOTE_BANKS = ["patches_3rdparty"]
REMOTE_NAME = "surge-remote.json"


def collect(bank):
    """
    Query. Every file in one bank, as (archive path, absolute path) pairs.

    The archive path is what the file will be called inside the wasm filesystem,
    relative to Surge's data root -- so it must keep the bank directory in it or
    Surge's scanner will not find anything.

    Args:
        bank (str): directory name under src/data/

    Returns:
        list[tuple[str, Path]]: sorted for a reproducible archive

    Examples:
        >>> # collect("wavetables")[0]
        >>> # ('wavetables/Basic/Sine.wt', PosixPath('/.../src/data/wavetables/Basic/Sine.wt'))
    """
    root = DATA_DIR / bank
    if not root.is_dir():
        return []

    found = []
    for path in sorted(root.rglob("*")):
        if path.is_file():
            found.append((str(path.relative_to(DATA_DIR)), path))
    return found


def main():
    """
    Command. Writes src/data/surge-data.{bin,json}.

    Fails loudly if a bank is missing rather than silently shipping a smaller
    archive -- a half-populated patch list looks like a working site with an
    oddly short list, which is exactly the kind of quiet wrongness that wastes
    an afternoon.
    """
    if not DATA_DIR.is_dir():
        raise SystemExit(f"{DATA_DIR} missing. Run tools/stage_data.sh first.")

    missing = [b for b in BANKS if not (DATA_DIR / b).is_dir()]
    if missing:
        raise SystemExit(
            "Missing banks: " + ", ".join(missing) + "\nRun tools/stage_data.sh first."
        )

    entries = []
    offset = 0
    blob = bytearray()

    for bank in BANKS:
        files = collect(bank)
        print(f"  {bank:20s} {len(files):5d} files")
        for archive_path, real_path in files:
            data = real_path.read_bytes()
            blob += data
            entries.append({"p": archive_path, "o": offset, "n": len(data)})
            offset += len(data)

    if not entries:
        raise SystemExit("Nothing to pack.")

    (DATA_DIR / BIN_NAME).write_bytes(bytes(blob))
    # Compact separators: this index is ~640 entries and is fetched on every
    # page load, so the whitespace is not free.
    (DATA_DIR / INDEX_NAME).write_text(
        json.dumps({"files": entries}, separators=(",", ":"))
    )

    # Manifest of the on-demand banks: paths only, no bytes.
    remote = []
    for bank in REMOTE_BANKS:
        found = [a for a, _ in collect(bank) if a.endswith(".fxp")]
        print(f"  {bank:20s} {len(found):5d} files (fetched on demand)")
        remote += found

    (DATA_DIR / REMOTE_NAME).write_text(
        json.dumps({"files": remote}, separators=(",", ":"))
    )

    print(f"\nWrote {REMOTE_NAME} {len(remote)} on-demand patches, "
          f"{(DATA_DIR / REMOTE_NAME).stat().st_size / 1024:.0f} KiB")
    print(f"Wrote {BIN_NAME}  {len(blob) / 1048576:.1f} MiB")
    print(f"Wrote {INDEX_NAME} {len(entries)} entries, "
          f"{(DATA_DIR / INDEX_NAME).stat().st_size / 1024:.0f} KiB")


if __name__ == "__main__":
    fire.Fire(main)
