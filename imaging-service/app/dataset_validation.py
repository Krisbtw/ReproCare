"""Dataset validation, image-mask pairing, geometry consistency, and duplicate detection (Task 2D)."""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
import hashlib
from pathlib import Path
import re
from typing import Any

import numpy as np

from .models import UMD_DEFAULT_LABEL_MAP
from .nifti_io import register_sitk_fallback

sitk = register_sitk_fallback()

_SUBJECT_PATTERNS = (
    re.compile(r"(?i)^(patient[_-]?\d+)"),
    re.compile(r"(?i)^(subj(?:ect)?[_-]?\d+)"),
    re.compile(r"(?i)^(umd[_-]?\d+)"),
    re.compile(r"(?i)^(case[_-]?\d+)"),
)


@dataclass
class CaseValidationRecord:
    case_id: str
    subject_id: str
    subject_id_source: str
    image_path: str
    mask_path: str
    valid: bool
    shape_zyx: tuple[int, int, int] | None = None
    spacing_zyx_mm: tuple[float, float, float] | None = None
    origin_xyz_mm: tuple[float, float, float] | None = None
    present_labels: list[int] = field(default_factory=list)
    class_voxel_counts: dict[str, int] = field(default_factory=dict)
    image_sha256: str | None = None
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class DatasetValidationSummary:
    data_dir: str
    total_paired_candidates: int
    valid_cases_count: int
    invalid_cases_count: int
    unpaired_images: list[str]
    unpaired_masks: list[str]
    duplicate_volume_groups: list[list[str]]
    unique_subjects_count: int
    subject_id_sources: dict[str, int]
    class_case_presence_counts: dict[str, int]
    class_total_voxels: dict[str, int]
    dataset_ready_for_training: bool
    cases: list[CaseValidationRecord] = field(default_factory=list)
    global_errors: list[str] = field(default_factory=list)
    global_warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _strip_nii_ext(name: str) -> str:
    if name.endswith(".nii.gz"):
        return name[:-7]
    if name.endswith(".nii"):
        return name[:-4]
    return Path(name).stem


def extract_subject_id(case_id: str, subject_manifest: dict[str, str] | None = None) -> tuple[str, str]:
    if subject_manifest and case_id in subject_manifest:
        return str(subject_manifest[case_id]).strip(), "manifest"

    clean = _strip_nii_ext(case_id)
    for idx, pat in enumerate(_SUBJECT_PATTERNS):
        m = pat.match(clean)
        if m:
            token = m.group(1).lower().replace("-", "_")
            source = "patient_prefix" if idx < 2 else "case_index_fallback"
            return token, source

    base = re.split(r"[_-](?:scan|series|visit|t\d+)\b", clean, maxsplit=1, flags=re.IGNORECASE)[0]
    return base.lower(), "case_index_fallback"


