#!/usr/bin/env bash
#
# Idempotent environment setup for the Surge XT -> WASM dump.
#
# Installs everything the build needs into the dump itself, so the container
# can reboot and this script recreates the world. Nothing is installed to a
# path outside the dump; nothing here depends on the dump's absolute location.
#
#   ./setup.sh          install everything (safe to re-run)
#   ./setup.sh emsdk    only the Emscripten SDK
#   ./setup.sh surge    only the Surge source clone
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

# Pinned versions. Both are load-bearing:
#   EMSDK 6.0.0 matches the only known-working Surge-under-Emscripten build,
#   so if we hit a toolchain wall we know 6.0.0 is not the reason.
#   SURGE_SHA pins upstream so src/data/ is exactly reproducible.
EMSDK_VERSION="6.0.0"
SURGE_SHA="fae324266aed52d3bd03ef2c7fb68e9098ada961"
SURGE_URL="https://github.com/surge-synthesizer/surge.git"

# Both default to inside the dump, which is what keeps this portable: a fresh
# checkout on any machine runs ./setup.sh and works with no configuration.
#
# The override exists because on some hosts the dump lives on slow network or
# object-backed storage (e.g. this Workbench, where /root is S3-backed), and a
# 23-submodule clone of small files there takes hours. Point these at local
# disk to build fast. They are toolchain/source caches only -- no build output
# and nothing the website needs is stored there, so overriding them never
# affects portability.
EMSDK_DIR="${SURGE_WASM_EMSDK_DIR:-$REPO_ROOT/emsdk}"
SURGE_DIR="${SURGE_WASM_SURGE_DIR:-$REPO_ROOT/vendor/surge}"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

require() {
    command -v "$1" >/dev/null 2>&1 || die "'$1' not found on PATH. Install it and re-run."
}

install_emsdk() {
    require git
    require python3

    if [ ! -d "$EMSDK_DIR/.git" ]; then
        log "Cloning emsdk"
        git clone https://github.com/emscripten-core/emsdk.git "$EMSDK_DIR"
    fi

    # emsdk records the active version in .emscripten; re-running install/activate
    # for an already-active version is cheap, so this stays idempotent.
    log "Installing and activating Emscripten $EMSDK_VERSION (slow on first run)"
    (cd "$EMSDK_DIR" && ./emsdk install "$EMSDK_VERSION" && ./emsdk activate "$EMSDK_VERSION")

    # shellcheck disable=SC1091
    source "$EMSDK_DIR/emsdk_env.sh" >/dev/null 2>&1
    command -v emcc >/dev/null 2>&1 || die "emcc still not on PATH after activating emsdk"
    log "emcc: $(emcc --version | head -1)"
}

install_surge() {
    require git

    if [ ! -d "$SURGE_DIR/.git" ]; then
        log "Cloning Surge XT"
        mkdir -p "$(dirname "$SURGE_DIR")"
        git clone "$SURGE_URL" "$SURGE_DIR"
    fi

    log "Checking out pinned Surge SHA $SURGE_SHA"
    git -C "$SURGE_DIR" fetch --quiet origin "$SURGE_SHA" 2>/dev/null || git -C "$SURGE_DIR" fetch --quiet origin
    git -C "$SURGE_DIR" checkout --quiet "$SURGE_SHA"

    # 23 submodules (JUCE, simde, sst-*, LuaJIT, PEGTL, pffft, ...). Shallow to
    # keep this from being a multi-GB download.
    log "Fetching submodules (23 of them; this is the slow part)"
    git -C "$SURGE_DIR" submodule update --init --recursive --depth 1

    log "Surge at $(git -C "$SURGE_DIR" rev-parse --short HEAD)"
}

main() {
    case "${1:-all}" in
        emsdk) install_emsdk ;;
        surge) install_surge ;;
        all)   install_emsdk; install_surge ;;
        *)     die "Unknown target '$1'. Use: emsdk | surge | all" ;;
    esac

    log "Setup complete."
    cat <<EOF

To use the toolchain in a shell:
    source "$EMSDK_DIR/emsdk_env.sh"

Next: ./build.sh   (not yet written -- see .claude_todo.md Phase 2)
EOF
}

main "$@"
