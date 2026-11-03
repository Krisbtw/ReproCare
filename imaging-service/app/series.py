"""DICOM series inspection, multi-frame expansion, and 3D volume assembly with full spatial geometry preservation (Sprint 5 Task 1B, 1C, 1D)."""
from __future__ import annotations

import copy
import io
from dataclasses import asdict, dataclass, field
from typing import Iterable

import numpy as np

from .dicom_io import dcmread as fallback_dcmread, register_pydicom_fallback

pydicom = register_pydicom_fallback()


_PHI_KEYWORDS = (
    "PatientName",
    "PatientID",
    "PatientBirthDate",
    "PatientSex",
    "PatientAge",
    "PatientAddress",
    "PatientTelephoneNumbers",
    "OtherPatientIDs",
    "OtherPatientNames",
    "IssuerOfPatientID",
    "InstitutionName",
    "InstitutionAddress",
    "ReferringPhysicianName",
    "PerformingPhysicianName",
    "PhysiciansOfRecord",
    "OperatorsName",
    "AccessionNumber",
    "StudyID",
)


@dataclass
class SliceInfo:
    index: int
    position_along_normal_mm: float
    rows: int
    columns: int
    pixel_spacing_mm: tuple[float, float]
    orientation: tuple[float, ...]
    origin_lps_mm: tuple[float, float, float]
    series_uid_hash: str
    frame_of_reference_uid: str | None


@dataclass
class Problem:
    code: str
    detail: str


@dataclass
class VolumeGeometry:
    """Complete physical 3D coordinate geometry for a stacked DICOM volume."""

    shape_zyx: tuple[int, int, int]
    spacing_zyx_mm: tuple[float, float, float]
    origin_lps_mm: tuple[float, float, float]
    direction_cosines: tuple[float, float, float, float, float, float, float, float, float]
    frame_of_reference_uid: str | None = None
    patient_position: str | None = None
    transfer_syntax_uid: str | None = None

    def to_dict(self) -> dict:
        return {
            "shape_zyx": list(self.shape_zyx),
            "spacing_zyx_mm": [round(float(v), 6) for v in self.spacing_zyx_mm],
            "origin_lps_mm": [round(float(v), 6) for v in self.origin_lps_mm],
            "direction_cosines": [round(float(v), 6) for v in self.direction_cosines],
            "frame_of_reference_uid": self.frame_of_reference_uid,
            "patient_position": self.patient_position,
            "transfer_syntax_uid": self.transfer_syntax_uid,
        }


@dataclass
class SeriesReport:
    n_files: int
    n_readable: int
    n_unreadable: int
    slice_count: int
    rows: int | None
    columns: int | None
    pixel_spacing_mm: tuple[float, float] | None
    slice_spacing_mm: float | None
    modality: str | None
    series_description: str | None
    volume_ready: bool
    problems: list[Problem] = field(default_factory=list)
    origin_lps_mm: tuple[float, float, float] | None = None
    direction_cosines: tuple[float, ...] | None = None
    frame_of_reference_uid: str | None = None
    patient_position: str | None = None
    transfer_syntax_uid: str | None = None

    def to_dict(self) -> dict:
        return asdict(self)


def _strip_phi(ds: pydicom.Dataset) -> None:
    for kw in _PHI_KEYWORDS:
        if kw in ds:
            if isinstance(ds, dict):
                del ds[kw]
            else:
                try:
                    delattr(ds, kw)
                except Exception:
                    pass


def _normal(iop: Iterable[float]) -> np.ndarray:
    vals = [float(x) for x in iop]
    row = np.asarray(vals[:3], dtype=np.float64)
    col = np.asarray(vals[3:6], dtype=np.float64)
    n = np.cross(row, col)
    norm = np.linalg.norm(n)
    return n / norm if norm > 0 else n


