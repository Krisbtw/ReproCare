"""DICOM series inspection and volume stacking.

Reports problems and never repairs them. Patient name, ID, birth date and other
identifying tags are never read into the report.
"""
from __future__ import annotations

import io
from dataclasses import dataclass, field
from typing import Iterable

import numpy as np
import pydicom
from pydicom.errors import InvalidDicomError

# Only these tags leave this module. Everything else, including patient tags, is dropped.
SAFE_TAGS = ("Modality", "SeriesDescription", "SliceThickness", "Rows", "Columns", "BitsAllocated")

ORIENT_TOL = 1e-3
GAP_RATIO = 1.5
DUP_RATIO = 0.1


@dataclass
class Problem:
    code: str
    message: str


@dataclass
class SeriesReport:
    n_files: int
    n_readable: int
    n_unreadable: int
    series_uids: int
    slice_count: int
    rows: int | None
    columns: int | None
    pixel_spacing_mm: tuple[float, float] | None  # (row spacing, column spacing)
    slice_spacing_mm: float | None
    problems: list[Problem] = field(default_factory=list)
    safe_metadata: dict = field(default_factory=dict)
    volume_ready: bool = False

    def to_dict(self) -> dict:
        return {
            "n_files": self.n_files,
            "n_readable": self.n_readable,
            "n_unreadable": self.n_unreadable,
            "series_uids": self.series_uids,
            "slice_count": self.slice_count,
            "rows": self.rows,
            "columns": self.columns,
            "pixel_spacing_mm": self.pixel_spacing_mm,
            "slice_spacing_mm": self.slice_spacing_mm,
            "problems": [p.__dict__ for p in self.problems],
            "safe_metadata": self.safe_metadata,
            "volume_ready": self.volume_ready,
        }


def _read(blobs: Iterable[bytes]):
    ok, bad = [], 0
    for b in blobs:
        try:
            ds = pydicom.dcmread(io.BytesIO(b), force=False)
            if not hasattr(ds, "ImageOrientationPatient") or not hasattr(ds, "ImagePositionPatient"):
                bad += 1
                continue
            ok.append(ds)
        except (InvalidDicomError, Exception):  # noqa: BLE001 - any parse failure counts as unreadable
            bad += 1
    return ok, bad


def _normal(ds) -> np.ndarray:
    iop = np.array(ds.ImageOrientationPatient, dtype=float)
    return np.cross(iop[:3], iop[3:])


def inspect(blobs: list[bytes]) -> tuple[SeriesReport, list]:
    """Return (report, datasets sorted along the slice normal)."""
    datasets, bad = _read(blobs)
    rep = SeriesReport(
        n_files=len(blobs), n_readable=len(datasets), n_unreadable=bad, series_uids=0,
        slice_count=len(datasets), rows=None, columns=None, pixel_spacing_mm=None, slice_spacing_mm=None,
    )
    if bad:
        rep.problems.append(Problem("unreadable_files", f"{bad} file(s) were not readable DICOM images with position and orientation."))
    if not datasets:
        rep.problems.append(Problem("no_images", "No readable DICOM images."))
        return rep, []

    uids = {str(getattr(d, "SeriesInstanceUID", "")) for d in datasets}
    rep.series_uids = len(uids)
    if len(uids) > 1:
        rep.problems.append(Problem("mixed_series", f"{len(uids)} different series in one upload. Split them first."))

    first = datasets[0]
    rep.rows, rep.columns = int(first.Rows), int(first.Columns)
    ps = getattr(first, "PixelSpacing", None)
    if ps is not None:
        rep.pixel_spacing_mm = (float(ps[0]), float(ps[1]))
    else:
        rep.problems.append(Problem("no_pixel_spacing", "PixelSpacing missing. Physical measurements are not possible."))
    rep.safe_metadata = {t: _plain(getattr(first, t, None)) for t in SAFE_TAGS if hasattr(first, t)}

    if any((int(d.Rows), int(d.Columns)) != (rep.rows, rep.columns) for d in datasets):
        rep.problems.append(Problem("mixed_matrix", "Slices have different matrix sizes."))
    ref_iop = np.array(first.ImageOrientationPatient, dtype=float)
    if any(np.abs(np.array(d.ImageOrientationPatient, dtype=float) - ref_iop).max() > ORIENT_TOL for d in datasets):
        rep.problems.append(Problem("mixed_orientation", "Slice orientation changes within the series."))
    if ps is not None and any(
        not np.allclose([float(x) for x in getattr(d, "PixelSpacing", [np.nan, np.nan])], [float(ps[0]), float(ps[1])], atol=1e-4)
        for d in datasets
    ):
        rep.problems.append(Problem("mixed_pixel_spacing", "Pixel spacing differs between slices."))

    n = _normal(first)
    ordered = sorted(datasets, key=lambda d: float(np.dot(np.array(d.ImagePositionPatient, dtype=float), n)))
    pos = np.array([float(np.dot(np.array(d.ImagePositionPatient, dtype=float), n)) for d in ordered])
    if len(pos) > 1:
        diffs = np.diff(pos)
        med = float(np.median(np.abs(diffs)))
        rep.slice_spacing_mm = med if med > 0 else None
        dups = int(np.sum(np.abs(diffs) < max(med * DUP_RATIO, 1e-6)))
        if dups:
            rep.problems.append(Problem("duplicate_positions", f"{dups} slice(s) share a position with a neighbour."))
        if med > 0:
            gaps = int(np.sum(diffs > med * GAP_RATIO))
            if gaps:
                rep.problems.append(Problem("slice_gap", f"{gaps} gap(s) larger than {GAP_RATIO}x the median spacing. Slices are missing."))
    else:
        rep.problems.append(Problem("single_slice", "One slice only. Not a volume."))

    rep.volume_ready = len(rep.problems) == 0
    return rep, ordered


def stack_volume(blobs: list[bytes]) -> tuple[np.ndarray, tuple[float, float, float], SeriesReport]:
    """Stack a clean series to (z, y, x) float32 in rescaled units. Refuses anything not volume-ready."""
    rep, ordered = inspect(blobs)
    if not rep.volume_ready:
        raise ValueError("Series is not volume-ready: " + "; ".join(p.code for p in rep.problems))
    slices = []
    for d in ordered:
        arr = d.pixel_array.astype(np.float32)
        slope = float(getattr(d, "RescaleSlope", 1.0))
        intercept = float(getattr(d, "RescaleIntercept", 0.0))
        slices.append(arr * slope + intercept)
    vol = np.stack(slices, axis=0)
    ps = rep.pixel_spacing_mm
    assert ps is not None and rep.slice_spacing_mm is not None
    return vol, (rep.slice_spacing_mm, ps[0], ps[1]), rep  # spacing in (z, y, x) order


def _plain(v):
    if isinstance(v, bool):
        return str(v)
    if isinstance(v, (int, float)):
        return float(v) if isinstance(v, float) else int(v)
    return str(v)
