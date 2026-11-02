# ReproCare — Medical AI Risk Management File & Model Lifecycle Controls

**Document ID:** `REPROCARE-RISK-ISO14971-005`  
**Version:** `1.0 (Final Completion Sprint 1)`  
**Applicable Standards Assessed:** ISO 14971:2019, IEC 62304:2006+A1:2015, ISO 13485:2016, IEC 82304-1:2016, IEC 62366-1:2015

> **Important Notice:** This document constitutes the engineering hazard analysis, risk management file, international standards applicability assessment, and post-training model lifecycle control specification for ReproCare's experimental medical imaging and AI segmentation pipeline.

---

## 1. Applicability Assessment of International Medical Software Standards

| Standard | Title & Scope | Applicability to ReproCare | Current Engineering Alignment & Remaining Gap for Regulated Release |
| :--- | :--- | :--- | :--- |
| **ISO 14971:2019** | *Medical devices — Application of risk management to medical devices* | **Directly Applicable** to all imaging, AI segmentation, 3D reconstruction, longitudinal measurement, and clinical report extraction functions. | **Addressed in Engineering:** Hazard identification, severity/likelihood scoring, technical risk controls in code, and residual risk disclosure (Section 2 below).<br>**Gap for Regulated Release:** Formal sign-off by an ISO 13485 Quality & Clinical Risk Management Board and post-market clinical follow-up (PMCF) plan. |
| **IEC 62304:2006 + A1:2015** | *Medical device software — Software life cycle processes* | **Directly Applicable** to the ReproCare web application and `imaging-service` Python backend. Software Safety Classification: **Class B** (non-serious injury possible if erroneous decision-support output is not caught by clinician review). | **Addressed in Engineering:** Modular architectural decomposition, unit/integration verification (`273` TS + `107` Python tests), deterministic builds, SOUP (Software of Unknown Provenance) inventory (`package.json`, `requirements.txt`), and version-controlled migrations.<br>**Gap for Regulated Release:** Formal Software Development Plan (SDP), full requirements-to-test traceability matrix under an audited QMS. |
| **ISO 13485:2016** | *Medical devices — Quality management systems — Requirements for regulatory purposes* | **Applicable at Organizational Level** before applying for a CDSCO Class B/C manufacturing licence under MDR 2017. | **Addressed in Engineering:** Technical design history documentation, change-controlled Git commits, and immutable checkpoint registry.<br>**Gap for Regulated Release:** Requires organizational QMS certification by a CDSCO-notified auditing body, document control SOPs, CAPA, and supplier audits. |
| **IEC 82304-1:2016** | *Health software — Part 1: General requirements for product safety* | **Directly Applicable** as standalone health software operating on general-purpose IT infrastructure. | **Addressed in Engineering:** Explicit intended-use boundaries, instructions for use (`docs/USER_MANUAL.md`, `docs/INSTALL.md`), fail-closed authentication/authorization, SHA-256 data integrity checks, and security headers.<br>**Gap for Regulated Release:** Formal product safety validation report in the target clinical network environment. |
| **IEC 62366-1:2015** | *Medical devices — Part 1: Application of usability engineering to medical devices* | **Directly Applicable** to prevent use errors and automation bias in `VolumeLab`, `ReproTrace`, and condition pathway screens. | **Addressed in Engineering:** Prominent `ai_experimental` and `unreviewed` badges, separation of manual seeded segmentation from AI segmentation, mandatory clinician review notes, and explicit uncertainty banners.<br>**Gap for Regulated Release:** Summative human-factors usability testing with representative Indian clinicians and patients. |

---

## 2. Medical AI Hazard & Risk Management Matrix (ISO 14971)

**Severity Scale:** `S1` Negligible | `S2` Minor | `S3` Serious (inappropriate diagnostic workup or delayed/incorrect therapy) | `S4` Critical  
**Likelihood Scale (Pre-Control -> Post-Control):** `L1` Improbable | `L2` Remote | `L3` Occasional | `L4` Probable

