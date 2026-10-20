"""
Request guards for the public API: an upload size cap and a per-IP rate limit.
Both are plain ASGI middleware so they run before FastAPI reads the body.

Settings (environment variables):
  ULTRAPDF_MAX_UPLOAD_MB      largest request body accepted, default 100
  ULTRAPDF_RATE_LIMIT         server jobs per IP per window, default 60 (0 disables)
  ULTRAPDF_RATE_WINDOW_SEC    window length in seconds, default 3600
  ULTRAPDF_TRUST_PROXY        how to find the visitor's IP behind a proxy:
                              unset/"0"     the connecting address (no proxy)
                              "cloudflare"  the CF-Connecting-IP header set by Cloudflare
                              "1"           the last X-Forwarded-For entry, i.e. the address your
                                            own proxy saw (earlier entries are typed by the visitor)
                              Only set this when the server can be reached through the proxy
                              alone, or anyone can send a fake header and dodge the limit.
"""

import ipaddress
import json
import os
import threading
import time
from collections import defaultdict, deque


def _json_response(status: int, detail: str, extra_headers=None):
    body = json.dumps({"detail": detail}).encode()
    headers = [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]
    headers += extra_headers or []
    return status, headers, body


async def _send(send, status, headers, body):
    await send({"type": "http.response.start", "status": status, "headers": headers})
    await send({"type": "http.response.body", "body": body})


class UploadLimitMiddleware:
    """Rejects request bodies over the limit with 413, whether or not Content-Length is sent."""

    def __init__(self, app, max_bytes=None):
        self.app = app
        mb = float(os.environ.get("ULTRAPDF_MAX_UPLOAD_MB", "100"))
        self.max_bytes = max_bytes if max_bytes is not None else int(mb * 1024 * 1024)

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] not in ("POST", "PUT", "PATCH"):
            return await self.app(scope, receive, send)

        too_large = _json_response(
            413, f"File too large. The limit is {self.max_bytes // (1024 * 1024)} MB per request.")
        for name, value in scope.get("headers", []):
            if name == b"content-length" and value.isdigit() and int(value) > self.max_bytes:
                return await _send(send, *too_large)

        received = 0
        exceeded = False
        replied = False

        async def limited_receive():
            nonlocal received, exceeded
            if exceeded:
                return {"type": "http.disconnect"}
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > self.max_bytes:
                    # Stop feeding the app; it sees a disconnect and we answer 413 below.
                    exceeded = True
                    return {"type": "http.disconnect"}
            return message

        async def guarded_send(message):
            nonlocal replied
            if exceeded:
                return  # drop whatever the app tries to say about the cut-off body
            if message["type"] == "http.response.start":
                replied = True
            await send(message)

        try:
            await self.app(scope, limited_receive, guarded_send)
        except Exception:
            if not exceeded:
                raise
        if exceeded and not replied:
            await _send(send, *too_large)


class RateLimitMiddleware:
    """Sliding-window limit on POST /api/* per client IP. In memory, so per process."""

    def __init__(self, app, limit=None, window=None, clock=time.monotonic):
        self.app = app
        self.limit = limit if limit is not None else int(os.environ.get("ULTRAPDF_RATE_LIMIT", "60"))
        self.window = window if window is not None else float(os.environ.get("ULTRAPDF_RATE_WINDOW_SEC", "3600"))
        self.trust_proxy = os.environ.get("ULTRAPDF_TRUST_PROXY", "0").strip().lower()
        self.clock = clock
        self.hits = defaultdict(deque)
        self.lock = threading.Lock()

    def _client_ip(self, scope):
        headers = dict(scope.get("headers", []))
        ip = None
        if self.trust_proxy == "cloudflare":
            ip = headers.get(b"cf-connecting-ip", b"").decode("latin-1").strip()
        elif self.trust_proxy == "1":
            # The first entries are whatever the visitor sent; the last one was added by our proxy.
            ip = headers.get(b"x-forwarded-for", b"").decode("latin-1").split(",")[-1].strip()
        if not ip:
            client = scope.get("client")
            ip = client[0] if client else "unknown"
        return self._bucket(ip)

    @staticmethod
    def _bucket(ip):
        """One bucket per IPv4 address, but per /64 for IPv6: anyone with IPv6 gets a whole /64,
        so counting single addresses would let them rotate through billions of them."""
        try:
            addr = ipaddress.ip_address(ip)
        except ValueError:
            return ip[:64]
        if addr.version == 6:
            if addr.ipv4_mapped:
                return str(addr.ipv4_mapped)
            return str(ipaddress.ip_network(f"{addr}/64", strict=False))
        return str(addr)

    async def __call__(self, scope, receive, send):
        if (self.limit <= 0 or scope["type"] != "http" or scope["method"] != "POST"
                or not scope["path"].startswith("/api/")):
            return await self.app(scope, receive, send)

        ip = self._client_ip(scope)
        now = self.clock()
        with self.lock:
            q = self.hits[ip]
            while q and now - q[0] >= self.window:
                q.popleft()
            if len(q) >= self.limit:
                retry = int(self.window - (now - q[0])) + 1
                blocked = True
            else:
                q.append(now)
                blocked = False
            if len(self.hits) > 10000:  # drop idle IPs so memory stays bounded
                for key in [k for k, v in self.hits.items() if not v]:
                    del self.hits[key]
        if blocked:
            return await _send(send, *_json_response(
                429,
                "You've hit the limit for server tools for now. Tools marked 'Runs on your device' still work. "
                f"Try again in {max(1, retry // 60)} minute(s).",
                [(b"retry-after", str(retry).encode())]))
        return await self.app(scope, receive, send)
