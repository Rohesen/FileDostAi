"""
FileDost AI backend API server.
FastAPI-based, high-throughput microservice for document manipulation and AI intelligence.

Security settings (environment variables; guards.py and sandbox.py list their own):
  ULTRAPDF_API_DOCS        "1" serves the interactive API docs at /docs (off by default)
  ULTRAPDF_ALLOWED_HOSTS   comma-separated host names to answer for, e.g. "example.com,www.example.com"
                           (127.0.0.1 and localhost are always allowed, for the health check)
  ULTRAPDF_HTTPS           "1" once the site is served over HTTPS: adds HSTS and upgrades insecure requests
  ULTRAPDF_CORS_ORIGINS    comma-separated other sites allowed to call the API from a browser (none by default)
"""

import html
import io
import json
import logging
import mimetypes
import sys
import os
from typing import List, Optional

sys.path.insert(0, os.path.dirname(__file__))

from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import Response, JSONResponse, FileResponse, HTMLResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from fastapi.concurrency import run_in_threadpool

from pdf_engine import PDFEngine, ToolUnavailableError, MAX_PAGE_LIST
from guards import UploadLimitMiddleware, RateLimitMiddleware
import feedback
import converters
import image_ocr
import bg_remove
import sandbox

log = logging.getLogger("ultrapdf")

# Windows can map .js/.mjs to text/plain, which browsers refuse to run as modules or workers.
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("application/manifest+json", ".webmanifest")
mimetypes.add_type("application/wasm", ".wasm")  # the HEIC, archive and video engines


def _env_list(name: str) -> List[str]:
    return [v.strip() for v in os.environ.get(name, "").split(",") if v.strip()]


_API_DOCS = os.environ.get("ULTRAPDF_API_DOCS") == "1"
_HTTPS = os.environ.get("ULTRAPDF_HTTPS") == "1"

app = FastAPI(
    title="FileDost AI API",
    description="Next-Generation Document Processing and Intelligence Platform",
    version="2.0.0",
    docs_url="/docs" if _API_DOCS else None,
    redoc_url="/redoc" if _API_DOCS else None,
    openapi_url="/openapi.json" if _API_DOCS else None,
)


@app.on_event("startup")
def warm_up_office() -> None:
    # Prepares LibreOffice in the background so the first Word/PowerPoint conversion is quick.
    import threading
    threading.Thread(target=converters.warm_up_office, daemon=True).start()


# What the browser may load and run on our pages. Scripts come only from this site (inline
# ones are still allowed because index.html uses onclick attributes; WebAssembly because
# pdf.js, libarchive and ffmpeg use it); no plugins, no other site may frame the page, and
# forms can only post back here.
_CSP = "; ".join([
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",  # fonts are self-hosted in static/fonts
    "img-src 'self' data: blob:",
    "media-src 'self' blob: mediastream:",
    "connect-src 'self' blob: data:",
    "worker-src 'self' blob:",
    "frame-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "manifest-src 'self'",
] + (["upgrade-insecure-requests"] if _HTTPS else []))

_SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(self), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
}


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    for name, value in _SECURITY_HEADERS.items():
        response.headers.setdefault(name, value)
    if _HTTPS:
        response.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
    if request.url.path.startswith("/api/"):
        # Processed documents must never sit in a browser, proxy or CDN cache.
        response.headers.setdefault("Cache-Control", "no-store")
    else:
        response.headers.setdefault("Content-Security-Policy", _CSP)
        if request.method == "GET":
            # The app's own files change together with each update, so the browser must check for a
            # newer copy every time (a cheap 304 when nothing changed) instead of mixing old and new files.
            response.headers.setdefault("Cache-Control", "no-cache")
    return response


app.add_middleware(RateLimitMiddleware)
app.add_middleware(UploadLimitMiddleware)
if _env_list("ULTRAPDF_CORS_ORIGINS"):
    # Same-site calls need no CORS at all; other sites may call the API only when listed.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_env_list("ULTRAPDF_CORS_ORIGINS"),
        allow_credentials=False,
        allow_methods=["GET", "POST"],
        allow_headers=["*"],
    )
if _env_list("ULTRAPDF_ALLOWED_HOSTS"):
    # Loopback names stay allowed so the container's own health check keeps working.
    _hosts = _env_list("ULTRAPDF_ALLOWED_HOSTS")
    _hosts += [h for h in ("127.0.0.1", "localhost") if h not in _hosts]
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=_hosts)


@app.get("/api/health")
async def health_check():
    return {
        "status": "healthy",
        "service": "FileDost AI engine",
        "version": "2.0.0",
        "capabilities": [
            "browser_side_organize_tools",
            "in_memory_processing",
            "true_redaction",
            "chained_batch_pipeline",
        ],
        "ocr_available": PDFEngine.ocr_available(),
    }


MAX_FILES_PER_REQUEST = 200

# Library errors that mean "this upload isn't a usable file", not "the server is broken".
_BAD_FILE_ERRORS = {"FileDataError", "PdfReadError", "PdfStreamError", "EmptyFileError", "DependencyError",
                    "UnidentifiedImageError", "DecompressionBombError", "DecompressionBombWarning", "BadZipFile"}


async def _run(label: str, fn, *args):
    """Runs a job in the sandbox (own process, time and memory caps) off the event loop and
    turns its errors into clear HTTP errors. Unexpected errors are logged in full but never
    shown to the user, since their text can reveal paths and library internals."""
    try:
        return await run_in_threadpool(sandbox.run_job, fn, *args)
    except HTTPException:
        raise
    except ToolUnavailableError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except sandbox.ServerBusyError as e:
        raise HTTPException(status_code=503, detail=str(e), headers={"Retry-After": "60"})
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)[:500])
    except Exception as e:
        if type(e).__name__ in _BAD_FILE_ERRORS:
            raise HTTPException(status_code=400, detail="This file is damaged or isn't the right type for this tool.")
        log.exception("%s failed", label)
        raise HTTPException(status_code=500, detail=f"{label} failed. The file may be damaged or unusual; "
                                                    "if it keeps happening, please report it.")


