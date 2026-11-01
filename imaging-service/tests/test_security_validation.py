"""Data validation, parameter sanitization, and SQL injection prevention tests."""
from unittest.mock import patch
import pytest
from app.main import app
from fastapi.testclient import TestClient

client = TestClient(app)


def test_invalid_patient_id():
    """Test handling of invalid patient IDs."""
    # Alphabetic only
    response = client.get(
        "/api/patients/abc123/trends",
        headers={"Authorization": "Bearer valid_token"},
    )
    assert response.status_code == 422

    # Special characters
    response = client.get(
        "/api/patients/patient@123/trends",
        headers={"Authorization": "Bearer valid_token"},
    )
    assert response.status_code == 422


def test_invalid_time_window():
    """Test handling of out-of-range or malformed query parameters."""
    # Negative time window
    response = client.get(
        "/api/patients/patient_123/trends?time_window_months=-1",
        headers={"Authorization": "Bearer valid_token"},
    )
    assert response.status_code == 422

    # Non-integer value
    response = client.get(
        "/api/patients/patient_123/trends?time_window_months=abc",
        headers={"Authorization": "Bearer valid_token"},
    )
    assert response.status_code == 422

    # Out of max range (>60 months)
    response = client.get(
        "/api/patients/patient_123/trends?time_window_months=1000",
        headers={"Authorization": "Bearer valid_token"},
    )
    assert response.status_code == 422


def test_sql_injection_attempt():
    """Test that potential SQL injection attempts are caught and rejected immediately."""
    malicious = "patient_123'; DROP TABLE users; --"
    response = client.get(
        f"/api/patients/{malicious}/trends",
        headers={"Authorization": "Bearer valid_token"},
    )
    assert response.status_code == 422

