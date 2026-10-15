"""
Correctness tests: check that each tool actually does what it says,
not just that it returns a valid file.  Run with:  python3 -m pytest tests
"""

import io
import os
import random
import sys

import pymupdf
import pdf_engine as pdf_engine_module
import pytest
from PIL import Image
from pypdf import PdfReader
from reportlab.pdfgen import canvas

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pdf_engine import PDFEngine  # noqa: E402


def all_text(pdf_bytes: bytes) -> str:
    """Text as seen by two independent extractors, so a tool can't fool just one."""
    doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    a = "\n".join(page.get_text() for page in doc)
    b = "\n".join((p.extract_text() or "") for p in PdfReader(io.BytesIO(pdf_bytes)).pages)
    return a + "\n" + b


def text_pdf(pages=3) -> bytes:
    buf = io.BytesIO()
    c = canvas.Canvas(buf)
    for p in range(1, pages + 1):
        c.setFont("Helvetica", 14)
        c.drawString(72, 750, f"Test page {p}")
        c.drawString(72, 700, f"Email: secret-user-{p}@enterprise.io")
        c.drawString(72, 650, "Phone: (555) 019-2834")
        c.drawString(72, 600, "Project Nightingale budget is confidential.")
        c.drawString(72, 550, "Quarterly growth metrics stay visible.")
        c.showPage()
    c.setAuthor("Project Nightingale team")
    c.save()
    return buf.getvalue()


def scanned_pdf() -> bytes:
    """A PDF whose only page is a 300 dpi picture of text (no text layer)."""
    src = pymupdf.open()
    page = src.new_page(width=612, height=792)
    page.insert_text((72, 120), "INVOICE NUMBER 48213", fontsize=28)
    page.insert_text((72, 180), "Total due seven hundred dollars", fontsize=22)
    pix = page.get_pixmap(dpi=300)
    out = pymupdf.open()
    p = out.new_page(width=612, height=792)
    p.insert_image(p.rect, stream=pix.tobytes("png"))
    data = out.tobytes()
    assert not pymupdf.open(stream=data, filetype="pdf")[0].get_text().strip()
    return data


