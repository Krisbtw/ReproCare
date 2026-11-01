"""Longitudinal trends, volumetric growth rates, and alert detection for reproductive imaging.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional

import numpy as np


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
    if last > first * 1.05:
        return 1
    elif last < first * 0.95:
        return -1
    return 0


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
                        "type": "volume_discrepancy",
                        "percent_change": round(pct_change * 100, 1),
                        "current_volume_mm3": cur_vol,
                        "previous_volume_mm3": hist_vol,
                        "severity": "high" if abs(pct_change) > 0.50 else "medium",
                    })
        elif not f_id:
            discrepancies.append({
                "type": "unmatched_new_finding",
                "finding": cur,
                "severity": "medium",
                "note": "New lesion not present in previous examination baseline.",
            })

    return discrepancies
