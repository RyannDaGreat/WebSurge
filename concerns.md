# Concerns — Historical Record

Append-only. Never delete. This is how the project got here, including wrong
turns. The manifest says what the project *is*; this says what happened.

---

## 2026-08-07 — Session 1: recon and scaffolding

### Starting state
`Dumps/Surge/` was **empty** and **not its own git repo** — `git rev-parse
--show-toplevel` returned `/root/CleanCode`, so it was being tracked by the
parent repo. Flagged to the user, then `git init`-ed once work began, per the
dump rule that every dump is a git repo.

### What was investigated

**Does a Surge WASM port already exist?** Two web searches found none —
no official port, no community port indexed. Then the user supplied
`https://ectcetera.net/tools/surge`, which *is* one.

**What that demo actually is** (probed by downloading its assets):

| File | Size | Notes |
| --- | --- | --- |
| `demo-host.js` | 532 KB | Emscripten glue, MAIN_MODULE |
| `demo-host.wasm` | 1.4 MB | the host |
| `surge-xt.clap.wasm` | 6.4 MB | Surge XT as a CLAP **side module** (`dylink.0`) |

Its host exposes exactly 14 C functions: `sh_load`, `sh_plugin_name`,
`sh_start`, `sh_param_count`, `sh_param_id`, `sh_param_name`,
`sh_param_module`, `sh_param_value`, `sh_param_text`, `sh_set_param`,
`sh_note`, `sh_midi`, `sh_render`, `sh_poll`.

The HTML comment in its source states it plainly: *"hosts the surge-xt.clap.wasm
side module through the demo-host main module and drives it with a
dependency-free UI."*

**Its UI is a searchable list of parameter sliders plus note buttons.** No
Surge panel. The user confirmed independently: *"(they have no GUI)"*.

No source published — 404 on `/tools/README.md`, `/tools/demo-host.c`,
directory index.

### Findings that shape the build

- **Emscripten 6.0.0**, side module with a `dylink.0` section. Establishes that
  a Surge CLAP build under Emscripten *is* achievable — valuable proof, since
  no documentation for it exists anywhere.
- **`configuration.xml` and `windows.wt` load from memory**, not disk. Confirmed
  by strings in the binary: *"Cannot parse 'configuration.xml' from memory! This
  means that Surge XT was incorrectly built from source code"*. So the engine
  boots with no filesystem mounted.
- **Factory patches are NOT in the 6.4 MB binary.** 639 `.fxp` files alone are
  24 MB. They must be supplied from JS.
- `/SurgeXTData` appears as a string in the binary — the expected data root.

### Upstream inventory (Surge @ `fae3242`, 2026-08-05, shallow clone)

- 639 factory `.fxp` patches (24 MB); 3rd-party bank 246 MB.
- Wavetables 6.8 MB factory / 165 MB 3rd-party. Impulses 36 MB.
- **142 classic-skin SVGs** in `resources/classic-skin-svgs/`.
- **130 `Connector(id, x, y, w, h, Component)` entries** in
  `src/common/SkinModel.cpp`, e.g.
  `Connector("global.active_scene", 7, 12, 40, 42, Components::MultiSwitch)`.
  182 `Component` references.
- 23 submodules (JUCE, simde, sst-*, LuaJIT, PEGTL, pffft, …).

**This is the key GUI insight:** Surge's layout is *data* and its artwork is
*data*. The real GUI can be reproduced faithfully — same coordinates, same
SVGs — without porting JUCE. That converts "port a JUCE GUI to WASM"
(intractable) into "generate a layout table and render SVGs" (tractable).

### Decisions

1. **Build Surge from source ourselves; do not ship the third-party binary.**
   Offered the user three engine strategies (reuse / build / reuse-then-build).
   User: *"im not interested in quick hacks. I need the full thing or nothing.
   Write that down in a local claudemd."* → written to `CLAUDE.md` as the
   project's governing rule. The ectcetera binary is demoted to
   reference/oracle and is barred from `src/`.
