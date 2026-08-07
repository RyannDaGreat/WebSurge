#!/usr/bin/env bash
#
# Serve the Surge XT WASM site.
#
# WebAssembly cannot be fetched from a file:// URL, so the site has to go over
# HTTP even locally. This serves src/ -- which is the entire deliverable; there
# is no backend and no build step at request time.
#
#   ./run_server.sh              https on :8080   (default)
#   ./run_server.sh 9000         https on another port
#   ./run_server.sh --no-tls     plain http -- audio then works ONLY on localhost
#
# HTTPS IS THE DEFAULT because AudioWorklet exists only in a secure context.
# Browsers treat http://localhost as secure, but a plain-http LAN address is
# not, so over HTTP the LAN URL loads the page and then fails with
# `AudioContext.audioWorklet` undefined. Serving TLS by default means the
# address printed below always works. The certificate is self-signed, so accept
# the browser warning once per device.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

log() { printf '\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

TLS=1
PORT=8080
for arg in "$@"; do
    case "$arg" in
        --no-tls) TLS=0 ;;
        --tls)    TLS=1 ;;   # accepted but redundant; TLS is the default
        ''|*[!0-9]*) die "Unknown argument '$arg'. Use: [--no-tls] [port]" ;;
        *) PORT="$arg" ;;
    esac
done

WEB_ROOT="$REPO_ROOT/src"

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

if [ "$TLS" -eq 1 ]; then SCHEME=https; else SCHEME=http; fi

log "Serving $WEB_ROOT"
log "  engine   $(du -h "$WEB_ROOT/js/surge-engine.wasm" | cut -f1)"
log "  patches  $PATCH_COUNT"
log "  data     $(du -sh "$WEB_ROOT/data" 2>/dev/null | cut -f1)"
echo
printf '\033[1;32m   local   %s://localhost:%s\033[0m\n' "$SCHEME" "$PORT"
if [ -n "$IP" ]; then
    printf '\033[1;32m   LAN     %s://%s:%s\033[0m\n' "$SCHEME" "$IP" "$PORT"
else
    printf '\033[1;33m   LAN     (could not determine an address)\033[0m\n'
fi
echo

if [ "$TLS" -eq 1 ]; then
    echo "Self-signed certificate: the browser will warn once per device. Accept it."
else
    printf '\033[1;33mNOTE: --no-tls. Audio will only work on localhost; over the LAN\033[0m\n'
    printf '\033[1;33m      AudioWorklet needs a secure context and will be unavailable.\033[0m\n'
fi
echo "Play with zxcvbnm,./ and qwertyuiop[]\\ . Ctrl-C to stop."
echo

# Bound to 0.0.0.0 so the LAN address above actually works. This serves a
# synthesizer on a trusted network, not anything sensitive, but it IS reachable
# by anything that can route to this host.
#
# Served by tools/serve.py rather than `python3 -m http.server` because that has
# no TLS option, and because a threading server matters here: the page opens
# many parallel requests (wasm, worklet, patch index, 142 SVGs).
exec uv run "$REPO_ROOT/tools/serve.py" \
    --root "$WEB_ROOT" --port "$PORT" --bind 0.0.0.0 $([ "$TLS" -eq 1 ] && echo --tls)
