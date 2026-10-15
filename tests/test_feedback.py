"""Ratings and feedback endpoints: stored without file content or IP, validated, averaged."""

import json
import os

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("ULTRAPDF_DATA_DIR", str(tmp_path))
    import main
    return TestClient(main.app), tmp_path


def test_ratings_are_averaged_per_tool(client):
    c, _ = client
    for n in (5, 4, 4):
        assert c.post("/api/feedback", data={"kind": "rating", "tool": "merge-pdf", "rating": n}).status_code == 200
    c.post("/api/feedback", data={"kind": "rating", "tool": "split-pdf", "rating": 2, "comment": "Slow"})
    r = c.get("/api/ratings").json()
    assert r["merge-pdf"] == {"average": 4.3, "count": 3}
    assert r["split-pdf"] == {"average": 2.0, "count": 1}


def test_problem_report_is_stored_without_ip(client):
    c, tmp = client
    res = c.post("/api/feedback", data={"kind": "problem", "tool": "ocr-pdf", "comment": "OCR failed on my scan",
                                        "contact": "me@example.com"})
    assert res.status_code == 200
    line = json.loads((tmp / "feedback.jsonl").read_text().strip())
    assert line["comment"] == "OCR failed on my scan" and line["contact"] == "me@example.com"
    assert "ip" not in json.dumps(line).lower().replace("description", "")


@pytest.mark.parametrize("fields, message", [
    ({"kind": "rating", "tool": "merge-pdf", "rating": 9}, "1 to 5"),
    ({"kind": "rating", "tool": "not-a-tool", "rating": 5}, "Unknown tool"),
    ({"kind": "request", "comment": "hi"}, "a little more"),
    ({"kind": "spam", "comment": "hello there"}, "Unknown feedback"),
    ({"kind": "request", "comment": "Please add EPUB", "contact": "not-an-email"}, "email"),
])
def test_bad_feedback_is_refused(client, fields, message):
    c, _ = client
    res = c.post("/api/feedback", data=fields)
    assert res.status_code == 400 and message in res.json()["detail"]


def test_ratings_empty_before_any_feedback(client):
    c, _ = client
    assert c.get("/api/ratings").json() == {}
