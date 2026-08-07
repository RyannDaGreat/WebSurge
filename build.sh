#!/usr/bin/env bash
#
# Build Surge XT's DSP engine to WebAssembly.
#
# Everything -- toolchain, source, build tree, output -- lives inside the dump.
# Run ./setup.sh first.
#
#   ./build.sh            configure (if needed) and build
#   ./build.sh clean      wipe the build tree and reconfigure from scratch
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

EMSDK_DIR="$REPO_ROOT/emsdk"
SURGE_DIR="$REPO_ROOT/vendor/surge"
BUILD_DIR="$REPO_ROOT/build/wasm"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[ -d "$SURGE_DIR/src/common" ] || die "Surge source missing. Run ./setup.sh"
[ -f "$EMSDK_DIR/emsdk_env.sh" ] || die "emsdk missing. Run ./setup.sh"

MODE="${1:-release}"

if [ "$MODE" = "clean" ]; then
    log "Wiping $BUILD_DIR"
    rm -rf "$BUILD_DIR"
    MODE=release
fi

# 'debug' links an unoptimized engine with Emscripten assertions on. Surge aborts
# rather than reporting when something goes wrong during construction, and a
# release link reports only "Aborted(undefined)" with no stack -- useless. This
# target exists so failures are diagnosed from evidence rather than guessed at.
case "$MODE" in
    release) OPT_FLAGS=(-O3);                 OUT_NAME="src/js/surge-engine.js"; EXTRA_LINK=() ;;
    # EXPORT_EXCEPTION_HANDLING_HELPERS gives JS getExceptionMessage(), without
    # which a C++ throw surfaces as an opaque empty "WebAssembly.Exception {}".
    debug)   OPT_FLAGS=(-O0 -g2);             OUT_NAME="build/dbg-engine.js";
             EXTRA_LINK=(-sASSERTIONS=2 -sEXPORT_EXCEPTION_HANDLING_HELPERS=1
                         -sEXPORTED_RUNTIME_METHODS=cwrap,ccall,HEAPF32,HEAPU8,FS,getExceptionMessage) ;;
    *)       die "Unknown mode '$MODE'. Use: release | debug | clean" ;;
esac

# shellcheck disable=SC1091
source "$EMSDK_DIR/emsdk_env.sh" >/dev/null 2>&1
command -v emcc >/dev/null 2>&1 || die "emcc not on PATH after sourcing emsdk_env.sh"

# WASM SIMD. Emscripten maps the SSE intrinsics Surge uses (via simde) onto
# WASM SIMD128, so -msimd128 is what makes the DSP fast rather than scalar.
# -msse4.2 selects the SSE level Emscripten should emulate.
SIMD_FLAGS="-msimd128 -msse4.2"

# -Wno-everything: Surge builds with -Werror on a curated warning set tuned for
# native targets. Emscripten's clang is far newer and emits a large volume of
# unrelated warnings; SURGE_SKIP_WERROR plus this keeps the log readable.
# Exceptions are REQUIRED, not optional. Emscripten defaults to -fignore-exceptions,
# which turns every `throw` into abort(). Surge throws and catches internally during
# SurgeSynthesizer construction (probing for its data path), so a default build
# aborts in sh_init with the unhelpful message "Aborted(undefined)".
#
# -fwasm-exceptions uses the native WebAssembly exception-handling proposal rather
# than the older JS-based emulation (-fexceptions): far lower overhead, which
# matters on an audio thread. Must be passed at compile time for every object AND
# at link, or the build fails with mismatched feature sets.
EXCEPTION_FLAGS="-fwasm-exceptions"

CXX_FLAGS="$SIMD_FLAGS $EXCEPTION_FLAGS -Wno-everything"

if [ ! -f "$BUILD_DIR/build.ninja" ]; then
    log "Configuring (Emscripten)"
    mkdir -p "$BUILD_DIR"

    # Why each of these:
    #   SURGE_SKIP_JUCE_FOR_RACK  Surge's own switch for building the engine with
    #                             no JUCE at all (it exists for VCV Rack). Without
    #                             it CMake builds juceaide, a *native* tool needing
    #                             X11 headers, which has nothing to do with wasm.
    #   SURGE_BUILD_{XT,FX,CLAP}  all JUCE-hosted plugin wrappers; we host it ourselves.
    #   SURGE_BUILD_32BIT_LINUX   wasm32 is a 32-bit target and Surge hard-fails on
    #                             32-bit with FATAL_ERROR. This opts past that gate.
    #   SURGE_SKIP_LUA            LuaJIT cannot target wasm (formula modulators).
    #   ENABLE_LTO=OFF            LTO massively slows link; revisit for release.
    emcmake cmake "$SURGE_DIR" -B "$BUILD_DIR" -G Ninja \
        -DCMAKE_BUILD_TYPE=Release \
        -DSURGE_SKIP_JUCE_FOR_RACK=TRUE \
        -DSURGE_BUILD_XT=OFF \
        -DSURGE_BUILD_FX=OFF \
        -DSURGE_BUILD_CLAP=OFF \
        -DSURGE_BUILD_TESTRUNNER=OFF \
        -DSURGE_SKIP_STANDALONE=TRUE \
        -DSURGE_BUILD_32BIT_LINUX=ON \
        -DSURGE_SKIP_WERROR=TRUE \
        -DSURGE_SKIP_LUA=TRUE \
        -DENABLE_LTO=OFF \
        -DBUILD_TESTING=OFF \
        -DCMAKE_CXX_FLAGS="$CXX_FLAGS" \
        -DCMAKE_C_FLAGS="$CXX_FLAGS"