| # | Hazard / Risk Category | Clinical Failure Mode & Potential Harm | Pre-Control Severity / Likelihood | Technical & Workflow Mitigations Implemented in ReproCare | Post-Control Likelihood & Residual Risk |
| :---: | :--- | :--- | :---: | :--- | :--- |
| **1** | **False Positive Segmentation** | AI model labels normal myometrium, bowel loop, or Nabothian cyst as a uterine fibroid (`myoma`), leading to overestimation of fibroid burden. | `S3` / `L4` | • `postprocess_segmentation` (`app/models.py`) supports connected-component filtering (`min_component_voxels`).<br>• `metrics.false_positive_negative_analysis` quantifies spurious FP volume (`fp_volume_ml`) and disconnected FP components.<br>• All AI masks are labeled `ai_experimental` and `unreviewed` until verified on multi-planar slices by a clinician. | `L2` (Acceptable with mandatory clinician slice-by-slice verification; residual risk disclosed in UI). |
| **2** | **False Negative Segmentation** | AI model misses a small submucosal (FIGO 0–2) or pedunculated fibroid, or under-segments lesion boundaries. | `S3` / `L4` | • Combined Class-Weighted Cross-Entropy + Multi-Class Soft Dice Loss (`DEFAULT_CLASS_WEIGHTS = (0.20, 1.00, 2.50, 3.00, 3.50)`) penalizes missed foreground structures.<br>• Evaluation pipeline explicitly flags `missed_when_present` (`failed_cases` in `app/evaluation.py`).<br>• Manual 3D seeded region-growing (`segmentFromSeed`) and manual caliper tools remain independently available in `VolumeLab`. | `L2` (Clinicians must inspect the original MRI series directly; AI never replaces primary radiological reading). |
| **3** | **Incorrect Anatomical Measurements** | Wrong voxel spacing, missing slices, or uncalibrated pixel intensities cause erroneous millimetre diameter or $\text{cm}^3$ volume calculations. | `S3` / `L3` | • `analyzeSeries` (`src/lib/imaging/series.ts`) and `series.inspect` (`imaging-service/app/series.py`) block volume assembly when `PixelSpacing`, `ImagePositionPatient`, or `ImageOrientationPatient` are missing, or when slice gaps (`missing_slices`) or mixed orientations occur.<br>• `reconcileReportWithImaging` flags discrepancies ($\ge 20\%$ or $\ge 5\text{ mm}$) between report measurements and imaging measurements. | `L1` (Series failing geometric consistency are refused for 3D volumetric measurement). |
| **4** | **Misleading 3D Reconstructions** | Isosurface mesh is exported or rendered in arbitrary voxel indices instead of physical patient space, or triangle winding is inverted. | `S2` / `L3` | • `VolumePatientGeometry` preserves `originMm`, `rowCosines`, `colCosines`, `normalCosines`, and `patientPosition` end-to-end.<br>• `transformMeshToPatientSpace` transforms vertices into physical DICOM LPS millimetres and corrects negative-determinant triangle winding.<br>• `validateExportedMeshGeometry` verifies exported STL/OBJ vertex coordinates within $\le 0.01\text{ mm}$. | `L1` (Verified by automated geometry preservation test suite). |
| **5** | **Incorrect Finding Correspondence** | Longitudinal tracker (`ReproTrace`) matches two different fibroids across baseline and follow-up studies, producing a false growth rate. | `S3` / `L3` | • `src/lib/imaging/registration.ts` requires explicit 3D rigid/affine transform validation (or flags correspondence as `uncertain` / `provisional = true` when spatial registration is unavailable or residual landmark error is high).<br>• Every correspondence requires explicit clinician confirmation (`decideCorrespondence`) before being marked confirmed. | `L2` (Uncertain correspondences are visually flagged and never auto-confirmed). |
| **6** | **Population & Scanner Bias** | Model trained on UMD (Chinese hospital sagittal T2W MRI cohort) underperforms on Indian patient demographics, different coil profiles, 1.5T vs. 3.0T scanners, or axial/coronal acquisitions. | `S3` / `L4` | • `UMD_PROVENANCE_RECORD` (`app/dataset_governance.py`) and UI metadata explicitly disclose single-sequence (sagittal T2WI) and geographic cohort limitations (`external_validation_performed: False`).<br>• `validate_input_volume` rejects blank, corrupt, or non-3D inputs. | `L3` (**Requires External Clinical Validation** on multi-centre Indian MRI cohorts prior to clinical deployment). |
| **7** | **Data Leakage (Train / Val / Test)** | Slices or repeat scans from the same patient appear in both training and test splits, producing over-optimistic evaluation metrics. | `S2` / `L3` | • `create_subject_level_split` (`app/dataset_split.py`) partitions by `subject_id` (70% train / 15% val / 15% held-out test) and runs `verify_zero_split_leakage` across both subject IDs and 3D volume SHA-256 hashes.<br>• Held-out test set is never used for gradient updates or checkpoint selection. | `L1` (Mathematically verified by `zero_subject_leakage_verified` and `zero_volume_hash_leakage_verified`). |
| **8** | **Model Drift** | Changes in MRI acquisition protocols, scanner software upgrades, or patient case mix degrade segmentation Dice/IoU over time. | `S3` / `L3` | • Every segmentation run records `model_id`, `model_version`, `checkpoint_sha256`, `preprocessing`, and `label_counts` in `segmentation_runs`.<br>• Post-training monitoring plan tracks clinician rejection/override rates and report-vs-imaging measurement discrepancies (Section 3.3). | `L2` (Controlled via versioned checkpoint registry and rollback procedure). |
| **9** | **Cybersecurity & Unauthorized Access Risks** | Unauthorized user accesses another patient's DICOM scans, or malicious pickle checkpoint executes arbitrary code during model loading. | `S4` / `L3` | • `checkPatientAndClinicianAccess` (`src/lib/imaging/storage.server.ts`) enforces fail-closed profile, verification, ownership, and consent checks.<br>• `load_checkpoint_bundle` (`app/models.py`) uses pickle-free NPZ bundles (`allow_pickle=False`) or `torch.load(..., weights_only=True)` and verifies SHA-256 sidecar checksums.<br>• Constant-time `hmac.compare_digest` API key verification in `imaging-service`. | `L1` (Verified by 12-scenario storage security test suite and Python security suite). |
| **10** | **Incorrect User Interpretation** | Patient or clinician misinterprets an unreviewed AI extraction, normal endometriosis scan, cyst morphology, or adolescent ultrasound PCOM finding. | `S3` / `L3` | • 6-tier evidence provenance (`patient_reported`, `imaging_observation`, `report_extracted`, `ai_experimental`, `clinician_reviewed`, `clinician_confirmed_assessment`).<br>• Hard guardrails in `src/lib/clinic/workflows.ts`: normal imaging never excludes endometriosis; cysts are never auto-classified as benign/malignant; adolescent (`<8y` post-menarche) PCOS evaluations block adult Rotterdam & ultrasound PCOM criteria. | `L1` (Enforced in backend business logic and UI). |
| **11** | **Inappropriate Reliance on AI Output (Automation Bias)** | Clinician accepts AI segmentation or LLM report explanation without inspecting source slices or original report text. | `S3` / `L3` | • `executeSaveLabMeasurement` requires `clinicianConfirmed: true` and an explicit reason before saving an AI-derived finding version.<br>• Report AI interpretations (`src/lib/reports/llm-interpreter.ts`) attach mandatory `sourceQuote` citations verified as verbatim substrings of the source report (`verifyQuoteExistsInSource`).<br>• When no trained checkpoint is configured, `/segment/{model_id}` returns HTTP `503 ModelNotConnected` and never fabricates a mask. | `L2` (Human-in-the-loop confirmation enforced at API boundary). |

