import pytest
from fastapi.testclient import TestClient

from app.main import app
from tests.conftest import make_series

client = TestClient(app)


def files(blobs):
    return [("files", (f"s{i}.dcm", b, "application/dicom")) for i, b in enumerate(blobs)]


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

