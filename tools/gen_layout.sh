#!/usr/bin/env bash
#
# Regenerate src/layout.json and src/skin/ from the pinned Surge source.
#
# layout.json is produced by compiling and running tools/dump_layout.cpp, which
# links Surge's own SkinModel registry -- see that file for why we do not parse
# the C++ by hand. src/skin/ is the classic-skin SVG set the layout refers to
# by numeric BACKGROUND id (id N -> bmp00N.svg).
#
# Both outputs are committed to git (small, and they are the GUI). Re-run this
# after bumping the pinned Surge SHA.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

SURGE_DIR="$REPO_ROOT/vendor/surge"
SVG_DIR="$SURGE_DIR/resources/classic-skin-svgs"

log() { printf '\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[ -d "$SURGE_DIR/src/common" ] || die "Surge source not at '$SURGE_DIR'. Run ./setup.sh first."
[ -d "$SVG_DIR" ] || die "Classic skin SVGs not at '$SVG_DIR'."

mkdir -p build src/skin

log "Compiling dump_layout"
# SkinModel.cpp holds the connector data; SkinModelImpl.cpp holds the registry
# implementation; strnatcmp is SkinModelImpl's only outside dependency.
g++ -std=c++17 -O1 -o build/dump_layout \
    tools/dump_layout.cpp \
    "$SURGE_DIR/src/common/SkinModel.cpp" \
    "$SURGE_DIR/src/common/SkinModelImpl.cpp" \
    "$SURGE_DIR/libs/sst/sst-plugininfra/libs/strnatcmp/strnatcmp.cpp" \
    -I"$SURGE_DIR/src/common" \
    -I"$SURGE_DIR/src" \
    -I"$SURGE_DIR/libs/sst/sst-plugininfra/libs/strnatcmp"

log "Generating src/layout.json"
./build/dump_layout > src/layout.json

log "Staging classic skin SVGs"
cp "$SVG_DIR"/*.svg src/skin/

# Every BACKGROUND id the layout references must have a matching SVG, or a
# control will silently render as a blank rectangle -- exactly the kind of
# quiet failure this project forbids. Fail the build instead.
log "Verifying every referenced asset exists"
missing=0
for id in $(grep -oE '"BACKGROUND": "[0-9]+"' src/layout.json | grep -oE '[0-9]+' | sort -un); do
    if [ ! -f "src/skin/bmp00$id.svg" ]; then
        echo "  MISSING: bmp00$id.svg (referenced by layout.json)" >&2
        missing=$((missing + 1))
    fi
done
[ "$missing" -eq 0 ] || die "$missing referenced skin asset(s) missing."

log "Done: $(grep -c '"id":' src/layout.json) connectors, $(ls src/skin/*.svg | wc -l) SVGs"
