"""Upload limit, rate limit and per-tool pages."""

import glob
import io
import os
import re
import sys

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server"))

from guards import RateLimitMiddleware, UploadLimitMiddleware  # noqa: E402
from main import BRAND, TOOL_PAGES, app  # noqa: E402

# Links use brand.json's site_url once it is a real address, else the request's host.
_SITE = (BRAND.get("site_url") or "").rstrip("/")
BASE = _SITE if _SITE.startswith(("https://", "http://")) and "REPLACE_ME" not in _SITE else "http://testserver"

STATIC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static")


def tiny_app():
    a = FastAPI()

    @a.post("/api/echo")
    async def echo(request: Request):
        return {"n": len(await request.body())}

    return a


def test_upload_limit_rejects_big_body():
    client = TestClient(UploadLimitMiddleware(tiny_app(), max_bytes=1000))
    assert client.post("/api/echo", content=b"x" * 999).status_code == 200
    res = client.post("/api/echo", content=b"x" * 1001)
    assert res.status_code == 413 and "too large" in res.json()["detail"]


def test_upload_limit_catches_chunked_body_without_length():
    client = TestClient(UploadLimitMiddleware(tiny_app(), max_bytes=1000))
    res = client.post("/api/echo", content=iter([b"x" * 600, b"x" * 600]))
    assert res.status_code == 413


def test_rate_limit_blocks_then_recovers():
    now = [0.0]
    client = TestClient(RateLimitMiddleware(tiny_app(), limit=3, window=60, clock=lambda: now[0]))
    assert [client.post("/api/echo").status_code for _ in range(3)] == [200, 200, 200]
    blocked = client.post("/api/echo")
    assert blocked.status_code == 429 and int(blocked.headers["retry-after"]) > 0
    now[0] = 61
    assert client.post("/api/echo").status_code == 200


def test_rate_limit_ignores_pages_and_static():
    client = TestClient(RateLimitMiddleware(tiny_app(), limit=1, window=60))
    client.post("/api/echo")
    assert client.get("/api/echo").status_code != 429


client = TestClient(app)


def test_every_tool_in_the_ui_has_a_page_and_vice_versa():
    # Most tools are listed in tools.js; some modules (form-kit.js, chains.js, ...) register their own.
    js = "".join(open(p, encoding="utf-8").read() for p in glob.glob(os.path.join(STATIC, "*.js")))
    slugs = set(re.findall(r'slug: "([a-z0-9-]+)"', js))
    assert slugs == set(TOOL_PAGES)


def test_tool_page_has_its_own_title_and_canonical():
    res = client.get("/merge-pdf")
    assert res.status_code == 200
    assert "<title>Merge PDF Free Online | FileDost AI</title>" in res.text
    assert f'rel="canonical" href="{BASE}/merge-pdf"' in res.text
    assert client.get("/not-a-tool").status_code == 404


def test_sitemap_lists_every_tool():
    body = client.get("/sitemap.xml").text
    for slug in TOOL_PAGES:
        assert f"{BASE}/{slug}</loc>" in body


def test_pwa_files_served_with_right_types():
    sw = client.get("/sw.js")
    assert sw.status_code == 200 and "javascript" in sw.headers["content-type"]
    assert client.get("/manifest.webmanifest").json()["name"] == "FileDost AI"
    mjs = client.get("/static/pdfjs-loader.mjs")
    assert "javascript" in mjs.headers["content-type"]


def test_service_worker_precaches_files_that_exist():
    sw = open(os.path.join(STATIC, "sw.js"), encoding="utf-8").read()
    for path in re.findall(r'"(/static/[^"]+)"', sw):
        if path.endswith("/"):
            continue  # a folder prefix used in a URL check, not a file to precache
        assert client.get(path).status_code == 200, path


def test_info_pages_and_brand_are_served():
    from main import BRAND_NAME, INFO_PAGES
    client = TestClient(app)
    for slug in INFO_PAGES:
        r = client.get(f"/{slug}")
        assert r.status_code == 200 and f"| {BRAND_NAME}</title>" in r.text
    home = client.get("/").text
    assert "window.BRAND = " in home and '"name": "' + BRAND_NAME + '"' in home
    assert "/faq</loc>" in client.get("/sitemap.xml").text


def test_brand_name_comes_from_brand_json(monkeypatch):
    import main
    monkeypatch.setitem(main.BRAND, "name", "AiDocs")
    monkeypatch.setitem(main.BRAND, "logo_main", "Ai")
    monkeypatch.setitem(main.BRAND, "logo_accent", "Docs")
    monkeypatch.setattr(main, "BRAND_NAME", "AiDocs")
    monkeypatch.setattr(main, "HOME_TITLE", "AiDocs: Free PDF, Image and File Tools That Keep Your Files Private")
    page = main._index_html()
    assert "Ai <strong>Docs</strong>" in page and "FileDost AI" not in page and "FileDost <strong>" not in page
