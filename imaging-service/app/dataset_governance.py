"""UMD dataset provenance, licensing, and usage verification registry (Task 2A)."""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass(frozen=True)
class DatasetProvenanceRecord:
    dataset_id: str
    dataset_name: str
    version: str
    original_source_institution: str
    publication_title: str
    publication_authors: str
    publication_journal: str
    publication_year: int
    publication_doi: str
    download_repository: str
    download_url: str
    dataset_doi: str
    declared_license: str
    license_url: str
    attribution_requirements: str
    permitted_uses_verified: list[str]
    unverified_or_restricted_uses: dict[str, str]
    composition: dict[str, Any]
    imaging_modalities_and_sequences: dict[str, Any]
    annotation_methodology: dict[str, Any]
    label_definitions: dict[int, dict[str, str]]
    subject_identifier_structure: dict[str, str]
    known_limitations: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


UMD_PROVENANCE_RECORD = DatasetProvenanceRecord(
    dataset_id="umd_uterine_myoma_mri_2024",
    dataset_name="Uterine Myoma MRI Dataset (UMD)",
    version="1.0 (Figshare 23541312 / Scientific Data 2024)",
    original_source_institution=(
        "Multi-institutional collaboration led by authors affiliated with Chinese clinical and academic "
        "centres as reported in Scientific Data (2024) 11:410"
    ),
    publication_title="A large-scale multi-class dataset for uterine fibroids segmentation on magnetic resonance images",
    publication_authors="Pan, H., Chen, M., Bai, W., et al.",
    publication_journal="Scientific Data (Nature Portfolio)",
    publication_year=2024,
    publication_doi="10.1038/s41597-024-03170-x",
    download_repository="Figshare",
    download_url="https://figshare.com/articles/dataset/UMD_zip/23541312",
    dataset_doi="10.6084/m9.figshare.23541312",
    declared_license="Creative Commons Attribution 4.0 International (CC BY 4.0)",
    license_url="https://creativecommons.org/licenses/by/4.0/",
    attribution_requirements=(
        "Must cite Pan et al., Scientific Data 11, 410 (2024), DOI: 10.1038/s41597-024-03170-x, "
        "and the Figshare dataset DOI: 10.6084/m9.figshare.23541312, indicate if changes/adaptations "
        "were made, and link to the CC BY 4.0 licence without implying endorsement by the original authors."
    ),
    permitted_uses_verified=[
        "Academic and scientific research on automated pelvic MRI segmentation with attribution under CC BY 4.0.",
        "Reproducible benchmarking and training of experimental segmentation algorithms with citation of the paper and dataset DOI.",
    ],
    unverified_or_restricted_uses={
        "bundled_redistribution_in_repo": (
            "NOT BUNDLED — Raw UMD patient NIfTI scans are not committed to this repository; "
            "authorized researchers must download them directly from Figshare under the dataset licence."
        ),
        "regulated_clinical_diagnostic_deployment": (
            "UNVERIFIED / NOT PERMITTED WITHOUT REGULATORY CLEARANCE — CC BY 4.0 is a copyright licence "
            "and expressly disclaims warranties (Section 5). It does NOT grant CDSCO/FDA/CE medical device "
            "approval or clinical validation for diagnostic decision-making."
        ),
        "commercial_medical_device_incorporation": (
            "REQUIRES EXTERNAL LEGAL REVIEW — While CC BY 4.0 does not contain a Non-Commercial (NC) clause, "
            "separate hospital data-transfer agreements, institutional ethics approvals, and national medical "
            "data regulations (e.g., India DPDP Act 2023 / ICMR guidelines) must be independently verified by "
            "legal counsel before commercial productisation."
        ),
        "reidentification_or_linkage": (
            "PROHIBITED — Attempting to re-identify de-identified subjects or link public research scans to "
            "clinical identities violates medical research ethics and data protection law."
        ),
    },
    composition={
        "total_cases": 300,
        "total_annotated_slices_approx": 7722,
        "file_format": "NIfTI (.nii.gz) paired image and multi-class segmentation mask volumes",
        "anatomical_region": "Female pelvis / uterus",
    },
    imaging_modalities_and_sequences={
        "modality": "MRI (Magnetic Resonance Imaging)",
        "primary_sequence": "Sagittal T2-weighted imaging (T2WI)",
        "coordinate_orientation": "Sagittal acquisition (anisotropic slice spacing, thicker through-plane than in-plane)",
    },
    annotation_methodology={
        "software": "ITK-SNAP",
        "annotators": "11 radiologists / imaging specialists with review and quality verification by senior radiologists",
        "protocol": "Slice-by-slice manual polygonal delineation of 4 foreground uterine structures",
    },
    label_definitions={
        0: {
            "name": "background",
            "clinical_description": "Non-uterine pelvic background and surrounding tissue",
        },
        1: {
            "name": "uterine_wall",
            "clinical_description": "Uterine wall / myometrium (excluding cavity, myomas, and Nabothian cysts)",
        },
        2: {
            "name": "cavity",
            "clinical_description": "Uterine cavity / endometrium",
        },
        3: {
            "name": "myoma",
            "clinical_description": "Uterine myoma (uterine fibroid / leiomyoma)",
        },
        4: {
            "name": "nabothian",
            "clinical_description": "Nabothian cyst (cervical retention cyst)",
        },
    },
    subject_identifier_structure={
        "identifier_type": "De-identified sequential case identifiers (e.g., case_0001 to case_0300)",
        "direct_phi_present": "No direct patient names, hospital MRNs, or dates of birth in public NIfTI distribution",
        "longitudinal_linkage_limitation": (
            "Public UMD files are indexed by case ID (1..300). The public release states 300 patient cases; "
            "however, if any external derivative dataset contains multiple scans per subject without explicit "
            "patient_id mapping, case-index splitting alone cannot detect cross-scan subject overlap unless "
            "a subject manifest is supplied and duplicate/similarity checks are run."
        ),
    },
    known_limitations=[
        "Single MRI sequence (sagittal T2-weighted only); models trained solely on UMD do not generalise directly to axial/coronal T1W, DWI, or contrast-enhanced DCE-MRI without domain adaptation.",
        "Anisotropic through-plane resolution typical of clinical 2D sagittal T2W spin-echo acquisitions can cause boundary stair-stepping along the slice-selection axis.",
        "Class imbalance: Nabothian cysts (label 4) and uterine cavity (label 2) occupy a very small fraction of voxels compared with uterine wall (label 1) and large myomas (label 3), and Nabothian cysts are absent in a substantial subset of cases.",
        "Retrospective cohort from specific clinical centres; demographic, scanner-vendor, and field-strength distribution may not represent Indian clinical populations without local multi-centre validation.",
    ],
)


def get_umd_provenance() -> dict[str, Any]:
    return UMD_PROVENANCE_RECORD.to_dict()
