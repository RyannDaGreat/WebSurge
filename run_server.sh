#!/usr/bin/env bash
#
# Serve the Surge XT WASM site.
#
# WebAssembly cannot be fetched from a file:// URL, so the site has to go over
# HTTP even locally. This serves src/ -- which is the entire deliverable; there
# is no backend and no build step at request time.
#
#   ./run_server.sh              serve on http://localhost:8080
#   ./run_server.sh 9000         serve on a different port
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

PORT="${1:-8080}"
WEB_ROOT="$REPO_ROOT/src"

log() { printf '\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# Fail loudly and specifically rather than serving a page that half-works. Each
# of these has a different fix, so they are checked separately.
[ -f "$WEB_ROOT/index.html" ] || die "src/index.html missing -- is this the right directory?"

[ -f "$WEB_ROOT/js/surge-engine.wasm" ] \
    || die "Engine not built. Run ./setup.sh then ./build.sh"

[ -f "$WEB_ROOT/js/surge-worklet-bundle.js" ] \
    || die "Worklet bundle missing. Run ./build.sh"

[ -f "$WEB_ROOT/layout.json" ] \
    || die "layout.json missing. Run ./tools/gen_layout.sh"

if [ ! -f "$WEB_ROOT/data/patches.json" ]; then
    die "Patch index missing. Run ./tools/stage_data.sh then: uv run tools/gen_patch_index.py"
fi

PATCH_COUNT=$(grep -o '"name"' "$WEB_ROOT/data/patches.json" | wc -l)

# Query. Best-guess LAN address of this machine, or empty if it cannot be found.
#
# `ip route get` is the reliable one: it asks the kernel which source address
# would be used to reach the outside world, so it picks the right interface on a
# machine with several (docker0, veth, tun...). `hostname -I` is the fallback and
# just returns the first address, which is usually but not always right.
lan_ip() {
    if command -v ip >/dev/null 2>&1; then
        ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}'
    elif command -v hostname >/dev/null 2>&1; then
        hostname -I 2>/dev/null | awk '{print $1}'
    fi
}

IP="$(lan_ip || true)"

log "Serving $WEB_ROOT"
log "  engine   $(du -h "$WEB_ROOT/js/surge-engine.wasm" | cut -f1)"
log "  patches  $PATCH_COUNT"
log "  data     $(du -sh "$WEB_ROOT/data" 2>/dev/null | cut -f1)"
echo
printf '\033[1;32m   local   http://localhost:%s\033[0m\n' "$PORT"
if [ -n "$IP" ]; then
    printf '\033[1;32m   LAN     http://%s:%s\033[0m\n' "$IP" "$PORT"
else
    printf '\033[1;33m   LAN     (could not determine an address)\033[0m\n'
fi
echo
echo "Click 'Start audio', then play with zxcvbnm,./ and qwertyuiop[]\\"
echo "Ctrl-C to stop."
echo

# Bound to 0.0.0.0 so the LAN address above actually works -- this serves a
# synthesizer on a trusted network, not anything sensitive, but it IS reachable
# by anything that can route to this host.
#
# python3 -m http.server is single threaded, and the browser opens several
# parallel requests (wasm, worklet, patch index, 142 SVGs). --protocol HTTP/1.1
# keeps connections alive so those do not serialise painfully.
exec python3 -m http.server "$PORT" --directory "$WEB_ROOT" --bind 0.0.0.0 --protocol HTTP/1.1
