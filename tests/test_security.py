"""Security checks: response headers, error messages, job isolation, hostile files, rate-limit IPs."""

import http.server
import io
import os
import struct
import sys
import threading
import time
import zipfile
import zlib

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import converters  # noqa: E402
import sandbox  # noqa: E402
from guards import RateLimitMiddleware  # noqa: E402
from main import app  # noqa: E402

client = TestClient(app)
posix_only = pytest.mark.skipif(os.name != "posix", reason="job processes are only used on Linux/macOS")


def text_pdf() -> bytes:
    return converters.text_to_pdf("hello")


# ---------- headers and errors ----------

def test_pages_send_security_headers():
    r = client.get("/merge-pdf")
    csp = r.headers["content-security-policy"]
    assert "frame-ancestors 'none'" in csp and "object-src 'none'" in csp and "default-src 'self'" in csp
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["x-frame-options"] == "DENY"
    assert r.headers["cache-control"] == "no-cache"


def test_api_results_are_never_cached():
    r = client.post("/api/compress", files={"file": ("a.pdf", text_pdf(), "application/pdf")}, data={"level": "low"})
    assert r.status_code == 200
    assert r.headers["cache-control"] == "no-store"
    assert r.headers["x-content-type-options"] == "nosniff"


def test_api_docs_are_off_by_default():
    for path in ("/docs", "/redoc", "/openapi.json"):
        assert client.get(path).status_code == 404


def test_no_cors_for_other_sites():
    r = client.post("/api/compress", headers={"Origin": "https://evil.example"},
                    files={"file": ("a.pdf", text_pdf(), "application/pdf")})
    assert "access-control-allow-origin" not in r.headers


def test_bad_file_gets_plain_error_without_internals():
    for path in ("/api/compress", "/api/flatten", "/api/get-metadata", "/api/pdf-to-text"):
        r = client.post(path, files={"file": ("a.pdf", b"%PDF-1.7 not really", "application/pdf")})
        assert r.status_code in (400, 500), path
        detail = r.json()["detail"]
        assert "Traceback" not in detail and "/" not in detail.replace("PDF/A", ""), (path, detail)


def test_forged_host_header_does_not_reach_page_html():
    r = client.get("/merge-pdf", headers={"Host": "evil.example\"><script>x</script>"})
    assert "<script>x</script>" not in r.text


def test_repair_report_header_is_single_line():
    from main import _header_safe
    assert _header_safe("a\r\nSet-Cookie: x=1 b") == "a  Set-Cookie: x=1 b"


# ---------- limits on what a request can ask for ----------

def test_pipeline_step_limit():
    steps = '[' + ",".join(['{"action": "rotate"}'] * 50) + ']'
    r = client.post("/api/pipeline", files={"file": ("a.pdf", text_pdf(), "application/pdf")}, data={"recipe_json": steps})
    assert r.status_code == 400 and "at most" in r.json()["detail"]


def test_huge_page_list_rejected():
    r = client.post("/api/reorder", files={"file": ("a.pdf", text_pdf(), "application/pdf")},
                    data={"order": ",".join(["1"] * 20000)})
    assert r.status_code == 400


def test_out_of_range_numbers_rejected():
    r = client.post("/api/watermark", files={"file": ("a.pdf", text_pdf(), "application/pdf")},
                    data={"font_size": "100000000"})
    assert r.status_code == 422


def _png_header_only(width: int, height: int) -> bytes:
    def chunk(kind, body):
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body))
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(b"\x00" * 10)) + chunk(b"IEND", b"")


def test_image_decompression_bomb_rejected():
    r = client.post("/api/img-to-pdf", files={"files": ("bomb.png", _png_header_only(60000, 60000), "image/png")})
    assert r.status_code == 400


def test_zip_bomb_office_file_rejected():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", "<Types/>")
        with z.open("word/document.xml", "w", force_zip64=True) as f:
            block = b"\x00" * (16 * 1024 * 1024)
            for _ in range(45):  # 720 MB unpacked, well under 1 MB packed
                f.write(block)
    with pytest.raises(ValueError, match="600 MB|zip bomb"):
        converters.check_zip_container(buf.getvalue())


# ---------- job isolation ----------

@posix_only
def test_job_memory_cap(monkeypatch):
    monkeypatch.setattr(sandbox, "JOB_MEMORY_MB", 512)
    with pytest.raises(ValueError, match="memory|safely"):
        sandbox.run_job(bytearray, 2 * 1024 ** 3)


@posix_only
def test_job_time_limit(monkeypatch):
    monkeypatch.setattr(sandbox, "JOB_TIMEOUT", 2)
    start = time.monotonic()
    with pytest.raises(ValueError, match="too long"):
        sandbox.run_job(time.sleep, 30)
    assert time.monotonic() - start < 10


@posix_only
def test_crashing_job_does_not_take_the_server_down():
    with pytest.raises(ValueError, match="safely"):
        sandbox.run_job(os._exit, 9)
    assert sandbox.run_job(converters.text_to_pdf, "still alive")[:5] == b"%PDF-"


