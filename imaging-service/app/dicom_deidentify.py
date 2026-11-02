"""DICOM PS3.15 Basic Application Level Confidentiality Profile de-identification,
deterministic UID remapping, private-tag removal, nested sequence scrubbing, and
burned-in pixel identifier detection for the Python imaging service (Sprint 6 Task 2E & 2F).
"""
from __future__ import annotations

import copy
from datetime import datetime, timedelta
import gzip
import hashlib
import hmac
import struct
from typing import Any

import numpy as np

PS315_IDENTIFYING_KEYWORDS = (
    "AccessionNumber",
    "InstitutionName",
    "InstitutionAddress",
    "InstitutionCodeSequence",
    "ReferringPhysicianName",
    "ReferringPhysicianAddress",
    "ReferringPhysicianTelephoneNumbers",
    "StationName",
    "StudyDescription",
    "InstitutionalDepartmentName",
    "PhysiciansOfRecord",
    "PerformingPhysicianName",
    "NameOfPhysiciansReadingStudy",
    "OperatorsName",
    "AdmittingDiagnosesDescription",
    "DerivationDescription",
    "PatientName",
    "PatientID",
    "IssuerOfPatientID",
    "PatientBirthDate",
    "PatientBirthTime",
    "PatientSex",
    "OtherPatientIDs",
    "OtherPatientNames",
    "PatientBirthName",
    "PatientAge",
    "PatientSize",
    "PatientWeight",
    "PatientAddress",
    "PatientMotherBirthName",
    "MilitaryRank",
    "BranchOfService",
    "MedicalRecordLocator",
    "PatientTelephoneNumbers",
    "EthnicGroup",
    "Occupation",
    "AdditionalPatientHistory",
    "PatientComments",
    "DeviceSerialNumber",
    "ProtocolName",
    "StudyID",
    "ImageComments",
    "RequestingPhysician",
    "RequestingService",
    "AdmissionID",
    "ServiceEpisodeID",
    "ScheduledPerformingPhysicianName",
    "PerformedStationAETitle",
    "PerformedStationName",
    "PerformedLocation",
    "PerformedProcedureStepID",
    "PerformedProcedureStepDescription",
    "RequestAttributesSequence",
    "PersonName",
)

UID_KEYWORDS_TO_REMAP = (
    "MediaStorageSOPInstanceUID",
    "SOPInstanceUID",
    "ReferencedSOPInstanceUID",
    "StudyInstanceUID",
    "SeriesInstanceUID",
    "FrameOfReferenceUID",
)

DATE_KEYWORDS = (
    "StudyDate",
    "SeriesDate",
    "AcquisitionDate",
    "ContentDate",
)

TIME_KEYWORDS = (
    "StudyTime",
    "SeriesTime",
    "AcquisitionTime",
    "ContentTime",
)


def remap_dicom_uid(original_uid: str, salt: str = "reprocare-ps315-default-salt") -> str:
    """Deterministically remap a DICOM UID using HMAC-SHA256 while preserving standard 1.2.840.10008.* UIDs."""
    clean = str(original_uid or "").strip("\x00 ")
    if not clean or clean.startswith("1.2.840.10008."):
        return clean
    digest = hmac.new(salt.encode("utf-8"), clean.encode("utf-8"), hashlib.sha256).hexdigest()
    digits = "".join(str((int(digest[i : i + 2], 16) % 9) + 1) for i in range(0, len(digest), 2))
    prefix = "1.2.826.0.1.3680043.8.498."
    return (prefix + digits)[:64]


def shift_dicom_date(raw_date: str, shift_days: int | None = None) -> str:
    clean = str(raw_date or "").strip()
    if len(clean) != 8 or not clean.isdigit():
        return "19700101"
    if shift_days is None:
        return f"{clean[:4]}0101"
    try:
        dt = datetime.strptime(clean, "%Y%m%d") + timedelta(days=int(shift_days))
        return dt.strftime("%Y%m%d")
    except Exception:
        return "19700101"


