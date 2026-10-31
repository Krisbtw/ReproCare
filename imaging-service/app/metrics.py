"""Segmentation metrics on binary masks with physical spacing.

Return None where a number cannot be supported (for example an empty mask).
Never substitutes a default score.
"""
from __future__ import annotations

import numpy as np
from scipy import ndimage as ndi


def _bin(a) -> np.ndarray:
    return np.asarray(a).astype(bool)


def volume_ml(mask, spacing_zyx_mm) -> float:
    vox = float(np.prod(spacing_zyx_mm))
    return float(_bin(mask).sum()) * vox / 1000.0


def dice(a, b) -> float | None:
    a, b = _bin(a), _bin(b)
    s = a.sum() + b.sum()
    return None if s == 0 else float(2.0 * (a & b).sum() / s)


def jaccard(a, b) -> float | None:
    a, b = _bin(a), _bin(b)
    u = (a | b).sum()
    return None if u == 0 else float((a & b).sum() / u)


def _surface(m: np.ndarray) -> np.ndarray:
    return m & ~ndi.binary_erosion(m, structure=ndi.generate_binary_structure(3, 1), border_value=0)


def surface_distances(a, b, spacing_zyx_mm) -> tuple[np.ndarray, np.ndarray] | None:
    a, b = _bin(a), _bin(b)
    if not a.any() or not b.any():
        return None
    sa, sb = _surface(a), _surface(b)
    dist_to_b = ndi.distance_transform_edt(~sb, sampling=spacing_zyx_mm)
    dist_to_a = ndi.distance_transform_edt(~sa, sampling=spacing_zyx_mm)
    return dist_to_b[sa], dist_to_a[sb]


def hd95(a, b, spacing_zyx_mm) -> float | None:
    d = surface_distances(a, b, spacing_zyx_mm)
    if d is None:
        return None
    return float(np.percentile(np.concatenate(d), 95))


def hausdorff(a, b, spacing_zyx_mm) -> float | None:
    d = surface_distances(a, b, spacing_zyx_mm)
    if d is None:
        return None
    return float(max(d[0].max(), d[1].max()))


def mean_surface_distance(a, b, spacing_zyx_mm) -> float | None:
    d = surface_distances(a, b, spacing_zyx_mm)
    if d is None:
        return None
    return float((d[0].mean() + d[1].mean()) / 2.0)


def components(mask) -> int:
    return int(ndi.label(_bin(mask), structure=ndi.generate_binary_structure(3, 1))[1])


def score(pred, ref, spacing_zyx_mm) -> dict:
    pred, ref = _bin(pred), _bin(ref)
    if pred.shape != ref.shape:
        raise ValueError(f"Shape mismatch: prediction {pred.shape} vs reference {ref.shape}")
    vp, vr = volume_ml(pred, spacing_zyx_mm), volume_ml(ref, spacing_zyx_mm)
    return {
        "dice": dice(pred, ref),
        "jaccard": jaccard(pred, ref),
        "hd95_mm": hd95(pred, ref, spacing_zyx_mm),
        "hausdorff_mm": hausdorff(pred, ref, spacing_zyx_mm),
        "mean_surface_distance_mm": mean_surface_distance(pred, ref, spacing_zyx_mm),
        "pred_volume_ml": vp,
        "ref_volume_ml": vr,
        "volume_difference_ml": vp - vr,
        "pred_components": components(pred),
        "ref_components": components(ref),
        "note": "Computed on the supplied masks only. Not a clinical accuracy figure.",
    }
