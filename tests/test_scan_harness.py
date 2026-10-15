"""
Checks the Scan to PDF image core (static/scan-tool.js) under Node: page edge detection,
perspective correction with the right aspect ratio, and the clean-up filters.
The browser side (camera, UI, the saved PDF) is covered by tests/e2e_scan.js.
"""

import json
import math
import os
import shutil
import subprocess
import sys

import numpy as np
import pytest
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from scan_harness_fixtures import SETS, make_blank, make_photo  # noqa: E402

HARNESS = os.path.join(HERE, "scan_harness.js")
pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")


def run(*args):
    return json.loads(subprocess.check_output(["node", HARNESS, *map(str, args)], timeout=120))


def rgba_file(tmp_path, img, name):
    path = tmp_path / name
    path.write_bytes(img.convert("RGBA").tobytes())
    return path


def load(data):
    import io
    return Image.open(io.BytesIO(data))


def detect(tmp_path, img):
    s = 480 / max(img.size)
    small = img.resize((round(img.width * s), round(img.height * s)), Image.BILINEAR)
    r = run("detect", rgba_file(tmp_path, small, "small.rgba"), small.width, small.height)
    if r["corners"]:
        r["corners"] = [[x / small.width * img.width, y / small.height * img.height] for x, y in r["corners"]]
    return r


@pytest.mark.parametrize("name", list(SETS))
def test_finds_page_corners(tmp_path, name):
    data, truth = make_photo(**SETS[name])
    img = load(data)
    r = detect(tmp_path, img)
    assert r["corners"], f"no page found (confidence {r['confidence']})"
    diag = math.hypot(*img.size)
    err = max(math.dist(c, t) / diag for c, t in zip(r["corners"], truth))
    assert err < 0.015, f"corner error {err:.3%}"


def test_no_page_means_no_corners(tmp_path):
    r = detect(tmp_path, load(make_blank()))
    assert r["corners"] is None


def straighten(tmp_path, img, corners, filt):
    out = tmp_path / "out.rgba"
    r = run("warp", rgba_file(tmp_path, img, "full.rgba"), img.width, img.height, json.dumps(corners), filt, out, 1400)
    return Image.frombytes("RGBA", (r["w"], r["h"]), out.read_bytes()).convert("L")


def text_bands(gray):
    g = np.asarray(gray, float)
    h, w = g.shape
    rows = (g[int(h * .1):int(h * .9), int(w * .15):int(w * .85)] < 110).mean(1) > 0.004
    bands, run_len = 0, 0
    for v in list(rows) + [False]:
        if v:
            run_len += 1
        else:
            bands += run_len >= 2
            run_len = 0
    return bands, 1 - rows.mean()


def test_straightens_to_a4_and_cleans_up(tmp_path):
    data, truth = make_photo(**SETS["photo_a.jpg"])
    img = load(data)
    for filt in ("enhanced", "bw"):
        out = straighten(tmp_path, img, truth, filt)
        assert abs(out.height / out.width - math.sqrt(2)) < 0.02, out.size  # perspective-aware aspect
        g = np.asarray(out, float)
        assert (g > 200).mean() > 0.85  # paper is white, even in the shaded corner
        bands, blank = text_bands(out)
        assert bands >= 14 and blank > 0.3, (bands, blank)  # text lines are horizontal


def test_original_keeps_colours(tmp_path):
    data, truth = make_photo(**SETS["photo_a.jpg"])
    img = load(data)
    out = np.asarray(straighten(tmp_path, img, truth, "original"), float)
    # Uneven lighting is left alone: the paper is not pure white.
    assert np.percentile(out, 50) < 240
