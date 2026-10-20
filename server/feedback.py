"""
Tool ratings and feedback: star ratings after a tool runs, "Report a problem" and
"Request a tool" messages. Stored as JSON lines on the server; no file content and
no IP address is ever kept.

Env: ULTRAPDF_DATA_DIR (default ./data next to this file).
"""

import json
import os
import re
import threading
import time
from typing import Dict, Optional

KINDS = {"rating", "problem", "request"}
MAX_FILE_BYTES = 20 * 1024 * 1024  # stop accepting new entries rather than fill the disk
_lock = threading.Lock()
_cache: Dict[str, Dict] = {}
_cache_mtime: Optional[float] = None


def data_dir() -> str:
    return os.environ.get("ULTRAPDF_DATA_DIR") or os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")


def _path() -> str:
    return os.path.join(data_dir(), "feedback.jsonl")


def _clean(text: Optional[str], limit: int) -> str:
    # Control characters and bidi overrides are removed so an entry can't disguise itself
    # when someone reads the file in a terminal or editor.
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]", "", text or "").strip()
    return re.sub(r"[\r\t]+", " ", text)[:limit]


def record(kind: str, tool: str = "", rating: Optional[int] = None, comment: str = "", contact: str = "") -> Dict:
    """Validates and stores one submission. Raises ValueError with a message for the user."""
    if kind not in KINDS:
        raise ValueError("Unknown feedback type.")
    tool = _clean(tool, 60)
    if tool and not re.fullmatch(r"[a-z0-9-]+", tool):
        raise ValueError("Unknown tool.")
    if kind == "rating":
        if not tool:
            raise ValueError("Which tool are you rating?")
        if rating is None or not 1 <= int(rating) <= 5:
            raise ValueError("Pick 1 to 5 stars.")
        rating = int(rating)
    else:
        rating = None
    comment = _clean(comment, 2000)
    contact = _clean(contact, 200)
    if kind != "rating" and len(comment) < 5:
        raise ValueError("Tell us a little more, at least a few words.")
    if contact and not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", contact):
        raise ValueError("That email address doesn't look right.")
    entry = {"ts": int(time.time()), "kind": kind, "tool": tool, "rating": rating, "comment": comment, "contact": contact}
    os.makedirs(data_dir(), mode=0o700, exist_ok=True)
    with _lock:
        try:
            if os.path.getsize(_path()) > MAX_FILE_BYTES:
                raise ValueError("Thanks! We can't take more feedback right now. Please try again later.")
        except OSError:
            pass
        # Owner-only: entries can hold the email address someone left for a reply.
        fd = os.open(_path(), os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        with open(fd, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    return entry


def ratings() -> Dict[str, Dict]:
    """{tool: {"average": 4.6, "count": 12}} from every rating so far, cached until the file changes."""
    global _cache, _cache_mtime
    path = _path()
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        return {}
    with _lock:
        if mtime == _cache_mtime:
            return _cache
        totals: Dict[str, list] = {}
        with open(path, encoding="utf-8") as f:
            for line in f:
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                if e.get("kind") == "rating" and e.get("tool") and isinstance(e.get("rating"), int):
                    t = totals.setdefault(e["tool"], [0, 0])
                    t[0] += e["rating"]
                    t[1] += 1
        _cache = {tool: {"average": round(s / n, 1), "count": n} for tool, (s, n) in totals.items()}
        _cache_mtime = mtime
        return _cache
