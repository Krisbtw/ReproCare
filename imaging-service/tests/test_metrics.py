import numpy as np
import pytest

from app import metrics


def ball(shape, centre, radius_mm, spacing):
    z, y, x = np.mgrid[0:shape[0], 0:shape[1], 0:shape[2]]
    d = ((z - centre[0]) * spacing[0]) ** 2 + ((y - centre[1]) * spacing[1]) ** 2 + ((x - centre[2]) * spacing[2]) ** 2
    return d <= radius_mm**2


SP = (3.0, 1.0, 1.0)
SHAPE = (30, 60, 60)


def test_identical_masks():
    a = ball(SHAPE, (15, 30, 30), 10, SP)
    s = metrics.score(a, a, SP)
    assert s["dice"] == 1.0 and s["jaccard"] == 1.0 and s["hd95_mm"] == 0.0 and s["volume_difference_ml"] == 0.0


def test_disjoint_masks():
    a = ball(SHAPE, (15, 15, 15), 5, SP)
    b = ball(SHAPE, (15, 45, 45), 5, SP)
    assert metrics.dice(a, b) == 0.0 and metrics.jaccard(a, b) == 0.0


def test_shift_in_plane_gives_that_distance_in_mm():
    a = ball(SHAPE, (15, 30, 25), 10, SP)
    b = ball(SHAPE, (15, 30, 30), 10, SP)  # 5 voxels in x = 5 mm
    assert metrics.hausdorff(a, b, SP) == pytest.approx(5.0)


def test_shift_along_thick_axis_uses_spacing():
    a = ball(SHAPE, (12, 30, 30), 12, SP)
    b = ball(SHAPE, (14, 30, 30), 12, SP)  # 2 slices x 3 mm = 6 mm
    assert metrics.hausdorff(a, b, SP) == pytest.approx(6.0)


def test_volume_in_ml_matches_voxel_count():
    m = np.zeros(SHAPE, bool)
    m[:10, :10, :10] = True  # 1000 voxels x 3 mm3
    assert metrics.volume_ml(m, SP) == pytest.approx(3.0)


def test_empty_mask_returns_none_not_a_number():
    a = ball(SHAPE, (15, 30, 30), 8, SP)
    e = np.zeros(SHAPE, bool)
    assert metrics.dice(e, e) is None
    assert metrics.hd95(a, e, SP) is None
    s = metrics.score(a, e, SP)
    assert s["hd95_mm"] is None and s["dice"] == 0.0


def test_components_and_shape_mismatch():
    m = np.zeros(SHAPE, bool)
    m[2:6, 2:6, 2:6] = True
    m[20:24, 30:34, 30:34] = True
    assert metrics.components(m) == 2
    with pytest.raises(ValueError):
        metrics.score(m, m[:-1], SP)