def _direction_tuple(iop: Iterable[float]) -> tuple[float, float, float, float, float, float, float, float, float]:
    vals = [float(x) for x in iop]
    row = np.asarray(vals[:3], dtype=np.float64)
    col = np.asarray(vals[3:6], dtype=np.float64)
    r_norm = np.linalg.norm(row)
    c_norm = np.linalg.norm(col)
    if r_norm > 0:
        row = row / r_norm
    if c_norm > 0:
        col = col / c_norm
    n = np.cross(row, col)
    n_norm = np.linalg.norm(n)
    if n_norm > 0:
        n = n / n_norm
    return (
        float(row[0]), float(row[1]), float(row[2]),
        float(col[0]), float(col[1]), float(col[2]),
        float(n[0]), float(n[1]), float(n[2]),
    )


def inspect(raw_files: list[bytes], stop_before_pixels: bool = True) -> tuple[SeriesReport, list[tuple[float, pydicom.Dataset]]]:
    readable: list[pydicom.Dataset] = []
    unreadable = 0
    for b in raw_files:
        try:
            try:
                ds = pydicom.dcmread(io.BytesIO(b), stop_before_pixels=stop_before_pixels, force=False)
            except Exception:
                ds = fallback_dcmread(io.BytesIO(b), stop_before_pixels=stop_before_pixels, force=False)
            if "SOPClassUID" not in ds and "Modality" not in ds and "Rows" not in ds:
                unreadable += 1
                continue
            _strip_phi(ds)
            object.__setattr__(ds, "_raw_bytes", b)
            readable.append(ds)
        except Exception:
            unreadable += 1

    problems: list[Problem] = []
    if unreadable:
        problems.append(Problem("unreadable_files", f"{unreadable} file(s) were not valid DICOM"))

    if not readable:
        return (
            SeriesReport(
                n_files=len(raw_files),
                n_readable=0,
                n_unreadable=unreadable,
                slice_count=0,
                rows=None,
                columns=None,
                pixel_spacing_mm=None,
                slice_spacing_mm=None,
                modality=None,
                series_description=None,
                volume_ready=False,
                problems=problems or [Problem("empty", "no readable DICOM slices")],
            ),
            [],
        )

    series_uids = {str(ds.get("SeriesInstanceUID", "")) for ds in readable}
    if len(series_uids) > 1:
        problems.append(Problem("mixed_series", f"{len(series_uids)} different SeriesInstanceUIDs in upload"))

    patient_positions = {str(ds.get("PatientPosition", "")).strip() for ds in readable if str(ds.get("PatientPosition", "")).strip()}
    if len(patient_positions) > 1:
        problems.append(Problem("mixed_patient_position", f"inconsistent PatientPosition values: {sorted(patient_positions)}"))

    positioned: list[tuple[float, np.ndarray, pydicom.Dataset]] = []
    missing_geom = 0
    for ds in readable:
        ipp = ds.get("ImagePositionPatient")
        iop = ds.get("ImageOrientationPatient")
        ps = ds.get("PixelSpacing")
        if ipp is None or iop is None or ps is None or "Rows" not in ds or "Columns" not in ds:
            missing_geom += 1
            continue
        n = _normal(iop)
        base_ipp = np.asarray([float(x) for x in ipp], dtype=np.float64)
        iop_arr = np.asarray([float(x) for x in iop], dtype=np.float64)
        num_frames = int(ds.get("NumberOfFrames", 1) or 1)
        if num_frames > 1:
            gfov = ds.get("GridFrameOffsetVector")
            sbs = ds.get("SpacingBetweenSlices")
            if gfov is not None and isinstance(gfov, (list, tuple)) and len(gfov) == num_frames:
                for f_idx, off in enumerate(gfov):
                    f_ds = copy.deepcopy(ds)
                    object.__setattr__(f_ds, "_frame_index", f_idx)
                    object.__setattr__(f_ds, "_raw_bytes", getattr(ds, "_raw_bytes", None))
                    f_ipp = base_ipp + float(off) * n
                    f_ds.ImagePositionPatient = [float(f_ipp[0]), float(f_ipp[1]), float(f_ipp[2])]
                    positioned.append((float(np.dot(f_ipp, n)), iop_arr, f_ds))
            elif sbs is not None and float(sbs) > 0:
                step = float(sbs)
                for f_idx in range(num_frames):
                    f_ds = copy.deepcopy(ds)
                    object.__setattr__(f_ds, "_frame_index", f_idx)
                    object.__setattr__(f_ds, "_raw_bytes", getattr(ds, "_raw_bytes", None))
                    f_ipp = base_ipp + (f_idx * step) * n
                    f_ds.ImagePositionPatient = [float(f_ipp[0]), float(f_ipp[1]), float(f_ipp[2])]
                    positioned.append((float(np.dot(f_ipp, n)), iop_arr, f_ds))
            else:
                missing_geom += 1
        else:
            z = float(np.dot(base_ipp, n))
            positioned.append((z, iop_arr, ds))

    if missing_geom:
        problems.append(Problem("missing_geometry", f"{missing_geom} slice(s)/multi-frame object(s) lack position, orientation, pixel spacing, or frame spacing"))

    if not positioned:
        return (
            SeriesReport(
                n_files=len(raw_files),
                n_readable=len(readable),
                n_unreadable=unreadable,
                slice_count=0,
                rows=None,
                columns=None,
                pixel_spacing_mm=None,
                slice_spacing_mm=None,
                modality=str(readable[0].get("Modality", "")) or None,
                series_description=str(readable[0].get("SeriesDescription", "")) or None,
                volume_ready=False,
                problems=problems,
            ),
            [],
        )

    positioned.sort(key=lambda t: t[0])
    ref_iop = positioned[0][1]
    for _, iop, _ in positioned[1:]:
        if not np.allclose(iop, ref_iop, atol=1e-2):
            problems.append(Problem("mixed_orientation", "slices do not share a single ImageOrientationPatient"))
            break

    shapes = {(int(ds.Rows), int(ds.Columns)) for _, _, ds in positioned}
    if len(shapes) > 1:
        problems.append(Problem("mixed_dimensions", f"inconsistent slice matrix sizes: {sorted(shapes)}"))

    spacings = {(round(float(ds.PixelSpacing[0]), 4), round(float(ds.PixelSpacing[1]), 4)) for _, _, ds in positioned}
    if len(spacings) > 1:
        problems.append(Problem("mixed_pixel_spacing", f"inconsistent PixelSpacing across slices: {sorted(spacings)}"))

    zs = np.asarray([z for z, _, _ in positioned], dtype=np.float64)
    slice_spacing: float | None = None
    if len(zs) < 2:
        problems.append(Problem("too_few_slices", "need at least 2 positioned slices to form a volume"))
    else:
        dz = np.diff(zs)
        if np.any(np.abs(dz) < 1e-3):
            problems.append(Problem("duplicate_positions", "two or more slices share the same spatial position"))
        pos_dz = dz[dz >= 1e-3]
        if len(pos_dz):
            median_step = float(np.median(pos_dz))
            slice_spacing = round(median_step, 4)
            if np.any(np.abs(pos_dz - median_step) > max(0.05 * median_step, 0.1)):
                problems.append(
                    Problem(
                        "slice_gap",
                        f"uneven slice spacing (median {median_step:.2f} mm, range {pos_dz.min():.2f}–{pos_dz.max():.2f} mm)",
                    )
                )

    ds0 = positioned[0][2]
    rows, cols = int(ds0.Rows), int(ds0.Columns)
    ps0 = (float(ds0.PixelSpacing[0]), float(ds0.PixelSpacing[1]))
    ipp0 = ds0.get("ImagePositionPatient")
    origin0 = (float(ipp0[0]), float(ipp0[1]), float(ipp0[2])) if ipp0 is not None else (0.0, 0.0, 0.0)
    dir_cosines = _direction_tuple(ref_iop)
    for_uid = str(ds0.get("FrameOfReferenceUID", "")).strip() or None
    pat_pos = str(ds0.get("PatientPosition", "")).strip() or None
    fmeta = getattr(ds0, "file_meta", None)
    ts_raw = getattr(fmeta, "TransferSyntaxUID", None) if fmeta is not None else None
    if ts_raw is None and isinstance(fmeta, dict):
        ts_raw = fmeta.get("TransferSyntaxUID")
    ts_uid = str(ts_raw or "").strip() or None

    report = SeriesReport(
        n_files=len(raw_files),
        n_readable=len(readable),
        n_unreadable=unreadable,
        slice_count=len(positioned),
        rows=rows,
        columns=cols,
        pixel_spacing_mm=ps0,
        slice_spacing_mm=slice_spacing,
        modality=str(ds0.get("Modality", "")) or None,
        series_description=str(ds0.get("SeriesDescription", "")) or None,
        volume_ready=(len(problems) == 0),
        problems=problems,
        origin_lps_mm=origin0,
        direction_cosines=dir_cosines,
        frame_of_reference_uid=for_uid,
        patient_position=pat_pos,
        transfer_syntax_uid=ts_uid,
    )
    return report, [(z, ds) for z, _, ds in positioned]


