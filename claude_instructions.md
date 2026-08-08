# Surge XT in the Browser — Project Manifest

## 1. The Problem

[Surge XT](https://surge-synthesizer.github.io/) is a large, mature open-source
hybrid synthesizer (GPLv3, C++, ~200k LOC + 23 submodules). It ships as a
desktop plugin (VST3/AU/CLAP/LV2) and standalone app. It has **no browser
version**.

**Goal:** run the complete Surge XT — engine *and* its real graphical interface
— as a static website, playable from a computer keyboard, with every patch
Surge ships available in a browser patch browser.

**"Complete" is the whole point.** The user's governing instruction is recorded
verbatim in `CLAUDE.md`: *"im not interested in quick hacks. I need the full
thing or nothing."* A working DSP engine driven by a list of raw parameter
sliders is a known, explicitly rejected failure mode — that already exists (see
§7 Prior Art) and is not what this project is.

### Success criteria

1. Surge XT's DSP engine compiled from source to WebAssembly, built by us.
2. Surge's actual classic-skin GUI rendered in the browser — real controls,
   real layout, two-way bound to the engine.
3. Every patch Surge ships (factory + 3rd-party) loadable from a patch browser.
4. `qwertyuiop[]\` and `zxcvbnm,./` play notes.
5. Static site: `python3 -m http.server` in `src/` and it works. No backend.

## 2. Glossary

Read this before anything else. Terms are used throughout without re-explanation.

| Term | Meaning |
| --- | --- |
| **dump** | Self-contained portable project folder under `~/CleanCode/Dumps/`. Nothing inside may depend on its absolute path; nothing outside may reference into it. See root `CLAUDE.md`. |
| **CLAP** | *Clever Audio Plugin* API — the plugin ABI Surge XT exports via `clap_entry`. Cleaner than VST3 and what we target for host↔engine communication. |
| **host** | The small C/C++ layer *we* write that instantiates the Surge CLAP plugin and exposes it to JavaScript. Analogous to a DAW. |
| **side module / MAIN_MODULE** | Emscripten's dynamic-linking model. A *side module* is a `.wasm` loaded at runtime by a *main module* via `dlopen`. Relevant because Surge-as-CLAP is naturally a side module. |
| **classic skin** | Surge's default appearance: 142 SVGs in `resources/classic-skin-svgs/`. |
| **connector** | One `Connector(id, x, y, w, h, Component)` entry in `src/common/SkinModel.cpp`. 130 of them define the entire panel layout. This is how we reproduce the GUI faithfully instead of eyeballing it. |
| **fxp** | Surge's patch file format — a VST2 preset wrapper around Surge's own XML+binary chunk. 
| **wt** | Surge's wavetable format. |
| **AudioWorklet** | Browser API for running audio DSP on the realtime audio thread. Fixed 128-frame render quantum. |
| **simde** | *SIMD everywhere* — header library that maps SSE intrinsics to other targets, including WASM SIMD128. Surge depends on it heavily. |
| **VLM check** | Screenshotting output and having a vision model verify it looks right. Mandatory before claiming any GUI work succeeded. |
| **peer** | Our `WasmComponentPeer` (`host/surge_wasm/`) — the platform layer JUCE expects. Owns an ARGB `juce::Image` that gets blitted to the `<canvas>`. One per top-level window, so an open popup menu is a second peer. |
| **skin** | One of the ten page-chrome looks. A table of 31 Tailwind class strings, NOT a palette — skins differ in layout, type and density. Nothing to do with Surge's own "classic skin". See §12. |
| **region** | One styleable part of the chrome (`toolbar`, `sidebar`, `piano`, …). Every skin defines a class string for all 31. |
| **input mode** | A way of turning intent into notes: computer keyboard, piano roll, notation. One active at a time. See §13. |
| **io** | The `{noteOn, noteOff, allNotesOff, setModeStatus}` object handed to an input mode. Its only channel to make sound. |
| **legend** | The `?` overlay listing every shortcut. Generated from the binding table, so it cannot drift. "Key" as in the key to a map. |
| **startup archive / on-demand bank** | The two patch tiers — 29 MiB fetched up front, 2920 patches fetched on click. See §5. |
| **frenzy** | Ten (or N) parallel subagents on diversified prompts. From the root `CLAUDE.md`; used here for the skins. Scratch output lives in `.frenzy/`, which is gitignored. |

## 3. Architecture

```
Browser main thread                        Audio thread (AudioWorklet)
┌────────────────────────────────────┐    ┌──────────────────────────────┐
│ surge-gui.wasm                     │    │ surge-worklet-bundle.js      │
│  └ SurgeSynthEditor                │    │  └ surge-engine.wasm         │
│     └ SurgeGUIEditor  (Surge's own)│    │     └ SurgeSynthesizer       │
│        └ WasmComponentPeer         │    │        process(128 frames)   │
│           └ juce::Image (ARGB)     │    └───────────────▲──────────────┘
│                  │ compositeInto() │                    │
│                  ▼                 │   postMessage:     │
│            <canvas>  ◄── mouse/key │   setParam, noteOn/Off, loadPatch
│                                    │────────────────────┘
│ Page chrome (Tailwind, 10 skins)   │
│  ├ patch browser   3559 patches    │   Both wasm modules are the SAME
│  ├ input modes     kbd/roll/score  │   Surge build, so parameter indices
│  └ 128-key piano                   │   line up. Each frame the GUI's
└────────────────────────────────────┘   param block is diffed and only
                                          what moved is posted across.
```

The panel is **not drawn by us**. Those are Surge's own pixels, painted by
Surge's paint code through the peer, then blitted. There is no widget layer and
no `layout.json` in the shipped app — an earlier version of this manifest
described one, and that approach was built, rejected and deleted (see §3 below
and `concerns.md`).

### Why this shape

- **Why compile Surge's engine rather than reimplement it?** Surge's sound *is*
  the project. Reimplementation is not on the table.
- **The GUI: port JUCE, do not reimplement it.**

  *An earlier version of this manifest claimed "JUCE has no supported Emscripten
  target" and used that to justify reimplementing the interface in DOM from the
  skin assets. That claim was never tested and is **wrong**. The user's verdict
  on the reimplementation was blunt and correct: it is not the original GUI.*

  Measured facts, from compiling each module for wasm:

  | Module | Errors |
  | --- | --- |
  | `juce_core` | 0 (after `patches/juce-emscripten.patch`) |
  | `juce_events` | 0 |
  | `juce_graphics` | 0 (with `-sUSE_FREETYPE=1`) |
  | `juce_gui_basics` | 4, all missing *platform* types |

  JUCE 8.0.12 already defines `JUCE_WASM` and ships
  `juce_core/native/juce_SystemStats_wasm.cpp`. Upstream's wasm target is
  **incomplete, not absent**.

  JUCE rasterizes in software (`LowLevelGraphicsSoftwareRenderer`), so Surge's
  GUI needs no OpenGL and no X11 to draw. The only missing piece is a
  `ComponentPeer`: give `SurgeGUIEditor` a pixel buffer to paint into, blit it to
  a `<canvas>`, and feed mouse/key events back. Those are Surge's own pixels —
  real fonts, real menus, real LFO display, real hover states.

  Prior art that this is viable: [Dreamtonics/juce_emscripten](https://github.com/Dreamtonics/juce_emscripten)
  shipped a commercial product (Synthesizer V) this way, on a much older JUCE.
- **Why CLAP rather than Surge's C++ classes directly?** `SurgeSynthesizer` is
  usable directly, but the CLAP surface already solves parameter enumeration,
  state save/load (which is how patches load), and event handling in a stable,
  documented way. Patch loading via `clap_plugin_state` avoids reimplementing
  Surge's patch streaming.
- **Why AudioWorklet?** It is the only way to get glitch-free audio on the
  realtime thread. Note the known constraint: `AudioWorkletGlobalScope` has no
  `await`/dynamic import, so the `.wasm` must be fetched on the main thread and
  transferred to the worklet over its `messagePort`.

## 4. Key paths

### Running it

```sh
./setup.sh                        # emsdk 6.0.0 + Surge at the pinned SHA + vendor patches
./build.sh                        # engine  -> src/js/surge-engine.{js,wasm} + worklet bundle
./build_gui.sh                    # the GUI -> src/js/surge-gui.{js,wasm}   (incremental)
./tools/stage_data.sh             # ~469 MB of patches/wavetables into src/data/
uv run tools/pack_data.py         # surge-data.{bin,json} + surge-remote.json
node .frenzy/build_themes.mjs     # src/js/themes.js from the skin definitions
./run_server.sh                   # serve src/ over HTTPS; prints localhost + LAN URL
```

`build_gui.sh` is incremental — it skips any object newer than its source, so a
one-file change is one translation unit plus the link, not 75.

Verification (never skip these — a compile is not evidence of sound):

```sh
node tools/verify_audio.mjs       # renders 2s headlessly, measures pitch/envelope
node tools/browser_test.mjs       # real Chrome: engine, GUI, patches, keyboard
node tools/skin_shots.mjs         # screenshots every skin + reports COMPUTED style
node .frenzy/input_test.mjs       # the three input modes, shortcuts, legend
node .frenzy/lazy_test.mjs        # 3559 patches listed, on-demand patch loads
node .frenzy/live_test.mjs        # the same, against the DEPLOYED site
```

`skin_shots.mjs` reports computed style rather than class attributes on purpose:
Tailwind's browser build ignores a class it cannot parse **without any error**,
so a skin can be perfect in the file and render as nothing.

| Path | What |
| --- | --- |
| `src/` | The static website. This is the deliverable. |
| `index.html` (repo root) | Redirect to `src/`. Pages publishes the repo ROOT from a branch and can only serve the root or `/docs`, so the site needs a door there. |
| `docs/screenshot.png` | The README image. |
| `src/data/surge-data.{bin,json}` | The startup archive: factory patches + wavetables, 29 MiB. **Committed.** |
| `src/data/surge-remote.json` | Paths of the 2920 on-demand patches, 152 KiB. **Committed.** |
| `src/data/patches_3rdparty/` | The on-demand bank, 241 MB of loose `.fxp`. **Committed** — see §5. |
| `src/data/` (everything else) | Staged resources. **gitignored** — regenerate with `tools/stage_data.sh`. |
| `src/skin/` | The 142 classic-skin SVGs. |
| `src/js/input/` | The note-input modes, shortcut table and legend. See §13. |
| `src/js/themes.js` | **Generated.** The ten skins. See §12. |
| `src/vendor/` | Pinned third-party browser libraries: Tailwind 4.3.3 (275 KB), abcjs 6.4.4 (472 KB). Vendored, not hot-linked, so the dump works offline. |
| `src/js/surge-{engine,gui}.{js,wasm}` | Our Emscripten build output. **Committed** — Pages serves them directly. |
| `vendor/surge/` | Upstream Surge clone at the pinned SHA. **gitignored** — `setup.sh` clones it. |
| `emsdk/` | Emscripten 6.0.0. **gitignored** — `setup.sh` installs it. |
| `tools/` | Build-time generators (layout extraction, patch indexing, data staging). |
| `build/` | CMake build tree. gitignored. |

**Portability:** this dump is portable. Everything absolute is regenerated by
`setup.sh` from pinned upstream SHAs. Nothing references an absolute path
outside the dump. The one deliberate exception permitted by the root CLAUDE.md
(`/models/`) is not used here.

### Pinned versions

- Surge: `fae324266aed52d3bd03ef2c7fb68e9098ada961` (2026-08-05)
- Emscripten: `6.0.0`

## 5. Resource inventory (measured, from the pinned clone)

| Bank | Size | Count |
| --- | --- | --- |
| `patches_factory` | 24 MB | 639 `.fxp` |
| `patches_3rdparty` | 246 MB | — |
| `wavetables` (factory) | 6.8 MB | — |
| `wavetables_3rdparty` | 165 MB | — |
| `impulses_factory` / `_3rdparty` | 19 MB / 17 MB | reverb IRs |
| `fx_presets`, `modulator_presets`, `tuning_library` | 1.3 / 0.44 / 2.3 MB | — |

**Decision (user, 2026-08-07, restated 2026-08-08):** ship *everything* —
factory **and** 3rd-party. "ALSO WHY ONLY FACTORY PATCHES :( i want ALL the
patches."

**How that is actually delivered — two tiers, and the reason matters:**

| Tier | Contents | Arrives |
| --- | --- | --- |
| Startup archive | 639 factory patches + 203 wavetables, 29 MiB | one fetch, before the synth exists |
| On demand | 2920 3rd-party patches, 241 MB as loose files | when the user picks one |

The split is forced by `SurgeStorage`, which scans a directory **in its
constructor** to build its patch list. Anything Surge's own browser and jog
buttons must see has to be on the filesystem before the synth is constructed —
so the factory bank cannot be lazy. But all 3559 in one archive would be a
271 MB download before the first note, which is not a usable page.

The sidebar lists all 3559 either way. Only the bytes are deferred. A remote
patch is written into **both** wasm filesystems before either Surge is asked for
it, since the engine loads by path exactly as the GUI does.

`wavetables_3rdparty` (165 MB) is still excluded. Nothing in the shipped patch
set references it; if that changes it joins the on-demand tier.

## 6. Known technical risks

Recorded up front so they are not rediscovered painfully. See `concerns.md` for
what actually happened.

1. **32-bit alignment.** Surge fails to build on 32-bit ARM with
   `requested alignment 16 is larger than 8` in `QuadFilterUnit_Impl.h` and
   Spring Reverb. `wasm32` is also 32-bit — expect the same class of failure.
   Contingency: patch alignment attributes, or build with `MEMORY64`.
2. **SIMD.** Surge leans on SSE via simde. Target `-msimd128 -msse4.2` so
   Emscripten maps SSE→WASM SIMD128; scalar fallback is the slow contingency.
3. **Dependencies to strip.** Surge can build without Airwindows, SQLite and
   MTS-ESP. SQLite backs the patch database (`SurgePatches.db`) — we build the
   patch index ourselves at build time instead.
4. **LuaJIT** (formula modulators/wavetable scripts) will not target WASM.
   Contingency: build with Lua disabled, or swap to plain Lua.
5. **Threads.** Surge spawns threads (patch DB, wavetable loading).
   `-pthread` in WASM requires `SharedArrayBuffer`, which requires COOP/COEP
   headers — hostile to "just open the static site". Prefer a single-threaded
   build.
6. **Resource loading.** `configuration.xml` and `windows.wt` are compiled into
   the binary and load *from memory* (confirmed by strings in the reference
   build), so the engine boots with no filesystem. Everything else needs to be
   fed in from JS.

## 7. Prior art

- **`https://ectcetera.net/tools/surge`** — an existing Surge XT WASM demo.
  Hosts `surge-xt.clap.wasm` (6.4 MB side module, `dylink.0`, Emscripten 6.0.0)
  through a `demo-host.js` main module (532 KB glue + 1.4 MB wasm). Its host
  exposes only 14 functions (`sh_load`, `sh_param_*`, `sh_note`, `sh_midi`,
  `sh_render`, `sh_poll`, …). **It has no GUI** — just a searchable list of
  parameter sliders — and no patch API. No source published (404 on the
  obvious paths).
  **Use:** reference and oracle only. Per `CLAUDE.md` its binary must never be
  shipped in `src/`. It is useful for A/B-checking our own engine's output and
  for confirming that a Surge CLAP build under Emscripten 6.0.0 is achievable
  at all — which it evidently is.
- No official or other community Surge WASM port found.

## 8. Keyboard mapping (user spec)

User's words: *"qwertyuiop[]\ and zxcvbnm,./ to be major notes on my keyboard"*.

Interpretation: those two rows are the **naturals** (white keys) — a diatonic
run, not a chromatic one. Sharps/flats sit on the row *above* each natural row,
at piano-correct positions (i.e. a gap where E–F and B–C have no black key).

- `zxcvbnm,./` → 10 naturals from C3
- `sdfghjkl;'` → the corresponding sharps, gapped like a piano
- `qwertyuiop[]\` → 13 naturals from C4
- `1234567890-=` → the corresponding sharps, gapped like a piano

Requirements: ignore key auto-repeat, note-off on keyup, octave shift, velocity
control, and no stuck notes when the window loses focus. All met, in
`src/js/keyboard.js`.

**Assumption flagged:** "major notes" is read as *naturals/white keys*. If it
meant "notes of a specific major scale", only the mapping table changes.

### The shortcut space is nearly full

Worth stating because it constrains every future binding. The note layout claims
all four letter rows, the digits `1234567890-=`, AND the arrow keys (octave and
velocity). What is left:

- `PageUp` / `PageDown`, `Escape`, `F1`, `?`
- anything with **ctrl**, **meta** or **alt** — free by construction, because
  `keyboard.js` returns immediately when one is held

Current bindings live in `src/js/input/bindings.js` and are the single source
for both the dispatcher and the legend:

| Chord | Action |
| --- | --- |
| `PageDown` / `PageUp` | next / previous patch |
| `shift` + those | next / previous category |
| `Ctrl+R` | random patch |
| `Escape` | close what is open, else panic (all notes off) |
| `Ctrl+1/2/3` | keyboard / piano roll / notation |
| `?` or `F1` | the legend |
| `Space` | play-stop, contributed by whichever mode is mounted |

## 9. Development philosophy

Inherited from the global CLAUDE.md; the load-bearing ones here:

- **Manifest-first.** Update this file before changing code.
- **No silent fallbacks, ever.** A missing patch or wavetable fails loudly.
  Silence in a synthesizer is an especially treacherous failure mode: it looks
  identical to "quiet patch". Never let a load failure render as silence.
- **Verify for real.** Audio: render and inspect the samples. GUI: screenshot
  and VLM-check. "It compiled" proves nothing.
- Pure functions, labeled per CQS. einops-style dimension names where tensors
  appear. No magic numbers.

## 10. Backburner

- **Timestamped event queue in the worklet.** The blocker for real sequencing.
  Note events currently carry no time and are played on arrival, so the piano
  roll and the notation editor are audibly loose. Fix: messages carry a target
  frame; `process()` drains what is due in the coming 128 samples. Block-
  quantised (2.7 ms) first — sample-accurate only if that proves audible.
- Web MIDI input. Cheap: `app.io.noteOn/noteOff` is already the single seam and
  live notes need no scheduling.
- Pitch bend, mod wheel and macro knobs — see §15.
- Preset save back to disk (browser download).
- `SharedArrayBuffer` + threaded build if single-threaded DSP proves too slow.
  Blocked on Pages: branch-published sites cannot set COOP/COEP headers.
- Microtuning UI (Surge's tuning library ships in the data set).

## 11. Status

Deployed and working at **https://ryanndagreat.github.io/WebSurge/**.

Engine, real GUI, 3559 patches, 203 wavetables, 10 skins, 3 input modes.
See `.claude_todo.md` for the live task list and `concerns.md` for history.

## 12. Deployment

Live at **https://ryanndagreat.github.io/WebSurge/**, published by GitHub Pages
from the `master` branch, repo ROOT.

Two consequences worth knowing before changing anything here:

- **The root must have an `index.html`.** Branch-published Pages serves only the
  repo root or `/docs`, and the site lives in `src/`. The root `index.html` is a
  redirect. A copy would be two files to keep in step; they would diverge.
- **No custom headers.** This rules out COOP/COEP, and therefore
  `SharedArrayBuffer`, and therefore the threaded build and unifying the two
  Surge instances. It is the reason that item is on the backburner rather than
  in progress.

A GitHub Actions workflow was added and then deleted: the repo already had a
branch build configured, and two publishers racing for the same site is worse
than either alone.

## 13. Skins

Ten of them, in `src/js/themes.js`, which is **generated** — edit
`.frenzy/skin_*.js` and re-run `node .frenzy/build_themes.mjs`.

A skin is not a palette. Each is a table of 31 Tailwind class strings, one per
REGION of the page chrome, and applying it rewrites that region's `class`
attribute outright. That is why skins differ in **layout** — Brutalist and Paper
put the sidebar on the right — and not only in hue. There is no stylesheet to
override because there is no stylesheet: `src/css/surge.css` was deleted,
398 lines to 0.

    class = MARKERS[region] + BASE[region] + skin.classes[region] + sticky

`BASE` is layout plumbing a skin must not break. `MARKERS` are the class names
other modules query by (`patches.js` finds rows with `.patch`), so dressing an
element cannot break the code that finds it. `sticky` is runtime state
(`selected`, `held`, `indeterminate`) re-applied last, which skins style through
the arbitrary variant `[&.selected]:…`.

**Do not remove `@import "tailwindcss"` from index.html.** It looks redundant —
the browser build contains Tailwind — but without it the runtime emits no base
and no utilities, and every skin falls back to Times New Roman on transparent.
Measured, 2026-08-08. Its cost is one 404 for `/tailwindcss` per page load
before the runtime falls back to its bundled copy; that request is root-relative
so a project Pages site cannot satisfy it. Noise, not breakage.

## 14. Input modes

`src/js/input/`. One mounted at a time, chosen from the toolbar or `Ctrl+1/2/3`.

A mode is `{id, label, hint, async mount(container, io) -> {destroy, shortcuts?}}`.
`io` — `{noteOn, noteOff, allNotesOff, setModeStatus}` — is the **only** channel
a mode has to make sound. Modes never touch the synth, the worklet or the piano.
Adding one requires no change anywhere else.

**Teardown is enforced**: `mount` must return a `destroy()` or the registry
throws. Not ceremony — `attachKeyboard()` had always returned a `destroy()` that
the app discarded, and `createPiano()` leaked a `window` blur listener. Either
would mean two input sources firing after a switch, notes stuck on, no error.

`mount` is async so a mode can `import()` a heavy dependency on first use rather
than at page load; the notation mode pulls in 472 KB of abcjs that way.

Both the roll and the notation editor are **not sequencers** and must not be
described as such — see the Backburner entry above.

## 15. Macros and MIDI controllers (not yet wired)

Surge already has per-patch assignable knobs: **8 Macros**, renamed by each
patch (a loaded patch shows "How Messy?", "Ring Mod" and so on), plus Pitch
Bend, Mod Wheel, Channel/Poly Aftertouch, Breath, Expression, Sustain, Timbre,
Velocity, Keytrack and the LFOs. They are all visible in the modulation row of
the panel, and because mouse events are forwarded to Surge's real editor they
are **already draggable today**.

What is missing is only the chrome and the plumbing:
`surge-worklet.js` already handles `pitchBend` and `cc` message types — nothing
has ever sent them.
Current phase: **scaffolding + toolchain**. No engine built yet.
