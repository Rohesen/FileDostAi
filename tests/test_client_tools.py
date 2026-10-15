"""
Checks the in-browser tools (static/client-tools.js) by running them under Node
and reading the results back with PyMuPDF / pypdf.
"""

import io
import json
import os
import shutil
import subprocess
import zipfile

import pymupdf
import pytest
from PIL import Image
from pypdf import PdfReader
from reportlab.pdfgen import canvas

HERE = os.path.dirname(os.path.abspath(__file__))
HARNESS = os.path.join(HERE, "client_harness.js")

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")


def numbered_pdf(pages=4) -> bytes:
    buf = io.BytesIO()
    c = canvas.Canvas(buf)
    for p in range(1, pages + 1):
        c.drawString(72, 750, f"Original page {p}")
        c.showPage()
    c.save()
    return buf.getvalue()


def run(tmp_path, op, inputs, **opts):
    paths = []
    for i, (name, data) in enumerate(inputs):
        p = tmp_path / f"in{i}_{name}"
        p.write_bytes(data)
        paths.append(str(p))
    out = tmp_path / "out.bin"
    proc = subprocess.run(["node", HARNESS, op, str(out), json.dumps(opts), *paths],
                          capture_output=True, text=True, timeout=60)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip())
    return out.read_bytes(), json.loads(proc.stdout)


def titles(pdf_bytes):
    return [p.extract_text().splitlines()[0] for p in PdfReader(io.BytesIO(pdf_bytes)).pages]


def test_merge_keeps_order(tmp_path):
    a, b = numbered_pdf(2), numbered_pdf(3)
    out, _ = run(tmp_path, "merge", [("a.pdf", a), ("b.pdf", b)])
    assert titles(out) == ["Original page 1", "Original page 2",
                           "Original page 1", "Original page 2", "Original page 3"]


def test_split_ranges(tmp_path):
    out, meta = run(tmp_path, "split", [("a.pdf", numbered_pdf(5))], ranges="2-3, 5")
    assert meta["mime"] == "application/pdf"
    assert titles(out) == ["Original page 2", "Original page 3", "Original page 5"]


def test_split_all_makes_one_pdf_per_page(tmp_path):
    out, meta = run(tmp_path, "split", [("a.pdf", numbered_pdf(3))], ranges="all")
    assert meta["mime"] == "application/zip"
    with zipfile.ZipFile(io.BytesIO(out)) as z:
        names = sorted(z.namelist())
        assert names == ["page_1.pdf", "page_2.pdf", "page_3.pdf"]
        assert titles(z.read("page_2.pdf")) == ["Original page 2"]


def test_split_rejects_missing_page(tmp_path):
    with pytest.raises(RuntimeError, match="USER_ERROR.*3 pages"):
        run(tmp_path, "split", [("a.pdf", numbered_pdf(3))], ranges="2-9")


def test_reorder(tmp_path):
    out, _ = run(tmp_path, "reorder", [("a.pdf", numbered_pdf(3))], order="3,1,2")
    assert titles(out) == ["Original page 3", "Original page 1", "Original page 2"]


def test_remove_pages(tmp_path):
    out, _ = run(tmp_path, "remove", [("a.pdf", numbered_pdf(4))], pages="2,4")
    assert titles(out) == ["Original page 1", "Original page 3"]


def test_rotate_selected_pages_adds_to_existing_rotation(tmp_path):
    first, _ = run(tmp_path, "rotate", [("a.pdf", numbered_pdf(3))], angle=90, pages="1,3")
    second, _ = run(tmp_path, "rotate", [("b.pdf", first)], angle=270, pages="3")
    assert [p.rotation for p in PdfReader(io.BytesIO(second)).pages] == [90, 0, 0]


def test_watermark_text_is_on_every_page_and_centred(tmp_path):
    out, _ = run(tmp_path, "watermark", [("a.pdf", numbered_pdf(2))], text="DRAFT", angle=0, fontSize=40)
    doc = pymupdf.open(stream=out, filetype="pdf")
    for page in doc:
        hits = page.search_for("DRAFT")
        assert hits, "watermark missing"
        centre = (hits[0].x0 + hits[0].x1) / 2
        assert abs(centre - page.rect.width / 2) < 5
        assert "Original page" in page.get_text()


def test_page_numbers(tmp_path):
    out, _ = run(tmp_path, "page-numbers", [("a.pdf", numbered_pdf(3))],
                 format="{n} / {total}", position="top-right")
    doc = pymupdf.open(stream=out, filetype="pdf")
    for i, page in enumerate(doc, start=1):
        hit = page.search_for(f"{i} / 3")[0]
        assert hit.x1 > page.rect.width - 60 and hit.y0 < 60


def test_unencodable_text_gives_clear_error(tmp_path):
    with pytest.raises(RuntimeError, match="USER_ERROR"):
        run(tmp_path, "watermark", [("a.pdf", numbered_pdf(1))], text="机密")


