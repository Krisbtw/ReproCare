"""Data validation and parameter sanitization tests for real service endpoints."""
import pytest
from app.main import app
from fastapi.testclient import TestClient

client = TestClient(app)


def test_mask_score_invalid_dimension(monkeypatch):
    """Mask score requires 3D and matching shapes."""
    monkeypatch.setenv("ANATOMYBRIDGE_DEV_NO_AUTH", "1")
    res = client.post(
        "/metrics/score",
        json={
            "spacing_zyx_mm": [1.0, 1.0, 1.0],
            "prediction": [[1, 0], [0, 1]],  # 2D instead of 3D
            "reference": [[[1]]],
        },
    )
    assert res.status_code == 422


def test_trends_calculate_invalid_body(monkeypatch):
    """Malformed body is rejected with 422 structured error."""
    monkeypatch.setenv("ANATOMYBRIDGE_DEV_NO_AUTH", "1")
    res = client.post(
        "/trends/calculate",
        json={"observations": "not-a-list"},
    )
    assert res.status_code == 422
    assert res.json()["error"] == "Validation Error"


def test_series_inspect_empty_files_rejected(monkeypatch):
    """Inspect without files is rejected."""
    monkeypatch.setenv("ANATOMYBRIDGE_DEV_NO_AUTH", "1")
    res = client.post("/series/inspect", files={})
    assert res.status_code in [400, 422]
