"""CORS is opt-in, explicit-origin only, and never a wildcard (the service has no auth)."""
import importlib

from fastapi.testclient import TestClient

from app.main import cors_origins


def test_cors_origins_parsing():
    assert cors_origins(None) == []
    assert cors_origins("") == []
    assert cors_origins("*") == []
    assert cors_origins("http://localhost:8080/, https://ab.example.org ,ftp://x, *") == [
        "http://localhost:8080",
        "https://ab.example.org",
    ]


def _fresh_app(monkeypatch, value):
    if value is None:
        monkeypatch.delenv("ANATOMYBRIDGE_CORS_ORIGINS", raising=False)
    else:
        monkeypatch.setenv("ANATOMYBRIDGE_CORS_ORIGINS", value)
    import app.main as main
    importlib.reload(main)
    return TestClient(main.app)


def test_no_cors_header_by_default(monkeypatch):
    c = _fresh_app(monkeypatch, None)
    r = c.get("/health", headers={"Origin": "http://localhost:8080"})
    assert r.status_code == 200
    assert "access-control-allow-origin" not in {k.lower() for k in r.headers}


def test_listed_origin_allowed_unlisted_not(monkeypatch):
    c = _fresh_app(monkeypatch, "http://localhost:8080")
    ok = c.get("/health", headers={"Origin": "http://localhost:8080"})
    assert ok.headers.get("access-control-allow-origin") == "http://localhost:8080"
    other = c.get("/health", headers={"Origin": "http://evil.example"})
    assert other.headers.get("access-control-allow-origin") is None
    pre = c.options(
        "/series/inspect",
        headers={"Origin": "http://localhost:8080", "Access-Control-Request-Method": "POST"},
    )
    assert pre.status_code == 200
    assert pre.headers.get("access-control-allow-origin") == "http://localhost:8080"


def test_wildcard_env_is_ignored(monkeypatch):
    c = _fresh_app(monkeypatch, "*")
    r = c.get("/health", headers={"Origin": "http://anything.example"})
    assert r.headers.get("access-control-allow-origin") is None


def teardown_module(_m):
    # Leave the module in its default (no CORS) state for other test files.
    import os
    os.environ.pop("ANATOMYBRIDGE_CORS_ORIGINS", None)
    import app.main as main
    importlib.reload(main)