2. **Ship all patches** — factory + 3rd-party, ~270 MB of patches, ~480 MB of
   resources total. User picked this explicitly over the lighter options.
3. **Gitignore `src/data/`.** Regenerable from the pinned SHA via
   `tools/stage_data.sh`. Keeps the dump's git history sane and avoids heavy
   writes to `/root/`, which is S3-backed and slow. *Flagged as a judgement
   call — if the user wants a fully self-contained checkout, this reverses.*

### Mistakes / corrections this session

- **Assumed the dump would already be a git repo.** It was not. Checked
  neighbouring dumps to confirm the convention (`MakoTUI` and `GeminiCaptioner`
  are their own repos; `DailiesExplore` is not) before acting.
- **Initial web searches concluded "no WASM port exists".** That conclusion was
  wrong — the user had one. Lesson: absence of indexed search results is weak
  evidence about niche audio tooling; ask before concluding nothing exists.

### Open risks going into the build

Enumerated in manifest §6. The one most likely to bite first: **`wasm32` is a
32-bit target and Surge already fails on 32-bit ARM** with
`requested alignment 16 is larger than 8` in `QuadFilterUnit_Impl.h`. Expect to
hit it. Second most likely: **LuaJIT** cannot target WASM.

### Toolchain + layout extraction (same session, later)

**emsdk 6.0.0 installed and verified** (`afa15e0c`), Surge cloned at the pinned
SHA with all 23 submodules (240 MB of `libs/`).

**Storage decision.** `/root` is S3-backed on this Workbench and a
23-submodule small-file clone there is pathologically slow. `setup.sh` grew two
env overrides — `SURGE_WASM_EMSDK_DIR`, `SURGE_WASM_SURGE_DIR` — defaulting to
inside the dump so a fresh checkout stays zero-config, but pointable at local
disk (`/var/tmp/surge-wasm-cache`) here. They hold only toolchain/source
caches, never build output or anything the website needs, so portability is
untouched.

**Layout extraction — approach changed mid-task, for the better.** The initial
plan was `tools/gen_layout.py` regex-parsing `SkinModel.cpp`. Rejected on
inspection: coordinates are sometimes parent-relative (`.inParent("osc.param.
panel")`), style arrives via chained modifiers (`.asHorizontal().asWhite()`),
and one helper (`withHSwitch2Properties`) silently expands into four separate
properties. A regex would have produced plausible-looking wrong coordinates —
the worst failure mode, because it looks fine until controls are subtly
misplaced.

Instead `tools/dump_layout.cpp` links Surge's *own* registry
(`Connector::allConnectorIDs()` / `connectorByID()`, which exist in
`SkinModelImpl.cpp`) and dumps JSON. The C++ remains the source of truth and
this survives upstream changes.

Build deps turned out to be tiny: `SkinModel.cpp` + `SkinModelImpl.cpp` +
`strnatcmp.cpp`, three include dirs, no JUCE. Compiles in about a second.

**Result: 172 connectors** — notably *more* than the 130 an earlier `grep`
counted, because grep missed multi-line definitions. Concrete evidence that the
parse-by-hand route would have silently dropped ~40 controls.

Also confirmed: `BACKGROUND: N` in a connector maps to `bmp00N.svg`. All 38
referenced ids resolve; `gen_layout.sh` now hard-fails if any asset is missing,
since a missing SVG would otherwise render as a blank rectangle — a silent
failure this project forbids.

### Not yet verified (do not assume any of this works)

- That Surge compiles under Emscripten 6.0.0 *for us*.
- That `SkinModel.cpp` connectors are sufficient to place every control —
  some may be positioned in skin XML or in code instead.
- That `.fxp` payloads can be fed to `clap_plugin_state.load` unmodified.
- Any audio has been produced. None has.