def validate_single_pair(
    case_id: str,
    image_path: Path,
    mask_path: Path,
    allowed_labels: dict[int, str] | None = None,
    subject_manifest: dict[str, str] | None = None,
) -> CaseValidationRecord:
    labels_map = allowed_labels or UMD_DEFAULT_LABEL_MAP
    subj_id, subj_source = extract_subject_id(case_id, subject_manifest)
    errors: list[str] = []
    warnings: list[str] = []

    if not image_path.exists():
        errors.append(f"Missing image file: {image_path.name}")
    if not mask_path.exists():
        errors.append(f"Missing mask file: {mask_path.name}")
    if errors:
        return CaseValidationRecord(
            case_id=case_id,
            subject_id=subj_id,
            subject_id_source=subj_source,
            image_path=str(image_path),
            mask_path=str(mask_path),
            valid=False,
            errors=errors,
        )

    try:
        img_obj = sitk.ReadImage(str(image_path))
        img_arr = sitk.GetArrayFromImage(img_obj)
    except Exception as e:
        return CaseValidationRecord(
            case_id=case_id,
            subject_id=subj_id,
            subject_id_source=subj_source,
            image_path=str(image_path),
            mask_path=str(mask_path),
            valid=False,
            errors=[f"Unreadable image NIfTI ({e})"],
        )

    try:
        msk_obj = sitk.ReadImage(str(mask_path))
        msk_arr = sitk.GetArrayFromImage(msk_obj)
    except Exception as e:
        return CaseValidationRecord(
            case_id=case_id,
            subject_id=subj_id,
            subject_id_source=subj_source,
            image_path=str(image_path),
            mask_path=str(mask_path),
            valid=False,
            errors=[f"Unreadable mask NIfTI ({e})"],
        )

    if img_arr.ndim != 3:
        errors.append(f"Image is not 3D (shape={img_arr.shape})")
    if msk_arr.ndim != 3:
        errors.append(f"Mask is not 3D (shape={msk_arr.shape})")

    if img_arr.shape != msk_arr.shape:
        errors.append(f"Image shape {img_arr.shape} != mask shape {msk_arr.shape}")

    img_sp = img_obj.GetSpacing()
    msk_sp = msk_obj.GetSpacing()
    if any(s <= 0 or not np.isfinite(s) for s in img_sp):
        errors.append(f"Invalid non-positive image voxel spacing {img_sp}")
    if not np.allclose(img_sp, msk_sp, atol=1e-3):
        errors.append(f"Voxel spacing mismatch: image {img_sp} vs mask {msk_sp}")

    img_orig = img_obj.GetOrigin()
    msk_orig = msk_obj.GetOrigin()
    if not np.allclose(img_orig, msk_orig, atol=1e-2):
        errors.append(f"Origin mismatch: image {img_orig} vs mask {msk_orig}")

    img_dir = img_obj.GetDirection()
    msk_dir = msk_obj.GetDirection()
    if not np.allclose(img_dir, msk_dir, atol=1e-2):
        errors.append("Direction cosines mismatch between image and mask")

    if not np.all(np.isfinite(img_arr)):
        errors.append("Image contains NaN or Inf intensity values")
    elif float(img_arr.max()) - float(img_arr.min()) <= 1e-6:
        errors.append("Image has constant intensity (zero dynamic range)")

    if not np.all(np.isfinite(msk_arr)):
        errors.append("Mask contains NaN or Inf values")
    else:
        if np.any(np.mod(msk_arr, 1) != 0):
            errors.append("Mask contains non-integer label values")
        unique_vals = [int(v) for v in np.unique(np.round(msk_arr).astype(np.int64))]
        allowed_set = set(labels_map.keys())
        unknown = sorted(set(unique_vals) - allowed_set)
        if unknown:
            errors.append(f"Mask contains invalid label integer(s) {unknown} not in {sorted(allowed_set)}")
        if unique_vals == [0] or len(unique_vals) == 0:
            errors.append("Mask is completely empty (contains only background label 0)")
    unique_vals = [int(v) for v in np.unique(np.round(msk_arr).astype(np.int64))] if np.all(np.isfinite(msk_arr)) else []

    voxel_counts: dict[str, int] = {}
    for cid, cname in sorted(labels_map.items()):
        voxel_counts[cname] = int((msk_arr == cid).sum()) if msk_arr.ndim == 3 else 0

    if subj_source == "case_index_fallback":
        warnings.append(
            "Subject ID inferred from case filename index; provide subject_manifest.json if multiple scans per patient exist."
        )

    img_sha256 = hashlib.sha256(np.ascontiguousarray(img_arr, dtype=np.float32).tobytes()).hexdigest()
    spacing_zyx = (float(img_sp[2]), float(img_sp[1]), float(img_sp[0]))
    shape_zyx = (int(img_arr.shape[0]), int(img_arr.shape[1]), int(img_arr.shape[2])) if img_arr.ndim == 3 else None

    return CaseValidationRecord(
        case_id=case_id,
        subject_id=subj_id,
        subject_id_source=subj_source,
        image_path=str(image_path),
        mask_path=str(mask_path),
        valid=(len(errors) == 0),
        shape_zyx=shape_zyx,
        spacing_zyx_mm=spacing_zyx,
        origin_xyz_mm=(float(img_orig[0]), float(img_orig[1]), float(img_orig[2])),
        present_labels=unique_vals,
        class_voxel_counts=voxel_counts,
        image_sha256=img_sha256,
        errors=errors,
        warnings=warnings,
    )


