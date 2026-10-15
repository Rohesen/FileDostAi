"""
Checks the Edit PDF operation (static/edit-ops.js) by running it under Node
(tests/edit_harness.js) and reading the result back with PyMuPDF.

Edit coordinates are points on the page as displayed, from the top-left corner.
"""

import io
import json
import os
import shutil
import subprocess

import pymupdf
import pytest
from PIL import Image
from reportlab.pdfgen import canvas

HERE = os.path.dirname(os.path.abspath(__file__))
HARNESS = os.path.join(HERE, "edit_harness.js")

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")

# Baseline offset of the first line from the top of a text box, in em (sans, line height 1.2).
SANS_BASELINE = (1.2 - (0.905 + 0.212)) / 2 + 0.905


def sample_pdf(pages=1, rotation=0) -> bytes:
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=(612, 792))
    for p in range(pages):
        c.setFont("Helvetica", 24)
        c.drawString(72, 700, "Hello World")  # baseline at y=92 from the top
        c.setFont("Helvetica", 12)
        c.drawString(72, 600, f"Body text on page {p + 1}")
        c.showPage()
    c.save()
    data = buf.getvalue()
    if rotation:
        doc = pymupdf.open(stream=data)
        for page in doc:
            page.set_rotation(rotation)
        data = doc.tobytes()
    return data


def apply(tmp_path, pdf_bytes, edits):
    src = tmp_path / "in.pdf"
    src.write_bytes(pdf_bytes)
    out = tmp_path / "out.pdf"
    spec = tmp_path / "edits.json"
    spec.write_text(json.dumps(edits))
    proc = subprocess.run(["node", HARNESS, str(src), str(out), str(spec)],
                          capture_output=True, text=True, timeout=60)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip())
    meta = json.loads(proc.stdout)
    assert meta["filename"] == "edited.pdf" and meta["mime"] == "application/pdf"
    return pymupdf.open(stream=out.read_bytes())


def png_file(tmp_path, size=(40, 20), color=(0, 160, 0, 255), name="img.png"):
    p = tmp_path / name
    Image.new("RGBA", size, color).save(p)
    return str(p)


def pixel(page, x, y, dpi=72):
    """RGB of the rendered page (as displayed) at (x, y) points from the top-left."""
    pix = page.get_pixmap(dpi=dpi)
    s = dpi / 72
    return pix.pixel(int(x * s), int(y * s))[:3]


def span_origin(page, text):
    """Baseline origin of the span containing text, in displayed coordinates."""
    for block in page.get_text("dict")["blocks"]:
        for line in block.get("lines", []):
            for span in line["spans"]:
                if text in span["text"]:
                    return pymupdf.Point(span["origin"]) * page.rotation_matrix
    raise AssertionError(f"{text!r} not found")


def close(a, b, tol=40):
    return all(abs(x - y) <= tol for x, y in zip(a, b))


def test_add_text_lands_at_position(tmp_path):
    doc = apply(tmp_path, sample_pdf(), [
        {"page": 0, "type": "text", "x": 100, "y": 200, "size": 20, "text": "Added text", "font": "sans",
         "color": "#cc0000"},
    ])
    page = doc[0]
    assert "Added text" in page.get_text()
    o = span_origin(page, "Added text")
    assert abs(o.x - 100) < 0.5 and abs(o.y - (200 + SANS_BASELINE * 20)) < 0.5
    span = next(s for b in page.get_text("dict")["blocks"] for l in b.get("lines", []) for s in l["spans"]
                if "Added" in s["text"])
    assert span["color"] == 0xCC0000 and abs(span["size"] - 20) < 0.01


def test_text_styles_multiline_and_alignment(tmp_path):
    doc = apply(tmp_path, sample_pdf(), [
        {"page": 0, "type": "text", "x": 100, "y": 300, "size": 14, "text": "Wide first line\nmid",
         "font": "serif", "bold": True, "italic": True, "align": "center"},
        {"page": 0, "type": "text", "x": 100, "y": 400, "size": 10, "text": "code()", "font": "mono"},
    ])
    page = doc[0]
    fonts = {s["text"]: s["font"] for b in page.get_text("dict")["blocks"] for l in b.get("lines", [])
             for s in l["spans"]}
    assert "BoldItalic" in fonts["Wide first line"] and "Times" in fonts["Wide first line"]
    assert "Courier" in fonts["code()"]
    first = page.search_for("Wide first line")[0]
    second = page.search_for("mid")[0]
    assert abs((first.x0 + first.x1) / 2 - (second.x0 + second.x1) / 2) < 1  # centred
    assert abs((second.y0 - first.y0) - 14 * 1.2) < 0.5  # one line apart