async def _read_all(files: List[UploadFile]) -> List[bytes]:
    if len(files) > MAX_FILES_PER_REQUEST:
        raise HTTPException(status_code=400, detail=f"Too many files at once (the limit is {MAX_FILES_PER_REQUEST}).")
    return [await f.read() for f in files]


def _pdf(data: bytes, filename: str, **headers) -> Response:
    return Response(content=data, media_type="application/pdf",
                    headers={"Content-Disposition": f"attachment; filename={filename}", **headers})


def _pages(text: Optional[str]) -> List[int]:
    nums = [int(p.strip()) for p in (text or "").split(",") if p.strip().isdigit()]
    if len(nums) > MAX_PAGE_LIST:
        raise HTTPException(status_code=400, detail="The page list is too long.")
    return nums


@app.post("/api/merge")
async def merge_pdfs(files: List[UploadFile] = File(...)):
    if len(files) < 2:
        raise HTTPException(status_code=400, detail="At least two PDF files are required for merging.")
    return _pdf(await _run("Merge", PDFEngine.merge, await _read_all(files)), "merged_ultra.pdf")


@app.post("/api/split")
async def split_pdf(
    file: UploadFile = File(...),
    page_ranges: str = Form("all", max_length=2000)
):
    result = await _run("Split", PDFEngine.split, await file.read(), page_ranges)
    if page_ranges.strip().lower() == "all":
        return Response(content=result, media_type="application/zip",
                        headers={"Content-Disposition": "attachment; filename=split_pages.zip"})
    return _pdf(result, "extracted_pages.pdf")


@app.post("/api/reorder")
async def reorder_pdf(
    file: UploadFile = File(...),
    order: str = Form(...)
):
    page_order = _pages(order)
    if not page_order:
        raise HTTPException(status_code=400, detail="Valid comma-separated page order required (e.g. '3,1,2').")
    return _pdf(await _run("Reorder", PDFEngine.reorder, await file.read(), page_order), "reordered_doc.pdf")


@app.post("/api/rotate")
async def rotate_pdf(
    file: UploadFile = File(...),
    angle: int = Form(90),
    pages: Optional[str] = Form(None)
):
    if angle % 90:
        raise HTTPException(status_code=400, detail="Angle must be a multiple of 90.")
    page_nums = _pages(pages) if pages else None
    return _pdf(await _run("Rotate", PDFEngine.rotate, await file.read(), angle, page_nums), "rotated_doc.pdf")


@app.post("/api/compress")
async def compress_pdf(
    file: UploadFile = File(...),
    level: str = Form("medium")
):
    return _pdf(await _run("Compression", PDFEngine.compress, await file.read(), level), "compressed_doc.pdf")


@app.post("/api/compress-to-size")
async def compress_pdf_to_size(file: UploadFile = File(...), target: int = Form(..., ge=1024)):
    data, level, fits = await _run("Compression", PDFEngine.compress_to_size, await file.read(), target)
    return _pdf(data, "compressed_doc.pdf", **{"X-Compress-Level": level, "X-Fits": "1" if fits else "0"})


@app.post("/api/watermark")
async def watermark_pdf(
    file: UploadFile = File(...),
    text: str = Form("CONFIDENTIAL", max_length=500),
    opacity: float = Form(0.3, ge=0, le=1),
    angle: float = Form(45.0, ge=-360, le=360),
    font_size: int = Form(38, ge=4, le=400)
):
    result = await _run("Watermark", PDFEngine.watermark, await file.read(), text, opacity, angle, font_size)
    return _pdf(result, "watermarked_doc.pdf")


@app.post("/api/page-numbers")
async def page_numbers_pdf(
    file: UploadFile = File(...),
    format_pattern: str = Form("Page {n} of {total}", max_length=200),
    position: str = Form("bottom-center", max_length=40),
    font_size: int = Form(10, ge=4, le=200)
):
    result = await _run("Adding page numbers", PDFEngine.add_page_numbers, await file.read(), format_pattern, position, font_size)
    return _pdf(result, "numbered_doc.pdf")


@app.post("/api/protect")
async def protect_pdf(
    file: UploadFile = File(...),
    password: str = Form(..., max_length=256)
):
    if not password:
        raise HTTPException(status_code=400, detail="Password cannot be empty.")
    return _pdf(await _run("Protection", PDFEngine.protect, await file.read(), password), "protected_doc.pdf")


@app.post("/api/unlock")
async def unlock_pdf(
    file: UploadFile = File(...),
    password: str = Form(..., max_length=256)
):
    try:
        result = await _run("Unlock", PDFEngine.unlock, await file.read(), password)
    except HTTPException as e:
        if e.status_code == 400:  # wrong password
            raise HTTPException(status_code=403, detail=e.detail)
        raise
    return _pdf(result, "unlocked_doc.pdf")


@app.post("/api/img-to-pdf")
async def images_to_pdf(files: List[UploadFile] = File(...)):
    if not files:
        raise HTTPException(status_code=400, detail="At least one image file required.")
    datas = await _read_all(files)
    img_tuples = [(f.filename, d) for f, d in zip(files, datas)]
    return _pdf(await _run("Image conversion", PDFEngine.images_to_pdf, img_tuples), "converted_images.pdf")


