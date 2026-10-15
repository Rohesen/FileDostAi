"""
FileDost AI comprehensive End-to-End Integration Test Suite.
Verifies all REST API endpoints, edge cases, status codes, and media types.
"""

import io
import json
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))

from fastapi.testclient import TestClient
from reportlab.pdfgen import canvas
from PIL import Image
from main import app

client = TestClient(app)


def create_sample_pdf(num_pages=3) -> bytes:
    buf = io.BytesIO()
    c = canvas.Canvas(buf)
    for p in range(1, num_pages + 1):
        c.drawString(100, 750, f"UltraPDF Test Page {p}")
        c.drawString(100, 700, f"Confidential Data: secret-user-{p}@enterprise.io")
        c.drawString(100, 650, f"Phone Contact: +1-555-019{p}")
        c.drawString(100, 600, "Quarterly financial growth metrics and risk factors.")
        c.showPage()
    c.save()
    return buf.getvalue()


def create_sample_image() -> bytes:
    img = Image.new("RGB", (300, 300), color=(73, 109, 137))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def run_all_tests():
    print("========================================")
    print("Running FileDost AI End-to-End Test Suite")
    print("========================================")

    pdf_sample = create_sample_pdf(3)
    img_sample = create_sample_image()

    # 1. Health Check
    res = client.get("/api/health")
    assert res.status_code == 200, f"Health check failed: {res.text}"
    assert res.json()["status"] == "healthy"
    print("✔ Health Check PASSED")

    # 2. Static Web Root
    res = client.get("/")
    assert res.status_code == 200
    assert "FileDost AI" in res.text
    print("✔ Static Web Root PASSED")

    # 3. Merge PDFs
    res = client.post(
        "/api/merge",
        files=[
            ("files", ("doc1.pdf", pdf_sample, "application/pdf")),
            ("files", ("doc2.pdf", pdf_sample, "application/pdf")),
        ]
    )
    assert res.status_code == 200
    assert res.headers["content-type"] == "application/pdf"
    assert len(res.content) > len(pdf_sample)
    print("✔ Merge Endpoint PASSED")

    # 4. Split PDF (Ranges)
    res = client.post(
        "/api/split",
        files={"file": ("doc.pdf", pdf_sample, "application/pdf")},
        data={"page_ranges": "1-2"}
    )
    assert res.status_code == 200
    assert res.headers["content-type"] == "application/pdf"
    print("✔ Split (Ranges) PASSED")

    # 5. Split PDF (All to ZIP)
    res = client.post(
        "/api/split",
        files={"file": ("doc.pdf", pdf_sample, "application/pdf")},
        data={"page_ranges": "all"}
    )
    assert res.status_code == 200
    assert res.headers["content-type"] == "application/zip"
    print("✔ Split (All ZIP) PASSED")

    # 6. Reorder PDF
    res = client.post(
        "/api/reorder",
        files={"file": ("doc.pdf", pdf_sample, "application/pdf")},
        data={"order": "3,1,2"}
    )
    assert res.status_code == 200
    assert res.headers["content-type"] == "application/pdf"
    print("✔ Reorder Endpoint PASSED")

    # 7. Rotate PDF
    res = client.post(
        "/api/rotate",
        files={"file": ("doc.pdf", pdf_sample, "application/pdf")},
        data={"angle": "90", "pages": "1"}
    )
    assert res.status_code == 200
    assert res.headers["content-type"] == "application/pdf"
    print("✔ Rotate Endpoint PASSED")

    # 8. Compress PDF
    res = client.post(
        "/api/compress",
        files={"file": ("doc.pdf", pdf_sample, "application/pdf")},
        data={"level": "medium"}
    )
    assert res.status_code == 200
    assert res.headers["content-type"] == "application/pdf"
    print("✔ Compress Endpoint PASSED")

    # 9. Watermark PDF
    res = client.post(
        "/api/watermark",
        files={"file": ("doc.pdf", pdf_sample, "application/pdf")},
        data={"text": "CLASSIFIED", "opacity": "0.3", "angle": "45"}
    )
    assert res.status_code == 200
    assert res.headers["content-type"] == "application/pdf"
    print("✔ Watermark Endpoint PASSED")

    # 10. Page Numbers PDF
    res = client.post(
        "/api/page-numbers",
        files={"file": ("doc.pdf", pdf_sample, "application/pdf")},
        data={"format_pattern": "Page {n} of {total}", "position": "bottom-center"}
    )
    assert res.status_code == 200
    assert res.headers["content-type"] == "application/pdf"
    print("✔ Page Numbers Endpoint PASSED")

    # 11. Protect & Unlock Flow
    pwd = "UltraSecurePassword2026!"
    res_protect = client.post(
        "/api/protect",
        files={"file": ("doc.pdf", pdf_sample, "application/pdf")},
        data={"password": pwd}
    )
    assert res_protect.status_code == 200
    protected_pdf = res_protect.content

    res_unlock = client.post(
        "/api/unlock",
        files={"file": ("protected.pdf", protected_pdf, "application/pdf")},
        data={"password": pwd}
    )
    assert res_unlock.status_code == 200
    assert res_unlock.headers["content-type"] == "application/pdf"
    print("✔ Protect & Unlock Lifecycle PASSED")

    # 12. Images to PDF
    res = client.post(
        "/api/img-to-pdf",
        files=[
            ("files", ("img1.png", img_sample, "image/png")),
            ("files", ("img2.png", img_sample, "image/png")),
        ]
    )
    assert res.status_code == 200
    assert res.headers["content-type"] == "application/pdf"
    print("✔ Images to PDF Endpoint PASSED")

    # 13. PDF to Text & Markdown
    res = client.post(
        "/api/pdf-to-text",
        files={"file": ("doc.pdf", pdf_sample, "application/pdf")}
    )
    assert res.status_code == 200
    data = res.json()
    assert data["page_count"] == 3
    assert data["word_count"] > 0
    assert data["markdown"].startswith("# ") and "Pages: 3" in data["markdown"]
    print("✔ PDF to Text & Markdown PASSED")

    # 14. PDF to DOCX
    res = client.post(
        "/api/pdf-to-docx",
        files={"file": ("doc.pdf", pdf_sample, "application/pdf")}
    )
    assert res.status_code == 200
    assert "openxmlformats" in res.headers["content-type"]
    assert len(res.content) > 1000
    print("✔ PDF to DOCX Endpoint PASSED")

    # 15. Smart PII Redact
    res = client.post(
        "/api/redact",
        files={"file": ("doc.pdf", pdf_sample, "application/pdf")},
        data={"keywords": "financial", "redact_emails": "true", "redact_phones": "true"}
    )
    assert res.status_code == 200
    assert int(res.headers.get("x-redacted-count", 0)) > 0
    print(f"✔ Smart PII Redaction PASSED (Redacted entities: {res.headers['x-redacted-count']})")

    # 16. Document AI Analysis
    res = client.post(
        "/api/ai-analyze",
        files={"file": ("doc.pdf", pdf_sample, "application/pdf")}
    )
    assert res.status_code == 200
    ai_data = res.json()
    assert "readability_score" in ai_data
    assert len(ai_data["top_keywords"]) > 0
    assert len(ai_data["executive_summary"]) > 0
    print("✔ Document AI Intelligence Analysis PASSED")

    # 17. Chained Batch Pipeline
    recipe = [
        {"action": "watermark", "text": "PIPELINE PASS", "opacity": 0.25},
        {"action": "page_numbers", "format": "P. {n}/{total}"},
        {"action": "compress", "level": "medium"}
    ]
    res = client.post(
        "/api/pipeline",
        files={"file": ("doc.pdf", pdf_sample, "application/pdf")},
        data={"recipe_json": json.dumps(recipe)}
    )
    assert res.status_code == 200
    assert res.headers["content-type"] == "application/pdf"
    print("✔ Chained Batch Pipeline PASSED")


    # 18. Sign PDF
    res_sign = client.post(
        "/api/sign",
        files={
            "file": ("doc.pdf", pdf_sample, "application/pdf"),
            "signature": ("sig.png", img_sample, "image/png"),
        },
        data={"page": 1, "x": 100, "y": 100, "width": 120, "height": 50}
    )
    assert res_sign.status_code == 200
    assert res_sign.headers["content-type"] == "application/pdf"
    print("✔ Sign PDF Endpoint PASSED")

    # 19. Get & Edit Metadata
    res_meta_edit = client.post(
        "/api/metadata",
        files={"file": ("doc.pdf", pdf_sample, "application/pdf")},
        data={"title": "Quarterly Financial Analysis 2026", "author": "Finance Dept", "subject": "Audit", "keywords": "audit, q3"}
    )
    assert res_meta_edit.status_code == 200
    meta_pdf = res_meta_edit.content

    res_meta_get = client.post(
        "/api/get-metadata",
        files={"file": ("meta.pdf", meta_pdf, "application/pdf")}
    )
    assert res_meta_get.status_code == 200
    meta_json = res_meta_get.json()
    assert meta_json["title"] == "Quarterly Financial Analysis 2026"
    assert meta_json["author"] == "Finance Dept"
    print("✔ Metadata Get & Edit Endpoints PASSED")

    # 20. Flatten PDF
    res_flatten = client.post(
        "/api/flatten",
        files={"file": ("doc.pdf", pdf_sample, "application/pdf")}
    )
    assert res_flatten.status_code == 200
    assert res_flatten.headers["content-type"] == "application/pdf"
    print("✔ Flatten PDF Endpoint PASSED")

    # 21. Compare PDFs
    pdf_sample_diff = create_sample_pdf(2)
    res_compare = client.post(
        "/api/compare",
        files={
            "file1": ("doc1.pdf", pdf_sample, "application/pdf"),
            "file2": ("doc2.pdf", pdf_sample_diff, "application/pdf")
        }
    )
    assert res_compare.status_code == 200
    comp_data = res_compare.json()
    assert "similarity_percentage" in comp_data
    assert comp_data["doc1_pages"] == 3
    assert comp_data["doc2_pages"] == 2
    print(f"✔ Compare PDFs Endpoint PASSED (Similarity: {comp_data['similarity_percentage']}%)")

    # 22. OCR Searchable PDF
    res_ocr = client.post(
        "/api/ocr",
        files={"file": ("doc.pdf", pdf_sample, "application/pdf")}
    )
    assert res_ocr.status_code == 200
    assert res_ocr.headers["content-type"] == "application/pdf"
    print("✔ OCR Searchable PDF Endpoint PASSED")

    print("========================================")
    print("ALL 22 INTEGRATION TESTS PASSED SUCCESSFULLY!")
    print("========================================")



if __name__ == "__main__":
    run_all_tests()