def detect_burned_in_pixel_overlay(pixel_array: np.ndarray | None) -> dict[str, Any]:
    """Scan top and bottom border strips (12% height) of 2D/3D pixel array for high-contrast burned-in glyph patterns."""
    if pixel_array is None or not isinstance(pixel_array, np.ndarray) or pixel_array.size == 0:
        return {"suspected": False, "border_sharp_transition_ratio": 0.0, "reason": None}

    plane = pixel_array[0] if pixel_array.ndim == 3 else pixel_array
    if plane.ndim != 2 or plane.shape[0] < 16 or plane.shape[1] < 16:
        return {"suspected": False, "border_sharp_transition_ratio": 0.0, "reason": None}

    plane_f = plane.astype(np.float32)
    vmin = float(plane_f.min())
    vmax = float(plane_f.max())
    span = vmax - vmin
    if span <= 1e-5:
        return {"suspected": False, "border_sharp_transition_ratio": 0.0, "reason": None}

    rows, _ = plane_f.shape
    b_rows = max(2, int(rows * 0.12))
    border_band = np.concatenate([plane_f[:b_rows, :], plane_f[rows - b_rows :, :]], axis=0)

    high_thresh = vmin + 0.78 * span
    grad_thresh = 0.45 * span
    horiz_diff = np.abs(np.diff(border_band, axis=1))
    transition_ratio = float((horiz_diff >= grad_thresh).mean())
    bright_ratio = float((border_band >= high_thresh).mean())

    suspected = bool(transition_ratio >= 0.035 and 0.01 <= bright_ratio <= 0.45)
    return {
        "suspected": suspected,
        "border_sharp_transition_ratio": round(transition_ratio, 4),
        "reason": (
            f"High-contrast sharp horizontal transitions ({transition_ratio * 100:.1f}%) detected in image border bands."
            if suspected
            else None
        ),
    }


def _has_kw(container: Any, kw: str) -> bool:
    if isinstance(container, dict):
        return kw in container
    return kw in container or hasattr(container, kw)


def _get_kw(container: Any, kw: str, default: Any = "") -> Any:
    if isinstance(container, dict):
        return container.get(kw, default)
    if hasattr(container, "get"):
        try:
            return container.get(kw, default)
        except Exception:
            pass
    return getattr(container, kw, default)


def _set_kw(container: Any, kw: str, val: Any) -> None:
    if isinstance(container, dict):
        container[kw] = val
    else:
        setattr(container, kw, val)


def _del_kw(container: Any, kw: str) -> None:
    if isinstance(container, dict):
        container.pop(kw, None)
    else:
        try:
            delattr(container, kw)
        except Exception:
            try:
                del container[kw]
            except Exception:
                pass