def validate_umd_dataset_directory(
    data_dir: str | Path,
    allowed_labels: dict[int, str] | None = None,
    subject_manifest: dict[str, str] | None = None,
) -> DatasetValidationSummary:
    root = Path(data_dir)
    labels_map = allowed_labels or UMD_DEFAULT_LABEL_MAP
    global_errors: list[str] = []
    global_warnings: list[str] = []

    images_dir = root / "images"
    masks_dir = root / "labels" if (root / "labels").exists() else (root / "masks")

    if not root.exists():
        return DatasetValidationSummary(
            data_dir=str(root),
            total_paired_candidates=0,
            valid_cases_count=0,
            invalid_cases_count=0,
            unpaired_images=[],
            unpaired_masks=[],
            duplicate_volume_groups=[],
            unique_subjects_count=0,
            subject_id_sources={},
            class_case_presence_counts={},
            class_total_voxels={},
            dataset_ready_for_training=False,
            global_errors=[f"Dataset directory does not exist: {root}"],
        )

    if not images_dir.exists() or not masks_dir.exists():
        return DatasetValidationSummary(
            data_dir=str(root),
            total_paired_candidates=0,
            valid_cases_count=0,
            invalid_cases_count=0,
            unpaired_images=[],
            unpaired_masks=[],
            duplicate_volume_groups=[],
            unique_subjects_count=0,
            subject_id_sources={},
            class_case_presence_counts={},
            class_total_voxels={},
            dataset_ready_for_training=False,
            global_errors=[f"Expected 'images/' and 'labels/' (or 'masks/') subdirectories inside {root}"],
        )

    img_files = {
        _strip_nii_ext(p.name): p
        for p in sorted(images_dir.iterdir())
        if p.is_file() and (p.name.endswith(".nii.gz") or p.name.endswith(".nii"))
    }
    msk_files = {
        _strip_nii_ext(p.name): p
        for p in sorted(masks_dir.iterdir())
        if p.is_file() and (p.name.endswith(".nii.gz") or p.name.endswith(".nii"))
    }

    unpaired_images = sorted(set(img_files.keys()) - set(msk_files.keys()))
    unpaired_masks = sorted(set(msk_files.keys()) - set(img_files.keys()))

    if unpaired_images:
        global_errors.append(f"Found {len(unpaired_images)} image(s) without matching mask: {unpaired_images[:5]}")
    if unpaired_masks:
        global_errors.append(f"Found {len(unpaired_masks)} mask(s) without matching image: {unpaired_masks[:5]}")

    paired_ids = sorted(set(img_files.keys()) & set(msk_files.keys()))
    cases: list[CaseValidationRecord] = []
    sha_to_cases: dict[str, list[str]] = {}
    class_presence: dict[str, int] = {name: 0 for name in labels_map.values()}
    class_voxels: dict[str, int] = {name: 0 for name in labels_map.values()}
    subject_sources: dict[str, int] = {}

    for cid in paired_ids:
        rec = validate_single_pair(
            cid,
            img_files[cid],
            msk_files[cid],
            allowed_labels=labels_map,
            subject_manifest=subject_manifest,
        )
        cases.append(rec)
        subject_sources[rec.subject_id_source] = subject_sources.get(rec.subject_id_source, 0) + 1
        if rec.image_sha256:
            sha_to_cases.setdefault(rec.image_sha256, []).append(cid)
        if rec.valid:
            for lbl_id, lbl_name in labels_map.items():
                cnt = rec.class_voxel_counts.get(lbl_name, 0)
                class_voxels[lbl_name] += cnt
                if cnt > 0:
                    class_presence[lbl_name] += 1

    duplicate_groups = [sorted(group) for group in sha_to_cases.values() if len(group) > 1]
    if duplicate_groups:
        global_errors.append(
            f"Detected {len(duplicate_groups)} duplicate image volume group(s) with identical voxel SHA-256: {duplicate_groups}"
        )

    valid_cases = [c for c in cases if c.valid]
    invalid_cases = [c for c in cases if not c.valid]
    unique_subjects = {c.subject_id for c in valid_cases}

    if subject_sources.get("case_index_fallback", 0) > 0:
        global_warnings.append(
            f"{subject_sources['case_index_fallback']} case(s) use case-index filenames without an explicit "
            "multi-visit patient manifest; SHA-256 duplicate volume check was applied to guard against identical scan leakage."
        )

    ready = (
        len(valid_cases) >= 3
        and len(invalid_cases) == 0
        and len(unpaired_images) == 0
        and len(unpaired_masks) == 0
        and len(duplicate_groups) == 0
    )

    return DatasetValidationSummary(
        data_dir=str(root),
        total_paired_candidates=len(paired_ids),
        valid_cases_count=len(valid_cases),
        invalid_cases_count=len(invalid_cases),
        unpaired_images=unpaired_images,
        unpaired_masks=unpaired_masks,
        duplicate_volume_groups=duplicate_groups,
        unique_subjects_count=len(unique_subjects),
        subject_id_sources=subject_sources,
        class_case_presence_counts=class_presence,
        class_total_voxels=class_voxels,
        dataset_ready_for_training=ready,
        cases=cases,
        global_errors=global_errors,
        global_warnings=global_warnings,
    )
