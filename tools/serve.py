#!/usr/bin/env python3
"""
Static file server for the Surge site, with optional TLS.

WHY TLS IS NEEDED AT ALL
------------------------
AudioWorklet is only exposed in a *secure context*. Browsers treat
http://localhost as secure, but a plain-http LAN address is NOT, so over the LAN
`AudioContext.audioWorklet` is simply `undefined` and the synth cannot start.
Serving HTTPS with a self-signed certificate makes the LAN address a secure
context and the worklet appear.

The certificate is self-signed, so the browser shows a warning the first time.
That is expected: accept it once per device.

Run via ./run_server.sh rather than directly.
"""

# /// script
# requires-python = ">=3.9"
# dependencies = ["fire"]
# ///

import functools
import http.server
import ssl
import subprocess
import sys
from pathlib import Path

import fire

REPO_ROOT = Path(__file__).resolve().parent.parent
CERT_DIR = REPO_ROOT / "build" / "tls"
CERT_FILE = CERT_DIR / "server.crt"
KEY_FILE = CERT_DIR / "server.key"

CERT_DAYS = "825"  # the longest most browsers will accept for a leaf certificate


class Handler(http.server.SimpleHTTPRequestHandler):
    """
    Serves the site with the headers the page needs.

    Adds no-cache because during development a stale surge-engine.wasm silently
    serves an old build, which is maddening to debug.
    """

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        # .wasm must arrive as application/wasm for streaming instantiation.
        super().end_headers()

    def log_message(self, fmt, *args):
        # Quieter than the default: one line per request, no client address noise.
        sys.stderr.write(f"  {fmt % args}\n")


def ensure_cert():
    """
    Command. Creates a self-signed certificate if one is not already present.

    Idempotent: regenerating on every start would force the browser to
    re-prompt for trust each time.
    """
    if CERT_FILE.exists() and KEY_FILE.exists():
        return

    CERT_DIR.mkdir(parents=True, exist_ok=True)
    print("generating a self-signed certificate (once)...")
    subprocess.run(
        [
            "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
            "-keyout", str(KEY_FILE),
            "-out", str(CERT_FILE),
            "-days", CERT_DAYS,
            "-subj", "/CN=surge-wasm",
            # Without a subjectAltName modern browsers reject the cert outright,
            # regardless of what CN says.
            "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:0.0.0.0",
        ],
        check=True,
        capture_output=True,
    )


def main(root, port=8080, bind="0.0.0.0", tls=False):
    """
    Command. Serves `root` over HTTP or HTTPS until interrupted.

    Args:
        root (str): directory to serve
        port (int): TCP port
        bind (str): interface to bind
        tls (bool): wrap the socket in TLS using a self-signed certificate
    """
    root_path = Path(root).resolve()
    if not (root_path / "index.html").is_file():
        raise SystemExit(f"No index.html in {root_path}")

    handler = functools.partial(Handler, directory=str(root_path))
    httpd = http.server.ThreadingHTTPServer((bind, port), handler)

    if tls:
        ensure_cert()
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(certfile=CERT_FILE, keyfile=KEY_FILE)
        httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    fire.Fire(main)