def deidentify_dataset(
    ds: Any,
    uid_salt: str = "reprocare-ps315-default-salt",
    date_shift_days: int | None = None,
) -> tuple[Any, dict[str, Any]]:
    """Apply DICOM PS3.15 Basic Application Level Confidentiality Profile to a deep copy of `ds`.

    Never mutates `ds` in place; returns `(derived_ds, report_dict)`.
    Works identically on both `pydicom.Dataset` and `app.dicom_io.FileDataset`.
    """
    derived = copy.deepcopy(ds)
    standard_scrubbed: list[str] = []
    private_removed: list[str] = []
    nested_scrubbed: list[str] = []
    dates_modified: list[str] = []
    uid_remappings: dict[str, str] = {}
    burned_in_reasons: list[str] = []

    # 1. Enumerate and remove private tags (compatible with both pydicom.Dataset and FileDataset)
    if isinstance(derived, dict):
        for k in list(derived.keys()):
            if isinstance(k, tuple) and len(k) == 2 and (k[0] % 2 == 1) and k[0] > 0x0007 and k[0] != 0x7FE0:
                private_removed.append(f"{k[0]:04x},{k[1]:04x}")
    else:
        try:
            for elem in list(derived):
                tag = getattr(elem, "tag", None)
                if tag is not None and getattr(tag, "is_private", False):
                    private_removed.append(f"{int(tag.group):04x},{int(tag.element):04x}")
        except Exception:
            pass

    if hasattr(derived, "remove_private_tags"):
        removed = derived.remove_private_tags()
        if isinstance(removed, list):
            for r in removed:
                if r not in private_removed:
                    private_removed.append(r)

    def _scrub_container(container: Any, in_sequence: bool = False) -> None:
        # Remap UIDs
        for u_kw in UID_KEYWORDS_TO_REMAP:
            if _has_kw(container, u_kw):
                orig_val = str(_get_kw(container, u_kw, "")).strip()
                if orig_val:
                    new_uid = remap_dicom_uid(orig_val, salt=uid_salt)
                    uid_remappings[orig_val] = new_uid
                    _set_kw(container, u_kw, new_uid)
                    if in_sequence:
                        nested_scrubbed.append(u_kw)

        # Shift / generalize dates & times
        for d_kw in DATE_KEYWORDS:
            if _has_kw(container, d_kw):
                orig_d = str(_get_kw(container, d_kw, "")).strip()
                if orig_d:
                    _set_kw(container, d_kw, shift_dicom_date(orig_d, date_shift_days))
                    dates_modified.append(d_kw)
                    if in_sequence:
                        nested_scrubbed.append(d_kw)

        for t_kw in TIME_KEYWORDS:
            if _has_kw(container, t_kw):
                _set_kw(container, t_kw, "000000")
                dates_modified.append(t_kw)

        # Remove identifying keywords
        for kw in PS315_IDENTIFYING_KEYWORDS:
            if _has_kw(container, kw):
                _del_kw(container, kw)
                if in_sequence:
                    nested_scrubbed.append(kw)
                else:
                    standard_scrubbed.append(kw)

        # Recurse into sequences (if any sequence attributes exist)
        for seq_attr in (
            "SharedFunctionalGroupsSequence",
            "PerFrameFunctionalGroupsSequence",
            "ReferencedSeriesSequence",
            "ReferencedStudySequence",
        ):
            seq_val = _get_kw(container, seq_attr, None)
            if isinstance(seq_val, (list, tuple)) or hasattr(seq_val, "__iter__") and not isinstance(seq_val, (str, bytes, dict)):
                for item in seq_val:
                    _scrub_container(item, in_sequence=True)

    _scrub_container(derived, in_sequence=False)
    if hasattr(derived, "file_meta") and derived.file_meta is not None:
        _scrub_container(derived.file_meta, in_sequence=False)

    # Check Burned-In Annotation header flags & pixel border overlay
    burned_tag = str(_get_kw(derived, "BurnedInAnnotation", "")).strip().upper()
    recog_tag = str(_get_kw(derived, "RecognizableVisualFeatures", "")).strip().upper()
    modality = str(_get_kw(derived, "Modality", "")).strip().upper()
    sop_class = str(_get_kw(derived, "SOPClassUID", "")).strip()

    risk = "none"
    if burned_tag == "YES":
        risk = "high"
        burned_in_reasons.append("BurnedInAnnotation (0028,0301) is 'YES'.")
    if recog_tag == "YES":
        if risk == "none":
            risk = "moderate"
        burned_in_reasons.append("RecognizableVisualFeatures (0028,0302) is 'YES'.")
    if sop_class == "1.2.840.10008.5.1.4.1.1.7":
        risk = "high"
        burned_in_reasons.append("Secondary Capture SOPClassUID detected.")
    if modality in {"US", "ES", "SC", "XC", "OT"}:
        if risk == "none":
            risk = "moderate"
        burned_in_reasons.append(f"Modality '{modality}' frequently contains burned-in text overlays.")

    px_arr = None
    try:
        px_arr = derived.pixel_array
    except Exception:
        px_arr = None
    px_check = detect_burned_in_pixel_overlay(px_arr)
    if px_check["suspected"]:
        risk = "high"
        if px_check["reason"]:
            burned_in_reasons.append(px_check["reason"])

    report = {
        "standard_tags_scrubbed": sorted(set(standard_scrubbed)),
        "private_tags_removed": sorted(set(private_removed)),
        "nested_sequence_tags_scrubbed": sorted(set(nested_scrubbed)),
        "dates_modified": sorted(set(dates_modified)),
        "uid_remappings": uid_remappings,
        "burned_in_annotation_risk": risk,
        "burned_in_reasons": burned_in_reasons,
        "pixel_border_text_suspected": px_check["suspected"],
        "manual_review_required": risk != "none",
        "claim_complete_anonymisation": False,
        "profile_applied": "DICOM_PS3.15_Basic_Application_Level_Confidentiality_Profile",
    }
    return derived, report


