"""Longitudinal trends, volumetric growth rates, physical measurements, and alert detection for reproductive imaging.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

import numpy as np
from scipy import ndimage


def _validate_spacing_zyx_mm(spacing_zyx_mm: tuple[float, float, float]) -> tuple[float, float, float]:
    if len(spacing_zyx_mm) != 3:
        raise ValueError(f"Expected 3D spacing_zyx_mm (sz, sy, sx), got {spacing_zyx_mm}")
    sz, sy, sx = (float(spacing_zyx_mm[0]), float(spacing_zyx_mm[1]), float(spacing_zyx_mm[2]))
    if not (np.isfinite(sz) and np.isfinite(sy) and np.isfinite(sx)) or sz <= 0 or sy <= 0 or sx <= 0:
        raise ValueError(f"Invalid non-positive or non-finite voxel spacing (mm): {spacing_zyx_mm}")
    return sz, sy, sx


def _parse_date(d: Any) -> datetime | None:
    if isinstance(d, datetime):
        return d
    if isinstance(d, str) and d.strip():
        cleaned = d.strip()
        if cleaned.endswith("Z"):
            cleaned = cleaned[:-1] + "+00:00"
        try:
            return datetime.fromisoformat(cleaned)
        except ValueError:
            return None
    return None


def calculate_growth_rate(
    dates: list[datetime | str] | list[dict[str, Any]],
    volumes: list[float] | None = None,
) -> float:
    """Calculates linear growth rate (mm³/month) from longitudinal studies.
    - Strictly sorts observations chronologically by actual examination date.
    - Deduplicates same-day duplicate examinations so zero-day intervals do not skew regression.
    - Rejects unparseable/missing dates or negative volumes.
    - Returns 0.0 if fewer than 2 distinct valid dated observations exist.
    """
    pairs: list[tuple[datetime, float]] = []

    if volumes is None:
        # Called with list of observation dicts
        for item in dates:
            if not isinstance(item, dict):
                continue
            dt = _parse_date(item.get("date") or item.get("study_date"))
            vol = item.get("volume_mm3")
            if vol is None and item.get("volume_cm3") is not None:
                vol = float(item["volume_cm3"]) * 1000.0
            if dt is not None and vol is not None and np.isfinite(float(vol)) and float(vol) >= 0:
                pairs.append((dt, float(vol)))
    else:
        if len(dates) < 2 or len(volumes) < 2 or len(dates) != len(volumes):
            return 0.0
        for d, v in zip(dates, volumes):
            dt = _parse_date(d)
            if dt is not None and v is not None and np.isfinite(float(v)) and float(v) >= 0:
                pairs.append((dt, float(v)))

    if len(pairs) < 2:
        return 0.0

    # Sort observations strictly chronologically
    sorted_pairs = sorted(pairs, key=lambda p: p[0])

    # Deduplicate same-day duplicate timestamps (keeping earliest entry for each calendar date)
    deduped_pairs: list[tuple[datetime, float]] = []
    seen_days: set[str] = set()
    for dt, vol in sorted_pairs:
        day_key = dt.date().isoformat()
        if day_key in seen_days:
            continue
        seen_days.add(day_key)
        deduped_pairs.append((dt, vol))

    if len(deduped_pairs) < 2:
        return 0.0

    s_dates = [p[0] for p in deduped_pairs]
    s_vols = [p[1] for p in deduped_pairs]

    first_date = s_dates[0]
    time_in_months = [(d - first_date).total_seconds() / (86400.0 * 30.44) for d in s_dates]

    # Require non-zero elapsed interval
    if max(time_in_months) - min(time_in_months) < 1e-4:
        return 0.0

    x = np.array(time_in_months, dtype=float)
    y = np.array(s_vols, dtype=float)
    slope, _ = np.polyfit(x, y, 1)
    return float(round(slope, 3))


def calculate_trend(values: list[float] | list[dict[str, Any]], threshold: float = 0.05) -> int:
    """Determines general trajectory: +1 (growth/increasing), -1 (shrinking), 0 (stable within threshold).
    If a list of dated observation dicts is provided, sorts them chronologically by date first.
    """
    if len(values) < 2:
        return 0

    if isinstance(values[0], dict):
        valid_pairs: list[tuple[datetime, float]] = []
        for item in values:
            if not isinstance(item, dict):
                continue
            dt = _parse_date(item.get("date") or item.get("study_date"))
            vol = item.get("volume_mm3")
            if vol is None and item.get("volume_cm3") is not None:
                vol = float(item["volume_cm3"]) * 1000.0
            if dt is not None and vol is not None and np.isfinite(float(vol)) and float(vol) >= 0:
                valid_pairs.append((dt, float(vol)))
        if len(valid_pairs) < 2:
            return 0
        valid_pairs.sort(key=lambda p: p[0])
        first, last = valid_pairs[0][1], valid_pairs[-1][1]
    else:
        nums = [float(v) for v in values if v is not None and np.isfinite(float(v))]
        if len(nums) < 2:
            return 0
        first, last = nums[0], nums[-1]

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


def analyze_fibroids(
    mask: np.ndarray,
    spacing_zyx_mm: tuple[float, float, float] = (1.0, 1.0, 1.0),
    origin_lps_mm: tuple[float, float, float] = (0.0, 0.0, 0.0),
) -> dict[str, Any]:
    """Extracts fibroid characteristics from a 3D binary segmentation mask with true physical volume (`mm³`),
    physical millimetre centroids (`centroid` and `centroid_mm` in `mm`, `patient_centroid_lps_mm` in LPS `mm`),
    and boundary partial-volume uncertainty (`uncertainty_mm3`).
    """
    sz, sy, sx = _validate_spacing_zyx_mm(spacing_zyx_mm)
    voxel_volume = float(sz * sy * sx)
    voxel_diag_mm = float(np.sqrt(sz * sz + sy * sy + sx * sx))
    labeled_mask, num_fibroids = ndimage.label(mask > 0)
    fibroids = []
    for fibroid_id in range(1, num_fibroids + 1):
        fibroid_mask = labeled_mask == fibroid_id
        cnt = int(np.sum(fibroid_mask))
        vol_mm3 = float(cnt * voxel_volume)
        cz, cy, cx = ndimage.center_of_mass(fibroid_mask)
        centroid_voxel_zyx = np.array([float(cz), float(cy), float(cx)], dtype=float)
        centroid_mm_zyx = np.array([float(cz * sz), float(cy * sy), float(cx * sx)], dtype=float)
        patient_centroid_lps_mm = [
            float(origin_lps_mm[0] + cx * sx),
            float(origin_lps_mm[1] + cy * sy),
            float(origin_lps_mm[2] + cz * sz),
        ]

        eroded = ndimage.binary_erosion(fibroid_mask)
        surface_voxels = int(np.sum(fibroid_mask ^ eroded))
        uncertainty_mm3 = float(max(voxel_volume, 0.5 * surface_voxels * voxel_volume))

        fibroids.append(
            {
                "fibroid_id": f"fib_{fibroid_id}",
                "volume_mm3": vol_mm3,
                "volume_cm3": float(vol_mm3 / 1000.0),
                "voxel_count": cnt,
                "centroid": centroid_mm_zyx,
                "centroid_mm": centroid_mm_zyx.tolist(),
                "centroid_voxel_zyx": centroid_voxel_zyx.tolist(),
                "patient_centroid_lps_mm": patient_centroid_lps_mm,
                "uncertainty_mm3": uncertainty_mm3,
                "uncertainty_mm": float(0.5 * voxel_diag_mm),
                "spacing_zyx_mm": [sz, sy, sx],
                "location": classify_location(fibroid_mask),
                "size_category": classify_size(vol_mm3),
            }
        )
    total_vol = float(np.sum(mask > 0) * voxel_volume)
    return {
        "fibroid_count": int(num_fibroids),
        "total_volume_mm3": total_vol,
        "fibroids": fibroids,
    }


def _extract_centroid_mm(f: dict[str, Any]) -> np.ndarray | None:
    for key in ("patient_centroid_lps_mm", "centroid_mm", "centroid"):
        val = f.get(key)
        if val is not None:
            arr = np.asarray(val, dtype=float)
            if arr.shape == (3,) and np.all(np.isfinite(arr)):
                return arr
    return None


def find_matching_fibroid(
    current_fibroid: dict[str, Any],
    historical_fibroids: list[dict[str, Any]],
    distance_threshold_mm: float = 18.0,
) -> dict[str, Any] | None:
    """Matches a current fibroid to historical records based on finding ID or physical spatial centroid (mm)."""
    cur_id = current_fibroid.get("finding_id") or current_fibroid.get("id")
    if cur_id:
        for h in historical_fibroids:
            hist_id = h.get("finding_id") or h.get("id")
            if hist_id and hist_id == cur_id:
                return h

    cur_c = _extract_centroid_mm(current_fibroid)
    cur_loc = str(current_fibroid.get("location") or "").strip().lower()
    if cur_c is not None:
        best_match = None
        best_dist = float("inf")
        for h in historical_fibroids:
            hist_loc = str(h.get("location") or "").strip().lower()
            if (
                ("anterior" in cur_loc and "posterior" in hist_loc)
                or ("posterior" in cur_loc and "anterior" in hist_loc)
                or ("left" in cur_loc and "right" in hist_loc)
                or ("right" in cur_loc and "left" in hist_loc)
            ):
                continue
            hist_c = _extract_centroid_mm(h)
            if hist_c is not None:
                dist = float(np.linalg.norm(cur_c - hist_c))
                if dist <= distance_threshold_mm and dist < best_dist:
                    best_dist = dist
                    best_match = h
        if best_match is not None:
            return best_match
    return None


def detect_discrepancies(
    current_findings: list[dict[str, Any]],
    historical_findings: list[dict[str, Any]],
    *,
    method_changed: bool = False,
    spacing_changed: bool = False,
    registration_degraded: bool = False,
    image_quality_degraded: bool = False,
    include_possible_resolved: bool = False,
) -> list[dict[str, Any]]:
    """Detects discrepancies between current findings and historical imaging findings,
    distinguishing genuine anatomical change from measurement uncertainty, protocol/spacing
    differences, segmentation method differences, registration uncertainty, and image quality limitations.
    """
    discrepancies: list[dict[str, Any]] = []
    matched_historical_ids: set[int] = set()

    for cur in current_findings:
        matched = find_matching_fibroid(cur, historical_findings)
        cur_id = cur.get("finding_id") or cur.get("id")
        cur_c = _extract_centroid_mm(cur)
        has_valid_match = matched is not None and (cur_id is not None or cur_c is not None)

        if not has_valid_match:
            discrepancies.append(
                {
                    "type": "unmatched_new_finding",
                    "correspondence_outcome": "possible_new_finding",
                    "attribution_category": "insufficient_evidence",
                    "severity": "medium",
                    "finding_id": cur_id,
                    "details": {
                        "volume_mm3": cur.get("volume_mm3"),
                        "location": cur.get("location"),
                    },
                    "note": "Finding has no matching counterpart in previous study. Correlate clinically.",
                }
            )
        else:
            assert matched is not None
            matched_historical_ids.add(id(matched))
            prev_vol = float(matched.get("volume_mm3", 0.0))
            cur_vol = float(cur.get("volume_mm3", 0.0))
            if prev_vol > 0:
                pct = ((cur_vol - prev_vol) / prev_vol) * 100.0
                delta_mm3 = cur_vol - prev_vol
                u1 = float(matched.get("uncertainty_mm3", prev_vol * 0.06))
                u2 = float(cur.get("uncertainty_mm3", cur_vol * 0.06))
                combined_u = float(np.hypot(u1, u2))

                if image_quality_degraded:
                    attribution = "image_quality_limitation"
                elif registration_degraded:
                    attribution = "registration_error_or_uncertainty"
                elif abs(delta_mm3) <= combined_u:
                    attribution = "within_measurement_uncertainty"
                elif method_changed or (
                    matched.get("method")
                    and cur.get("method")
                    and matched.get("method") != cur.get("method")
                ):
                    attribution = "segmentation_method_difference"
                elif spacing_changed or (
                    matched.get("spacing_zyx_mm")
                    and cur.get("spacing_zyx_mm")
                    and matched.get("spacing_zyx_mm") != cur.get("spacing_zyx_mm")
                ):
                    attribution = "protocol_or_spacing_difference"
                else:
                    attribution = "genuine_anatomical_change"

                if abs(pct) > 20.0:
                    discrepancies.append(
                        {
                            "type": "volume_discrepancy",
                            "correspondence_outcome": "probable_match_review_required",
                            "attribution_category": attribution,
                            "severity": "high" if abs(pct) > 50.0 else "medium",
                            "finding_id": cur_id or matched.get("finding_id") or matched.get("id"),
                            "percent_change": round(pct, 1),
                            "combined_uncertainty_mm3": round(combined_u, 1),
                            "details": {
                                "current_volume_mm3": cur_vol,
                                "previous_volume_mm3": prev_vol,
                                "percent_change": round(pct, 1),
                                "combined_uncertainty_mm3": round(combined_u, 1),
                                "attribution_category": attribution,
                            },
                            "note": f"Volume changed by {pct:+.1f}% (attribution: {attribution}). Exceeds standard measurement variability.",
                        }
                    )

    if include_possible_resolved:
        for hist in historical_findings:
            if id(hist) not in matched_historical_ids:
                hist_id = hist.get("finding_id") or hist.get("id")
                discrepancies.append(
                    {
                        "type": "possible_resolved_finding",
                        "correspondence_outcome": "possible_resolved_finding",
                        "attribution_category": "insufficient_evidence",
                        "severity": "info",
                        "finding_id": hist_id,
                        "details": {
                            "previous_volume_mm3": hist.get("volume_mm3"),
                            "location": hist.get("location"),
                        },
                        "note": "Historical finding was not detected in current study. Do not mark resolved without clinician verification.",
                    }
                )

    return discrepancies