else
    log "Build tree exists; skipping configure (use './build.sh clean' to redo)"
fi

log "Building surge-common"
cmake --build "$BUILD_DIR" --target surge-common

ARTIFACT="$BUILD_DIR/src/common/libsurge-common.a"
[ -f "$ARTIFACT" ] || die "Expected artifact missing: $ARTIFACT"

log "Built $(du -h "$ARTIFACT" | cut -f1) -> ${ARTIFACT#"$REPO_ROOT"/}"

# ---------------------------------------------------------------------------
# Link our host against the engine
# ---------------------------------------------------------------------------

# Take the include set straight from the generated build system rather than
# duplicating 37 -I flags here. If Surge reorganizes its headers, this follows.
NINJA="$BUILD_DIR/build.ninja"
INCLUDES="$(grep -m1 '^  INCLUDES = .*surge/src/common' "$NINJA" | sed 's/^  INCLUDES = //')"
[ -n "$INCLUDES" ] || die "Could not extract include flags from $NINJA"

# The defines matter as much as the includes: SURGE_COMPILE_BLOCK_SIZE feeds
# globals.h's BLOCK_SIZE, and without it headers like QuadFilterChain.h declare
# arrays of non-constant size and fail to parse. Take the exact set CMake used
# for surge-common so the host and the engine agree on every ABI-affecting macro.
DEFINES="$(awk '/surge-common\.dir\/SurgeSynthesizer\.cpp\.o:/{f=1} f && /^  DEFINES =/{print substr($0,13); exit}' "$NINJA")"
[ -n "$DEFINES" ] || die "Could not extract compile definitions from $NINJA"

# Every static archive CMake produced. surge-common goes first; wasm-ld resolves
# the rest regardless of order, but leading with it keeps the intent obvious.
mapfile -t OTHER_LIBS < <(find "$BUILD_DIR" -name '*.a' ! -name 'libsurge-common.a' | sort)

OUT="$REPO_ROOT/$OUT_NAME"
mkdir -p "$(dirname "$OUT")"

log "Linking host ($MODE) -> $OUT_NAME"

# -sMODULARIZE + EXPORT_NAME: the worklet needs to instantiate this explicitly
#   rather than have it attach to a global.
# -sENVIRONMENT=web,worker,node: AudioWorkletGlobalScope counts as worker. node
#   is included so tools/verify_audio.mjs can render and inspect real samples
#   headlessly -- a compile is not evidence that the synth makes sound.
# -sALLOW_MEMORY_GROWTH: patch and wavetable loading allocates unpredictably.
# -sEXPORTED_RUNTIME_METHODS: cwrap/ccall to call in, HEAPF32 to read rendered
#   audio out, FS to write fetched .fxp bytes in for Surge's own loader.
# -sEXPORTED_FUNCTIONS: malloc/free so JS can own the render scratch buffers;
#   the sh_* entry points are already held by EMSCRIPTEN_KEEPALIVE.
emcc "$REPO_ROOT/host/surge_host.cpp" \
    $DEFINES \
    $INCLUDES \
    $SIMD_FLAGS $EXCEPTION_FLAGS \
    -std=c++20 -fno-char8_t -Wno-everything \
    "${OPT_FLAGS[@]}" \
    "$ARTIFACT" "${OTHER_LIBS[@]}" \
    -o "$OUT" \
    -sMODULARIZE=1 \
    -sEXPORT_NAME=createSurgeEngine \
    -sENVIRONMENT=web,worker,node \
    -sALLOW_MEMORY_GROWTH=1 \
    -sEXPORTED_RUNTIME_METHODS=cwrap,ccall,HEAPF32,HEAPU8,FS \
    -sEXPORTED_FUNCTIONS=_malloc,_free \
    -sSTACK_SIZE=1048576 \
    "${EXTRA_LINK[@]}"
    # EXTRA_LINK goes LAST: emcc lets a later -s override an earlier one, and the
    # debug mode needs to widen EXPORTED_RUNTIME_METHODS set just above.

[ -f "$OUT" ] || die "Link produced no output"
log "Engine: $(du -h "$OUT" | cut -f1) js + $(du -h "${OUT%.js}.wasm" | cut -f1) wasm"