@app.post("/api/pdf-to-text")
async def pdf_to_text(file: UploadFile = File(...)):
    return JSONResponse(content=await _run("Text extraction", PDFEngine.extract_text_and_markdown, await file.read()))


DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation"


def _stem(filename: Optional[str], default: str = "document") -> str:
    base = os.path.splitext(os.path.basename(filename or ""))[0]
    base = "".join(c for c in base if c.isalnum() or c in " ._-").strip()[:80]
    return base or default


def _download(data: bytes, filename: str, media_type: str, **headers) -> Response:
    from urllib.parse import quote
    disposition = f"attachment; filename=\"{filename.encode('ascii', 'replace').decode()}\"; filename*=UTF-8''{quote(filename)}"
    return Response(content=data, media_type=media_type, headers={"Content-Disposition": disposition, **headers})


def _pdf_to_docx_any(pdf_data: bytes) -> bytes:
    """Layout-preserving conversion when pdf2docx is installed and copes, plain text otherwise."""
    try:
        return converters.pdf_to_docx(pdf_data)
    except ValueError:
        raise
    except Exception:
        return PDFEngine.to_docx(pdf_data)


@app.post("/api/pdf-to-docx")
async def pdf_to_docx(file: UploadFile = File(...)):
    docx_data = await _run("Word conversion", _pdf_to_docx_any, await file.read())
    return _download(docx_data, f"{_stem(file.filename)}.docx", DOCX_MIME)


TEXT_FORMATS = {".md": "markdown", ".markdown": "markdown", ".html": "html", ".htm": "html", ".csv": "csv", ".txt": "text"}
OFFICE_FORMATS = {".doc", ".docx", ".odt", ".rtf", ".xls", ".xlsx", ".ods", ".ppt", ".pptx", ".odp"}


def _decode(data: bytes) -> str:
    for enc in ("utf-8-sig", "utf-16", "cp1252"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("latin-1")


@app.post("/api/to-pdf")
async def convert_to_pdf(file: UploadFile = File(...)):
    """Word, Excel, PowerPoint, OpenDocument, Markdown, HTML, CSV or text to PDF."""
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="The file is empty.")
    ext = os.path.splitext(file.filename or "")[1].lower()
    kind = TEXT_FORMATS.get(ext)
    if kind == "markdown":
        pdf = await _run("Conversion", converters.markdown_to_pdf, _decode(data))
    elif kind == "html":
        pdf = await _run("Conversion", converters.html_to_pdf, _decode(data))
    elif kind == "csv":
        pdf = await _run("Conversion", converters.csv_to_pdf, data)
    elif kind == "text":
        pdf = await _run("Conversion", converters.text_to_pdf, _decode(data))
    elif ext in OFFICE_FORMATS:
        pdf = await _run("Conversion", converters.office_to_pdf, data, file.filename or f"file{ext}")
    else:
        raise HTTPException(status_code=400, detail="This file type can't be converted to PDF yet.")
    return _download(pdf, f"{_stem(file.filename)}.pdf", "application/pdf")


@app.post("/api/pdf-to-excel")
async def pdf_to_excel(file: UploadFile = File(...)):
    data = await _run("Excel conversion", converters.pdf_to_excel, await file.read())
    return _download(data, f"{_stem(file.filename)}.xlsx", XLSX_MIME)


@app.post("/api/pdf-to-powerpoint")
async def pdf_to_powerpoint(file: UploadFile = File(...)):
    data = await _run("PowerPoint conversion", converters.pdf_to_pptx, await file.read())
    return _download(data, f"{_stem(file.filename)}.pptx", PPTX_MIME)


@app.post("/api/pdf-to-pdfa")
async def pdf_to_pdfa(file: UploadFile = File(...)):
    data = await _run("PDF/A conversion", converters.pdf_to_pdfa, await file.read())
    return _download(data, f"{_stem(file.filename)}_pdfa.pdf", "application/pdf")


def _header_safe(text: str, limit: int = 900) -> str:
    """Text from inside a file, made safe to send as an HTTP header (no line breaks, ASCII only)."""
    return "".join(c if 32 <= ord(c) < 127 else " " for c in text)[:limit]


@app.post("/api/repair")
async def repair(file: UploadFile = File(...)):
    result = await _run("Repair", converters.repair_pdf, await file.read())
    report = _header_safe("; ".join(result.get("report") or []))
    return _download(result["bytes"], f"{_stem(file.filename)}_repaired.pdf", "application/pdf",
                     **{"X-Repair-Report": report})


@app.post("/api/privacy-scan")
async def privacy_scan(file: UploadFile = File(...)):
    return JSONResponse(await _run("Privacy scan", converters.privacy_scan, await file.read()))


@app.post("/api/strip-private")
async def strip_private(file: UploadFile = File(...)):
    data = await _run("Cleaning", converters.strip_private_data, await file.read())
    return _download(data, f"{_stem(file.filename)}_clean.pdf", "application/pdf")


@app.post("/api/redact")
async def redact_pdf(
    file: UploadFile = File(...),
    keywords: Optional[str] = Form(None, max_length=20000),
    redact_emails: bool = Form(False),
    redact_phones: bool = Form(False)
):
    kw_list = [k.strip() for k in keywords.split(",") if k.strip()][:500] if keywords else []
    result, count = await _run("Redaction", PDFEngine.redact, await file.read(), kw_list, redact_emails, redact_phones)
    return _pdf(result, "redacted_document.pdf", **{"X-Redacted-Count": str(count)})


@app.post("/api/ai-analyze")
async def ai_analyze_pdf(file: UploadFile = File(...)):
    return JSONResponse(content=await _run("Analysis", PDFEngine.analyze_ai, await file.read()))


