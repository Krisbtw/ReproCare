"""Authentication and access control security tests."""
from unittest.mock import patch
import pytest
from app.main import app
from fastapi.testclient import TestClient

client = TestClient(app)


def test_unauthorized_access():
    """Test that unauthorized access is properly blocked."""
    response = client.get("/api/patients/patient_123/trends")
    assert response.status_code == 401
    assert "Not authenticated" in response.text


def test_missing_token():
    """Test handling of empty authorization header."""
    response = client.get(
        "/api/patients/patient_123/trends",
        headers={"Authorization": ""},
    )
    assert response.status_code == 401
    assert "Not authenticated" in response.text


def test_invalid_token_format():
    """Test handling of malformed authorization tokens."""
    response = client.get(
        "/api/patients/patient_123/trends",
        headers={"Authorization": "Bearer"},
    )
    assert response.status_code == 401

    response = client.get(
        "/api/patients/patient_123/trends",
        headers={"Authorization": "InvalidTokenFormat"},
    )
    assert response.status_code == 401


def test_clinician_access_to_own_patients():
    """Test that clinicians can access their assigned patients."""
    mock_patient = {"id": "patient_456", "assigned_clinician": "clinician_123"}

    with patch("app.routes.trends.db.fetchall", return_value=[]), \
         patch("app.routes.trends.db.fetchone", side_effect=[None, mock_patient]):
        response = client.get(
            "/api/patients/patient_456/trends",
            headers={"Authorization": "Bearer valid_token"},
        )
        assert response.status_code == 200


def test_clinician_access_to_other_patients():
    """Test that clinicians cannot access unassigned patients."""
    mock_patient = {"id": "patient_789", "assigned_clinician": "clinician_other"}

    with patch("app.routes.trends.db.fetchone", side_effect=[None, mock_patient]):
        response = client.get(
            "/api/patients/patient_789/trends",
            headers={"Authorization": "Bearer valid_token"},
        )
        assert response.status_code == 403
        assert "Unauthorized" in response.text


def test_admin_access_to_all_patients():
    """Test that admin users can access any patient's data."""
    with patch("app.routes.trends.db.fetchall", return_value=[]), \
         patch("app.routes.trends.db.fetchone", return_value={"role": "admin"}):
        response = client.get(
            "/api/patients/patient_123/trends",
            headers={"Authorization": "Bearer admin_token"},
        )
        assert response.status_code == 200

