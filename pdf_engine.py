"""
UltraPDF Engine - High-Performance In-Memory PDF Processing Library.
Provides robust operations using PyPDF, PyMuPDF, ReportLab, Pillow, and python-docx.
OCR uses OCRmyPDF + Tesseract when they are installed.
"""

import io
import os
import re
import math
import warnings
import zipfile
from typing import List, Dict, Any, Optional, Tuple

import pypdf
from pypdf import PdfReader, PdfWriter
from reportlab.pdfgen import canvas
from reportlab.lib import colors
from PIL import Image
from docx import Document
import pymupdf


# Image "decompression bombs": a tiny PNG can claim to be 100,000 x 100,000 pixels and eat
# tens of GB when opened. Pillow refuses anything over twice this limit; over the limit
# itself it only warns, so that warning is made an error too.
Image.MAX_IMAGE_PIXELS = 60_000_000
warnings.simplefilter("error", Image.DecompressionBombWarning)

MAX_PIPELINE_STEPS = 20
MAX_PAGE_LIST = 10_000


class ToolUnavailableError(RuntimeError):
    """Raised when an optional system dependency (e.g. Tesseract) is missing."""


# Image settings per compression level: (dpi above which images are downsampled,
# target dpi, JPEG quality). None means images are left untouched (lossless only).
COMPRESSION_PROFILES = {
    "low": None,
    "medium": (165, 150, 75),
    "extreme": (90, 72, 45),
}

EMAIL_PATTERN = r"[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+"
PHONE_PATTERN = r"(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}"



