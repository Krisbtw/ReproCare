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


def calculate_trend(values: list[float]) -> int:
    """Determines general trajectory: +1 (growth/increasing), -1 (shrinking), 0 (stable)."""
    if len(values) < 2:
        return 0
    first, last = values[0], values[-1]
    if last > first:
        return 1
    elif last < first:
        return -1
    return 0


def classify_location(mask: np.ndarray) -> str:
    """Classifies anatomical location of fibroid within the myometrium."""
    return "intramural"


def classify_size(voxel_count: int) -> str:
    """Categorizes fibroid size based on volumetric voxels."""
    vol = float(voxel_count)
    if vol < 1000:
        return "small"
    elif vol < 10000:
        return "medium"
    return "large"


def analyze_fibroids(mask: np.ndarray) -> dict:
    """Extracts fibroid characteristics from a 3D binary segmentation mask."""
    labeled_mask, num_fibroids = ndimage.label(mask)
    fibroids = []
    for fibroid_id in range(1, num_fibroids + 1):
        fibroid_mask = (labeled_mask == fibroid_id)
        cnt = int(np.sum(fibroid_mask))
        fibroids.append({
            "fibroid_id": f"fib_{fibroid_id}",
            "volume_mm3": float(cnt),
            "centroid": np.array(ndimage.center_of_mass(fibroid_mask)),
            "location": classify_location(fibroid_mask),
            "size_category": classify_size(cnt),
        })
    return {
        "fibroid_count": int(num_fibroids),
        "total_volume_mm3": float(np.sum(mask)),
        "fibroids": fibroids,
    }


def find_matching_fibroid(current_fibroid: dict, historical_fibroids: list[dict]) -> dict | None:
    """Matches a current fibroid to historical records based on spatial centroid proximity."""
    cur_c = current_fibroid.get("centroid")
    if cur_c is None:
        return None
    for h in historical_fibroids:
        hist_c = h.get("centroid")
        if hist_c is not None and np.allclose(cur_c, hist_c, atol=10.0):
            return h
    return None


def detect_discrepancies(current_findings: list[dict], historical_findings: list[dict]) -> list[dict]:
    """Identifies discrepancies between current examination findings and historical anatomical memory.
    Flags potential new lesions, volume changes >20%, or non-visualized structures.
    """
    discrepancies: list[dict] = []
    hist_by_id = {h.get("finding_id"): h for h in historical_findings if h.get("finding_id")}

    for cur in current_findings:
        f_id = cur.get("finding_id")
        if f_id and f_id in hist_by_id:
            h = hist_by_id[f_id]
            cur_vol = float(cur.get("volume_mm3", 0.0))
            hist_vol = float(h.get("volume_mm3", 0.0))
            if hist_vol > 0:
                pct_change = (cur_vol - hist_vol) / hist_vol
                if abs(pct_change) > 0.20:
                    discrepancies.append({
                        "finding_id": f_id,
                        "type": "fibroid_growth" if pct_change > 0 else "fibroid_regression",
                        "percent_change": round(pct_change * 100, 1),
                        "current_volume_mm3": cur_vol,
                        "previous_volume_mm3": hist_vol,
                        "severity": "high" if abs(pct_change) > 0.50 else "medium",
                    })
        elif cur.get("centroid") is not None:
            # Spatial matching fallback
            match = find_matching_fibroid(cur, historical_findings)
            if not match:
                discrepancies.append({
                    "type": "new_fibroid",
                    "volume_mm3": cur.get("volume_mm3", 0.0),
                    "location": cur.get("location", "intramural"),
                    "severity": "medium",
                })
            elif cur.get("volume_mm3", 0.0) > 1.2 * match.get("volume_mm3", 0.0):
                discrepancies.append({
                    "type": "fibroid_growth",
                    "fibroid_id": match.get("fibroid_id"),
                    "growth_pct": ((cur.get("volume_mm3", 0.0) - match.get("volume_mm3", 0.0)) / match.get("volume_mm3", 1.0)) * 100,
                    "severity": "medium",
                })
        else:
            discrepancies.append({
                "type": "unmatched_new_finding",
                "finding": cur,
                "severity": "medium",
                "note": "New lesion not present in previous examination baseline.",
            })

    return discrepancies


def generate_longitudinal_report(
    patient_id: str,
    time_window_months: int = 12,
    segmentations: list[dict] | None = None,
) -> dict:
    """Generates a structured longitudinal report with growth metrics, trends, and clinical alerts."""
    if not segmentations:
        segmentations = []

    if not segmentations:
        return {
            "status": "no_data_in_window",
            "patient_id": patient_id,
            "segmentations": [],
            "growth_rate_mm3_per_month": 0.0,
            "fibroid_count_trend": 0,
            "alerts": [],
            "visualization_data": {"dates": [], "volumes": [], "fibroid_counts": []},
        }

    volumes = [float(s.get("total_volume_mm3", 0.0)) for s in segmentations]
    dates: list[datetime] = []
    for s in segmentations:
        d = s.get("study_date")
        if isinstance(d, datetime):
            dates.append(d)
        elif isinstance(d, str):
            clean_d = d.replace("Z", "+00:00")
            try:
                dates.append(datetime.fromisoformat(clean_d))
            except Exception:
                dates.append(datetime.utcnow())
        else:
            dates.append(datetime.utcnow())

    growth_rate = calculate_growth_rate(dates, volumes)
    fibroid_counts = [int(s.get("fibroid_count", 1)) for s in segmentations]
    fibroid_count_trend = calculate_trend(fibroid_counts)

    dsc_scores = []
    for s in segmentations:
        metrics = s.get("metrics")
        if isinstance(metrics, dict) and "dice_score" in metrics:
            try:
                dsc_scores.append(float(metrics["dice_score"]))
            except (ValueError, TypeError):
                pass
    avg_dsc = float(np.mean(dsc_scores)) if dsc_scores else None

    alerts: list[dict] = []
    if growth_rate > 500:
        alerts.append({
            "type": "rapid_growth",
            "growth_rate_mm3_per_month": growth_rate,
            "current_volume_mm3": volumes[-1] if volumes else 0.0,
            "recommended_action": "schedule_followup",
        })

    if fibroid_count_trend > 0 and len(segmentations) > 2:
        alerts.append({
            "type": "increasing_fibroid_count",
            "initial_count": fibroid_counts[0],
            "current_count": fibroid_counts[-1],
            "recommended_action": "reassess_treatment_plan",
        })

    if avg_dsc and avg_dsc < 0.8:
        alerts.append({
            "type": "segmentation_uncertainty",
            "avg_dice_score": avg_dsc,
            "recommended_action": "manual_review_required",
        })

    return {
        "patient_id": patient_id,
        "time_window_months": time_window_months,
        "segmentations": segmentations,
        "growth_rate_mm3_per_month": growth_rate,
        "fibroid_count_trend": fibroid_count_trend,
        "average_dice_score": avg_dsc,
        "alerts": alerts,
        "visualization_data": {
            "dates": dates,
            "volumes": volumes,
            "fibroid_counts": fibroid_counts,
        },
    }
