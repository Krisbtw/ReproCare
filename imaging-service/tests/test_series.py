import json

import numpy as np
import pytest

from app import series
from tests.conftest import make_series


def codes(rep):
    return {p.code for p in rep.problems}


def test_clean_series_is_volume_ready():
    rep, ordered = series.inspect(make_series())
    assert rep.volume_ready and rep.problems == []
    assert rep.slice_count == 12 and rep.slice_spacing_mm == pytest.approx(3.0)
    assert rep.pixel_spacing_mm == (1.0, 1.0)


def test_shuffled_files_are_ordered_by_position():
    blobs = make_series()
    rng = np.random.default_rng(0)
    rng.shuffle(blobs)
    vol, spacing, rep = series.stack_volume(blobs)
    assert vol.shape == (12, 32, 32) and spacing == (pytest.approx(3.0), 1.0, 1.0)
    # centre slice holds the ellipsoid, end slices should not
    assert vol[6].max() == 500 and vol[0].max() == 100


def test_missing_slice_is_a_gap_and_blocks_stacking():
    blobs = make_series(drop=(5,))
    rep, _ = series.inspect(blobs)
    assert "slice_gap" in codes(rep) and not rep.volume_ready
    with pytest.raises(ValueError):
        series.stack_volume(blobs)


def test_duplicate_position_detected():
    rep, _ = series.inspect(make_series(dup=(4,)))
    assert "duplicate_positions" in codes(rep)


def test_mixed_orientation_and_mixed_series_detected():
    assert "mixed_orientation" in codes(series.inspect(make_series(tilt_idx=3))[0])
    assert "mixed_series" in codes(series.inspect(make_series(other_series_idx=2))[0])


def test_unreadable_files_counted_not_crashing():
    rep, _ = series.inspect(make_series(n=4) + [b"not dicom"])
    assert rep.n_unreadable == 1 and "unreadable_files" in codes(rep)


def test_no_patient_identifiers_in_report():
    rep, _ = series.inspect(make_series())
    dumped = json.dumps(rep.to_dict())
    for secret in ("Doe", "Jane", "SECRET-ID-7", "19900101"):
        assert secret not in dumped


def test_anisotropic_spacing_reported():
    rep, _ = series.inspect(make_series(px=(0.8, 0.9), step=4.5))
    assert rep.pixel_spacing_mm == (0.8, 0.9) and rep.slice_spacing_mm == pytest.approx(4.5)