def test_encrypted_pdf_is_refused(tmp_path):
    from pypdf import PdfWriter
    w = PdfWriter(clone_from=PdfReader(io.BytesIO(numbered_pdf(1))))
    w.encrypt("pw", algorithm="AES-256")
    buf = io.BytesIO()
    w.write(buf)
    with pytest.raises(RuntimeError, match="password protected"):
        run(tmp_path, "rotate", [("a.pdf", buf.getvalue())], angle=90)


def test_images_to_pdf(tmp_path):
    def img(fmt, size):
        b = io.BytesIO()
        Image.new("RGB", size, (200, 30, 30)).save(b, format=fmt)
        return b.getvalue()
    out, _ = run(tmp_path, "img-to-pdf", [("a.png", img("PNG", (400, 200))), ("b.jpg", img("JPEG", (200, 400)))])
    doc = pymupdf.open(stream=out, filetype="pdf")
    assert [(round(p.rect.width), round(p.rect.height)) for p in doc] == [(300, 150), (150, 300)]
    assert all(len(p.get_images()) == 1 for p in doc)


@pytest.mark.parametrize("spec,total,expected", [
    ("1-3, 5", 6, [0, 1, 2, 4]),
    ("all", 3, [0, 1, 2]),
    ("4-", 6, [3, 4, 5]),
    ("3-1", 3, [2, 1, 0]),
    ("2,2", 3, [1]),
])
def test_parse_page_list(tmp_path, spec, total, expected):
    proc = subprocess.run(["node", HARNESS, "parse", "-", json.dumps({"spec": spec, "total": total})],
                          capture_output=True, text=True, timeout=30)
    assert json.loads(proc.stdout) == expected


# ---------- Page grid (assemble), metadata and signing ----------

def test_assemble_mixes_files_reorders_rotates_and_duplicates(tmp_path):
    a, b = numbered_pdf(2), numbered_pdf(3)
    plan = [{"file": 1, "page": 2, "rotate": 90}, {"file": 0, "page": 0, "rotate": 0},
            {"file": 1, "page": 2, "rotate": 0}, {"file": 0, "page": 1, "rotate": 270}]
    out, _ = run(tmp_path, "assemble", [("a.pdf", a), ("b.pdf", b)], plan=plan)
    reader = PdfReader(io.BytesIO(out))
    assert titles(out) == ["Original page 3", "Original page 1", "Original page 3", "Original page 2"]
    # The duplicated page must not share the rotation of its twin.
    assert [p.rotation for p in reader.pages] == [90, 0, 0, 270]


def test_assemble_rejects_bad_page(tmp_path):
    with pytest.raises(RuntimeError, match="USER_ERROR"):
        run(tmp_path, "assemble", [("a.pdf", numbered_pdf(2))], plan=[{"file": 0, "page": 5, "rotate": 0}])


def test_edit_metadata_round_trip(tmp_path):
    out, _ = run(tmp_path, "edit-metadata", [("a.pdf", numbered_pdf(1))],
                 title="Annual Report", author="Rohesen", subject="Finance", keywords="audit, 2026")
    meta = PdfReader(io.BytesIO(out)).metadata
    assert meta.title == "Annual Report" and meta.author == "Rohesen" and meta.subject == "Finance"
    assert "audit" in meta["/Keywords"] and "2026" in meta["/Keywords"]
    p = tmp_path / "m.pdf"
    p.write_bytes(out)
    proc = subprocess.run(["node", HARNESS, "get-metadata", "-", "{}", str(p)], capture_output=True, text=True)
    got = json.loads(proc.stdout)
    assert got["title"] == "Annual Report" and got["pages"] == 1


def red_png(tmp_path):
    path = tmp_path / "sig.png"
    Image.new("RGB", (200, 100), (255, 0, 0)).save(path)
    return str(path)


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
def test_signature_lands_where_the_reader_clicked(tmp_path, rotation):
    """Place a red box at the bottom-left of what the reader sees, on rotated pages too."""
    doc = pymupdf.open()
    page = doc.new_page(width=600, height=800)
    page.set_rotation(rotation)
    src = doc.tobytes()
    placements = [{"page": 0, "x": 50, "y": 60, "width": 100, "height": 50}]
    out, _ = run(tmp_path, "stamp", [("a.pdf", src)], image=red_png(tmp_path), placements=placements)
    shown = pymupdf.open(stream=out, filetype="pdf")[0]
    pix = shown.get_pixmap(dpi=72)
    W, H = pix.width, pix.height

    def red(x, y):
        r, g, b = pix.pixel(int(x), int(y))[:3]
        return r > 200 and g < 60 and b < 60

    # Viewer coordinates: x from the left, y from the top.
    assert red(100, H - 85), f"centre of signature not red at rotation {rotation}"
    assert red(55, H - 65) and red(145, H - 105)
    assert not red(40, H - 85) and not red(160, H - 85) and not red(100, H - 120)


# ---------- Crop, resize, headers and footers, invert ----------

