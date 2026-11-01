"""Longitudinal trends, volumetric growth rates, and alert detection for reproductive imaging.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional

import numpy as np
from scipy import ndimage


def calculate_growth_rate(dates: list[datetime], volumes: list[float]) -> float:
    """Calculates linear growth rate (mm³/month) from longitudinal studies.
    Returns 0.0 if fewer than 2 distinct observations exist.
    """
    if len(dates) < 2 or len(volumes) < 2 or len(dates) != len(volumes):
        return 0.0

    # Sort observations chronologically
    sorted_pairs = sorted(zip(dates, volumes), key=lambda p: p[0])
    s_dates = [p[0] for p in sorted_pairs]
    s_vols = [p[1] for p in sorted_pairs]

    first_date = s_dates[0]
    time_in_months = [(d - first_date).days / 30.44 for d in s_dates]

    # Check for non-zero variance in time
    if max(time_in_months) - min(time_in_months) < 1e-4:
        return 0.0

    x = np.array(time_in_months, dtype=float)
    y = np.array(s_vols, dtype=float)
    slope, _ = np.polyfit(x, y, 1)
    return float(round(slope, 3))


def calculate_trend(values: list[float], threshold: float = 0.05) -> int:
    """Determines general trajectory: +1 (growth/increasing), -1 (shrinking), 0 (stable within threshold)."""
    if len(values) < 2:
        return 0
    first, last = values[0], values[-1]
    if first == 0:
        return 1 if last > 0 else 0
    rel_change = (last - first) / abs(first)
    if rel_change > threshold:
        return 1
    elif rel_change < -threshold:
        return -1
    return 0


def classify_location(mask: np.ndarray) -> str:
    """Classifies anatomical location of fibroid. FIGO subclassification requires clinician review."""
    return "requires_clinician_figo_classification"


def classify_size(volume_mm3: float) -> str:
    """Categorizes fibroid size based on true physical volume in mm³."""
    if volume_mm3 < 5000.0:
        return "small"
    elif volume_mm3 < 50000.0:
        return "medium"
    return "large"


def analyze_fibroids(mask: np.ndarray, spacing_zyx_mm: tuple[float, float, float] = (1.0, 1.0, 1.0)) -> dict:
    """Extracts fibroid characteristics from a 3D binary segmentation mask with true physical volume."""
    voxel_volume = float(spacing_zyx_mm[0] * spacing_zyx_mm[1] * spacing_zyx_mm[2])
    labeled_mask, num_fibroids = ndimage.label(mask)
    fibroids = []
    for fibroid_id in range(1, num_fibroids + 1):
        fibroid_mask = (labeled_mask == fibroid_id)
        cnt = int(np.sum(fibroid_mask))
        vol_mm3 = float(cnt * voxel_volume)
        fibroids.append({
            "fibroid_id": f"fib_{fibroid_id}",
            "volume_mm3": vol_mm3,
            "voxel_count": cnt,
            "centroid": np.array(ndimage.center_of_mass(fibroid_mask)),
            "location": classify_location(fibroid_mask),
            "size_category": classify_size(vol_mm3),
        })
    total_vol = float(np.sum(mask) * voxel_volume)
    return {
        "fibroid_count": int(num_fibroids),
        "total_volume_mm3": total_vol,
        "fibroids": fibroids,
    }


def find_matching_fibroid(current_fibroid: dict, historical_fibroids: list[dict]) -> dict | None:
    """Matches a current fibroid to historical records based on finding ID or spatial centroid."""
    cur_id = current_fibroid.get("finding_id") or current_fibroid.get("id")
    if cur_id:
        for h in historical_fibroids:
            hist_id = h.get("finding_id") or h.get("id")
            if hist_id and hist_id == cur_id:
                return h

    cur_c = current_fibroid.get("centroid")
    if cur_c is not None:
        for h in historical_fibroids:
            hist_c = h.get("centroid")
            if hist_c is not None and np.allclose(cur_c, hist_c, atol=18.0):
                return h
    return None


def detect_discrepancies(current_findings: list[dict], historical_findings: list[dict]) -> list[dict]:
    """Detects discrepancies between current findings and historical imaging findings."""
    discrepancies = []
    for cur in current_findings:
        matched = find_matching_fibroid(cur, historical_findings)
        cur_id = cur.get("finding_id") or cur.get("id")
        if not matched or not cur_id:
            discrepancies.append({
                "type": "unmatched_new_finding",
                "severity": "medium",
                "finding_id": cur_id,
                "details": {
                    "volume_mm3": cur.get("volume_mm3"),
                    "location": cur.get("location"),
                },
                "note": "Finding has no matching counterpart in previous study. Correlate clinically.",
            })
        else:
            prev_vol = matched.get("volume_mm3", 0.0)
            cur_vol = cur.get("volume_mm3", 0.0)
            if prev_vol > 0:
                pct = ((cur_vol - prev_vol) / prev_vol) * 100.0
                if abs(pct) > 20.0:
                    discrepancies.append({
                        "type": "volume_discrepancy",
                        "severity": "high" if pct > 50.0 else "medium",
                        "finding_id": cur_id,
                        "percent_change": round(pct, 1),
                        "details": {
                            "current_volume_mm3": cur_vol,
                            "previous_volume_mm3": prev_vol,
                            "percent_change": round(pct, 1),
                        },
                        "note": f"Volume changed by {pct:+.1f}%. Exceeds standard measurement variability.",
                    })
    return discrepancies
