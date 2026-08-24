#!/usr/bin/env python3
"""Local development server for the wall: static `public/` plus `/api/token`.

    python dev_server.py     ->  http://127.0.0.1:3100

Serves `public/` as static files and runs `api/token.py` as the token route,
stdlib only. `WallHandler` subclasses that `handler` rather than reimplementing
it, with one deliberate difference: it falls back to SPEECHMATICS_API_KEY from
`.env` when the browser sends no key, so local work needs no pasting. See
`WallHandler.fallback_api_key`.
"""

import mimetypes
import os
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PUBLIC_DIR = ROOT / "public"

# `api` is a namespace package, so the use-case root must be importable. Reach
# the module as `api.token`; `api/` on the path would shadow stdlib `token`.
sys.path.insert(0, str(ROOT))

from api.token import handler as TokenRoute
from api.token import token_ttl_seconds

# Loopback, hardcoded, with no override. With a key in `.env` this server mints
# credentials against YOUR account for anyone who asks, and a *default* of
# loopback is one careless `HOST=0.0.0.0` away from putting that on conference
# Wi-Fi. See the README under "Running It On Stage".
HOST = "127.0.0.1"
DEFAULT_PORT = 3100

# Pin the module MIME type rather than trust the OS: `mimetypes` reads it on
# Windows from a registry key that is commonly "text/plain", and a browser will
# not execute an ES module served as text/plain, so the wall comes up blank.
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/css", ".css")


def load_dotenv(path: Path) -> None:
    """Read `KEY=value` lines into the environment; existing values win.

    Hand-rolled so the whole web path stays dependency-free. Only `cli.py` needs pip.
    """
    if not path.is_file():
        return

    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if key:
            os.environ.setdefault(key, value)


class WallHandler(TokenRoute, SimpleHTTPRequestHandler):
    """Serve `public/` on GET and `/api/token` on POST.

    The base classes are the design: `TokenRoute` is the real token endpoint, so
    its `do_POST` and headers arrive unchanged, and `SimpleHTTPRequestHandler`
    serves the static files. This class only routes between them.
    """

    TOKEN_PATH = "/api/token"

    def fallback_api_key(self) -> str:
        """DEV ONLY: use SPEECHMATICS_API_KEY when the browser sends no key.

        The whole dev/production difference lives here. `api/token.py` returns ""
        and never reads the environment, so a deployment can only mint against a
        key the visitor supplied; do not "fix" that by adding this path there.
        """
        return os.environ.get("SPEECHMATICS_API_KEY", "")

    def _is_token_path(self) -> bool:
        """Whether this is /api/token, ignoring any query string."""
        return self.path.split("?", 1)[0] == self.TOKEN_PATH

    def do_POST(self) -> None:
        """Mint a key via the token route, or 404 the way a static host would."""
        if not self._is_token_path():
            self.send_error(404, "Not Found")
            return
        TokenRoute.do_POST(self)

    def do_GET(self) -> None:
        """Serve a file from `public/`, or the token route's own 405."""
        if self._is_token_path():
            TokenRoute.do_GET(self)
            return
        self._no_store = True
        SimpleHTTPRequestHandler.do_GET(self)

    def end_headers(self) -> None:
        """Make static responses uncacheable: Chrome caches ES modules hard, and a
        stale `main.js` after an edit is indistinguishable from a bug."""
        # Only the static path sets the flag. /api/token sends its own no-store
        # and must not get a second one.
        if getattr(self, "_no_store", False):
            self.send_header("Cache-Control", "no-store, must-revalidate")
            self._no_store = False
        super().end_headers()

    def log_request(self, code: object = "-", size: object = "-") -> None:
        """One line per request, query string cut off: a route handing out
        credentials should not put URLs in a log. `log_message` stays the token
        route's silent one, so a 404 gets one line rather than two."""
        status = getattr(code, "value", code)
        sys.stderr.write(f"{self.command} {self.path.split('?', 1)[0]} {status}\n")


def serve(port: int) -> None:
    """Run the dev server on `HOST` until interrupted."""
    # Threaded: minting a key is a blocking HTTPS round trip with a 10s timeout,
    # and one thread would stall every stylesheet behind it.
    handler_factory = partial(WallHandler, directory=str(PUBLIC_DIR))
    server = ThreadingHTTPServer((HOST, port), handler_factory)

    # The address the socket got, not the one asked for: PORT=0 is ephemeral.
    bound_host, bound_port = server.server_address[:2]

    print("Wall of Voices - dev server")
    print(f"  serving:  http://{bound_host}:{bound_port}  (loopback only, never 0.0.0.0)")
    print(f"  static:   {PUBLIC_DIR}")
    print(f"  api:      POST /api/token {{ apiKey }} -> {{ jwt, ttl }}, ttl {token_ttl_seconds()}s")

    # Say whether the key exists, never what it is. Both lines are working setups:
    # a browser-supplied key is all the token endpoint itself ever accepts.
    if os.environ.get("SPEECHMATICS_API_KEY", "").strip():
        print("  api key:  server key from .env - DEV ONLY, the deployment has no such fallback")
    else:
        print("  api key:  none on the server - paste one in the browser, as production requires")

    if not (PUBLIC_DIR / "index.html").is_file():
        print(f"  ! no index.html in {PUBLIC_DIR} - the wall will 404")

    print("\nCtrl+C to stop.\n")

    # Redirected to a file, stdout is block-buffered, so the banner would sit in
    # the buffer until the process is killed.
    sys.stdout.flush()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()


def main() -> None:
    """Load .env, resolve the port, and start serving."""
    load_dotenv(ROOT / ".env")

    raw_port = os.environ.get("PORT", "").strip()
    try:
        port = int(raw_port) if raw_port else DEFAULT_PORT
    except ValueError:
        print(f"PORT={raw_port!r} is not a number - using {DEFAULT_PORT}")
        port = DEFAULT_PORT

    serve(port)


if __name__ == "__main__":
    main()
