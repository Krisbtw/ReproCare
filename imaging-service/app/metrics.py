"""3D binary and multi-class segmentation metrics with physical voxel spacing.

Every distance or volume metric takes `spacing_zyx_mm = (dz, dy, dx)` so
anisotropic MR (thick slices, fine in-plane) is measured in millimetres and
millilitres, never in raw voxels.

When a metric is undefined (e.g., surface distance when one mask is empty, or
Dice/IoU when both masks are empty), functions return `None` rather than
fabricating `0.0`, `1.0`, or `inf`.
"""
from __future__ import annotations

from typing import Any

import numpy as np
from scipy import ndimage


def _check(a: np.ndarray, b: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    if a.shape != b.shape or a.ndim != 3:
        raise ValueError(f"Expected two 3D arrays of equal shape, got {a.shape} and {b.shape}")
    return a.astype(bool, copy=False), b.astype(bool, copy=False)


def dice(a: np.ndarray, b: np.ndarray) -> float | None:
    a, b = _check(a, b)
    denom = int(a.sum()) + int(b.sum())
    if denom == 0:
        return None
    return float(2 * int(np.logical_and(a, b).sum()) / denom)


def jaccard(a: np.ndarray, b: np.ndarray) -> float | None:
    a, b = _check(a, b)
    union = int(np.logical_or(a, b).sum())
    if union == 0:
        return None
    return float(int(np.logical_and(a, b).sum()) / union)


def iou(a: np.ndarray, b: np.ndarray) -> float | None:
    """Intersection over Union (alias for Jaccard index)."""
    return jaccard(a, b)


def precision(pred: np.ndarray, ref: np.ndarray) -> float | None:
    """Voxel-level precision TP / (TP + FP). Returns None if both masks are empty."""
    p, r = _check(pred, ref)
    tp = int(np.logical_and(p, r).sum())
    fp = int(np.logical_and(p, ~r).sum())
    fn = int(np.logical_and(~p, r).sum())
    if tp + fp + fn == 0:
        return None
    if tp + fp == 0:
        return 0.0
    return float(tp / (tp + fp))


def sensitivity(pred: np.ndarray, ref: np.ndarray) -> float | None:
    """Voxel-level sensitivity / recall TP / (TP + FN). Returns None if reference is empty."""
    p, r = _check(pred, ref)
    tp = int(np.logical_and(p, r).sum())
    fn = int(np.logical_and(~p, r).sum())
    if tp + fn == 0:
        return None
    return float(tp / (tp + fn))


def _surface(mask: np.ndarray) -> np.ndarray:
    eroded = ndimage.binary_erosion(mask, structure=ndimage.generate_binary_structure(3, 1), border_value=0)
    return np.logical_and(mask, ~eroded)


def _surface_distances(a: np.ndarray, b: np.ndarray, spacing_zyx_mm: tuple[float, float, float]) -> np.ndarray | None:
    a, b = _check(a, b)
    if not a.any() or not b.any():
        return None
    sa, sb = _surface(a), _surface(b)
    dt_a = ndimage.distance_transform_edt(~sa, sampling=spacing_zyx_mm)
    dt_b = ndimage.distance_transform_edt(~sb, sampling=spacing_zyx_mm)
    return np.concatenate([dt_b[sa], dt_a[sb]])


def hausdorff(a: np.ndarray, b: np.ndarray, spacing_zyx_mm: tuple[float, float, float]) -> float | None:
    d = _surface_distances(a, b, spacing_zyx_mm)
    return float(d.max()) if d is not None else None


def hd95(a: np.ndarray, b: np.ndarray, spacing_zyx_mm: tuple[float, float, float]) -> float | None:
    d = _surface_distances(a, b, spacing_zyx_mm)
    return float(np.percentile(d, 95)) if d is not None else None


def mean_surface_distance(a: np.ndarray, b: np.ndarray, spacing_zyx_mm: tuple[float, float, float]) -> float | None:
    d = _surface_distances(a, b, spacing_zyx_mm)
    return float(d.mean()) if d is not None else None


def volume_ml(mask: np.ndarray, spacing_zyx_mm: tuple[float, float, float]) -> float:
    voxel_mm3 = float(spacing_zyx_mm[0]) * float(spacing_zyx_mm[1]) * float(spacing_zyx_mm[2])
    return float(int(mask.astype(bool, copy=False).sum()) * voxel_mm3 / 1000.0)


def components(mask: np.ndarray) -> int:
    _, n = ndimage.label(mask.astype(bool, copy=False))
    return int(n)


def false_positive_negative_analysis(
    pred: np.ndarray,
    ref: np.ndarray,
    spacing_zyx_mm: tuple[float, float, float],
) -> dict[str, Any]:
    """Compute false-positive and false-negative voxel, volume, and component statistics."""
    p, r = _check(pred, ref)
    voxel_mm3 = float(spacing_zyx_mm[0]) * float(spacing_zyx_mm[1]) * float(spacing_zyx_mm[2])

    tp_voxels = int(np.logical_and(p, r).sum())
    fp_mask = np.logical_and(p, ~r)
    fn_mask = np.logical_and(~p, r)
    fp_voxels = int(fp_mask.sum())
    fn_voxels = int(fn_mask.sum())

    # Count disconnected false-positive islands (predicted connected components that have 0 overlap with reference)
    pred_labeled, n_pred_comp = ndimage.label(p)
    spurious_fp_components = 0
    for comp_id in range(1, int(n_pred_comp) + 1):
        comp_mask = pred_labeled == comp_id
        if not np.logical_and(comp_mask, r).any():
            spurious_fp_components += 1

    # Count completely missed reference lesions (reference connected components with 0 overlap with prediction)
    ref_labeled, n_ref_comp = ndimage.label(r)
    missed_fn_components = 0
    for comp_id in range(1, int(n_ref_comp) + 1):
        comp_mask = ref_labeled == comp_id
        if not np.logical_and(comp_mask, p).any():
            missed_fn_components += 1

    if not p.any() and not r.any():
        presence_state = "absent_in_both"
    elif p.any() and not r.any():
        presence_state = "false_positive_when_absent"
    elif not p.any() and r.any():
        presence_state = "missed_when_present"
    else:
        presence_state = "present_in_both"

    return {
        "presence_state": presence_state,
        "tp_voxels": tp_voxels,
        "fp_voxels": fp_voxels,
        "fn_voxels": fn_voxels,
        "fp_volume_ml": round(fp_voxels * voxel_mm3 / 1000.0, 4),
        "fn_volume_ml": round(fn_voxels * voxel_mm3 / 1000.0, 4),
        "spurious_fp_components": spurious_fp_components,
        "missed_fn_components": missed_fn_components,
    }


def score(pred: np.ndarray, ref: np.ndarray, spacing_zyx_mm: tuple[float, float, float]) -> dict:
    p, r = _check(pred, ref)
    vp, vr = volume_ml(p, spacing_zyx_mm), volume_ml(r, spacing_zyx_mm)
    fp_fn = false_positive_negative_analysis(p, r, spacing_zyx_mm)
    return {
        "dice": dice(p, r),
        "jaccard": jaccard(p, r),
        "iou": iou(p, r),
        "precision": precision(p, r),
        "sensitivity": sensitivity(p, r),
        "hausdorff_mm": hausdorff(p, r, spacing_zyx_mm),
        "hd95_mm": hd95(p, r, spacing_zyx_mm),
        "mean_surface_distance_mm": mean_surface_distance(p, r, spacing_zyx_mm),
        "predicted_volume_ml": round(vp, 4),
        "reference_volume_ml": round(vr, 4),
        "volume_difference_ml": round(vp - vr, 4),
        "predicted_components": components(p),
        "reference_components": components(r),
        **fp_fn,
    }