def test_edit_existing_text_replaces_it_visually(tmp_path):
    # "Hello World" at 24pt: baseline at y=92, covering roughly x 72..200, y 70..98.
    cover = {"x": 70, "y": 68, "w": 140, "h": 32, "color": "#ffffff"}
    doc = apply(tmp_path, sample_pdf(), [
        {"page": 0, "type": "text", "x": 72, "y": 92 - SANS_BASELINE * 24, "size": 24, "text": "Hi there",
         "font": "sans", "cover": cover},
    ])
    page = doc[0]
    assert "Hi there" in page.get_text()
    o = span_origin(page, "Hi there")
    assert abs(o.x - 72) < 0.5 and abs(o.y - 92) < 0.5  # same baseline as the original
    # "World" sat at about x 140..200; the replacement is shorter, so that area must be blank now.
    pix = page.get_pixmap(dpi=144)
    dark = sum(1 for x in range(165, 205) for y in range(72, 97)
               if sum(pix.pixel(x * 2, y * 2)[:3]) < 300)
    assert dark == 0
    # And the replacement itself is drawn.
    assert sum(pixel(page, x, 85) < (100, 100, 100) for x in range(72, 100)) > 0


def test_cover_is_drawn_under_later_objects(tmp_path):
    doc = apply(tmp_path, sample_pdf(), [
        {"page": 0, "type": "rect", "x": 60, "y": 60, "w": 40, "h": 40, "fill": "#0000ff", "stroke": None},
        {"page": 0, "type": "text", "x": 300, "y": 300, "size": 12, "text": "x", "cover": cover_box()},
    ])
    assert close(pixel(doc[0], 80, 80), (0, 0, 255))


def cover_box():
    return {"x": 50, "y": 50, "w": 200, "h": 60, "color": "#ffffff"}


def test_image_count_and_placement(tmp_path):
    img = png_file(tmp_path)
    doc = apply(tmp_path, sample_pdf(), [
        {"page": 0, "type": "image", "x": 300, "y": 400, "w": 120, "h": 60, "mime": "image/png",
         "bytes": {"$file": img}},
        {"page": 0, "type": "image", "x": 50, "y": 500, "w": 40, "h": 20, "mime": "image/png",
         "bytes": {"$file": img}},
    ])
    page = doc[0]
    assert len(page.get_images()) >= 1
    rects = page.get_image_rects(page.get_images()[0][0])
    assert any(abs(r.x0 - 300) < 0.5 and abs(r.y0 - 400) < 0.5 and abs(r.width - 120) < 0.5 for r in rects)
    assert close(pixel(page, 360, 430), (0, 160, 0))


def test_jpeg_image(tmp_path):
    p = tmp_path / "photo.jpg"
    Image.new("RGB", (30, 30), (200, 30, 30)).save(p, "JPEG")
    doc = apply(tmp_path, sample_pdf(), [
        {"page": 0, "type": "image", "x": 10, "y": 10, "w": 50, "h": 50, "mime": "image/jpeg",
         "bytes": {"$file": str(p)}},
    ])
    assert len(doc[0].get_images()) == 1
    assert close(pixel(doc[0], 35, 35), (200, 30, 30))


