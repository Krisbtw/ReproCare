# ReproCare / AnatomyBridge — UMD Dataset Governance & Provenance

**Last Updated:** 2026-11-02  
**Primary Modules:** `imaging-service/app/privacy.py`, `imaging-service/app/dataset_validation.py`, `imaging-service/train_umd.py`

---

## 1. Official Dataset Source, Version, Licence & Attribution

| Attribute | Verified Detail |
| :--- | :--- |
| **Dataset Name** | Large-scale Uterine Myoma MRI Dataset (UMD) |
| **Primary Publication** | Pan H, Chen M, Bai W, et al. *Large-scale uterine myoma MRI dataset covering all FIGO types with pixel-level annotations*. **Scientific Data** 11, 410 (22 April 2024). [DOI: 10.1038/s41597-024-03170-x](https://pmc.ncbi.nlm.nih.gov/articles/PMC11035617/) |
| **Public Repository** | [Figshare: Uterine myoma MRI dataset](https://figshare.com/articles/dataset/Uterine_myoma_MRI_dataset/24769965) (`v1` / `UMD_221129`) |
| **Licence** | [Creative Commons Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/) |
| **Permitted Use** | Academic research, algorithm development, and reproducible benchmarking with mandatory attribution to the original authors and source DOI; no re-identification of subjects is permitted. |
| **Cohort Size & Demographics** | 300 patients with uterine myoma (6,845 slices total), aged 21–86 years (mean ± SD: $49.73 \pm 12.96$ years), collected between January 2015 and January 2023. |
| **Scanner & Modality** | Philips Ingenia $3.0\text{ T}$ ultra-high-field MRI; standard sagittal T2-weighted imaging (`T2WI`). |
| **File Organization** | Raw DICOM: `<UMD_221129_ID>/ID_*.dcm`; NIfTI volume: `<UMD_221129_ID>/UMD_221129_ID_t2.nii.gz`; NIfTI expert annotation mask: `<UMD_221129_ID>/UMD_221129_ID_seg.nii.gz`. |

---

## 2. Label Definitions & Anatomical Mapping

The UMD dataset is annotated in ITK-SNAP by 11 clinical experts and verified against surgical records and postoperative pathology across five integer voxel classes (`UMD_CLASS_LABELS` in `imaging-service/app/unet.py`):

| Integer Label | Key in ReproCare (`UMD_CLASS_LABELS`) | Anatomical Structure | Clinical Notes |
| :---: | :--- | :--- | :--- |
| `0` | `background` | Background / Non-uterine pelvic tissue | Excluded from foreground macro Dice average |
| `1` | `uterine_wall` | Uterine Wall (Myometrium) | Reference myometrial envelope for FIGO staging context |
| `2` | `cavity` | Uterine Cavity (Endometrium) | Reference endometrial canal for submucosal (FIGO 0–2) proximity |
| `3` | `myoma` | Uterine Fibroid / Leiomyoma (Myoma) | Covers FIGO types 0–8 and hybrid 2–5 myomas |
| `4` | `nabothian` | Nabothian Cyst (Cervical retention cyst) | Benign cervical finding; frequently absent in many cases |

---

## 3. Automated Dataset Governance & Integrity Enforcement

`imaging-service/app/privacy.py` and `imaging-service/app/dataset_validation.py` enforce the following programmatic checks before any training run can start:

1. **Governance & Licence Gate (`verify_training_data_governance`):**
   - Rejects unapproved dataset identifiers (`approved_dataset_id` must match `"UMD"` / `"umd_figshare_cc_by_4"`).
   - Rejects any dataset flagged as containing raw clinical PHI (`contains_patient_phi=True`) or lacking ethical/de-identification clearance.
2. **NIfTI Pairing & Spatial Geometry Validation (`validate_umd_dataset_directory`):**
   - Discovers paired `(*_t2.nii.gz, *_seg.nii.gz)` or `(image.nii.gz, mask.nii.gz)` files per case directory.
   - Verifies that both files exist, are readable 3D NIfTI volumes (`ndim == 3`), have identical 3D voxel dimensions `(Z, Y, X)`, and share matching physical voxel spacing (`spacing_zyx_mm`), origin (`origin_lps_mm`), and 3×3 direction cosines within `1e-4` tolerance.
   - Rejects volumes containing `NaN`/`Inf` intensities, zero-variance blank volumes, or masks containing label integers outside `{0, 1, 2, 3, 4}`.
   - Automatically quarantines invalid or corrupted cases into `excluded_cases` with explicit reason codes rather than crashing mid-epoch or training on corrupted labels.
3. **Subject-Level Leakage Prevention (`create_subject_level_split`, `verify_zero_split_leakage`):**
   - Extracts the canonical `subject_id` from each case (`UMD_221129_<ID>` or subject folder prefix) and assigns all scans from the same patient to the same partition (`70%` train / `15%` validation / `15%` held-out test, deterministic seed `42`).
   - Verifies `train_subjects ∩ val_subjects = ∅`, `train_subjects ∩ test_subjects = ∅`, and `val_subjects ∩ test_subjects = ∅` before training begins.

---

## 4. Known Dataset Limitations & Bias Risks

1. **Single-Scanner & Single-Protocol Bias:** All 300 UMD scans were acquired on a Philips Ingenia $3.0\text{ T}$ scanner using sagittal T2-weighted sequences. Performance on $1.5\text{ T}$ scanners, GE/Siemens/Canon coils, axial/coronal acquisitions, or T1/DWI sequences is unvalidated and subject to domain shift.
2. **Single-Region Demographic Representation:** Collected at a single tertiary hospital cohort (age range 21–86 years, mean $49.73$ years); external validation on diverse Indian multi-center reproductive-age cohorts is required before clinical deployment.
3. **Instance vs Semantic Labeling:** UMD provides semantic voxel classes (`3 = myoma`) rather than separate instance IDs for abutting/kissing fibroids; ReproCare uses 3D 26-connectivity connected-component labeling (`scipy.ndimage.label`) to separate individual fibroid instances, which can merge contiguous kissing fibroids if their boundaries touch.
4. **Local Availability in Offline Sandbox:** The multi-gigabyte UMD NIfTI archive is not bundled inside the Git repository or offline container image. `train_umd.py` never fabricates UMD training results when the dataset directory is absent.
