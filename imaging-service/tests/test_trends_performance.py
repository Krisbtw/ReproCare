"""Performance and latency benchmarks for trends calculation and 3D mask processing."""
import time
from datetime import datetime, timedelta
import numpy as np
import pytest
from app.trends import analyze_fibroids, calculate_growth_rate


def test_high_volume_data_handling():
    """Benchmark linear regression across 200 longitudinal points."""
    start_time = time.time()
    dates = [datetime(2020, 1, 1) + timedelta(days=30 * i) for i in range(200)]
    volumes = [10000.0 + 150.0 * i + np.random.normal(0, 20) for i in range(200)]

    rate = calculate_growth_rate(dates, volumes)
    duration_ms = (time.time() - start_time) * 1000

    assert rate > 100.0
    assert duration_ms < 50.0  # Should execute well under 50ms


def test_large_mask_processing():
    """Benchmark 3D connected-component analysis on an 80x80x80 voxel grid."""
    mask = np.zeros((80, 80, 80), dtype=np.uint8)
    # Add multiple simulated lesions
    mask[10:30, 10:30, 10:30] = 1
    mask[40:60, 40:60, 40:60] = 1
    mask[10:20, 50:60, 50:60] = 1

    start_time = time.time()
    result = analyze_fibroids(mask)
    duration_ms = (time.time() - start_time) * 1000

    assert result["fibroid_count"] == 3
    assert duration_ms < 500.0  # Processing should complete in under 500ms