def test_shapes_highlight_whiteout_and_pen(tmp_path):
    doc = apply(tmp_path, sample_pdf(), [
        {"page": 0, "type": "rect", "x": 300, "y": 100, "w": 80, "h": 50, "fill": "#ff0000",
         "stroke": "#000000", "strokeWidth": 2},
        {"page": 0, "type": "ellipse", "x": 400, "y": 100, "w": 80, "h": 50, "fill": None,
         "stroke": "#0000ff", "strokeWidth": 3},
        {"page": 0, "type": "line", "x1": 300, "y1": 200, "x2": 500, "y2": 200, "stroke": "#00aa00",
         "strokeWidth": 4},
        {"page": 0, "type": "arrow", "x1": 300, "y1": 250, "x2": 500, "y2": 250, "stroke": "#000000",
         "strokeWidth": 2},
        {"page": 0, "type": "highlight", "x": 70, "y": 185, "w": 160, "h": 18, "color": "#ffe94d",
         "opacity": 0.5},
        {"page": 0, "type": "whiteout", "x": 140, "y": 180, "w": 100, "h": 30},
        {"page": 0, "type": "pen", "paths": [[300, 400, 350, 450, 400, 400], [420, 400]],
         "stroke": "#aa00aa", "strokeWidth": 3},
    ])
    page = doc[0]
    assert close(pixel(page, 340, 125), (255, 0, 0))          # rect fill
    assert close(pixel(page, 400, 200), (0, 170, 0), 60)      # line
    assert close(pixel(page, 440, 125), (255, 255, 255))      # ellipse has no fill
    drawings = page.get_drawings()
    colors = {tuple(round(c, 2) for c in d["color"]) for d in drawings if d.get("color")}
    assert (0.0, 0.0, 1.0) in colors                           # ellipse stroke
    assert any(d.get("fill") == (0.0, 0.0, 0.0) and d["rect"].x1 > 495 for d in drawings)  # arrow head
    assert (0.67, 0.0, 0.67) in colors                         # pen
    # Highlight: yellow where there's no text; body text under it still dark (multiply blend).
    assert close(pixel(page, 75, 188), (255, 244, 166), 50)
    text_rect = page.search_for("Body text")[0]
    pix = page.get_pixmap(dpi=144)
    darkest = min(sum(pix.pixel(int(x * 2), int(y * 2))[:3])
                  for x in range(int(text_rect.x0), int(text_rect.x0) + 40)
                  for y in range(int(text_rect.y0), int(text_rect.y1)))
    assert darkest < 200
    # White-out hides the rest of the body text.
    assert all(pixel(page, x, 196) == (255, 255, 255) for x in range(150, 230, 3))


@pytest.mark.parametrize("rotation", [90, 180, 270])
def test_rotated_pages_use_displayed_coordinates(tmp_path, rotation):
    doc = apply(tmp_path, sample_pdf(rotation=rotation), [
        {"page": 0, "type": "rect", "x": 50, "y": 60, "w": 100, "h": 40, "fill": "#0000ff", "stroke": None},
        {"page": 0, "type": "text", "x": 200, "y": 300, "size": 18, "text": "Rotated ok", "font": "sans"},
        {"page": 0, "type": "line", "x1": 300, "y1": 100, "x2": 400, "y2": 100, "stroke": "#ff0000",
         "strokeWidth": 6},
    ])
    page = doc[0]
    assert page.rotation == rotation
    assert close(pixel(page, 100, 80), (0, 0, 255))
    assert close(pixel(page, 40, 80), (255, 255, 255))
    assert close(pixel(page, 100, 110), (255, 255, 255))
    assert close(pixel(page, 350, 100), (255, 0, 0), 60)
    o = span_origin(page, "Rotated ok")
    assert abs(o.x - 200) < 0.5 and abs(o.y - (300 + SANS_BASELINE * 18)) < 0.5
    # The text reads upright for the reader: its line direction is +x in displayed space.
    line = next(l for b in page.get_text("dict")["blocks"] for l in b.get("lines", [])
                if "Rotated" in l["spans"][0]["text"])
    d = pymupdf.Point(line["dir"]) * pymupdf.Matrix(page.rotation_matrix.a, page.rotation_matrix.b,
                                                    page.rotation_matrix.c, page.rotation_matrix.d, 0, 0)
    assert d.x > 0.99


def test_unencodable_text_needs_a_raster(tmp_path):
    with pytest.raises(RuntimeError, match="USER_ERROR.*image"):
        apply(tmp_path, sample_pdf(), [{"page": 0, "type": "text", "x": 10, "y": 10, "size": 12,
                                        "text": "नमस्ते"}])
    img = png_file(tmp_path, (300, 60), (20, 20, 20, 255), "raster.png")
    doc = apply(tmp_path, sample_pdf(), [{"page": 0, "type": "text", "x": 10, "y": 10, "size": 12,
                                          "text": "नमस्ते", "raster": {"bytes": {"$file": img}, "w": 75, "h": 15}}])
    assert len(doc[0].get_images()) == 1
    assert close(pixel(doc[0], 40, 17), (20, 20, 20))


def test_other_pages_untouched_and_errors(tmp_path):
    doc = apply(tmp_path, sample_pdf(pages=3), [
        {"page": 1, "type": "text", "x": 100, "y": 100, "size": 12, "text": "Only on two"},
    ])
    assert "Only on two" in doc[1].get_text()
    assert "Only on two" not in doc[0].get_text() + doc[2].get_text()
    with pytest.raises(RuntimeError, match="USER_ERROR.*at least one change"):
        apply(tmp_path, sample_pdf(), [])
    with pytest.raises(RuntimeError, match="USER_ERROR.*Page 5"):
        apply(tmp_path, sample_pdf(), [{"page": 4, "type": "whiteout", "x": 0, "y": 0, "w": 1, "h": 1}])