def stack_volume(raw_files: list[bytes]) -> tuple[np.ndarray, tuple[float, float, float], SeriesReport]:
    report, ordered = inspect(raw_files, stop_before_pixels=False)
    if not report.volume_ready or report.slice_spacing_mm is None or report.pixel_spacing_mm is None:
        codes = ", ".join(p.code for p in report.problems) or "not volume_ready"
        raise ValueError(f"Refusing to stack unsafe series ({codes})")

    # Preallocate 3D volume to avoid 2x heap duplication from temporary planes list + np.stack
    nz = len(ordered)
    rows = int(report.rows or 0)
    cols = int(report.columns or 0)
    vol = np.empty((nz, rows, cols), dtype=np.float32)

    for i, (_, ds) in enumerate(ordered):
        try:
            arr = ds.pixel_array.astype(np.float32)
        except Exception:
            raw_b = getattr(ds, "_raw_bytes", None)
            if raw_b is None:
                raise
            arr = fallback_dcmread(io.BytesIO(raw_b), stop_before_pixels=False).pixel_array.astype(np.float32)
        f_idx = getattr(ds, "_frame_index", None)
        if f_idx is None and isinstance(ds, dict):
            f_idx = ds.get("_frame_index")
        if f_idx is not None and arr.ndim == 3:
            arr = arr[int(f_idx)]
        slope = float(getattr(ds, "RescaleSlope", 1.0) or 1.0)
        intercept = float(getattr(ds, "RescaleIntercept", 0.0) or 0.0)
        vol[i] = arr * slope + intercept
    spacing_zyx = (report.slice_spacing_mm, report.pixel_spacing_mm[0], report.pixel_spacing_mm[1])
    return vol, spacing_zyx, report


def stack_volume_with_geometry(raw_files: list[bytes]) -> tuple[np.ndarray, VolumeGeometry, SeriesReport]:
    """Stack DICOM series into a 3D volume and return full physical coordinate geometry."""
    vol, spacing_zyx, report = stack_volume(raw_files)
    origin_lps = report.origin_lps_mm or (0.0, 0.0, 0.0)
    direction = report.direction_cosines or (1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0)
    geometry = VolumeGeometry(
        shape_zyx=(int(vol.shape[0]), int(vol.shape[1]), int(vol.shape[2])),
        spacing_zyx_mm=(float(spacing_zyx[0]), float(spacing_zyx[1]), float(spacing_zyx[2])),
        origin_lps_mm=(float(origin_lps[0]), float(origin_lps[1]), float(origin_lps[2])),
        direction_cosines=tuple(float(v) for v in direction),  # type: ignore[arg-type]
        frame_of_reference_uid=report.frame_of_reference_uid,
        patient_position=report.patient_position,
        transfer_syntax_uid=report.transfer_syntax_uid,
    )
    return vol, geometry, report
