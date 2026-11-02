"""DICOM PS3.15 Basic Application Level Confidentiality Profile de-identification,
deterministic UID remapping, private-tag removal, nested sequence scrubbing, and
burned-in pixel identifier detection for the Python imaging service (Sprint 6 Task 2E & 2F).
"""
from __future__ import annotations

import copy
from datetime import datetime, timedelta
import hashlib
import hmac
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


def deidentify_dataset(
    ds: Any,
    uid_salt: str = "reprocare-ps315-default-salt",
    date_shift_days: int | None = None,
) -> tuple[Any, dict[str, Any]]:
    """Apply DICOM PS3.15 Basic Application Level Confidentiality Profile to a deep copy of `ds`.

    Never mutates `ds` in place; returns `(derived_ds, report_dict)`.
    """
    derived = copy.deepcopy(ds)
    standard_scrubbed: list[str] = []
    private_removed: list[str] = []
    nested_scrubbed: list[str] = []
    dates_modified: list[str] = []
    uid_remappings: dict[str, str] = {}
    burned_in_reasons: list[str] = []

    # 1. Remove private tags if supported by dataset object
    if hasattr(derived, "remove_private_tags"):
        removed = derived.remove_private_tags()
        if isinstance(removed, list):
            private_removed.extend(removed)

    def _scrub_container(container: Any, in_sequence: bool = False) -> None:
        # Remap UIDs
        for u_kw in UID_KEYWORDS_TO_REMAP:
            if u_kw in container:
                orig_val = str(container.get(u_kw, "")).strip()
                if orig_val:
                    new_uid = remap_dicom_uid(orig_val, salt=uid_salt)
                    uid_remappings[orig_val] = new_uid
                    setattr(container, u_kw, new_uid)
                    if in_sequence:
                        nested_scrubbed.append(u_kw)

        # Shift / generalize dates & times
        for d_kw in DATE_KEYWORDS:
            if d_kw in container:
                orig_d = str(container.get(d_kw, "")).strip()
                if orig_d:
                    setattr(container, d_kw, shift_dicom_date(orig_d, date_shift_days))
                    dates_modified.append(d_kw)
                    if in_sequence:
                        nested_scrubbed.append(d_kw)

        for t_kw in TIME_KEYWORDS:
            if t_kw in container:
                setattr(container, t_kw, "000000")
                dates_modified.append(t_kw)

        # Remove identifying keywords
        for kw in PS315_IDENTIFYING_KEYWORDS:
            if kw in container:
                del container[kw]
                if in_sequence:
                    nested_scrubbed.append(kw)
                else:
                    standard_scrubbed.append(kw)

        # Recurse into sequences (if any sequence attributes exist)
        for seq_attr in ("SharedFunctionalGroupsSequence", "PerFrameFunctionalGroupsSequence", "ReferencedSeriesSequence", "ReferencedStudySequence"):
            seq_val = getattr(container, seq_attr, None)
            if isinstance(seq_val, list):
                for item in seq_val:
                    _scrub_container(item, in_sequence=True)

    _scrub_container(derived, in_sequence=False)
    if hasattr(derived, "file_meta") and derived.file_meta is not None:
        _scrub_container(derived.file_meta, in_sequence=False)

    # Check Burned-In Annotation header flags & pixel border overlay
    burned_tag = str(derived.get("BurnedInAnnotation", "")).strip().upper()
    recog_tag = str(derived.get("RecognizableVisualFeatures", "")).strip().upper()
    modality = str(derived.get("Modality", "")).strip().upper()
    sop_class = str(derived.get("SOPClassUID", "")).strip()

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
