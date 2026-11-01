from datetime import datetime
import numpy as np
import pytest
from app.trends import (
    analyze_fibroids,
    calculate_growth_rate,
    calculate_trend,
    detect_discrepancies,
)


def test_growth_rate_calculation():
    d1 = datetime(2025, 1, 1)
    d2 = datetime(2025, 3, 1)
    d3 = datetime(2025, 5, 1)

    dates = [d1, d2, d3]
    volumes = [1000.0, 2000.0, 3000.0]

    rate = calculate_growth_rate(dates, volumes)
    assert 480 < rate < 520  # ~500 mm³/month


def test_growth_rate_out_of_order_and_duplicate_dates():
    # Out-of-order dates should produce the exact same growth rate as chronological order
    d1 = datetime(2025, 1, 1)
    d2 = datetime(2025, 3, 1)
    d3 = datetime(2025, 5, 1)

    ordered_rate = calculate_growth_rate([d1, d2, d3], [1000.0, 2000.0, 3000.0])
    shuffled_rate = calculate_growth_rate([d3, d1, d2], [3000.0, 1000.0, 2000.0])
    assert ordered_rate == shuffled_rate

    # Duplicate same-day scan should be deduplicated and not distort regression
    dup_rate = calculate_growth_rate([d1, d1, d2, d3], [1000.0, 9999.0, 2000.0, 3000.0])
    assert dup_rate == ordered_rate


def test_growth_rate_single_point():
    assert calculate_growth_rate([datetime.now()], [100.0]) == 0.0


def test_trend_calculation():
    assert calculate_trend([100.0, 150.0]) == 1
    assert calculate_trend([150.0, 100.0]) == -1
    assert calculate_trend([100.0, 102.0]) == 0

    # Out-of-order dated dicts must sort by date before computing trend
    dated_points = [
        {"date": "2025-06-01", "volume_mm3": 1800.0},
        {"date": "2025-01-01", "volume_mm3": 1000.0},
    ]
    assert calculate_trend(dated_points) == 1


def test_analyze_fibroids_physical_volume_and_centroids():
    mask = np.zeros((10, 20, 20), dtype=np.uint8)
    mask[2:6, 5:10, 8:14] = 1  # 4 * 5 * 6 = 120 voxels
    spacing_zyx = (4.0, 0.8, 0.8)  # voxel volume = 2.56 mm³
    res = analyze_fibroids(mask, spacing_zyx_mm=spacing_zyx, origin_lps_mm=(-50.0, -60.0, 10.0))

    assert res["fibroid_count"] == 1
    assert pytest.approx(res["total_volume_mm3"], rel=1e-5) == 120 * 2.56
    fib = res["fibroids"][0]
    assert fib["voxel_count"] == 120
    assert pytest.approx(fib["volume_mm3"], rel=1e-5) == 307.2
    # Centroid in voxel indices is [3.5, 7.0, 10.5]; in physical mm is [14.0, 5.6, 8.4]
    assert pytest.approx(fib["centroid_voxel_zyx"], rel=1e-4) == [3.5, 7.0, 10.5]
    assert pytest.approx(fib["centroid_mm"], rel=1e-4) == [14.0, 5.6, 8.4]
    assert fib["uncertainty_mm3"] > 0

    with pytest.raises(ValueError):
        analyze_fibroids(mask, spacing_zyx_mm=(0.0, 1.0, 1.0))


def test_discrepancy_detection_volume_change_and_attribution():
    current = [{"finding_id": "f1", "volume_mm3": 2500.0}]
    historical = [{"finding_id": "f1", "volume_mm3": 1000.0}]

    disc = detect_discrepancies(current, historical)
    assert len(disc) == 1
    assert disc[0]["type"] == "volume_discrepancy"
    assert disc[0]["percent_change"] == 150.0
    assert disc[0]["severity"] == "high"
    assert disc[0]["attribution_category"] == "genuine_anatomical_change"

    # Method change attribution
    disc_method = detect_discrepancies(current, historical, method_changed=True)
    assert disc_method[0]["attribution_category"] == "segmentation_method_difference"

    # Spacing change attribution
    disc_spacing = detect_discrepancies(current, historical, spacing_changed=True)
    assert disc_spacing[0]["attribution_category"] == "protocol_or_spacing_difference"


def test_discrepancy_detection_new_unmatched_and_possible_resolved():
    current = [{"volume_mm3": 400.0}]  # No finding_id = new
    historical = [{"finding_id": "f1", "volume_mm3": 1000.0}]

    disc = detect_discrepancies(current, historical)
    assert len(disc) == 1
    assert disc[0]["type"] == "unmatched_new_finding"

    disc_with_resolved = detect_discrepancies(
        current, historical, include_possible_resolved=True
    )
    assert any(d["type"] == "possible_resolved_finding" for d in disc_with_resolved)


def test_trends_endpoint():
    from fastapi.testclient import TestClient
    from app.main import app

    client = TestClient(app)
    payload = {
        "observations": [
            {"date": "2025-01-01", "volume_mm3": 1000.0},
            {"date": "2025-03-01", "volume_mm3": 2000.0},
            {"date": "2025-05-01", "volume_mm3": 3000.0},
        ],
        "historical_findings": [{"finding_id": "f1", "volume_mm3": 1000.0}],
        "current_findings": [{"finding_id": "f1", "volume_mm3": 2500.0}],
    }

    res = client.post("/trends/calculate", json=payload)
    assert res.status_code == 200
    data = res.json()
    assert 480 < data["growth_rate_mm3_per_month"] < 520
    assert data["trend_direction"] == 1
    assert data["observations_count"] == 3
    assert len(data["discrepancies"]) == 1
    assert data["discrepancies"][0]["type"] == "volume_discrepancy"