@app.post("/api/feedback")
async def send_feedback(
    kind: str = Form(..., max_length=20),
    tool: str = Form("", max_length=60),
    rating: Optional[int] = Form(None),
    comment: str = Form("", max_length=5000),
    contact: str = Form("", max_length=300),
):
    if tool and tool not in TOOL_PAGES:
        raise HTTPException(status_code=400, detail="Unknown tool.")
    try:
        feedback.record(kind, tool=tool, rating=rating, comment=comment, contact=contact)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True}


@app.get("/api/ratings")
async def get_ratings():
    return JSONResponse(feedback.ratings(), headers={"Cache-Control": "no-cache"})


@app.post("/api/pipeline")
async def run_pipeline(
    file: UploadFile = File(...),
    recipe_json: str = Form(..., max_length=50000)
):
    try:
        steps = json.loads(recipe_json)
    except ValueError:
        raise HTTPException(status_code=400, detail="The recipe is not valid JSON.")
    if not isinstance(steps, list):
        raise HTTPException(status_code=400, detail="Recipe must be a JSON array of step objects.")
    return _pdf(await _run("Batch pipeline", PDFEngine.execute_pipeline, await file.read(), steps), "pipelined_output.pdf")


@app.post("/api/sign")
async def sign_pdf_endpoint(
    file: UploadFile = File(...),
    signature: UploadFile = File(...),
    page: int = Form(1),
    x: float = Form(100.0, ge=-20000, le=20000),
    y: float = Form(100.0, ge=-20000, le=20000),
    width: float = Form(150.0, gt=0, le=20000),
    height: float = Form(60.0, gt=0, le=20000)
):
    result = await _run("Signing", PDFEngine.sign, await file.read(), await signature.read(), page, x, y, width, height)
    return _pdf(result, "signed_document.pdf")


@app.post("/api/get-metadata")
async def get_metadata_endpoint(file: UploadFile = File(...)):
    return JSONResponse(content=await _run("Reading metadata", PDFEngine.get_metadata, await file.read()))


@app.post("/api/metadata")
async def edit_metadata_endpoint(
    file: UploadFile = File(...),
    title: Optional[str] = Form("", max_length=2000),
    author: Optional[str] = Form("", max_length=2000),
    subject: Optional[str] = Form("", max_length=2000),
    keywords: Optional[str] = Form("", max_length=5000)
):
    result = await _run("Updating metadata", PDFEngine.edit_metadata, await file.read(), title, author, subject, keywords)
    return _pdf(result, "updated_metadata.pdf")


@app.post("/api/flatten")
async def flatten_pdf_endpoint(file: UploadFile = File(...)):
    return _pdf(await _run("Flattening", PDFEngine.flatten, await file.read()), "flattened_document.pdf")


@app.post("/api/compare")
async def compare_pdfs_endpoint(
    file1: UploadFile = File(...),
    file2: UploadFile = File(...)
):
    return JSONResponse(content=await _run("Comparison", PDFEngine.compare, await file1.read(), await file2.read()))


@app.post("/api/ocr")
async def ocr_pdf_endpoint(
    file: UploadFile = File(...),
    language: str = Form("eng", max_length=60),
    force: bool = Form(False)
):
    result = await _run("OCR processing", PDFEngine.ocr_searchable, await file.read(), language, force)
    return _pdf(result, "searchable_ocr_document.pdf")

async def _images(files: List[UploadFile]):
    if not files:
        raise HTTPException(status_code=400, detail="Add at least one picture.")
    if len(files) > image_ocr.MAX_IMAGES:
        raise HTTPException(status_code=400, detail=f"Up to {image_ocr.MAX_IMAGES} pictures at a time, please.")
    return [(f.filename or "picture", d) for f, d in zip(files, await _read_all(files))]


@app.post("/api/image-to-text")
async def image_to_text(files: List[UploadFile] = File(...), language: str = Form("eng", max_length=60)):
    images = await _images(files)
    return JSONResponse(content=await _run("Reading text", image_ocr.images_to_text, images, language))


@app.post("/api/image-to-word")
async def image_to_word(files: List[UploadFile] = File(...), language: str = Form("eng", max_length=60)):
    images = await _images(files)
    data = await _run("Word conversion", image_ocr.images_to_docx, images, language)
    name = _stem(files[0].filename, "picture") if len(files) == 1 else "pictures"
    return _download(data, f"{name}.docx", DOCX_MIME)


@app.post("/api/remove-background")
async def remove_background(file: UploadFile = File(...)):
    """The subject mask of one photo (1024×1024 greyscale PNG); the browser makes the cut-out."""
    data = (await _read_all([file]))[0]
    return Response(content=await _run("Background removal", bg_remove.mask_png, data), media_type="image/png")


ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # repo root (server/ lives inside it)
STATIC_DIR = os.path.join(ROOT_DIR, "static")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

