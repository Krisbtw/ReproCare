"""Tests for HTTP security headers and CORS configurations in the imaging service."""
import pytest
from fastapi.testclient import TestClient
from app.main import app, cors_origins

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

    # XSS Protection
    assert response.headers.get("x-xss-protection") == "1; mode=block"

    # Content Security Policy
    assert "default-src 'self'" in response.headers.get("content-security-policy", "")


def test_frame_options():
    """Test X-Frame-Options header prevents clickjacking."""
    response = client.get("/health")
    assert response.headers.get("x-frame-options") == "DENY"


def test_content_type_options():
    """Test X-Content-Type-Options prevents MIME sniffing."""
    response = client.get("/health")
    assert response.headers.get("x-content-type-options") == "nosniff"


def test_hsts_header():
    """Test Strict-Transport-Security header configuration."""
    response = client.get("/health")
    hsts = response.headers.get("strict-transport-security", "")
    assert "max-age=" in hsts
    assert "includeSubDomains" in hsts


def test_security_headers_consistency():
    """Test that security headers are consistent across endpoints."""
    endpoints = ["/health", "/docs", "/openapi.json"]
    for ep in endpoints:
        res = client.get(ep)
        assert res.headers.get("x-content-type-options") == "nosniff"
        assert res.headers.get("x-frame-options") == "DENY"
        assert "strict-transport-security" in res.headers


def test_csp_policy_enforcement():
    """Test Content Security Policy presence."""
    res = client.get("/health")
    assert "content-security-policy" in res.headers
    assert "default-src 'self'" in res.headers["content-security-policy"]


def test_xss_protection():
    """Test X-XSS-Protection header."""
    res = client.get("/health")
    assert res.headers.get("x-xss-protection") == "1; mode=block"


def test_cors_origin_validation():
    """Test origin validation helper."""
    trusted = cors_origins("https://reprocare.health,https://www.reprocare.health")
    assert "https://reprocare.health" in trusted
    assert "https://www.reprocare.health" in trusted

    # Wildcards and empty values should be stripped
    assert "*" not in cors_origins("*")
    assert cors_origins("") == []