def marked_pdf(rotation=0) -> bytes:
    """One A4 page (as the reader sees it, portrait) with a red square near the top-left
    and a blue square near the bottom-right, whatever the page's /Rotate."""
    doc = pymupdf.open()
    w, h = (842, 595) if rotation % 180 else (595, 842)
    page = doc.new_page(width=w, height=h)
    page.set_rotation(rotation)
    to_page = page.derotation_matrix
    page.draw_rect(pymupdf.Rect(40, 40, 140, 140) * to_page, color=None, fill=(1, 0, 0))
    page.draw_rect(pymupdf.Rect(455, 702, 555, 802) * to_page, color=None, fill=(0, 0, 1))
    return doc.tobytes()


def colours(pdf_bytes, index=0):
    """Rendered size and how many clearly red / blue pixels sit in each half of the page."""
    page = pymupdf.open(stream=pdf_bytes, filetype="pdf")[index]
    pix = page.get_pixmap(dpi=36)
    img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
    found = {"red": [], "blue": []}
    for y in range(img.height):
        for x in range(img.width):
            r, g, b = img.getpixel((x, y))
            if r > 200 and g < 60 and b < 60:
                found["red"].append((x / img.width, y / img.height))
            if b > 200 and r < 60 and g < 60:
                found["blue"].append((x / img.width, y / img.height))
    return (page.rect.width, page.rect.height), found, img


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
def test_crop_keeps_the_area_the_reader_chose(tmp_path, rotation):
    out, _ = run(tmp_path, "crop", [("m.pdf", marked_pdf(rotation))], left=0, top=0, right=0.5, bottom=0.5)
    (w, h), found, _ = colours(out)
    assert abs(w - 297.6) < 2 and abs(h - 421) < 2, (w, h)
    assert found["red"] and not found["blue"]
    assert all(x < 0.6 and y < 0.6 for x, y in found["red"])


@pytest.mark.parametrize("rotation", [0, 90])
def test_resize_to_letter_keeps_orientation(tmp_path, rotation):
    out, _ = run(tmp_path, "resize", [("m.pdf", marked_pdf(rotation))], size="letter")
    (w, h), found, _ = colours(out)
    assert (round(w), round(h)) == (612, 792)
    assert all(x < 0.5 and y < 0.5 for x, y in found["red"]) and found["red"]
    assert all(x > 0.5 and y > 0.5 for x, y in found["blue"]) and found["blue"]


def test_resize_landscape_page_to_a4_auto_turns_paper(tmp_path):
    doc = pymupdf.open()
    doc.new_page(width=800, height=400).insert_text((50, 200), "Wide page", fontsize=30)
    out, _ = run(tmp_path, "resize", [("w.pdf", doc.tobytes())], size="a4")
    page = pymupdf.open(stream=out, filetype="pdf")[0]
    assert round(page.rect.width) == 842 and round(page.rect.height) == 595
    assert "Wide page" in page.get_text()


@pytest.mark.parametrize("rotation", [0, 90, 270])
def test_header_and_footer_sit_upright_at_top_and_bottom(tmp_path, rotation):
    out, _ = run(tmp_path, "header-footer", [("m.pdf", marked_pdf(rotation))],
                 header={"right": "ACME Report"}, footer={"center": "Page {n} of {total}"}, firstNumber=5)
    page = pymupdf.open(stream=out, filetype="pdf")[0]
    head = page.search_for("ACME Report")[0] * page.rotation_matrix
    foot = page.search_for("Page 5 of 1")[0] * page.rotation_matrix
    assert head.y1 < 80 and head.x1 > 595 - 80, head
    assert foot.y0 > 842 - 80 and abs((foot.x0 + foot.x1) / 2 - 297.5) < 10, foot
    assert head.width > head.height  # reads left to right, not sideways


def test_header_footer_skips_cover_page(tmp_path):
    out, _ = run(tmp_path, "header-footer", [("n.pdf", numbered_pdf(3))], footer={"right": "{n}"}, skipFirst=True)
    pages = [p.extract_text() for p in PdfReader(io.BytesIO(out)).pages]
    assert "2" in pages[1] and "3" in pages[2] and pages[0].strip() == "Original page 1"


def test_header_footer_needs_text(tmp_path):
    with pytest.raises(RuntimeError, match="USER_ERROR"):
        run(tmp_path, "header-footer", [("n.pdf", numbered_pdf(1))])


def test_invert_turns_white_black_and_keeps_text(tmp_path):
    doc = pymupdf.open(stream=marked_pdf(0), filetype="pdf")
    doc[0].insert_text((200, 400), "Still selectable", fontsize=20)
    out, _ = run(tmp_path, "invert", [("m.pdf", doc.tobytes())])
    _, found, img = colours(out)
    corner = img.getpixel((img.width // 2, img.height - 5))
    assert max(corner) < 30, corner              # white paper is now black
    assert not found["red"]                      # red became cyan
    assert "Still selectable" in pymupdf.open(stream=out, filetype="pdf")[0].get_text()
