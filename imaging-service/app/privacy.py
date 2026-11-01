"""Privacy, DICOM PHI inspection, and training data governance safeguards (Task 2B)."""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from enum import Enum
import io
from pathlib import Path
import re
from typing import Any

from .dicom_io import register_pydicom_fallback

pydicom = register_pydicom_fallback()


class DataGovernanceCategory(str, Enum):
    PUBLIC_RESEARCH_DATASET = "public_research_dataset"
    ANONYMISED_RESEARCH_DATA = "anonymised_research_data"
    PSEUDONYMISED_OR_IDENTIFIABLE_PATIENT_DATA = "pseudonymised_or_identifiable_patient_data"
    PROSPECTIVE_CLINICAL_RESEARCH_DATA = "prospective_clinical_research_data"


DICOM_PHI_TAGS: tuple[str, ...] = (
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

SAFE_ANONYMOUS_PLACEHOLDERS = {
    "",
    "anonymous",
    "anon",
    "deidentified",
    "redacted",
    "none",
    "unknown",
    "00000000",
    "19000101",
}

_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
_SSN_RE = re.compile(r"\b\d{3}-\d{2}-\d{4}\b")
_DOB_RE = re.compile(r"\b(19|20)\d{2}[-/](0[1-9]|1[0-2])[-/](0[1-9]|[12]\d|3[01])\b")
_PATIENT_KV_RE = re.compile(
    r"(?i)(patient[_ ]?(?:name|id|ssn|dob|phone|email)|mrn)\s*[:=]\s*([^\s,;]+)"
)


@dataclass
class DicomPrivacyInspectionResult:
    is_deidentified: bool
    detected_phi_tags: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _is_non_anonymous_value(tag_name: str, val: Any) -> bool:
    if val is None:
        return False
    text = str(val).strip()
    if not text:
        return False
    if text.lower() in SAFE_ANONYMOUS_PLACEHOLDERS:
        return False
    if tag_name == "PatientSex" and text.upper() in ("F", "M", "O"):
        return False
    return True


def inspect_dicom_privacy(raw_bytes_or_dataset: bytes | Any) -> DicomPrivacyInspectionResult:
    if isinstance(raw_bytes_or_dataset, (bytes, bytearray)):
        ds = pydicom.dcmread(io.BytesIO(raw_bytes_or_dataset), stop_before_pixels=True, force=False)
    else:
        ds = raw_bytes_or_dataset

    detected: list[str] = []
    warnings: list[str] = []
    for tag in DICOM_PHI_TAGS:
        val = ds.get(tag) if hasattr(ds, "get") else getattr(ds, tag, None)
        if _is_non_anonymous_value(tag, val):
            detected.append(tag)
            warnings.append(f"Potentially identifying DICOM tag '{tag}' is populated")

    return DicomPrivacyInspectionResult(
        is_deidentified=(len(detected) == 0),
        detected_phi_tags=detected,
        warnings=warnings,
    )


def scrub_dicom_phi_bytes(raw_bytes: bytes) -> bytes:
    ds = pydicom.dcmread(io.BytesIO(raw_bytes), stop_before_pixels=False, force=False)
    for tag in DICOM_PHI_TAGS:
        if tag in ds:
            del ds[tag]
    buf = io.BytesIO()
    pydicom.dcmwrite(buf, ds, enforce_file_format=True)
    return buf.getvalue()


def sanitize_log_message(message: str) -> str:
    cleaned = _EMAIL_RE.sub("[REDACTED_EMAIL]", message)
    cleaned = _SSN_RE.sub("[REDACTED_ID]", cleaned)
    cleaned = _DOB_RE.sub("[REDACTED_DATE]", cleaned)
    cleaned = _PATIENT_KV_RE.sub(r"\1=[REDACTED]", cleaned)
    return cleaned


def verify_training_data_governance(
    data_dir: str | Path | None,
    data_category: str | DataGovernanceCategory,
    ethics_approval_ref: str | None = None,
    allow_synthetic: bool = False,
) -> dict[str, Any]:
    try:
        cat = DataGovernanceCategory(str(data_category))
    except ValueError as e:
        valid = [c.value for c in DataGovernanceCategory]
        raise ValueError(f"Invalid data_category '{data_category}'. Must be one of: {valid}") from e

    if cat == DataGovernanceCategory.PSEUDONYMISED_OR_IDENTIFIABLE_PATIENT_DATA:
        raise PermissionError(
            "GOVERNANCE BLOCK: Refusing to run model training on 'pseudonymised_or_identifiable_patient_data'. "
            "Production or identifiable clinical patient scans must never be used for model training without "
            "a verified lawful basis, documented patient consent, IEC/IRB ethics approval, and full de-identification."
        )

    if cat in (
        DataGovernanceCategory.ANONYMISED_RESEARCH_DATA,
        DataGovernanceCategory.PROSPECTIVE_CLINICAL_RESEARCH_DATA,
    ):
        if not ethics_approval_ref or len(ethics_approval_ref.strip()) < 4:
            raise PermissionError(
                f"GOVERNANCE BLOCK: Data category '{cat.value}' requires an explicit institutional ethics "
                "committee approval reference (--ethics-approval-ref)."
            )

    if data_dir is not None:
        p = Path(data_dir).resolve()
        path_lower = str(p).lower()
        forbidden_tokens = ("production_patient", "clinical_patient", "live_patients", "patient_uploads")
        for tok in forbidden_tokens:
            if tok in path_lower:
                raise PermissionError(
                    f"GOVERNANCE BLOCK: Data directory path contains restricted clinical storage token '{tok}'."
                )

        if p.exists():
            for dcm_path in list(p.rglob("*.dcm"))[:100]:
                res = inspect_dicom_privacy(dcm_path.read_bytes())
                if not res.is_deidentified:
                    raise PermissionError(
                        f"GOVERNANCE BLOCK: Training directory contains DICOM file '{dcm_path.name}' "
                        f"with unredacted PHI tag(s): {', '.join(res.detected_phi_tags)}"
                    )

    return {
        "data_category": cat.value,
        "ethics_approval_ref": ethics_approval_ref,
        "governance_verified": True,
        "allow_synthetic": allow_synthetic,
    }
