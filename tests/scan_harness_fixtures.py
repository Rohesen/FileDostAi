"""
Synthetic "phone photos" of paper pages for the Scan to PDF tests.

make_photo() draws an A4-shaped page with black text, turns it, tilts it away from a pinhole camera and
lays it on a textured background. It returns the JPEG bytes and the page's true corners
(top-left, top-right, bottom-right, bottom-left) in photo pixels.

    python3 tests/scan_harness_fixtures.py OUT_DIR   writes photo_*.jpg and corners.json
"""

import io
import json
import math
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

PAGE_W, PAGE_H = 1000, 1414  # A4 ratio


def draw_page(bg=246):
    page = Image.new("RGB", (PAGE_W, PAGE_H), (bg, bg, bg - 4))
    d = ImageDraw.Draw(page)
    try:
        title = ImageFont.load_default(size=64)
        body = ImageFont.load_default(size=34)
    except TypeError:  # very old Pillow
        title = body = ImageFont.load_default()
    d.text((110, 120), "Quarterly Report", fill=(10, 10, 10), font=title)
    words = "the quick brown fox jumps over the lazy dog and keeps running far away".split()
    y = 280
    for i in range(16):
        line = " ".join(words[(i * 3) % len(words):] + words[: (i * 3) % len(words)])[:44]
        d.text((110, y), line, fill=(20, 20, 20), font=body)
        y += 64
    d.rectangle((110, y + 20, 600, y + 26), fill=(30, 30, 30))
    return page


def perspective_coeffs(dst, src):
    """Coefficients for PIL's PERSPECTIVE transform: maps output (dst) points to input (src) points."""
    A, b = [], []
    for (x, y), (u, v) in zip(dst, src):
        A.append([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.append(u)
        A.append([0, 0, 0, x, y, 1, -v * x, -v * y]); b.append(v)
    return np.linalg.solve(np.array(A, float), np.array(b, float)).tolist()


def true_corners(size, angle_deg, scale, tilt_deg, shift=(0, 0)):
    """Project the page with a pinhole camera: tilted back by tilt_deg, turned by angle_deg."""
    W, H = size
    f = 1.1 * max(W, H)  # typical phone focal length in pixels
    hw, hh = PAGE_W / 2, PAGE_H / 2
    a, t = math.radians(angle_deg), math.radians(tilt_deg)
    dist = f / scale  # at this distance an untilted page appears `scale` times its pixel size
    out = []
    for x, y in [(-hw, -hh), (hw, -hh), (hw, hh), (-hw, hh)]:
        x, y = x * math.cos(a) - y * math.sin(a), x * math.sin(a) + y * math.cos(a)  # turn in the page plane
        y, z = y * math.cos(t), dist + y * math.sin(t)  # tilt: the top moves away
        out.append((W / 2 + shift[0] + f * x / z, H / 2 + shift[1] + f * y / z))
    return out


def make_photo(size=(1600, 2000), angle=12, scale=1.25, tilt=25, background="dark", shift=(0, 0), seed=1):
    rng = np.random.default_rng(seed)
    W, H = size
    corners = true_corners(size, angle, scale, tilt, shift)
    page = draw_page()
    src = [(0, 0), (PAGE_W, 0), (PAGE_W, PAGE_H), (0, PAGE_H)]
    coeffs = perspective_coeffs(corners, src)
    warped = page.transform(size, Image.PERSPECTIVE, coeffs, Image.BICUBIC, fillcolor=(0, 0, 0))
    # The mask is the projected page itself (a transformed mask would also show the mirror image
    # a projective map makes beyond the horizon).
    big = Image.new("L", (W * 4, H * 4), 0)
    ImageDraw.Draw(big).polygon([(x * 4, y * 4) for x, y in corners], fill=255)
    mask = big.resize(size, Image.LANCZOS)

    yy, xx = np.mgrid[0:H, 0:W]
    if background == "dark":
        base = 55 + 25 * np.sin(xx / 37.0 + yy / 190.0) + rng.normal(0, 8, (H, W))
        bg = np.stack([base * 1.15, base * 0.9, base * 0.7], -1)
    else:  # light grey table, harder
        base = 150 + 12 * np.sin(yy / 53.0) + rng.normal(0, 6, (H, W))
        bg = np.stack([base, base, base * 1.03], -1)
    bg_img = Image.fromarray(np.clip(bg, 0, 255).astype(np.uint8))
    # A soft shadow under the page.
    shadow = mask.filter(ImageFilter.GaussianBlur(18))
    bg_arr = np.asarray(bg_img).astype(float) * (1 - 0.35 * (np.asarray(shadow, float) / 255.0)[..., None])
    photo = Image.composite(warped, Image.fromarray(np.clip(bg_arr, 0, 255).astype(np.uint8)), mask)
    # Uneven light: darker towards one corner.
    light = 0.78 + 0.22 * (1 - (xx / W * 0.6 + yy / H * 0.4))
    arr = np.asarray(photo).astype(float) * light[..., None]
    photo = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.8))
    buf = io.BytesIO()
    photo.save(buf, "JPEG", quality=90)
    return buf.getvalue(), [list(map(float, c)) for c in corners]


def make_blank(size=(1200, 900), seed=3):
    rng = np.random.default_rng(seed)
    arr = np.clip(90 + rng.normal(0, 20, (size[1], size[0], 3)), 0, 255).astype(np.uint8)
    buf = io.BytesIO()
    Image.fromarray(arr).save(buf, "JPEG", quality=85)
    return buf.getvalue()


SETS = {
    "photo_a.jpg": dict(angle=12, tilt=28, scale=1.0, background="dark"),
    "photo_b.jpg": dict(angle=-6, tilt=18, background="light", scale=0.95, shift=(40, -30), seed=2),
}


def write_all(out):
    os.makedirs(out, exist_ok=True)
    info = {}
    for name, kw in SETS.items():
        data, corners = make_photo(**kw)
        with open(os.path.join(out, name), "wb") as f:
            f.write(data)
        info[name] = corners
    with open(os.path.join(out, "blank.jpg"), "wb") as f:
        f.write(make_blank())
    with open(os.path.join(out, "corners.json"), "w") as f:
        json.dump(info, f)
    return info


if __name__ == "__main__":
    write_all(sys.argv[1])
    print("fixtures written")
