"""Integration tests for fibroid analysis, report generation, and longitudinal tracking."""
from datetime import datetime, timedelta
import numpy as np
import pytest
from app.main import app
from app.trends import analyze_fibroids, generate_longitudinal_report
from fastapi.testclient import TestClient

client = TestClient(app)


@pytest.fixture
def sample_segmentation_mask():
    """Create a sample 3D segmentation mask with two simulated fibroid lesions."""
    mask = np.zeros((50, 50, 50), dtype=np.uint8)
    # Lesion 1: 10x10x10 = 1000 voxels
    mask[10:20, 15:25, 10:20] = 1
    # Lesion 2: 10x10x10 = 1000 voxels
    mask[30:40, 35:45, 30:40] = 1
    return mask


def test_analyze_fibroids(sample_segmentation_mask):
    """Test fibroid analysis and count/volume calculation from segmentation mask."""
    result = analyze_fibroids(sample_segmentation_mask)

    assert result["fibroid_count"] == 2
    assert result["total_volume_mm3"] == 2000.0
    assert len(result["fibroids"]) == 2
    assert all(f["volume_mm3"] > 0 for f in result["fibroids"])
    assert all("centroid" in f for f in result["fibroids"])


def test_longitudinal_report_generation():
    """Test longitudinal report structure and alerting."""
    mock_segmentations = [
        {
            "study_date": datetime(2025, 1, 1),
            "total_volume_mm3": 8000.0,
            "fibroid_count": 2,
            "metrics": {"dice_score": "0.85"},
        },
        {
            "study_date": datetime(2025, 4, 1),
            "total_volume_mm3": 10500.0,
            "fibroid_count": 3,
            "metrics": {"dice_score": "0.88"},
        },
        {
            "study_date": datetime(2025, 7, 1),
            "total_volume_mm3": 13200.0,
            "fibroid_count": 4,
            "metrics": {"dice_score": "0.89"},
        },
    ]

    report = generate_longitudinal_report("patient_123", time_window_months=12, segmentations=mock_segmentations)

    assert report["patient_id"] == "patient_123"
    assert len(report["segmentations"]) == 3
    assert report["growth_rate_mm3_per_month"] > 500.0  # Significant growth rate
    assert report["fibroid_count_trend"] == 1  # Increasing
    assert len(report["alerts"]) >= 1  # Rapid growth alert flagged
    assert report["alerts"][0]["type"] == "rapid_growth"


def test_end_to_end_workflow():
    """Simulates multi-study monitoring lifecycle."""
    mask_baseline = np.zeros((30, 30, 30), dtype=np.uint8)
    mask_baseline[5:15, 5:15, 5:15] = 1  # 1000 mm3

    mask_followup = np.zeros((30, 30, 30), dtype=np.uint8)
    mask_followup[5:18, 5:18, 5:18] = 1  # ~2197 mm3

    metrics_1 = analyze_fibroids(mask_baseline)
    metrics_2 = analyze_fibroids(mask_followup)

    assert metrics_2["total_volume_mm3"] > metrics_1["total_volume_mm3"]

    segs = [
        {"study_date": datetime(2025, 1, 1), "total_volume_mm3": metrics_1["total_volume_mm3"], "fibroid_count": metrics_1["fibroid_count"]},
        {"study_date": datetime(2025, 3, 1), "total_volume_mm3": metrics_2["total_volume_mm3"], "fibroid_count": metrics_2["fibroid_count"]},
    ]

    report = generate_longitudinal_report("patient_456", 6, segs)
    assert report["growth_rate_mm3_per_month"] > 0