---

## 3. Model Lifecycle & Post-Training Controls

### 3.1 Dataset & Checkpoint Provenance (`checkpoint_registry.json`)
Every checkpoint saved by `save_checkpoint_bundle()` (`imaging-service/app/models.py`) writes:
1. A pickle-free compressed parameter bundle (`<name>.pt`) loadable with `allow_pickle=False`.
2. A sidecar `<name>.pt.metadata.json` containing:
   - `architecture`: `"SimpleUnet3D (custom 3D U-Net — PyTorch/NumPy, MONAI not used)"`
   - `model_version`, `dataset_version`, `dataset_provenance`, and `dataset_license_reference` (`CC BY 4.0`)
   - `label_map` (`0: background, 1: uterine_wall, 2: cavity, 3: myoma, 4: nabothian`)
   - `preprocessing_config` (`percentile_clip_1_99_and_zscore`)
   - `training_config` (epochs, learning rate, seed, loss function, class weights, execution backend)
   - `split_manifest_summary` (`seed`, ratios, subject counts, `zero_subject_leakage_verified`, `split_sha256`)
   - `training_history` (per-epoch train loss, validation macro Dice/IoU, per-class validation Dice)
   - `evaluation_splits` (`train`, `val`, and held-out `test` reports including `per_class`, `per_patient`, `per_case`, and `failed_cases`)
   - `checkpoint_sha256` and `trained_at` (UTC ISO-8601 timestamp)
   - `external_validation_performed` (`false` until validated on an independent external hospital cohort)
