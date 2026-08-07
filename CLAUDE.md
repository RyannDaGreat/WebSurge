# Surge XT → WASM — Local Project Rules

These are project-specific rules. They stack on top of `~/.claude/CLAUDE.md` and
`/root/CleanCode/CLAUDE.md`. Where they conflict, the stricter rule wins.

## !!! NO QUICK HACKS — THE FULL THING OR NOTHING !!!

**Stated by the user, 2026-08-07, verbatim:**

> "im not interested in quick hacks. I need the full thing or nothing."

This is the governing principle of this project. Concretely:

- **Build Surge XT from source to WASM ourselves.** Do NOT reuse
  `ectcetera.net/tools/surge-xt.clap.wasm` or any other prebuilt third-party
  binary as the shipped engine. That binary is a reference/oracle for
  comparison ONLY, and must never end up in `src/`.
- **The real GUI, not a parameter list.** The deliverable is Surge's actual
  panel — the classic skin, its real controls, its real layout. A list of
  sliders is exactly the failure mode the user rejected. If a control exists in
  desktop Surge XT, it exists here.
- **All patches means all patches.** Factory *and* 3rd-party, everything Surge
  ships. Not a curated subset.
- **No "phase 1 / good enough for now" substitutes.** Partial progress is fine
  and expected; *shipping a substitute and calling it done* is not. If
  something is incomplete, say so plainly and keep going.
- When a shortcut is tempting, the answer is to do the harder correct thing.

## Corollaries

- No silent degradation. If a wavetable, patch, or FX fails to load, it must
  fail loudly and visibly — never render silence and pretend success.
- Verify audio output for real. "It compiled" is not evidence of sound; capture
  rendered audio and inspect it.
- Verify the GUI for real. Screenshot it and check with the VLM before ever
  claiming a control works.

## Project facts

- Surge upstream pinned at `fae324266aed52d3bd03ef2c7fb68e9098ada961`
  (2026-08-05, "Reset FX control types before unstreaming a patch (#8514)").
- Emscripten pinned to **6.0.0**.
- Surge XT is **GPLv3**. Anything we ship is GPLv3 and must carry source.

## Glossary

- **dump** — a self-contained, portable project folder under `~/CleanCode/Dumps/`.
  See the root CLAUDE.md; nothing here may depend on its absolute path.
- **CLAP** — Clever Audio Plugin API; the plugin ABI Surge XT exports.
- **side module / MAIN_MODULE** — Emscripten's dynamic linking model. A side
  module is a `.wasm` loaded at runtime via `dlopen` by a main module.
- **classic skin** — Surge's default look, 142 SVGs in
  `resources/classic-skin-svgs/`, positioned by `src/common/SkinModel.cpp`.
- **connector** — one entry in `SkinModel.cpp` giving a control's id, x, y, w, h
  and component type. 130 of them define the panel layout.
- **fxp** — Surge's patch file format (a VST2 preset wrapper around Surge's own
  XML+binary chunk).
