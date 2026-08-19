"""Exchange a caller-supplied Speechmatics key for a short-lived realtime key.

    POST /api/token  {"apiKey": "..."}  ->  {"jwt": "<temporary key>", "ttl": <seconds>}

The deployment holds no credential of its own: the visitor's key arrives in the
body, is used for one Management Platform call, and is never stored, logged or
echoed back. The browser calls mp.speechmatics.com directly first and only falls
back here when CORS or the network blocks it.

The browser holds the microphone and opens the Melia socket itself; Python only
mints the key and never sits in the audio path. See the README under "How It Works".
"""

import json
import os
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler

# The Management Platform, not the ASR endpoint. `type=rt` is required: a batch
# key will not open a realtime socket.
SPEECHMATICS_MP_URL = "https://mp.speechmatics.com/v1/api_keys?type=rt"

# Clamped, not rejected, so a bad SM_TOKEN_TTL cannot 400 from an endpoint the
# reader cannot see. The floor is also the default: the key rides in the Melia
# socket URL as `?jwt=` (a browser WebSocket cannot set a header) and query
# strings leak, so a short life is the only real containment.
MIN_TTL_SECONDS = 60
MAX_TTL_SECONDS = 86_400
DEFAULT_TTL_SECONDS = 60

# Bounded so a hung upstream becomes a retryable 502 with a readable body, rather
# than a request that hangs until something further out gives up.
MP_REQUEST_TIMEOUT_SECONDS = 10

# A key is ~100 bytes of JSON; cap the read so a hostile Content-Length cannot
# make the server allocate whatever it claims.
MAX_BODY_BYTES = 4096


class MintError(Exception):
    """No usable temporary key came back from the Management Platform.

    `status` is the upstream HTTP status, or None for network and parse failures,
    and is all that escapes: an error *body* may carry credential material.
    """

    def __init__(self, status: int | None = None) -> None:
        super().__init__("token_mint_failed")
        self.status = status


def token_ttl_seconds() -> int:
    """Return the temporary-key lifetime in seconds, from `SM_TOKEN_TTL`."""
    # Coercion failure means "use the default": `SM_TOKEN_TTL=60s` is the natural
    # thing to write, and an escaping ValueError would 500 every request.
    raw = os.environ.get("SM_TOKEN_TTL", "").strip()
    try:
        ttl = int(raw)
    except ValueError:
        return DEFAULT_TTL_SECONDS
    return max(MIN_TTL_SECONDS, min(MAX_TTL_SECONDS, ttl))


def mint_temporary_key(api_key: str, ttl: int) -> str:
    """Exchange the long-lived `api_key` for a temporary realtime key."""
    request = urllib.request.Request(
        SPEECHMATICS_MP_URL,
        data=json.dumps({"ttl": ttl}).encode("utf-8"),
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=MP_REQUEST_TIMEOUT_SECONDS) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        # `from None`: a chained traceback formats the Request object, Authorization
        # header and all, and something eventually logs it.
        raise MintError(err.code) from None
    except (OSError, ValueError):
        # OSError covers URLError, DNS, resets and the timeout above.
        raise MintError() from None

    # Documented shape is {"apikey_id": null, "key_value": "eyJhbG..."}.
    key_value = payload.get("key_value") if isinstance(payload, dict) else None
    if not isinstance(key_value, str) or not key_value:
        raise MintError()
    return key_value


class handler(BaseHTTPRequestHandler):
    """The token endpoint behind `/api/token`.

    The lower-case name and the `BaseHTTPRequestHandler` shape are the contract:
    `dev_server.py` imports this class and subclasses it to serve the route.
    It is unauthenticated but it is not a key faucet: a caller can only mint
    against a Speechmatics key they already hold.
    """

    def fallback_api_key(self) -> str:
        """No server key in a deployment, ever. `dev_server.py` overrides this with
        SPEECHMATICS_API_KEY so local work needs no pasting; adding that path here
        would let any visitor mint credentials against your own account."""
        return ""

    def do_POST(self) -> None:
        """Mint from `{"apiKey"}`: 200, 400 with no key, 401/403 upstream, else 502."""
        api_key = self._read_api_key() or self.fallback_api_key().strip()
        if not api_key:
            # Machine-readable so the client prompts for a key rather than reading
            # this as an outage and retrying.
            self._send_json(400, {"error": "missing_api_key"})
            return

        ttl = token_ttl_seconds()
        try:
            jwt = mint_temporary_key(api_key, ttl)
        except MintError as err:
            # 401/403 pass through: a rejected key is the visitor's to fix, and only
            # the 502 is worth retrying.
            if err.status in (401, 403):
                self._send_json(err.status, {"error": "invalid_api_key", "status": err.status})
                return
            payload: dict[str, object] = {"error": "token_mint_failed"}
            if err.status is not None:
                payload["status"] = err.status
            self._send_json(502, payload)
            return

        # The ttl tells the client how long its credential lives.
        self._send_json(200, {"jwt": jwt, "ttl": ttl})

    def do_GET(self) -> None:
        """405. Minting a key is a side effect; it does not belong on a GET."""
        self._send_json(405, {"error": "method_not_allowed"}, allow="POST")

    def _read_api_key(self) -> str:
        """Return `apiKey` from the JSON body, or "" if absent or unusable."""
        # Bad length, short read, malformed JSON and wrong type all collapse to ""
        # and then to one 400: nothing from the body reaches a message or a log.
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except (TypeError, ValueError):
            return ""
        if length <= 0 or length > MAX_BODY_BYTES:
            return ""
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (OSError, UnicodeDecodeError, ValueError):
            return ""
        api_key = payload.get("apiKey") if isinstance(payload, dict) else None
        return api_key.strip() if isinstance(api_key, str) else ""

    def _send_json(self, status: int, payload: dict[str, object], *, allow: str | None = None) -> None:
        """Write `payload` as JSON. The single reply path, so nothing can answer
        without `Cache-Control: no-store` and no cache ever holds a credential."""
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if allow is not None:
            self.send_header("Allow", allow)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:
        """Log nothing: the default writes the request line, query string and all,
        next to a credential. `dev_server.py` logs the request, query cut off."""