3. An entry in `checkpoint_registry.json` linking the new version to `previous_active_checkpoint`.

### 3.2 Non-Overwrite Policy & Verification Gate
- `save_checkpoint_bundle()` **refuses to overwrite an existing checkpoint file** (`allow_overwrite=False` by default, raising `FileExistsError`).
- Every new model version must be written to a distinct versioned filename (e.g., `umd_unet3d_v1.1.0.pt`), pass `validate_state_dict_compatibility()`, and record held-out test metrics before `ANATOMYBRIDGE_UMD_WEIGHTS` is updated.

### 3.3 Retraining Criteria & Performance Monitoring Plan
1. **Performance Monitoring Indicators:**
   - Track the proportion of `segmentation_runs` rejected or manually overridden by clinicians in `VolumeLab`.
   - Track discrepancies flagged by `reconcileReportWithImaging` between AI-segmented lesion diameters and radiologist report measurements.
   - Monitor input rejection rates (`InvalidVolumeError` / `GeometryMismatchError`) across uploaded MRI series.
2. **Retraining Trigger Criteria:**
   - Clinician override/rejection rate exceeds 20% over a rolling 50-study review window;
   - Mean held-out myoma Dice drops below `0.75` on a newly curated, IEC-approved multi-scanner validation cohort; or
   - Support is extended to a new MRI sequence or acquisition plane (e.g., axial T2WI) under an approved protocol.
3. **Retraining Governance:**
   - Retraining must use `train_umd.py` with a fixed random seed, `verify_training_data_governance()` check, and a frozen held-out test split so candidate models are compared apples-to-apples against the active production checkpoint.

### 3.4 Rollback Procedure (`rollback_checkpoint`)
If post-deployment monitoring or regression testing identifies degraded performance or unexpected false positives/negatives in a newly promoted checkpoint:
1. Run `models.rollback_checkpoint(registry_dir, target_version_or_sha)` (or point `ANATOMYBRIDGE_UMD_WEIGHTS` back to the prior versioned `.pt` file recorded in `checkpoint_registry.json`).
2. `rollback_checkpoint()` verifies the target checkpoint's on-disk SHA-256 digest against `checkpoint_registry.json`, validates `SimpleUnet3D` tensor shapes via `validate_state_dict_compatibility()`, restores `active_checkpoint`, and logs an immutable entry in `rollback_events`.