def photo_pdf() -> bytes:
    """A PDF with one large, noisy, high-dpi photo, like a phone scan."""
    rnd = random.Random(7)
    img = Image.new("RGB", (2400, 3000))
    px = img.load()
    for y in range(0, 3000, 2):
        for x in range(0, 2400, 2):
            v = (x * 255 // 2400, y * 255 // 3000, rnd.randint(0, 255))
            px[x, y] = v
            px[x + 1, y] = v
            px[x, y + 1] = v
            px[x + 1, y + 1] = v
    jpg = io.BytesIO()
    img.save(jpg, format="JPEG", quality=95)
    doc = pymupdf.open()
    page = doc.new_page(width=612, height=792)
    page.insert_image(page.rect, stream=jpg.getvalue())
    page.insert_text((72, 72), "Caption text must survive", fontsize=12)
    return doc.tobytes()


def form_pdf() -> bytes:
    doc = pymupdf.open()
    page = doc.new_page()
    w = pymupdf.Widget()
    w.field_name = "full_name"
    w.field_type = pymupdf.PDF_WIDGET_TYPE_TEXT
    w.rect = pymupdf.Rect(72, 100, 372, 130)
    w.field_value = "Jane Q Public"
    page.add_widget(w)
    page.add_freetext_annot(pymupdf.Rect(72, 200, 372, 240), "Approved by reviewer", fontsize=12)
    return doc.tobytes()


# ---------- Redaction ----------

def test_redaction_removes_text_not_just_covers_it():
    src = text_pdf()
    out, count = PDFEngine.redact(src, keywords=["Nightingale"], redact_emails=True, redact_phones=True)
    text = all_text(out)
    assert count >= 9  # 3 pages x (email + phone + keyword)
    for p in (1, 2, 3):
        assert f"secret-user-{p}@enterprise.io" not in text
    assert "019-2834" not in text
    assert "nightingale" not in text.lower()
    # Raw bytes must not hide the data either (e.g. in an old content stream).
    raw = pymupdf.open(stream=out, filetype="pdf")
    for xref in range(1, raw.xref_length()):
        if raw.xref_is_stream(xref):
            assert b"enterprise.io" not in (raw.xref_stream(xref) or b"")
    # Untouched text stays.
    assert "Quarterly growth metrics stay visible." in text


def test_redaction_scrubs_metadata():
    out, _ = PDFEngine.redact(text_pdf(), keywords=["Nightingale"])
    meta = pymupdf.open(stream=out, filetype="pdf").metadata
    assert "Nightingale" not in (meta.get("author") or "")


def test_redaction_draws_black_box():
    out, _ = PDFEngine.redact(text_pdf(1), keywords=["Nightingale"])
    page = pymupdf.open(stream=out, filetype="pdf")[0]
    box = pymupdf.open(stream=text_pdf(1), filetype="pdf")[0].search_for("Nightingale")[0]
    pix = page.get_pixmap(clip=box + (2, 2, -2, -2))
    dark = sum(1 for i in range(0, len(pix.samples), pix.n) if pix.samples[i] < 40)
    assert dark > 0.8 * pix.width * pix.height


def test_redaction_without_matches_keeps_text():
    out, count = PDFEngine.redact(text_pdf(1), keywords=["zzz-not-there"])
    assert count == 0
    assert "secret-user-1@enterprise.io" in all_text(out)


def test_pipeline_redact_accepts_comma_string():
    out = PDFEngine.execute_pipeline(text_pdf(1), [{"action": "redact", "keywords": "Nightingale, growth"}])
    text = all_text(out).lower()
    assert "nightingale" not in text and "growth" not in text


# ---------- OCR ----------

@pytest.mark.skipif(not PDFEngine.ocr_available(), reason="tesseract/ocrmypdf not installed")
def test_ocr_makes_scanned_text_searchable():
    out = PDFEngine.ocr_searchable(scanned_pdf())
    text = all_text(out).upper()
    assert "INVOICE" in text and "48213" in text


@pytest.mark.skipif(not PDFEngine.ocr_available(), reason="tesseract/ocrmypdf not installed")
def test_ocr_keeps_existing_text_pages():
    src = text_pdf(1)
    out = PDFEngine.ocr_searchable(src)
    assert "Quarterly growth metrics stay visible." in all_text(out)


@pytest.mark.skipif(pdf_engine_module._find_tessdata() is None, reason="no Tesseract language files")
@pytest.mark.parametrize("rotation", [0, 90])
def test_ocr_without_ghostscript_places_words(monkeypatch, rotation):
    # Windows machines often have Tesseract but not Ghostscript; OCR must still work.
    monkeypatch.setattr(PDFEngine, "_ocrmypdf_ready", staticmethod(lambda: False))
    doc = pymupdf.open(stream=scanned_pdf(), filetype="pdf")
    if rotation:
        # A scan stored sideways, with /Rotate turning it upright for display.
        img = doc.extract_image(doc[0].get_images()[0][0])["image"]
        doc = pymupdf.open()
        p = doc.new_page(width=792, height=612)
        p.insert_image(p.rect, stream=img, rotate=rotation)
        p.set_rotation(rotation)
    out = pymupdf.open(stream=PDFEngine.ocr_searchable(doc.tobytes()), filetype="pdf")
    page = out[0]
    assert "INVOICE" in page.get_text().upper() and "48213" in page.get_text()
    # The invisible word sits where the picture of it is: compare with the scan's own OCR.
    # Both rects are compared as the reader sees the page.
    hit = page.search_for("48213")[0] * page.rotation_matrix
    tp = page.get_textpage_ocr(full=True, tessdata=pdf_engine_module._find_tessdata())
    seen = pymupdf.Rect([w for w in page.get_text("words", textpage=tp) if "48213" in w[4]][0][:4]) * page.rotation_matrix
    assert all(abs(a - b) < 6 for a, b in zip((hit.x0, hit.x1), (seen.x0, seen.x1))), (hit, seen)
    assert seen.y0 - 6 < (hit.y0 + hit.y1) / 2 < seen.y1 + 6, (hit, seen)
    assert len(page.get_images()) == 1


def test_ocr_rejects_bad_language():
    if not PDFEngine.ocr_available():
        pytest.skip("tesseract/ocrmypdf not installed")
    with pytest.raises(ValueError):
        PDFEngine.ocr_searchable(text_pdf(1), language="eng; rm -rf /")


# ---------- Flatten ----------

def test_flatten_keeps_form_values_and_annotations_visible():
    out = PDFEngine.flatten(form_pdf())
    doc = pymupdf.open(stream=out, filetype="pdf")
    page = doc[0]
    assert list(page.widgets()) == []
    assert list(page.annots()) == []
    text = page.get_text()
    assert "Jane Q Public" in text
    assert "Approved by reviewer" in text


# ---------- Compress ----------

def test_compress_levels_differ_and_shrink_images():
    src = photo_pdf()
    low = PDFEngine.compress(src, "low")
    med = PDFEngine.compress(src, "medium")
    ext = PDFEngine.compress(src, "extreme")
    assert len(low) <= len(src)
    assert len(med) < len(low)
    assert len(ext) < len(med)
    assert len(ext) < len(src) / 3
    for out in (low, med, ext):
        assert "Caption text must survive" in all_text(out)


def test_compress_downsamples_to_target_dpi():
    ext = PDFEngine.compress(photo_pdf(), "extreme")
    doc = pymupdf.open(stream=ext, filetype="pdf")
    info = doc[0].get_image_info()[0]
    dpi = info["width"] / (info["bbox"][2] - info["bbox"][0]) * 72
    assert dpi <= 100


def test_compress_never_grows_file():
    src = text_pdf(1)
    assert len(PDFEngine.compress(src, "extreme")) <= len(src)


def test_compress_rejects_unknown_level():
    with pytest.raises(ValueError):
        PDFEngine.compress(text_pdf(1), "ultra")


# ---------- Protect ----------

def test_protect_uses_aes256_and_requires_password():
    out = PDFEngine.protect(text_pdf(1), "pw123")
    reader = PdfReader(io.BytesIO(out))
    assert reader.is_encrypted
    encrypt = reader.trailer["/Encrypt"]
    assert encrypt["/V"] == 5 and encrypt["/CF"]["/StdCF"]["/CFM"] == "/AESV3"  # AES-256
    with pytest.raises(ValueError):
        PDFEngine.unlock(out, "wrong")
    assert "Test page 1" in all_text(PDFEngine.unlock(out, "pw123"))


# ---------- Organize tools (server copies, kept for the API) ----------

def page_titles(pdf_bytes):
    return [p.extract_text().splitlines()[0] for p in PdfReader(io.BytesIO(pdf_bytes)).pages]


def test_reorder_and_split_put_pages_in_the_right_place():
    src = text_pdf(3)
    assert page_titles(PDFEngine.reorder(src, [3, 1, 2])) == ["Test page 3", "Test page 1", "Test page 2"]
    assert page_titles(PDFEngine.split(src, "2-3")) == ["Test page 2", "Test page 3"]


def test_rotate_only_requested_pages():
    out = PDFEngine.rotate(text_pdf(3), 90, [2])
    assert [p.rotation for p in PdfReader(io.BytesIO(out)).pages] == [0, 90, 0]
