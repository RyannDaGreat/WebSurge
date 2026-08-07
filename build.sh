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

if [ "${1:-}" = "clean" ]; then
    log "Wiping $BUILD_DIR"
    rm -rf "$BUILD_DIR"
fi

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
CXX_FLAGS="$SIMD_FLAGS -Wno-everything"

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