## 11. Sprint 6 Technical Verification: Full-Graph Differentiability, Compressed DICOM Interoperability & PS3.15 De-Identification

### 11.1 Full-Graph Gradient Verification & No Silent Fallback (`imaging-service/app/unet.py`, `imaging-service/train_umd.py`)
- **All 50 Trainable Parameter Tensors Updated**: `SimpleUnet3D` contains 50 trainable parameter tensors (`7` `DoubleConv3D` blocks × `6` trainable tensors `[conv1.weight, bn1.weight, bn1.bias, conv2.weight, bn2.weight, bn2.bias]` = `42` + `3` `ConvTranspose3d` blocks × `2` = `6` + `outc` × `2` = `2`, plus `14` non-trainable BatchNorm running statistics buffers = `64` state dictionary tensors).
- **No Silent NumPy Fallback**: `train_umd.py` defaults to `allow_numpy_fallback=False` on the CLI (`--allow-numpy-fallback` must be explicitly passed when PyTorch is absent). When `allow_numpy_fallback=True` is explicitly enabled in CPU verification environments, `NumpySimpleUnet3D.backward()` computes exact analytical gradients through every `Conv3d`, `BatchNorm3d`, `ReLU`, `MaxPool3d`, `ConvTranspose3d`, and skip-connection concatenation layer and updates all 50 trainable tensors via a stateful AdamW optimizer (`verify_parameter_gradients_and_optimizer_updates()`).
- **Honest External Dataset Reporting**: The external 300-case UMD NIfTI archive (`10.6084/m9.figshare.23541312`, CC BY 4.0) is not bundled inside the repository or offline container; synthetic 3D multi-class phantom training/evaluation is explicitly labeled `"training_regime": "synthetic_pipeline_verification_only"` and `"clinical_claim": "NONE — synthetic pipeline verification only; NOT trained on clinical UMD patient MRI scans"`.

### 11.2 DICOM Interoperability, Multi-Frame Functional Groups & PS3.15 De-Identification (`src/lib/dicom/codec.ts`, `src/lib/dicom/deidentify.ts`, `imaging-service/app/dicom_io.py`, `imaging-service/app/dicom_deidentify.py`)
- **Transfer Syntaxes**: Explicit VR Little Endian (`1.2.840.10008.1.2.1`), Implicit VR Little Endian (`1.2.840.10008.1.2`), Deflated Explicit VR Little Endian (`1.2.840.10008.1.2.1.99`), RLE Lossless (`1.2.840.10008.1.2.5`), JPEG Baseline (`1.2.840.10008.1.2.4.50`), JPEG Lossless (`1.2.840.10008.1.2.4.57`, `.70`), JPEG 2000 Lossless (`1.2.840.10008.1.2.4.90`), and JPEG 2000 (`1.2.840.10008.1.2.4.91`) via Pillow `libjpeg` and `OpenJPEG`.
- **Multi-Frame & 4×4 Affine Geometry**: Extracts `SharedFunctionalGroupsSequence` (`5200,9229`) and `PerFrameFunctionalGroupsSequence` (`5200,9230`), rejects inconsistent per-frame orientation or pixel spacing, and preserves the 4×4 voxel-to-patient LPS affine matrix (`affine4x4`) end-to-end through volume reconstruction, AI segmentation, and 3D STL/OBJ mesh export.
- **DICOM PS3.15 Basic Application Level Confidentiality Profile**: Scrubs standard identifying tags, removes odd-group private tags (`gggg % 2 == 1`), recursively scrubs nested `SQ` sequences, shifts dates deterministically, remaps UIDs consistently via HMAC-SHA256 (`2.25.<uint128>`), preserves original buffers untouched, and detects burned-in annotations via both header flags (`0028,0301`) and pixel-border high-contrast glyph analysis (`manualReviewRequired: true`, `claimCompleteAnonymisation: false`).