def test_busy_server_says_so(monkeypatch):
    monkeypatch.setattr(sandbox, "_slots", threading.BoundedSemaphore(1))
    monkeypatch.setattr(sandbox, "QUEUE_WAIT", 0)
    sandbox._slots.acquire()
    try:
        with pytest.raises(sandbox.ServerBusyError):
            sandbox.run_job(len, b"x")
    finally:
        sandbox._slots.release()


# ---------- LibreOffice can't be used to reach other machines ----------

def _docx_with_linked_image(url: str) -> bytes:
    rels = ('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
    doc_rels = ('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                f'<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="{url}" TargetMode="External"/></Relationships>')
    types = ('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
             '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
             '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
    body = ('<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
            'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>'
            '<w:p><w:r><w:t>Linked picture test</w:t></w:r></w:p><w:p><w:r><w:drawing><wp:inline><wp:extent cx="914400" cy="914400"/><wp:docPr id="1" name="p"/>'
            '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="p"/><pic:cNvPicPr/></pic:nvPicPr>'
            '<pic:blipFill><a:blip r:link="rId5"/></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"/></pic:spPr>'
            '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p></w:body></w:document>')
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("[Content_Types].xml", types)
        z.writestr("_rels/.rels", rels)
        z.writestr("word/_rels/document.xml.rels", doc_rels)
        z.writestr("word/document.xml", body)
    return buf.getvalue()


@pytest.mark.skipif(not converters.find_soffice(), reason="LibreOffice not installed")
def test_office_file_cannot_make_server_fetch_urls():
    hits = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            hits.append(self.path)
            self.send_response(404)
            self.end_headers()
        do_OPTIONS = do_HEAD = do_PROPFIND = do_GET

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        url = f"http://127.0.0.1:{server.server_address[1]}/secret.png"
        r = client.post("/api/to-pdf", files={"file": ("linked.docx", _docx_with_linked_image(url), "application/octet-stream")})
        assert r.status_code == 200
        assert hits == []
    finally:
        server.shutdown()


# ---------- rate limit: the visitor's real address ----------

def _ip_app(trust):
    inner = FastAPI()
    seen = []

    @inner.post("/api/x")
    async def x():
        return {}

    mw = RateLimitMiddleware(inner, limit=1, window=60)
    mw.trust_proxy = trust
    return mw, seen


def test_forwarded_for_cannot_be_spoofed_to_dodge_limit():
    mw, _ = _ip_app("1")
    c = TestClient(mw)
    # The proxy appends the real address last; the visitor controls only the earlier entries.
    assert c.post("/api/x", headers={"X-Forwarded-For": "1.1.1.1, 203.0.113.9"}).status_code == 200
    assert c.post("/api/x", headers={"X-Forwarded-For": "2.2.2.2, 203.0.113.9"}).status_code == 429


def test_cloudflare_header_and_ipv6_prefix():
    mw, _ = _ip_app("cloudflare")
    c = TestClient(mw)
    assert c.post("/api/x", headers={"CF-Connecting-IP": "2001:db8:1:2::1"}).status_code == 200
    # Same /64, different address: same visitor.
    assert c.post("/api/x", headers={"CF-Connecting-IP": "2001:db8:1:2::ffff"}).status_code == 429
    assert c.post("/api/x", headers={"CF-Connecting-IP": "2001:db8:1:3::1"}).status_code == 200


def test_feedback_file_is_private(tmp_path, monkeypatch):
    import feedback
    monkeypatch.setenv("ULTRAPDF_DATA_DIR", str(tmp_path))
    feedback.record("problem", comment="Something ‮odd\x07 happened", contact="me@example.com")
    path = tmp_path / "feedback.jsonl"
    if os.name == "posix":
        assert (path.stat().st_mode & 0o077) == 0
    assert "‮" not in path.read_text(encoding="utf-8") and "\\u0007" not in path.read_text(encoding="utf-8")


def test_allowed_hosts_still_lets_the_health_check_in(tmp_path):
    # ULTRAPDF_ALLOWED_HOSTS is read at import, so check it in a fresh interpreter.
    import subprocess
    code = (
        "from fastapi.testclient import TestClient\n"
        "from main import app\n"
        "for host, want in (('example.com', 200), ('127.0.0.1:8000', 200), ('localhost', 200), ('evil.test', 400)):\n"
        "    r = TestClient(app, base_url='http://' + host).get('/api/health')\n"
        "    assert r.status_code == want, (host, r.status_code)\n"
    )
    env = dict(os.environ, ULTRAPDF_ALLOWED_HOSTS="example.com", ULTRAPDF_DATA_DIR=str(tmp_path))
    root = os.path.join(os.path.dirname(__file__), "..")
    r = subprocess.run([sys.executable, "-c", code], cwd=root, env=env, capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stderr[-2000:]