def _add_windows_ocr_paths() -> None:
    """On Windows, finds Tesseract and Ghostscript in their usual install folders even when
    the installer didn't add them to PATH."""
    if os.name != "nt":
        return
    import glob
    import shutil
    roots = [os.environ.get("ProgramFiles", r"C:\Program Files"), os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"),
             os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs")]
    extra = []
    if not shutil.which("tesseract"):
        extra += [os.path.join(r, "Tesseract-OCR") for r in roots]
    if not (shutil.which("gswin64c") or shutil.which("gswin32c")):
        extra += sorted(glob.glob(os.path.join(roots[0], "gs", "gs*", "bin")), reverse=True)
    found = [d for d in extra if os.path.isdir(d)]
    if found:
        os.environ["PATH"] = os.pathsep.join(found + [os.environ.get("PATH", "")])


def _find_tessdata() -> Optional[str]:
    """Folder holding Tesseract's *.traineddata language files, or None."""
    import glob
    import shutil
    _add_windows_ocr_paths()
    candidates = [os.environ.get("TESSDATA_PREFIX", "")]
    exe = shutil.which("tesseract")
    if exe:
        candidates.append(os.path.join(os.path.dirname(os.path.realpath(exe)), "tessdata"))
    candidates += sorted(glob.glob("/usr/share/tesseract-ocr/*/tessdata"), reverse=True)
    candidates += ["/usr/share/tessdata", "/usr/local/share/tessdata", "/opt/homebrew/share/tessdata"]
    for c in candidates:
        if c and glob.glob(os.path.join(c, "*.traineddata")):
            return c
    return None


def _ocr_with_pymupdf(pdf_bytes: bytes, language: str, force: bool) -> bytes:
    """OCR without Ghostscript: reads each scanned page with PyMuPDF's Tesseract and writes
    the words back as invisible text in their places, leaving the page itself untouched."""
    tessdata = _find_tessdata()
    missing = [l for l in language.split("+") if not os.path.exists(os.path.join(tessdata, f"{l}.traineddata"))]
    if missing:
        raise ValueError(f"The language pack for '{missing[0]}' isn't installed on this server.")
    try:
        doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    except Exception:
        raise ValueError("This file doesn't look like a valid PDF.")
    if doc.needs_pass:
        raise ValueError("This PDF is password protected. Unlock it before running OCR.")
    for page in doc:
        if not force and page.get_text().strip():
            continue
        # 300 dpi, but never more than ~60 megapixels for one page (a poster-sized page
        # at 300 dpi would need gigabytes of memory).
        area_in = max(page.rect.width * page.rect.height / (72 * 72), 1e-6)
        dpi = max(50, min(300, int(math.sqrt(60_000_000 / area_in))))
        tp = page.get_textpage_ocr(language=language, dpi=dpi, full=True, tessdata=tessdata)
        words = page.get_text("words", textpage=tp)
        if not words:
            continue
        # Word boxes and insert_text both use unrotated page space; size and baseline are
        # worked out in the displayed (upright) orientation and mapped back.
        for *coords, word, _b, _l, _w in words:
            box = pymupdf.Rect(coords) * page.rotation_matrix
            x0, y1 = box.x0, box.y1
            size = max(box.height * 0.85, 1)
            width = pymupdf.get_text_length(word, fontname="helv", fontsize=size)
            if width > 0 and box.width > 0:
                # Fit the word's width so selecting it highlights the right area.
                size = max(min(size * box.width / width, box.height * 1.5), 1)
            origin = pymupdf.Point(x0, y1 - box.height * 0.2) * page.derotation_matrix
            page.insert_text(origin, word, fontname="helv", fontsize=size, render_mode=3,
                             rotate=page.rotation)
    out = doc.tobytes(garbage=3, deflate=True)
    doc.close()
    return out

class PDFEngine:

    @staticmethod
    def merge(pdf_bytes_list: List[bytes]) -> bytes:
        """Merges multiple PDF byte buffers in order."""
        writer = PdfWriter()
        for b in pdf_bytes_list:
            reader = PdfReader(io.BytesIO(b))
            for page in reader.pages:
                writer.add_page(page)
        output = io.BytesIO()
        writer.write(output)
        return output.getvalue()

    @staticmethod
    def split(pdf_bytes: bytes, page_ranges: str) -> bytes:
        """
        Splits a PDF according to page ranges (e.g. '1-2, 4, 6-8')
        or creates a zip if 'all' is specified.
        Returns a single extracted PDF or a ZIP archive containing individual PDFs.
        """
        reader = PdfReader(io.BytesIO(pdf_bytes))
        total_pages = len(reader.pages)

        if page_ranges.strip().lower() == "all":
            zip_buf = io.BytesIO()
            with zipfile.ZipFile(zip_buf, "w", zipfile.ZIP_DEFLATED) as zip_file:
                for idx, page in enumerate(reader.pages):
                    writer = PdfWriter()
                    writer.add_page(page)
                    page_buf = io.BytesIO()
                    writer.write(page_buf)
                    zip_file.writestr(f"page_{idx + 1}.pdf", page_buf.getvalue())
            return zip_buf.getvalue()

        selected_pages = []
        for part in page_ranges.split(","):
            part = part.strip()
            if not part:
                continue
            if "-" in part:
                start_str, end_str = part.split("-", 1)
                start = max(1, int(start_str.strip()))
                end = min(total_pages, int(end_str.strip()))
                for p in range(start, end + 1):
                    if (p - 1) not in selected_pages and (p - 1) < total_pages:
                        selected_pages.append(p - 1)
            else:
                p = int(part)
                if 1 <= p <= total_pages and (p - 1) not in selected_pages:
                    selected_pages.append(p - 1)

        writer = PdfWriter()
        for idx in selected_pages:
            writer.add_page(reader.pages[idx])

        output = io.BytesIO()
        writer.write(output)
        return output.getvalue()

    @staticmethod
    def reorder(pdf_bytes: bytes, new_order: List[int]) -> bytes:
        """Reorders pages based on 1-based page indices."""
        if len(new_order) > MAX_PAGE_LIST:
            raise ValueError(f"The page list is too long (over {MAX_PAGE_LIST} entries).")
        reader = PdfReader(io.BytesIO(pdf_bytes))
        writer = PdfWriter()
        for p in new_order:
            idx = p - 1
            if 0 <= idx < len(reader.pages):
                writer.add_page(reader.pages[idx])
        output = io.BytesIO()
        writer.write(output)
        return output.getvalue()

    @staticmethod
    def rotate(pdf_bytes: bytes, angle: int, page_numbers: Optional[List[int]] = None) -> bytes:
        """Rotates specified pages (1-based) or all pages by angle (90, 180, 270)."""
        reader = PdfReader(io.BytesIO(pdf_bytes))
        writer = PdfWriter()
        for idx, page in enumerate(reader.pages):
            page_num = idx + 1
            if page_numbers is None or page_num in page_numbers:
                page.rotate(angle)
            writer.add_page(page)
        output = io.BytesIO()
        writer.write(output)
        return output.getvalue()

    @staticmethod
    def _image_rewrite_options(threshold: int, target: int, quality: int):
        """MuPDF image rewrite options: bicubic downsampling to the exact target dpi,
        JPEG for colour/grey images, CCITT fax for black-and-white scans."""
        mupdf = pymupdf.mupdf
        opts = mupdf.PdfImageRewriterOptions()
        q = str(quality)
        for kind in ("color_lossless", "color_lossy", "gray_lossless", "gray_lossy"):
            setattr(opts, f"{kind}_image_recompress_method", mupdf.FZ_RECOMPRESS_JPEG)
            setattr(opts, f"{kind}_image_recompress_quality", q)
            setattr(opts, f"{kind}_image_subsample_method", mupdf.FZ_SUBSAMPLE_BICUBIC)
            setattr(opts, f"{kind}_image_subsample_threshold", threshold)
            setattr(opts, f"{kind}_image_subsample_to", target)
        # Black-and-white scans need more pixels to stay readable.
        opts.bitonal_image_recompress_method = mupdf.FZ_RECOMPRESS_FAX
        opts.bitonal_image_subsample_method = mupdf.FZ_SUBSAMPLE_AVERAGE
        opts.bitonal_image_subsample_threshold = max(threshold * 2, 300)
        opts.bitonal_image_subsample_to = max(target * 2, 200)
        return opts

    @staticmethod
    def compress(pdf_bytes: bytes, level: str = "medium") -> bytes:
        """
        Compresses a PDF.
        level 'low': lossless only (drops unused objects, deflates streams, object streams).
        level 'medium': also downsamples images above 150 dpi to 150 dpi, JPEG quality 75.
        level 'extreme': also downsamples images above 96 dpi to 72 dpi, JPEG quality 45.
        Never returns a file larger than the input.
        """
        if level not in COMPRESSION_PROFILES:
            raise ValueError(f"Unknown compression level '{level}'. Use low, medium or extreme.")
        doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
        if doc.needs_pass:
            raise ValueError("This PDF is password protected. Unlock it before compressing.")
        profile = COMPRESSION_PROFILES[level]
        if profile:
            doc.rewrite_images(options=PDFEngine._image_rewrite_options(*profile))
        result = doc.tobytes(garbage=4, deflate=True, deflate_images=True,
                             deflate_fonts=True, use_objstms=1, clean=True)
        doc.close()
        return result if len(result) < len(pdf_bytes) else pdf_bytes

    @staticmethod
    def watermark(pdf_bytes: bytes, text: str, opacity: float = 0.3, angle: float = 45.0, font_size: int = 40) -> bytes:
        """Generates a dynamic watermark overlay and merges onto all pages."""
        reader = PdfReader(io.BytesIO(pdf_bytes))
        writer = PdfWriter()

        for page in reader.pages:
            width = float(page.mediabox.width)
            height = float(page.mediabox.height)

            wm_buf = io.BytesIO()
            c = canvas.Canvas(wm_buf, pagesize=(width, height))
            c.saveState()
            c.setFillColor(colors.HexColor("#64748b"), alpha=opacity)
            c.setFont("Helvetica-Bold", font_size)
            
            c.translate(width / 2, height / 2)
            c.rotate(angle)
            text_width = c.stringWidth(text, "Helvetica-Bold", font_size)
            c.drawString(-text_width / 2, -font_size / 3, text)
            c.restoreState()
            c.showPage()
            c.save()

            wm_reader = PdfReader(io.BytesIO(wm_buf.getvalue()))
            page.merge_page(wm_reader.pages[0])
            writer.add_page(page)

        output = io.BytesIO()
        writer.write(output)
        return output.getvalue()

    @staticmethod
    def add_page_numbers(pdf_bytes: bytes, format_pattern: str = "Page {n} of {total}", position: str = "bottom-center", font_size: int = 10) -> bytes:
        """
        Adds dynamic page numbers with customizable format and placement.
        Positions: bottom-center, bottom-right, bottom-left, top-right, top-center
        """
        reader = PdfReader(io.BytesIO(pdf_bytes))
        total_pages = len(reader.pages)
        writer = PdfWriter()

        for idx, page in enumerate(reader.pages):
            current_num = idx + 1
            width = float(page.mediabox.width)
            height = float(page.mediabox.height)

            num_text = format_pattern.replace("{n}", str(current_num)).replace("{total}", str(total_pages))

            num_buf = io.BytesIO()
            c = canvas.Canvas(num_buf, pagesize=(width, height))
            c.setFont("Helvetica", font_size)
            c.setFillColor(colors.HexColor("#334155"))

            text_w = c.stringWidth(num_text, "Helvetica", font_size)
            margin = 36

            if position == "bottom-center":
                x = (width - text_w) / 2
                y = margin
            elif position == "bottom-right":
                x = width - text_w - margin
                y = margin
            elif position == "bottom-left":
                x = margin
                y = margin
            elif position == "top-right":
                x = width - text_w - margin
                y = height - margin
            elif position == "top-center":
                x = (width - text_w) / 2
                y = height - margin
            else:
                x = (width - text_w) / 2
                y = margin

            c.drawString(x, y, num_text)
            c.showPage()
            c.save()

            num_reader = PdfReader(io.BytesIO(num_buf.getvalue()))
            page.merge_page(num_reader.pages[0])
            writer.add_page(page)

        output = io.BytesIO()
        writer.write(output)
        return output.getvalue()

    @staticmethod
    def protect(pdf_bytes: bytes, user_password: str, owner_password: Optional[str] = None) -> bytes:
        """Encrypts the PDF with AES-256 password protection."""
        reader = PdfReader(io.BytesIO(pdf_bytes))
        writer = PdfWriter(clone_from=reader)

        owner_pwd = owner_password or user_password
        writer.encrypt(user_password=user_password, owner_password=owner_pwd, algorithm="AES-256")
        output = io.BytesIO()
        writer.write(output)
        return output.getvalue()

    @staticmethod
    def unlock(pdf_bytes: bytes, password: str) -> bytes:
        """Decrypts a password-protected PDF."""
        reader = PdfReader(io.BytesIO(pdf_bytes))
        if reader.is_encrypted:
            res = reader.decrypt(password)
            if res == 0:
                raise ValueError("Incorrect password provided for encrypted document.")
        writer = PdfWriter()
        for page in reader.pages:
            writer.add_page(page)
        output = io.BytesIO()
        writer.write(output)
        return output.getvalue()

    @staticmethod
    def images_to_pdf(image_files: List[Tuple[str, bytes]]) -> bytes:
        """Converts multiple image files into a PDF."""
        pil_images = []
        for filename, img_bytes in image_files:
            img = Image.open(io.BytesIO(img_bytes))
            if img.mode in ("RGBA", "P"):
                img = img.convert("RGB")
            pil_images.append(img)

        if not pil_images:
            raise ValueError("No valid images provided.")

        output = io.BytesIO()
        pil_images[0].save(output, format="PDF", save_all=True, append_images=pil_images[1:], resolution=100.0)
        return output.getvalue()

    @staticmethod
    def extract_text_and_markdown(pdf_bytes: bytes) -> Dict[str, Any]:
        """Extracts text, metadata, and generates formatted Markdown."""
        reader = PdfReader(io.BytesIO(pdf_bytes))
        pages_content = []
        full_text_parts = []
        total_words = 0

        for idx, page in enumerate(reader.pages):
            text = page.extract_text() or ""
            pages_content.append({"page": idx + 1, "text": text.strip()})
            full_text_parts.append(f"## Page {idx + 1}\n\n" + text.strip())
            total_words += len(text.split())

        title = "Extracted Document"
        if reader.metadata and reader.metadata.title:
            title = reader.metadata.title

        joined_body = "\n\n".join(full_text_parts)
        markdown = f"# {title}\n\n*Pages: {len(reader.pages)} | Words: {total_words}*\n\n---\n\n" + joined_body

        return {
            "title": title,
            "page_count": len(reader.pages),
            "word_count": total_words,
            "estimated_read_time_minutes": round(total_words / 200, 1),
            "pages": pages_content,
            "markdown": markdown,
        }

    @staticmethod
    def to_docx(pdf_bytes: bytes) -> bytes:
        """Converts PDF extracted text and structures into a Word .docx document."""
        data = PDFEngine.extract_text_and_markdown(pdf_bytes)
        doc = Document()
        doc.add_heading(data["title"], level=0)
        doc.add_paragraph(f"Extracted from PDF — Total Pages: {data['page_count']}, Words: {data['word_count']}")

        for page in data["pages"]:
            doc.add_heading(f"Page {page['page']}", level=2)
            for line in page["text"].split("\n"):
                if line.strip():
                    doc.add_paragraph(line.strip())

        out_buf = io.BytesIO()
        doc.save(out_buf)
        return out_buf.getvalue()

    @staticmethod
    def redact(pdf_bytes: bytes, keywords: List[str] = None, redact_emails: bool = False, redact_phones: bool = False) -> Tuple[bytes, int]:
        """
        True redaction: finds keywords, emails and phone numbers, draws black boxes over
        them and permanently deletes the underlying text (and image pixels) from the file.
        Matching values are also removed from the document metadata.
        Returns (pdf_bytes, number_of_redacted_areas).
        """
        patterns = []
        for kw in keywords or []:
            if kw.strip():
                patterns.append(re.compile(re.escape(kw.strip()), re.IGNORECASE))
        if redact_emails:
            patterns.append(re.compile(EMAIL_PATTERN))
        if redact_phones:
            patterns.append(re.compile(PHONE_PATTERN))

        doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
        if doc.needs_pass:
            raise ValueError("This PDF is password protected. Unlock it before redacting.")

        total_redactions = 0
        found_terms = set()
        for page in doc:
            text = page.get_text("text")
            terms = set()
            for pat in patterns:
                for m in pat.finditer(text):
                    term = m.group(0).strip()
                    if term:
                        terms.add(term)
            areas = []
            for term in terms:
                # A match can wrap across lines in the extracted text; search each line part.
                for part in [p.strip() for p in term.splitlines() if p.strip()]:
                    areas.extend(page.search_for(part))
            for rect in areas:
                page.add_redact_annot(rect, fill=(0, 0, 0))
            if areas:
                page.apply_redactions(
                    images=pymupdf.PDF_REDACT_IMAGE_PIXELS,
                    graphics=pymupdf.PDF_REDACT_LINE_ART_NONE,
                )
            total_redactions += len(areas)
            found_terms |= terms

        if found_terms:
            meta = doc.metadata or {}
            cleaned = {}
            for key, value in meta.items():
                if isinstance(value, str) and value:
                    for pat in patterns:
                        value = pat.sub("[REDACTED]", value)
                cleaned[key] = value
            doc.set_metadata({k: v for k, v in cleaned.items() if k in (
                "author", "title", "subject", "keywords", "creator", "producer")})
            doc.del_xml_metadata()

        # garbage=4 drops the now-unreferenced original content streams from the file.
        result = doc.tobytes(garbage=4, deflate=True, clean=True)
        doc.close()
        return result, total_redactions

    @staticmethod
    def analyze_ai(pdf_bytes: bytes) -> Dict[str, Any]:
        """
        Performs in-depth document intelligence, readability analysis,
        keyword extraction, and automated executive summary generation.
        """
        extracted = PDFEngine.extract_text_and_markdown(pdf_bytes)
        full_text = " ".join([p["text"] for p in extracted["pages"]])
        words = re.findall(r"[A-Za-z]{3,}", full_text.lower())

        stopwords = {
            "the", "and", "for", "that", "this", "with", "from", "have", "are", "which",
            "will", "their", "were", "been", "they", "also", "would", "about", "more"
        }
        filtered_words = [w for w in words if w not in stopwords]
        freq = {}
        for w in filtered_words:
            freq[w] = freq.get(w, 0) + 1

        top_keywords = sorted(freq.items(), key=lambda x: x[1], reverse=True)[:10]

        sentences = [s.strip() for s in re.split(r"[.!?]+", full_text) if len(s.strip()) > 5]
        sentence_count = max(len(sentences), 1)
        word_count = max(extracted["word_count"], 1)

        avg_sentence_len = word_count / sentence_count
        readability = "Standard / Business Professional"
        if avg_sentence_len > 25:
            readability = "Complex / Technical / Academic"
        elif avg_sentence_len < 12:
            readability = "Conversational / Simple"

        summary_bullets = []
        for s in sentences[:5]:
            if len(s.split()) >= 6:
                summary_bullets.append(s.strip())
        if not summary_bullets:
            summary_bullets = ["Document contains concise tabular or graphical content."]

        return {
            "title": extracted["title"],
            "page_count": extracted["page_count"],
            "word_count": extracted["word_count"],
            "sentence_count": sentence_count,
            "estimated_read_time_minutes": extracted["estimated_read_time_minutes"],
            "readability_score": readability,
            "top_keywords": [{"keyword": k, "frequency": v} for k, v in top_keywords],
            "executive_summary": summary_bullets,
        }

    @staticmethod
    def execute_pipeline(pdf_bytes: bytes, steps: List[Dict[str, Any]]) -> bytes:
        """Executes a chained batch workflow of operations in a single memory pipeline."""
        current_data = pdf_bytes
        if len(steps) > MAX_PIPELINE_STEPS:
            raise ValueError(f"A pipeline can have at most {MAX_PIPELINE_STEPS} steps.")
        for step in steps:
            if not isinstance(step, dict):
                raise ValueError("Each pipeline step must be an object like {\"action\": \"rotate\"}.")
            action = step.get("action")
            if action == "rotate":
                current_data = PDFEngine.rotate(current_data, angle=step.get("angle", 90))
            elif action == "page_numbers":
                current_data = PDFEngine.add_page_numbers(
                    current_data,
                    format_pattern=step.get("format", "Page {n} of {total}"),
                    position=step.get("position", "bottom-center")
                )
            elif action == "watermark":
                current_data = PDFEngine.watermark(
                    current_data,
                    text=step.get("text", "SAMPLE"),
                    opacity=float(step.get("opacity", 0.25))
                )
            elif action == "compress":
                current_data = PDFEngine.compress(current_data, level=step.get("level", "medium"))
            elif action == "redact":
                keywords = step.get("keywords", [])
                if isinstance(keywords, str):
                    keywords = [k.strip() for k in keywords.split(",") if k.strip()]
                current_data, _ = PDFEngine.redact(
                    current_data,
                    keywords=keywords,
                    redact_emails=step.get("redact_emails", True),
                    redact_phones=step.get("redact_phones", True)
                )
        return current_data

    @staticmethod
    def get_metadata(pdf_bytes: bytes) -> Dict[str, str]:
        reader = PdfReader(io.BytesIO(pdf_bytes))
        meta = reader.metadata or {}
        return {
            "title": str(meta.get("/Title", "") or ""),
            "author": str(meta.get("/Author", "") or ""),
            "subject": str(meta.get("/Subject", "") or ""),
            "keywords": str(meta.get("/Keywords", "") or ""),
            "creator": str(meta.get("/Creator", "") or ""),
            "producer": str(meta.get("/Producer", "") or ""),
        }

    @staticmethod
    def edit_metadata(pdf_bytes: bytes, title: str = "", author: str = "", subject: str = "", keywords: str = "") -> bytes:
        reader = PdfReader(io.BytesIO(pdf_bytes))
        writer = PdfWriter()
        for page in reader.pages:
            writer.add_page(page)

        meta = dict(reader.metadata or {})
        if title:
            meta["/Title"] = title
        if author:
            meta["/Author"] = author
        if subject:
            meta["/Subject"] = subject
        if keywords:
            meta["/Keywords"] = keywords

        writer.add_metadata(meta)
        output = io.BytesIO()
        writer.write(output)
        return output.getvalue()

    @staticmethod
    def sign(pdf_bytes: bytes, signature_img_bytes: bytes, page_num: int = 1, x: float = 100, y: float = 100, width: float = 150, height: float = 60) -> bytes:
        reader = PdfReader(io.BytesIO(pdf_bytes))
        total_pages = len(reader.pages)
        target_idx = max(0, min(total_pages - 1, page_num - 1))
        writer = PdfWriter()

        sig_img = Image.open(io.BytesIO(signature_img_bytes))
        sig_buf = io.BytesIO()
        sig_img.save(sig_buf, format="PNG")
        sig_buf.seek(0)

        for idx, page in enumerate(reader.pages):
            if idx == target_idx:
                pw = float(page.mediabox.width)
                ph = float(page.mediabox.height)

                overlay_buf = io.BytesIO()
                c = canvas.Canvas(overlay_buf, pagesize=(pw, ph))
                from reportlab.lib.utils import ImageReader
                c.drawImage(ImageReader(sig_buf), x, y, width=width, height=height, mask="auto")
                c.showPage()
                c.save()

                overlay_reader = PdfReader(io.BytesIO(overlay_buf.getvalue()))
                page.merge_page(overlay_reader.pages[0])

            writer.add_page(page)

        output = io.BytesIO()
        writer.write(output)
        return output.getvalue()

    @staticmethod
    def flatten(pdf_bytes: bytes) -> bytes:
        """
        Burns annotations and filled-in form fields into the page content so they
        stay visible but can no longer be edited.
        """
        doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
        if doc.needs_pass:
            raise ValueError("This PDF is password protected. Unlock it before flattening.")
        doc.bake(annots=True, widgets=True)
        result = doc.tobytes(garbage=3, deflate=True)
        doc.close()
        return result

    @staticmethod
    def compare(pdf1_bytes: bytes, pdf2_bytes: bytes) -> Dict[str, Any]:
        import difflib

        ext1 = PDFEngine.extract_text_and_markdown(pdf1_bytes)
        ext2 = PDFEngine.extract_text_and_markdown(pdf2_bytes)

        lines1 = [line.strip() for p in ext1["pages"] for line in p["text"].splitlines() if line.strip()]
        lines2 = [line.strip() for p in ext2["pages"] for line in p["text"].splitlines() if line.strip()]

        matcher = difflib.SequenceMatcher(None, lines1, lines2)
        similarity = round(matcher.ratio() * 100, 1)

        diff = list(difflib.unified_diff(lines1, lines2, fromfile="Document A", tofile="Document B", lineterm=""))
        added = [l[1:] for l in diff if l.startswith("+") and not l.startswith("+++")]
        removed = [l[1:] for l in diff if l.startswith("-") and not l.startswith("---")]

        return {
            "similarity_percentage": similarity,
            "doc1_pages": ext1["page_count"],
            "doc2_pages": ext2["page_count"],
            "doc1_words": ext1["word_count"],
            "doc2_words": ext2["word_count"],
            "total_differences": len(added) + len(removed),
            "added_lines_count": len(added),
            "removed_lines_count": len(removed),
            "sample_added": added[:8],
            "sample_removed": removed[:8],
            "is_identical": similarity == 100.0 and ext1["page_count"] == ext2["page_count"],
        }

    @staticmethod
    def ocr_available() -> bool:
        return PDFEngine._ocrmypdf_ready() or _find_tessdata() is not None

    @staticmethod
    def _ocrmypdf_ready() -> bool:
        """OCRmyPDF needs Tesseract and Ghostscript on PATH."""
        import shutil
        try:
            import ocrmypdf  # noqa: F401
        except ImportError:
            return False
        _add_windows_ocr_paths()
        has_gs = any(shutil.which(n) for n in ("gs", "gswin64c", "gswin32c"))
        return shutil.which("tesseract") is not None and has_gs

    @staticmethod
    def ocr_searchable(pdf_bytes: bytes, language: str = "eng", force: bool = False) -> bytes:
        """
        Runs Tesseract OCR and adds an invisible, selectable text layer to scanned pages.
        Pages that already have text are left alone unless force=True. Uses OCRmyPDF when it
        and Ghostscript are installed, otherwise PyMuPDF's built-in Tesseract with the
        installed language files.
        """
        if not PDFEngine.ocr_available():
            raise ToolUnavailableError("OCR engine is not installed on this server (needs Tesseract).")
        if not re.fullmatch(r"[a-z_]{3,8}(\+[a-z_]{3,8})*", language or ""):
            raise ValueError("Language must be Tesseract codes like 'eng' or 'eng+fra'.")
        if not PDFEngine._ocrmypdf_ready():
            return _ocr_with_pymupdf(pdf_bytes, language, force)
        import ocrmypdf

        out = io.BytesIO()
        try:
            ocrmypdf.ocr(
                io.BytesIO(pdf_bytes),
                out,
                language=language,
                force_ocr=force,
                skip_text=not force,
                output_type="pdf",
                optimize=0,
                progress_bar=False,
                max_image_mpixels=60,
            )
        except ocrmypdf.exceptions.EncryptedPdfError:
            raise ValueError("This PDF is password protected. Unlock it before running OCR.")
        except ocrmypdf.exceptions.MissingDependencyError as e:
            raise ToolUnavailableError(f"OCR dependency missing: {e}")
        return out.getvalue()
