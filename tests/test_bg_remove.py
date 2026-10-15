"""Background Remover on the server (bg_remove.py and /api/remove-background)."""

import io
import os
import sys

import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from main import app  # noqa: E402

pytest.importorskip("onnxruntime")
client = TestClient(app)


def person_photo() -> bytes:
    """A head and shoulders in red and skin tones in front of a sky-to-grass background."""
    img = Image.new("RGB", (900, 700))
    d = ImageDraw.Draw(img)
    for y in range(700):
        d.line([(0, y), (900, y)], fill=(120 + y // 6, 170 + y // 8, 235) if y < 480 else (70, 140 - (y - 480) // 6, 60))
    d.polygon([(360, 330), (540, 330), (800, 700), (100, 700)], fill=(200, 30, 40))
    d.ellipse([355, 135, 545, 325], fill=(205, 150, 120))
    out = io.BytesIO()
    img.save(out, "JPEG", quality=92)
    return out.getvalue()


def test_mask_keeps_the_person_and_drops_the_background():
    r = client.post("/api/remove-background", files={"file": ("me.jpg", person_photo(), "image/jpeg")})
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "image/png"
    m = Image.open(io.BytesIO(r.content))
    assert m.mode == "L" and m.size == (1024, 1024)
    sx, sy = 1024 / 900, 1024 / 700
    at = lambda x, y: m.getpixel((int(x * sx), int(y * sy)))  # noqa: E731
    assert at(20, 20) < 20 and at(880, 680) < 20          # sky and grass corners
    assert at(450, 230) > 230 and at(450, 520) > 230      # face and body


def test_not_a_picture_is_a_clear_400():
    r = client.post("/api/remove-background", files={"file": ("x.jpg", b"not an image", "image/jpeg")})
    assert r.status_code == 400
    assert "picture" in r.json()["detail"]