# One page per tool so each can be found and bookmarked (/merge-pdf, /compress-pdf, ...).
# Keep in sync with the slugs in static/tools.js (a test checks this).
TOOL_PAGES = {
    "convert-image": ("Image Converter: PNG, JPG, WebP, AVIF, PDF", "Convert images between PNG, JPG, WebP, AVIF, BMP, ICO and PDF free, right in your browser. Nothing is uploaded."),
    "resize-image": ("Exam Photo & Signature Resizer", "Crop and resize photos and signatures to exact pixels, KB and DPI for JEE, NEET, SSC and UPSC forms. Free and private."),
    "compress-file": ("Compress Any File", "Reduce the size of photos, PDFs, Word, Excel, PowerPoint and any other file, with an optional target size in KB."),
    "word-to-pdf": ("Word to PDF", "Convert Word documents (DOC, DOCX, ODT, RTF) to PDF free, with layout kept. Files are never stored."),
    "excel-to-pdf": ("Excel to PDF", "Convert Excel spreadsheets (XLS, XLSX, ODS) to PDF free. Files are never stored."),
    "powerpoint-to-pdf": ("PowerPoint to PDF", "Convert PowerPoint slides (PPT, PPTX, ODP) to PDF free. Files are never stored."),
    "markdown-to-pdf": ("Markdown to PDF", "Turn Markdown, HTML, CSV or text files into clean, readable PDFs. Free, files are never stored."),
    "pdf-to-excel": ("PDF to Excel", "Pull tables out of a PDF into an Excel spreadsheet with real numbers. Free, files are never stored."),
    "pdf-to-powerpoint": ("PDF to PowerPoint", "Turn PDF pages into PowerPoint slides with the text in the notes. Free, files are never stored."),
    "pdf-to-pdfa": ("PDF to PDF/A", "Convert a PDF to PDF/A for long-term archiving. Free, files are never stored."),
    "repair-pdf": ("Repair PDF", "Fix damaged or corrupted PDF files that won't open. Free, files are never stored."),
    "privacy-check-pdf": ("PDF Privacy Check", "Find hidden personal data in a PDF: author names, edit history, emails, phone numbers, attachments and scripts, and remove it in one click."),
    "crop-pdf": ("Crop PDF", "Crop PDF pages by dragging a box, or trim white margins in one click. Free, runs in your browser."),
    "resize-pdf": ("Resize PDF", "Change PDF page size to A4, Letter, A3, A5 or Legal, scaled to fit. Free, runs in your browser."),
    "header-footer-pdf": ("Add Headers and Footers to PDF", "Add headers, footers, dates and page numbers to a PDF. Free, runs in your browser."),
    "invert-pdf-colors": ("Dark Mode PDF", "Invert PDF colours for night reading while keeping text searchable. Free, runs in your browser."),
    "compare-pdf": ("Compare PDF", "Compare two PDFs and see added and removed text side by side, plus visual differences. Free and private."),
    "summarize-pdf": ("Summarize PDF", "Summarize a PDF into key points with on-device AI. Free, private, nothing is uploaded."),
    "translate-pdf": ("Translate PDF", "Translate PDF text into 25 languages with on-device AI. Free and private."),
    "pdf-to-audio": ("PDF to Audio", "Listen to a PDF read aloud with your device's voices. Free, runs in your browser."),
    "edit-pdf": ("Edit PDF", "Edit PDF text and add text, images, shapes, highlights and drawings. Free, runs in your browser, files are never uploaded."),
    "scan-to-pdf": ("Scan to PDF", "Scan paper documents to PDF with your phone or webcam: straighten, crop and clean up pages. Free and private."),
    "merge-pdf": ("Merge PDF", "Combine PDF files into one, free. Drag pages to reorder. Runs in your browser, files are never uploaded."),
    "split-pdf": ("Split PDF", "Extract pages from a PDF or save every page as its own file. Free, runs in your browser."),
    "organize-pdf": ("Organize PDF", "Reorder, rotate and delete PDF pages visually. Free, runs in your browser."),
    "remove-pages": ("Remove PDF Pages", "Delete pages from a PDF in a click. Free, runs in your browser."),
    "rotate-pdf": ("Rotate PDF", "Rotate single PDF pages or the whole document. Free, runs in your browser."),
    "compress-pdf": ("Compress PDF", "Make PDFs smaller by downsampling images, with three quality levels. Free, files never stored."),
    "jpg-to-pdf": ("JPG to PDF", "Turn JPG, PNG, WebP and GIF images into a PDF. Free, runs in your browser."),
    "pdf-to-jpg": ("PDF to JPG", "Save PDF pages as JPG or PNG images. Free, runs in your browser."),
    "pdf-to-text": ("PDF to Text", "Extract PDF text as Markdown. Free, runs in your browser."),
    "pdf-to-word": ("PDF to Word", "Convert PDF text to an editable Word document. Free, files never stored."),
    "ocr-pdf": ("OCR PDF", "Make scanned PDFs searchable with Tesseract OCR. Free, files never stored."),
    "sign-pdf": ("Sign PDF", "Draw, type or upload a signature and place it on a PDF. Free, runs in your browser."),
    "protect-pdf": ("Protect PDF", "Add a password to a PDF with AES-256 encryption. Free, files never stored."),
    "unlock-pdf": ("Unlock PDF", "Remove a known password from a PDF. Free, files never stored."),
    "redact-pdf": ("Redact PDF", "Permanently remove emails, phone numbers and words from a PDF, not just cover them. Free."),
    "flatten-pdf": ("Flatten PDF", "Burn form fields and annotations into a PDF so they can't be edited. Free."),
    "watermark-pdf": ("Watermark PDF", "Stamp text across every page of a PDF. Free, runs in your browser."),
    "add-page-numbers": ("Add Page Numbers to PDF", "Number PDF pages in any corner. Free, runs in your browser."),
    "edit-pdf-metadata": ("Edit PDF Metadata", "Change a PDF's title, author, subject and keywords. Free, runs in your browser."),
    "pdf-insights": ("PDF Word Count and Insights", "Word count, reading time and key topics of a PDF. Free."),
    "exam-form-kit": ("Exam & Govt Form Kit", "Get every photo, signature, thumb impression and certificate for JEE, NEET, CUET, SSC, UPSC, passport, scholarship or bank KYC forms at the exact pixel size, KB range and format. Free, private, works on your phone."),
    "heic-to-jpg": ("HEIC to JPG", "Convert iPhone HEIC and HEIF photos to JPG or PNG in your browser, many at once. Free, nothing uploaded."),
    "compress-pdf-to-size": ("Compress PDF to Exact Size (100 KB, 200 KB, 1 MB)", "Get a PDF under the size a form or portal asks for: 100 KB, 200 KB, 1 MB or any limit. Text stays sharp when possible; says plainly if it can't fit."),
    "extract-images": ("Extract Images from PDF", "Save every picture inside a PDF at its original quality as a ZIP. JPEGs are saved unchanged, other images as PNG. Runs in your browser."),
    "n-up-pdf": ("Pages per Sheet (N-up PDF)", "Print 2, 4, 6 or 9 PDF pages on one A4 or Letter sheet to save paper on notes and question papers. Free, runs in your browser."),
    "booklet-pdf": ("Booklet Maker: Print a PDF as a Booklet", "Reorder a PDF for fold-and-staple booklet printing: double-sided, flip on short edge. Blank pages are added for you. Runs in your browser."),
    "pdf-bookmarks": ("Add Bookmarks & Table of Contents to PDF", "Add a clickable contents page and bookmarks to a PDF. Type your chapters or find headings automatically. Free, runs in your browser."),
    "split-by-bookmarks": ("Split PDF by Chapters (Bookmarks)", "Split a big PDF into one file per chapter using its bookmarks, with a page-range preview. Free, runs in your browser."),
    "fill-pdf-form": ("Fill PDF Form", "Type into the boxes of a fillable PDF form, tick check boxes, pick options and save. Lock the answers if you like."),
    "remove-exif": ("Remove Photo Location & EXIF Data", "See and remove the GPS location, phone model, date and other hidden data in photos. Free, private, the picture is not changed."),
    "blur-face": ("Blur Faces & Text in Photos", "Blur, pixelate or black out faces, number plates and text in a photo. Faces are found for you. Free, runs on your device."),
    "watermark-image": ("Watermark Images", "Add a text or logo watermark to many photos at once, in a corner or tiled across. Free and private."),
    "video-to-gif": ("Video to GIF (MP4 to GIF)", "Turn part of a video into a GIF. Choose start, length, size and smoothness. Free, runs on your device."),
    "compress-gif": ("Compress GIF", "Make animated GIFs smaller for WhatsApp, Discord and email. Free, runs on your device, nothing is uploaded."),
    "resize-video-for-reels": ("Resize Video for Reels & Shorts (9:16)", "Fit any video into 9:16 for Reels, Shorts and Status, or 1:1 and 4:5, with a blurred background or bars. Free and private."),
    "change-video-speed": ("Change Video or Audio Speed", "Speed up or slow down videos, songs and voice notes from 0.25x to 4x, with natural-sounding voices. Free, runs on your device."),
    "volume-booster": ("Volume Booster", "Make quiet videos, songs and voice notes louder without crackling. Free, runs on your device, nothing is uploaded."),
    "audio-joiner": ("Audio Joiner", "Join MP3s, voice notes and audio clips into one MP3, with optional crossfade. Free, runs on your device."),
    "diff-checker": ("Diff Checker: Compare Two Texts", "Compare two texts or code files and see what was added, removed and changed, side by side. Free and private."),
    "image-to-text": ("Image to Text Converter", "Copy text from a photo, screenshot or scanned page free with OCR. Works with Hindi, Marathi, Tamil and other Indian languages. Files are never stored."),
    "jpg-to-word": ("JPG to Word Converter", "Convert a photo or scan (JPG, PNG) into an editable Word document free with OCR. Paragraphs are kept. Files are never stored."),
    "image-upscaler": ("Image Upscaler", "Make small or blurry photos 2x or 4x bigger and sharper with free on-device AI. Nothing is uploaded."),
    "signature-maker": ("Signature Maker", "Draw or type your signature, or clean up a photo of one, and download a transparent PNG for forms and documents. Free and private."),
    "remove-background": ("Background Remover", "Remove the background from a photo free: save it see-through (PNG), on white or on any colour for passport and exam photos. Nothing to install or download, and photos are never stored."),
    "qr-code": ("QR Code Maker & Reader", "Make a QR code for a link, text, Wi-Fi, UPI payment or contact card, or read a QR code from a photo, PDF or your camera."),
    "zip-tools": ("ZIP Maker & Opener", "Pack any files into one ZIP, or open a ZIP, RAR, 7z or TAR to see what's inside and take out the files you need."),
    "compress-video": ("Compress Video", "Shrink a video to fit WhatsApp (16 MB), email (25 MB) or any size. Runs in your browser, nothing uploaded. Free."),
    "video-to-mp3": ("Video to MP3", "Save the sound from any video as an MP3, or convert M4A and WAV to MP3. Private, in your browser. Free."),
    "trim-media": ("Trim Audio or Video", "Cut the start and end off a video or audio file with a preview and sliders. Private, in your browser. Free."),
    "my-recipes": ("My Recipes: Run Several Tools in One Click", "Save a chain of tools like OCR, Compress and Page Numbers as a recipe and run it on any file in one click. Kept in your browser only."),
}

