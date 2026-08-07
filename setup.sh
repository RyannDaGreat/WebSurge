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

# Everything lives inside the dump. No env overrides, no escape hatches.
#
# An earlier version of this script let these be pointed at /var/tmp "just for
# speed" because /root is S3-backed on this host. That was wrong: the dump rule
# is that Claude works strictly inside the dump, and portability is
# non-negotiable. A build tree outside the dump is a build nobody else can
# reproduce. If this storage is slow, it is slow -- correctness first.
EMSDK_DIR="$REPO_ROOT/emsdk"
SURGE_DIR="$REPO_ROOT/vendor/surge"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

require() {
    command -v "$1" >/dev/null 2>&1 || die "'$1' not found on PATH. Install it and re-run."
}

# JUCE's CMake builds `juceaide`, a NATIVE helper tool, to embed Surge's fonts
# and skin SVGs as binary data. Being native, it links against real X11/font
# libraries even though our actual target is WebAssembly -- so these headers are
# needed on the build machine and have nothing to do with the wasm output.
#
# Without them the build dies with "X11/extensions/Xrandr.h: No such file",
# which is deeply confusing when you are cross-compiling to a browser.
APT_BUILD_DEPS=(
    libxrandr-dev libxinerama-dev libxcursor-dev libxcomposite-dev
    libasound2-dev libfreetype6-dev libfontconfig1-dev libgl1-mesa-dev
)

install_system_deps() {
    # Skip quickly when they are already present; apt-get update is slow.
    if [ -f /usr/include/X11/extensions/Xrandr.h ] && [ -f /usr/include/freetype2/ft2build.h ]; then
        log "System build dependencies already present"
        return
    fi

    command -v apt-get >/dev/null 2>&1 || die \
        "Need these packages for JUCE's native juceaide tool, and apt-get is not available: ${APT_BUILD_DEPS[*]}"

    log "Installing native build dependencies for juceaide"
    apt-get update -qq
    apt-get install -y -qq "${APT_BUILD_DEPS[@]}"
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

    apply_patches
}

# Surge and its submodules have no Emscripten target upstream, so a few platform
# files need WASM branches. Those live in patches/ INSIDE the dump -- never as
# loose edits in the clone -- so a fresh machine reproduces the build exactly.
#
# Idempotent: each patch is checked with --reverse before being applied, so
# re-running setup.sh on an already-patched tree is a no-op rather than an error.
apply_patches() {
    shopt -s nullglob
    local patches=("$REPO_ROOT/patches"/*.patch)
    shopt -u nullglob

    if [ ${#patches[@]} -eq 0 ]; then
        log "No patches to apply"
        return
    fi

    log "Applying ${#patches[@]} patch(es) to the Surge tree"
    for p in "${patches[@]}"; do
        # Each patch names the submodule it targets on its first line as
        #   # target: <path relative to the Surge checkout>
        local target
        target="$(sed -n 's/^# target: //p' "$p" | head -1)"
        [ -n "$target" ] || die "Patch '$p' has no '# target:' line."

        local dir="$SURGE_DIR/$target"
        [ -d "$dir" ] || die "Patch target '$dir' does not exist."

        if git -C "$dir" apply --reverse --check "$p" 2>/dev/null; then
            echo "  already applied: $(basename "$p")"
        elif git -C "$dir" apply --check "$p" 2>/dev/null; then
            git -C "$dir" apply "$p"
            echo "  applied: $(basename "$p")"
        else
            die "Patch '$(basename "$p")' does not apply cleanly to $dir. The pinned Surge SHA may have moved."
        fi
    done
}

main() {
    case "${1:-all}" in
        deps)    install_system_deps ;;
        emsdk)   install_emsdk ;;
        surge)   install_surge ;;
        patches) apply_patches ;;
        all)     install_system_deps; install_emsdk; install_surge ;;
        *)       die "Unknown target '$1'. Use: deps | emsdk | surge | patches | all" ;;
    esac

    log "Setup complete."
    cat <<EOF

To use the toolchain in a shell:
    source "$EMSDK_DIR/emsdk_env.sh"

Next: ./build.sh   (not yet written -- see .claude_todo.md Phase 2)
EOF
}

main "$@"
