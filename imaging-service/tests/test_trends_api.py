"""Unit tests for the patient longitudinal trends and ReproTrace API endpoints."""
from datetime import datetime, timedelta
from unittest.mock import patch

import pytest
from app.main import app
from app.routes.trends import db
from app.trends import calculate_growth_rate
from fastapi.testclient import TestClient

client = TestClient(app)


@pytest.fixture
def mock_clinician():
    return {"id": "clinician_123", "role": "clinician"}


@pytest.fixture
def mock_admin():
    return {"id": "admin_456", "role": "admin"}


@pytest.fixture
def mock_patient_data():
    return {
        "id": "patient_789",
        "assigned_clinician": "clinician_123",
    }


def test_get_patient_trends_success(mock_clinician, mock_patient_data):
    """Test successful retrieval of patient trends."""
    mock_segmentations = [
        {
            "study_date": (datetime.utcnow() - timedelta(days=90)).isoformat(),
            "total_volume_mm3": 10000,
            "fibroid_count": 2,
        },
        {
            "study_date": datetime.utcnow().isoformat(),
            "total_volume_mm3": 12000,
            "fibroid_count": 3,
        },
    ]

    with patch("app.routes.trends.db.fetchall", return_value=mock_segmentations), \
         patch("app.routes.trends.db.fetchone", side_effect=[None, mock_patient_data]):
        response = client.get(
            "/api/patients/patient_789/trends",
            headers={"Authorization": "Bearer valid_token"},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["growth_rate_mm3_per_month"] > 0
        assert len(data["chart_data"]) == 2
        assert data["chart_data"][0]["volume"] == 10000
        assert data["chart_data"][1]["volume"] == 12000


def test_get_patient_trends_unauthorized():
    """Test unauthorized access without token."""
    response = client.get("/api/patients/patient_789/trends")
    assert response.status_code == 401


def test_get_patient_trends_admin_access(mock_admin, mock_patient_data):
    """Test admin can access any patient's trends."""
    with patch("app.routes.trends.db.fetchall", return_value=[]), \
         patch("app.routes.trends.db.fetchone", return_value={"role": "admin"}):
        response = client.get(
            "/api/patients/patient_789/trends",
            headers={"Authorization": "Bearer admin_token"},
        )
        assert response.status_code == 200


def test_calculate_growth_rate():
    """Test growth rate calculation."""
    dates = [
        datetime(2026, 1, 1),
        datetime(2026, 4, 1),
        datetime(2026, 7, 1),
    ]
    volumes = [10000.0, 11500.0, 13000.0]
    rate = calculate_growth_rate(dates, volumes)
    assert rate > 0.0
    assert abs(rate - 500.0) < 50.0  # Approx 500 mm3/month


def test_growth_rate_with_single_data_point():
    """Single observation cannot compute growth rate."""
    dates = [datetime(2026, 1, 1)]
    volumes = [10000.0]
    assert calculate_growth_rate(dates, volumes) == 0.0


def test_get_reprotrace_discrepancies(mock_clinician, mock_patient_data):
    """Test fetching ReproTrace discrepancies."""
    mock_discrepancies = [
        {
            "id": "disc_1",
            "type": "report_mismatch",
            "details": {"note": "Size discrepancy"},
            "severity": "medium",
            "status": "pending",
            "created_at": datetime.utcnow().isoformat(),
        }
    ]

    with patch("app.routes.trends.db.fetchall", return_value=mock_discrepancies), \
         patch("app.routes.trends.db.fetchone", side_effect=[None, mock_patient_data]):
        response = client.get(
            "/api/patients/patient_789/reprotrace",
            headers={"Authorization": "Bearer valid_token"},
        )
        assert response.status_code == 200
        data = response.json()
        assert len(data["discrepancies"]) == 1
        assert data["discrepancies"][0]["id"] == "disc_1"


def test_update_discrepancy_status(mock_clinician, mock_patient_data):
    """Test updating discrepancy review status."""
    with patch("app.routes.trends.db.execute", return_value=1), \
         patch("app.routes.trends.db.fetchone", side_effect=[None, mock_patient_data]):
        response = client.patch(
            "/api/patients/patient_789/reprotrace/disc_1",
            json={"status": "resolved", "clinician_notes": "Reviewed and reconciled."},
            headers={"Authorization": "Bearer valid_token"},
        )
        assert response.status_code == 200
        assert response.json()["status"] == "updated"