def deidentify_nifti_bytes(
    raw_bytes: bytes,
    *,
    replacement_descrip: str = "ANON_NIFTI",
) -> tuple[bytes, dict[str, Any]]:
    """Scrubs identifying NIfTI-1 header fields (db_name, descrip, aux_file, intent_name)
    and strips embedded NIfTI extension blocks while preserving qform/sform affine geometry
    and original buffer immutability."""
    if not raw_bytes or len(raw_bytes) < 18:
        raise ValueError("Invalid NIfTI buffer: smaller than 348-byte NIfTI-1 header.")

    orig_sha = hashlib.sha256(raw_bytes).hexdigest()
    is_gzip = raw_bytes[:2] == b"\x1f\x8b"
    decompressed = bytearray(gzip.decompress(raw_bytes) if is_gzip else raw_bytes)
    if len(decompressed) < 352:
        raise ValueError("Decompressed NIfTI-1 stream is smaller than 352 bytes.")

    sizeof_hdr_le = struct.unpack_from("<i", decompressed, 0)[0]
    endian = "<" if sizeof_hdr_le == 348 else ">"
    sizeof_hdr = struct.unpack_from(f"{endian}i", decompressed, 0)[0]
    if sizeof_hdr != 348:
        raise ValueError(f"Invalid NIfTI-1 sizeof_hdr={sizeof_hdr} (expected 348).")

    fields_scrubbed: list[str] = []
    for name, start, length in (
        ("db_name", 14, 18),
        ("descrip", 148, 80),
        ("aux_file", 228, 24),
        ("intent_name", 328, 16),
    ):
        txt = bytes(decompressed[start : start + length]).rstrip(b"\x00 ").decode("utf-8", errors="ignore")
        if txt:
            fields_scrubbed.append(name)
        decompressed[start : start + length] = b"\x00" * length

    rep = replacement_descrip.encode("ascii", errors="ignore")[:79]
    decompressed[148 : 148 + len(rep)] = rep

    orig_vox_offset = max(352, int(round(struct.unpack_from(f"{endian}f", decompressed, 108)[0])))
    ext_removed = max(0, orig_vox_offset - 352)
    if decompressed[348] != 0 or ext_removed > 0:
        fields_scrubbed.append("nifti_extensions")

    decompressed[348:352] = b"\x00\x00\x00\x00"
    struct.pack_into(f"{endian}f", decompressed, 108, 352.0)

    clean_nii = bytes(decompressed[:352]) + bytes(decompressed[orig_vox_offset:])
    derived_bytes = gzip.compress(clean_nii, mtime=0) if is_gzip else clean_nii
    derived_sha = hashlib.sha256(derived_bytes).hexdigest()

    pixdim = struct.unpack_from(f"{endian}3f", clean_nii, 80)
    srow_x = struct.unpack_from(f"{endian}4f", clean_nii, 280)
    srow_y = struct.unpack_from(f"{endian}4f", clean_nii, 296)
    srow_z = struct.unpack_from(f"{endian}4f", clean_nii, 312)

    report: dict[str, Any] = {
        "was_gzipped": is_gzip,
        "original_sha256": orig_sha,
        "derived_sha256": derived_sha,
        "original_preserved": hashlib.sha256(raw_bytes).hexdigest() == orig_sha,
        "fields_scrubbed": fields_scrubbed,
        "extension_bytes_removed": ext_removed,
        "geometry_preserved": {
            "pixdim_mm": [round(float(x), 6) for x in pixdim],
            "srow_x": [round(float(x), 6) for x in srow_x],
            "srow_y": [round(float(x), 6) for x in srow_y],
            "srow_z": [round(float(x), 6) for x in srow_z],
        },
        "claim_complete_anonymisation": False,
    }
    return derived_bytes, report