def _load_brand() -> dict:
    """The app's name and contact details, from brand.json (one place to rename the app)."""
    brand = {"name": "FileDost AI", "logo_main": "FileDost", "logo_accent": "AI", "tagline": "Free for everyone",
             "contact_email": "", "source_code_url": "", "site_url": ""}
    try:
        with open(os.path.join(ROOT_DIR, "brand.json"), encoding="utf-8") as f:
            brand.update({k: v for k, v in json.load(f).items() if not k.startswith("_")})
    except (OSError, ValueError):
        pass
    return brand


BRAND = _load_brand()
BRAND_NAME = BRAND["name"]
HOME_TITLE = f"{BRAND_NAME}: Free PDF, Image and File Tools That Keep Your Files Private"
# The HTML file is written with the default name; it is swapped for BRAND_NAME when served.
_DEFAULT_TITLE = "FileDost AI: Free PDF, Image and File Tools That Keep Your Files Private"


def _index_html() -> str:
    with open(os.path.join(STATIC_DIR, "index.html"), encoding="utf-8") as f:
        page = f.read()
    page = page.replace(_DEFAULT_TITLE, HOME_TITLE)
    page = page.replace("FileDost <strong>AI</strong>", f"{html.escape(BRAND['logo_main'])} <strong>{html.escape(BRAND['logo_accent'])}</strong>")
    page = page.replace("Free for everyone</span>", f"{html.escape(BRAND['tagline'])}</span>", 1)
    page = page.replace("FileDost AI", html.escape(BRAND_NAME))
    public = {k: v for k, v in BRAND.items()}
    script = "<script>window.BRAND = " + json.dumps(public).replace("<", "\\u003c") + ";</script>"
    return page.replace("<head>", "<head>\n  " + script, 1)


