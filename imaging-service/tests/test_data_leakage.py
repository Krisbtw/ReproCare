"""Data leakage prevention, tenant isolation, and sensitive information redaction tests."""
from unittest.mock import patch
import pytest
from app.main import app, redact_sensitive_data
from fastapi.testclient import TestClient

client = TestClient(app)


def test_patient_data_isolation():
    """Test that unauthorized clinician requests are isolated and denied."""
    mock_patients = {
        "patient_123": {"assigned_clinician": "clinician_456"},
        "patient_456": {"assigned_clinician": "clinician_other"},
    }

    def mock_fetchone(query, *args):
        p_id = args[0]
        return mock_patients.get(p_id)

    with patch("app.routes.trends.db.fetchone", side_effect=mock_fetchone):
        # Access to another clinician's patient is rejected
        res = client.get(
            "/api/patients/patient_456/trends",
            headers={"Authorization": "Bearer clinician_456_token"},
        )
        assert res.status_code == 403


def test_sensitive_field_redaction():
    """Test that sensitive identifiers are omitted or redacted."""
    raw = {
        "patient_id": "patient_123",
        "patient_ssn": "000-11-2222",
        "patient_dob": "1990-01-01",
        "clinician_notes": "Internal clinical note",
        "email": "patient@example.com",
        "volume_mm3": 15000.0,
    }

    cleaned = redact_sensitive_data(raw)
    assert "patient_ssn" not in cleaned
    assert "patient_dob" not in cleaned
    assert "clinician_notes" not in cleaned
    assert cleaned["email"] == "REDACTED"
    assert cleaned["volume_mm3"] == 15000.0


def test_reprotrace_discrepancy_isolation():
    """Test that discrepancies are strictly scoped to the queried patient."""
    mock_patient = {"id": "patient_123", "assigned_clinician": "clinician_123"}
    discrepancies = [
        {"id": "disc_1", "patient_id": "patient_123", "type": "report_mismatch", "severity": "medium", "details": {}, "status": "pending", "created_at": "2026-01-01T00:00:00"},
    ]

    with patch("app.routes.trends.db.fetchall", return_value=discrepancies), \
         patch("app.routes.trends.db.fetchone", side_effect=[None, mock_patient]):
        response = client.get(
            "/api/patients/patient_123/reprotrace",
            headers={"Authorization": "Bearer valid_token"},
        )
        assert response.status_code == 200
        data = response.json()
        assert len(data["discrepancies"]) == 1
        assert data["discrepancies"][0]["id"] == "disc_1"

