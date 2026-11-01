# UMD Uterine Myoma MRI Dataset — Provenance & Governance Record

**Document ID:** `REPROCARE-GOV-UMD-001`  
**Status:** Verified against Primary Publication & Repository Metadata  
**Programmatic Registry:** `imaging-service/app/dataset_governance.py` (`UMD_PROVENANCE_RECORD`)

## 1. Original Dataset Source & Publication

| Attribute | Verified Record |
| :--- | :--- |
| **Dataset Name** | Uterine Myoma MRI Dataset (UMD) |
| **Primary Publication** | Pan, H., Chen, M., Bai, W., et al. *"A large-scale multi-class dataset for uterine fibroids segmentation on magnetic resonance images."* **Scientific Data** (Nature Portfolio), Vol. 11, Article 410 (2024). |
| **Publication DOI** | [`10.1038/s41597-024-03170-x`](https://doi.org/10.1038/s41597-024-03170-x) |
| **Dataset Repository** | Figshare |
| **Dataset Download URL** | [`https://figshare.com/articles/dataset/UMD_zip/23541312`](https://figshare.com/articles/dataset/UMD_zip/23541312) |
| **Dataset DOI** | [`10.6084/m9.figshare.23541312`](https://doi.org/10.6084/m9.figshare.23541312) |
| **Declared Licence** | Creative Commons Attribution 4.0 International (**CC BY 4.0**) — [`https://creativecommons.org/licenses/by/4.0/`](https://creativecommons.org/licenses/by/4.0/) |

## 2. Licence Terms, Attribution & Permission Verification

Following responsible medical AI governance, ReproCare distinguishes between **verified permissions** explicitly stated in the publication/repository metadata and **unverified or restricted uses**:

1. **Attribution Requirements (Verified):**
   - Any research, publication, or derivative model weights trained on UMD must cite Pan et al., *Scientific Data* 11, 410 (2024) (`10.1038/s41597-024-03170-x`) and the Figshare dataset (`10.6084/m9.figshare.23541312`), provide a link to the CC BY 4.0 licence, and indicate if modifications or preprocessing were applied.
2. **Academic & Scientific Research Use (Verified):**
   - Permitted under CC BY 4.0 with proper attribution.
3. **Repository Redistribution Policy (Enforced):**
   - Raw UMD patient NIfTI files are **not** bundled or redistributed inside the ReproCare Git repository. Authorized developers must download the archive directly from the official Figshare record and validate it locally using `imaging-service/app/dataset_validation.py`.
4. **Regulated Clinical Diagnostic Use (UNVERIFIED / NOT PERMITTED WITHOUT CLEARANCE):**
   - CC BY 4.0 is a copyright licence that expressly disclaims all warranties (Section 5) and does **not** grant medical device regulatory approval (CDSCO / FDA / CE), clinical efficacy validation, or patient consent waivers for diagnostic use.
5. **Commercial Medical Product Incorporation (UNVERIFIED — Requires External Legal Review):**
   - Although CC BY 4.0 does not include a Non-Commercial (`NC`) restriction in its copyright terms, using human medical imaging data or derived weights in a commercial healthcare product requires independent legal verification of institutional data-release agreements, medical privacy compliance, and national health data regulations.
6. **Subject Re-Identification (Strictly Prohibited):**
   - Attempting to re-identify subjects or link de-identified research scans to clinical records is strictly prohibited.

## 3. Dataset Composition & Imaging Protocol

- **Cohort Size:** 300 uterine myoma (fibroid) cases (~7,722 2D sagittal slices stacked into 300 3D volumetric NIfTI pairs).
- **Modality & Sequence:** Pelvic Magnetic Resonance Imaging (MRI), **Sagittal T2-Weighted Imaging (T2WI)**.
- **Spatial Characteristics:** Anisotropic clinical 2D spin-echo sagittal acquisitions (fine in-plane resolution, thicker through-plane slice spacing).
- **File Format:** Paired NIfTI (`.nii.gz`) 3D image volumes and 3D multi-class integer segmentation masks.

## 4. Annotation Methodology & Label Definitions

- **Annotation Tool:** ITK-SNAP.
- **Annotation Protocol:** Manual slice-by-slice polygonal delineation performed by 11 radiologists/specialists and reviewed for quality consistency by senior radiologists.
- **Label Mapping (`UMD_DEFAULT_LABEL_MAP`):**

| Label ID | Internal Key | Anatomical Structure | Clinical Description |
| :---: | :--- | :--- | :--- |
| `0` | `background` | Background | Non-uterine pelvic background and surrounding tissue |
| `1` | `uterine_wall` | Uterine Wall | Myometrium (excluding cavity, myomas, and Nabothian cysts) |
| `2` | `cavity` | Uterine Cavity | Endometrial cavity |
| `3` | `myoma` | Uterine Myoma | Uterine fibroid / leiomyoma |
| `4` | `nabothian` | Nabothian Cyst | Cervical Nabothian retention cyst |

## 5. Subject Identifiers & Known Limitations

1. **Subject Identifier Structure:**
   - Public UMD files use de-identified sequential case identifiers (e.g., `case_0001` through `case_0300`). Direct DICOM PHI tags are absent from the NIfTI release.
   - **Splitting Limitation:** While Pan et al. (2024) describe 300 patient cases, case-numbered filenames alone cannot prove the absence of repeat longitudinal scans if an external derivative dataset lacks an explicit `case_id -> patient_id` manifest. Therefore, `imaging-service/app/dataset_validation.py` and `dataset_split.py` support an explicit `subject_manifest.json`, enforce SHA-256 voxel-hash duplicate detection across the entire cohort, and record an explicit provenance warning whenever case-index fallback IDs are used.
2. **Modality Generalisation Limitation:**
   - The dataset contains sagittal T2W MRI only. Models trained on UMD do not generalise automatically to axial/coronal orientations, T1W, DWI, or ultrasound without domain-specific training.
3. **Foreground Class Imbalance:**
   - Label `4` (`nabothian`) and Label `2` (`cavity`) occupy a small fraction of total volume compared with Label `1` (`uterine_wall`) and Label `3` (`myoma`), and Nabothian cysts are absent in many cases. Evaluation must never assign `Dice = 1.0` when a class is absent in both prediction and ground truth.