def _base_url(request: Request) -> str:
    """The site's address for links in pages and the sitemap: brand.json's site_url when set,
    so a forged Host header can't put someone else's address into our pages."""
    site = (BRAND.get("site_url") or "").strip().rstrip("/")
    if site.startswith(("https://", "http://")) and "REPLACE_ME" not in site:
        return site
    return str(request.base_url).rstrip("/")


def _page(title: str, description: str, path: str, request: Request) -> HTMLResponse:
    page = _index_html()
    page = page.replace(f"<title>{HOME_TITLE}</title>", f"<title>{html.escape(title)}</title>", 1)
    start = page.index('<meta name="description" content="')
    end = page.index('">', start) + 2
    canonical = _base_url(request) + path
    base = _base_url(request)
    e = html.escape
    # Site-name signals: Google shows og:site_name / WebSite JSON-LD as the name above results,
    # instead of the bare domain.
    meta = (
        f'<meta name="description" content="{e(description)}">\n'
        f'  <link rel="canonical" href="{e(canonical)}">\n'
        f'  <meta name="application-name" content="{e(BRAND_NAME)}">\n'
        f'  <meta property="og:site_name" content="{e(BRAND_NAME)}">\n'
        f'  <meta property="og:type" content="website">\n'
        f'  <meta property="og:title" content="{e(title)}">\n'
        f'  <meta property="og:description" content="{e(description)}">\n'
        f'  <meta property="og:url" content="{e(canonical)}">\n'
        f'  <meta property="og:image" content="{e(base)}/static/icons/icon-512.png">\n'
        f'  <meta name="twitter:card" content="summary">'
    )
    if path == "/":
        site = {"@context": "https://schema.org", "@type": "WebSite", "name": BRAND_NAME,
                "alternateName": sorted({BRAND_NAME.replace(" ", ""), BRAND_NAME.replace(" ", "").lower() + ".com"} - {BRAND_NAME}),
                "url": base + "/"}
        meta += '\n  <script type="application/ld+json">' + json.dumps(site).replace("<", "\\u003c") + "</script>"
    page = page[:start] + meta + page[end:]
    return HTMLResponse(page)


@app.api_route("/", methods=["GET", "HEAD"], response_class=HTMLResponse)
async def serve_index(request: Request):
    return _page(HOME_TITLE, "Free PDF tools: merge, split, rotate, compress, OCR, redact, sign and more. "
                 "Most tools run in your browser, so your files never leave your device.", "/", request)


@app.api_route("/sitemap.xml", methods=["GET", "HEAD"])
async def sitemap(request: Request):
    base = _base_url(request)
    urls = [f"{base}/"] + [f"{base}/{slug}" for slug in list(TOOL_PAGES) + list(INFO_PAGES)]
    body = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    body += "".join(f"  <url><loc>{html.escape(u)}</loc></url>\n" for u in urls) + "</urlset>\n"
    return Response(body, media_type="application/xml")


@app.api_route("/robots.txt", methods=["GET", "HEAD"], response_class=PlainTextResponse)
async def robots(request: Request):
    return f"User-agent: *\nDisallow: /api/\nSitemap: {_base_url(request)}/sitemap.xml\n"


@app.get("/sw.js")
async def service_worker():
    # Served from the root so it can cache every page of the app.
    return FileResponse(os.path.join(STATIC_DIR, "sw.js"), media_type="text/javascript",
                        headers={"Cache-Control": "no-cache"})


