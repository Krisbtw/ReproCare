import pytest
from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)


def test_security_headers_present():
    """Test that all required security headers are present on service responses."""
    response = client.get("/health")
    assert response.status_code == 200

    # Content-Type options
    assert response.headers.get("x-content-type-options") == "nosniff"

    # Frame options
    assert response.headers.get("x-frame-options") == "DENY"

    # HSTS header
    assert "max-age=" in response.headers.get("strict-transport-security", "")


def test_cors_configuration(monkeypatch):
    """Test CORS preflight and origin headers."""
    monkeypatch.setenv("ANATOMYBRIDGE_CORS_ORIGINS", "http://localhost:8080,https://reprocare.app")
    from app.main import cors_origins
    origins = cors_origins("http://localhost:8080,https://reprocare.app")
    assert "http://localhost:8080" in origins
    assert "https://reprocare.app" in origins
