import pytest
from fastapi.testclient import TestClient

from app.main import app
from tests.conftest import make_series

client = TestClient(app)


def files(blobs):
    return [("files", (f"s{i}.dcm", b, "application/dicom")) for i, b in enumerate(blobs)]


def test_auth_fails_closed_when_key_unset_and_dev_disabled(monkeypatch):
    monkeypatch.delenv("ANATOMYBRIDGE_SERVICE_API_KEY", raising=False)
    monkeypatch.delenv("ANATOMYBRIDGE_DEV_NO_AUTH", raising=False)

    # Health check is public even when auth is misconfigured
    h = client.get("/health")
    assert h.status_code == 200

    # Protected endpoints fail closed with 401
    r1 = client.get("/models")
    assert r1.status_code == 401
    assert "ANATOMYBRIDGE_SERVICE_API_KEY is not configured" in str(r1.json())

    r2 = client.post("/series/inspect", files=files(make_series()))
    assert r2.status_code == 401


def test_auth_allows_dev_when_dev_mode_explicit(monkeypatch):
    monkeypatch.delenv("ANATOMYBRIDGE_SERVICE_API_KEY", raising=False)
    monkeypatch.setenv("ANATOMYBRIDGE_DEV_NO_AUTH", "1")

    # Protected endpoints succeed without token when dev mode is explicit
    r1 = client.get("/models")
    assert r1.status_code == 200


def test_auth_enforced_when_env_key_is_set(monkeypatch):
    monkeypatch.setenv("ANATOMYBRIDGE_SERVICE_API_KEY", "secret-token-1234")

    # Health check is public
    h = client.get("/health")
    assert h.status_code == 200

    # Protected endpoints without token return 401
    r1 = client.get("/models")
    assert r1.status_code == 401

    r2 = client.post("/series/inspect", files=files(make_series()))
    assert r2.status_code == 401

    # Protected endpoint with wrong token returns 401
    r3 = client.get("/models", headers={"Authorization": "Bearer wrong-token"})
    assert r3.status_code == 401

    # Protected endpoint with correct Bearer token succeeds
    r4 = client.get("/models", headers={"Authorization": "Bearer secret-token-1234"})
    assert r4.status_code == 200

    # Protected endpoint with correct X-API-Key header succeeds
    r5 = client.get("/models", headers={"X-API-Key": "secret-token-1234"})
    assert r5.status_code == 200


def test_security_headers_present():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.headers.get("x-content-type-options") == "nosniff"
    assert r.headers.get("x-frame-options") == "DENY"
    assert "max-age=" in r.headers.get("strict-transport-security", "")

