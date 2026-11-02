# AnatomyBridge / ReproCare Imaging Service (Python)

Stateless FastAPI microservice for 3D DICOM series geometry verification, physical-spacing segmentation metrics, compressed/multi-frame DICOM decoding, and `SimpleUnet3D` / `nnU-Net v2` uterine MRI segmentation.

## Installation & Environment Setup

```bash
cd imaging-service
python3 -m venv .venv
source .venv/bin/activate

# 1. Install core FastAPI, DICOM (pydicom, Pillow, pylibjpeg, openjpeg), and PyTorch dependencies:
pip install -r requirements.txt

# (Optional) For CUDA GPU acceleration on Linux/Windows hosts with NVIDIA drivers:
# pip install torch --index-url https://download.pytorch.org/whl/cu121
```

## Capabilities

- `POST /series/inspect`: Orders single-slice and multi-frame (`NumberOfFrames` / `GridFrameOffsetVector` / `PerFrameFunctionalGroupsSequence`) DICOM series along the right-handed slice normal (`ImageOrientationPatient` cross product), detects slice gaps, duplicate positions, mixed orientations, mixed matrix dimensions, and mixed series UIDs, strips identifying DICOM PHI tags in memory, and returns full 3D coordinate geometry (`origin_lps_mm`, `direction_cosines`, `frame_of_reference_uid`, `pixel_spacing_mm`, `slice_spacing_mm`).
- `POST /segment/{model_id}`: Runs validated 3D MRI segmentation (`umd_monai_fibroid` / `umd_unet3d_fibroid` using `SimpleUnet3D`, or `nnunet_umd` using external `nnUNetv2_predict`).
  - **Model Honesty:** If trained weights are not configured (`ANATOMYBRIDGE_UMD_WEIGHTS`) or fail SHA-256 / architecture compatibility checks, `/models` reports `connected: false` and `/segment/{model_id}` returns `503 Service Unavailable` with no fabricated mask.
  - **Architectural Transparency:** `SimpleUnet3D` is a custom 3D U-Net (`imaging-service/app/unet.py`), **not** a MONAI model.
  - **Geometry Preservation:** Validates input 3D volume dimensions, finite intensities, dynamic range, and orthonormal direction cosines, and verifies that the output segmentation mask preserves exact `shape_zyx`, `spacing_zyx_mm`, `origin_lps_mm`, `direction_cosines`, and `frame_of_reference_uid`.
- `POST /metrics/score` & `python3 -m app.score`: Computes Dice, Jaccard/IoU, precision, sensitivity, Hausdorff, HD95, mean surface distance, physical volume in mL, and false-positive/false-negative component counts. Returns `null` when a metric is undefined (e.g., when a class is absent in both masks) rather than inflating Dice with `1.0`.
- `train_umd.py`: Reproducible training and evaluation pipeline with strict PyTorch environment verification (`verify_training_environment` — blocks silent fallback unless `--allow-numpy-fallback` is explicitly passed), full-network gradient and parameter-update verification across all 50 trainable parameter tensors (59 total state-dict tensors including BatchNorm running buffers), optimizer momentum state checkpointing (`<ckpt>.optim.npz`), data-governance gates (`app/privacy.py`), dataset validation (`app/dataset_validation.py`), subject-level 3-way `train`/`val`/`test` splitting (`app/dataset_split.py`), combined weighted Cross-Entropy + soft Dice loss, and SHA-256 checkpoint provenance.

## Governance & Documentation

- [`../docs/DATASET_PROVENANCE.md`](../docs/DATASET_PROVENANCE.md) — UMD dataset provenance, CC BY 4.0 licence verification, and limitations.
- [`../docs/DATA_GOVERNANCE_AND_PRIVACY.md`](../docs/DATA_GOVERNANCE_AND_PRIVACY.md) — DICOM PHI scrubbing and 4-category training data protection gates.
- [`../docs/INDIAN_REGULATORY_AND_ETHICAL_READINESS.md`](../docs/INDIAN_REGULATORY_AND_ETHICAL_READINESS.md) — ICMR (2017, 2023), DPDP Act (2023), and CDSCO MDR (2017) readiness matrix.
- [`../docs/MEDICAL_AI_RISK_MANAGEMENT_AND_LIFECYCLE.md`](../docs/MEDICAL_AI_RISK_MANAGEMENT_AND_LIFECYCLE.md) — ISO 14971 11-hazard risk matrix, IEC 62304 / ISO 13485 / IEC 82304-1 / IEC 62366-1 assessment, and model lifecycle / rollback controls.
- [`../docs/MODEL_TRAINING_AND_EVALUATION.md`](../docs/MODEL_TRAINING_AND_EVALUATION.md) — Architecture, subject-level splitting, class-imbalance loss, and absent-class evaluation policy.
