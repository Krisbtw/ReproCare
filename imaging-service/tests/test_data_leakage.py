"""Data leakage prevention and sensitive information redaction tests."""
import pytest
from app.main import app, redact_sensitive_data
from fastapi.testclient import TestClient

client = TestClient(app)


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


def test_error_responses_redact_sensitive_payloads(monkeypatch):
    """HTTP exception handler redacts sensitive fields in error payloads."""
    monkeypatch.setenv("ANATOMYBRIDGE_DEV_NO_AUTH", "1")
    # Trigger an HTTPException via inspect with empty files
    res = client.post("/series/inspect", files={})
    assert res.status_code in [400, 422]
    data = res.json()
    assert "patient_ssn" not in str(data)
    assert "patient_dob" not in str(data)
    assert "timestamp" in data