# Other names people search for; they open the same tool (tools.js lists the same aliases).
TOOL_ALIASES = {
    "png-to-pdf": "jpg-to-pdf", "image-to-pdf": "jpg-to-pdf",
    "png-to-jpg": "convert-image", "jpg-to-png": "convert-image", "webp-to-jpg": "convert-image", "pdf-to-png": "convert-image",
    "crop-image": "resize-image", "image-cropper": "resize-image", "photo-resizer": "resize-image",
    "compress-image": "compress-file", "reduce-image-size": "compress-file",
    "heic-to-jpeg": "heic-to-jpg", "heif-to-jpg": "heic-to-jpg", "heic-to-png": "heic-to-jpg",
    "compress-pdf-to-100kb": "compress-pdf-to-size", "compress-pdf-to-200kb": "compress-pdf-to-size",
    "compress-pdf-to-500kb": "compress-pdf-to-size", "compress-pdf-to-1mb": "compress-pdf-to-size",
    "extract-images-from-pdf": "extract-images", "pdf-image-extractor": "extract-images",
    "pages-per-sheet": "n-up-pdf", "multiple-pages-per-sheet": "n-up-pdf",
    "pdf-booklet": "booklet-pdf", "booklet-maker": "booklet-pdf",
    "add-bookmarks-to-pdf": "pdf-bookmarks", "pdf-table-of-contents": "pdf-bookmarks",
    "split-pdf-by-chapters": "split-by-bookmarks", "split-by-chapters": "split-by-bookmarks",
    "qr-code-scanner": "qr-code", "upi-qr-code": "qr-code",
    "image-to-text-converter": "image-to-text", "photo-to-text": "image-to-text", "extract-text-from-image": "image-to-text",
    "ocr-image": "image-to-text", "jpg-to-text": "image-to-text", "picture-to-text": "image-to-text",
    "image-to-word": "jpg-to-word", "jpeg-to-word": "jpg-to-word", "png-to-word": "jpg-to-word", "photo-to-word": "jpg-to-word",
    "jpg-to-word-converter": "jpg-to-word",
    "upscale-image": "image-upscaler", "image-enhancer": "image-upscaler", "enhance-photo": "image-upscaler",
    "unblur-image": "image-upscaler", "increase-image-resolution": "image-upscaler", "ai-upscale": "image-upscaler",
    "signature-creator": "signature-maker", "signature-generator": "signature-maker", "online-signature": "signature-maker",
    "transparent-signature": "signature-maker", "digital-signature-maker": "signature-maker",
    "exif-remover": "remove-exif", "remove-location-from-photo": "remove-exif", "remove-metadata-from-photo": "remove-exif",
    "exif-viewer": "remove-exif", "photo-metadata-remover": "remove-exif", "remove-gps-from-photo": "remove-exif",
    "blur-faces": "blur-face", "blur-image": "blur-face", "pixelate-image": "blur-face", "blur-number-plate": "blur-face",
    "censor-photo": "blur-face", "blur-text-in-image": "blur-face",
    "add-watermark-to-photo": "watermark-image", "image-watermark": "watermark-image", "photo-watermark": "watermark-image",
    "add-logo-to-photo": "watermark-image",
    "mp4-to-gif": "video-to-gif", "gif-maker": "video-to-gif", "make-gif": "video-to-gif", "mov-to-gif": "video-to-gif",
    "gif-compressor": "compress-gif", "reduce-gif-size": "compress-gif", "optimize-gif": "compress-gif",
    "video-to-9-16": "resize-video-for-reels", "reels-size": "resize-video-for-reels", "youtube-shorts-size": "resize-video-for-reels",
    "instagram-video-size": "resize-video-for-reels", "video-aspect-ratio": "resize-video-for-reels", "square-video": "resize-video-for-reels",
    "speed-up-video": "change-video-speed", "slow-down-video": "change-video-speed", "audio-speed-changer": "change-video-speed",
    "change-audio-speed": "change-video-speed", "slow-motion-video": "change-video-speed",
    "increase-volume": "volume-booster", "make-audio-louder": "volume-booster", "increase-video-volume": "volume-booster",
    "audio-amplifier": "volume-booster", "mp3-volume-booster": "volume-booster",
    "merge-audio": "audio-joiner", "join-mp3": "audio-joiner", "combine-audio": "audio-joiner", "mp3-joiner": "audio-joiner", "merge-mp3": "audio-joiner",
    "text-compare": "diff-checker", "compare-text": "diff-checker", "text-diff": "diff-checker", "compare-two-texts": "diff-checker", "code-diff": "diff-checker",
    "background-remover": "remove-background", "remove-bg": "remove-background",
    "transparent-background": "remove-background", "passport-photo-background": "remove-background",
    "unzip-files": "zip-tools", "extract-rar": "zip-tools",
    "video-compressor": "compress-video", "reduce-video-size": "compress-video", "compress-video-for-whatsapp": "compress-video",
    "mp4-to-mp3": "video-to-mp3", "extract-audio": "video-to-mp3", "convert-to-mp3": "video-to-mp3",
    "trim-video": "trim-media", "trim-audio": "trim-media", "cut-video": "trim-media", "cut-audio": "trim-media", "cut-mp3": "trim-media",
}


# Pages that aren't tools: answers and the legal pages (site.js holds their text).
INFO_PAGES = {
    "faq": ("Frequently Asked Questions", "Answers about every tool: privacy, file limits, formats, exam photo sizes and more."),
    "about": ("About", "Free, open-source PDF, image and file tools that keep your files private."),
    "contact": ("Contact", "Report a problem, request a tool or get in touch."),
    "privacy": ("Privacy Policy", "What happens to your files: most tools never upload them, and server tools never store them."),
    "terms": ("Terms of Use", "The terms for using these free tools."),
    "security": ("Security", "How files are protected while they are processed."),
    "cookies": ("Cookies", "No tracking cookies. What the site stores in your browser and why."),
}


@app.get("/manifest.webmanifest")
async def manifest():
    with open(os.path.join(STATIC_DIR, "manifest.webmanifest"), encoding="utf-8") as f:
        body = f.read().replace("FileDost AI", BRAND_NAME.replace('"', "")).replace(
            '"short_name": "FileDost"', '"short_name": ' + json.dumps(BRAND["logo_main"] or BRAND_NAME))
    return Response(body, media_type="application/manifest+json")


@app.api_route("/{slug}", methods=["GET", "HEAD"], response_class=HTMLResponse)
async def tool_page(slug: str, request: Request):
    slug = TOOL_ALIASES.get(slug, slug)
    if slug in INFO_PAGES:
        title, description = INFO_PAGES[slug]
        return _page(f"{title} | {BRAND_NAME}", description, f"/{slug}", request)
    if slug not in TOOL_PAGES:
        raise HTTPException(status_code=404, detail="Page not found")
    name, description = TOOL_PAGES[slug]
    return _page(f"{name} Free Online | {BRAND_NAME}", description, f"/{slug}", request)
