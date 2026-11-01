from datetime import datetime, timedelta
import pytest
from app.trends import calculate_growth_rate, calculate_trend, detect_discrepancies


def test_growth_rate_calculation():
    d1 = datetime(2025, 1, 1)
    d2 = datetime(2025, 3, 1)
    d3 = datetime(2025, 5, 1)

    dates = [d1, d2, d3]
    volumes = [1000.0, 2000.0, 3000.0]

    rate = calculate_growth_rate(dates, volumes)
    assert 480 < rate < 520  # ~500 mm³/month


def test_growth_rate_single_point():
    assert calculate_growth_rate([datetime.now()], [100.0]) == 0.0


def test_trend_calculation():
    assert calculate_trend([100.0, 150.0]) == 1
    assert calculate_trend([150.0, 100.0]) == -1
    assert calculate_trend([100.0, 102.0]) == 0


def test_discrepancy_detection_volume_change():
    current = [{"finding_id": "f1", "volume_mm3": 2500.0}]
    historical = [{"finding_id": "f1", "volume_mm3": 1000.0}]

    disc = detect_discrepancies(current, historical)
    assert len(disc) == 1
    assert disc[0]["type"] == "volume_discrepancy"
    assert disc[0]["percent_change"] == 150.0
    assert disc[0]["severity"] == "high"


def test_discrepancy_detection_new_unmatched():
    current = [{"volume_mm3": 400.0}]  # No finding_id = new
    historical = [{"finding_id": "f1", "volume_mm3": 1000.0}]

    disc = detect_discrepancies(current, historical)
    assert len(disc) == 1
    assert disc[0]["type"] == "unmatched_new_finding"

