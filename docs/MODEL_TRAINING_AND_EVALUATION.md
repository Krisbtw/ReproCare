# ReproCare AI Segmentation — Model Training, Evaluation & Versioning Guide

**Document ID:** `REPROCARE-AI-TRAIN-004`  
**Modules:** `imaging-service/app/unet.py`, `imaging-service/app/models.py`, `imaging-service/train_umd.py`, `imaging-service/app/evaluation.py`

## 1. Architecture Honesty (`SimpleUnet3D`)

- The volumetric segmentation model in `imaging-service/app/unet.py` is **`SimpleUnet3D`**, a custom 3D U-Net with three encoder-decoder pooling stages (`DoubleConv3D` + `MaxPool3d` + `ConvTranspose3d` + skip concatenations + $1\times 1\times 1$ output head).
- **MONAI is NOT used.** Although the legacy adapter ID `umd_monai_fibroid` is preserved alongside `umd_unet3d_fibroid` for database and route backwards compatibility, all model status responses, checkpoint metadata, and UI panels explicitly report:
  `SimpleUnet3D (custom 3D U-Net — PyTorch/NumPy, MONAI not used)`.
- `SimpleUnet3D` supports two bit-compatible execution backends sharing the exact same `state_dict` parameter keys and tensor shapes (`expected_state_dict_spec`):
  1. **PyTorch (`torch.nn.Module`)** when `torch` is installed.
  2. **NumPy/SciPy (`NumpySimpleUnet3D`)** with exact analytic forward and backpropagation when running in lightweight CPU containers where `torch` is not installed.

## 2. Pre-Training Dataset Validation (`app/dataset_validation.py`)

Before any training run begins, `validate_umd_dataset_directory()` verifies:
1. **Image–Mask Pairing:** Every `.nii` / `.nii.gz` volume in `images/` has a matching mask in `labels/` (or `masks/`), and vice versa. Unpaired files block training.
2. **3D Geometry Consistency:** Image and mask must both be 3D arrays with identical `shape_zyx`, matching positive `spacing_zyx_mm` (`atol=1e-3`), matching `origin` (`atol=1e-2`), and matching `direction_cosines` (`atol=1e-2`).
3. **Label Integrity:** Mask values must be finite integers belonging strictly to `{0, 1, 2, 3, 4}` (`UMD_DEFAULT_LABEL_MAP`) and must not be completely empty (all zeros).
4. **Duplicate Volume Detection:** Computes the SHA-256 digest of every 3D image tensor to detect duplicate scans across case IDs before splitting.

## 3. Reproducible Subject-Level Splitting (`app/dataset_split.py`)

- `create_subject_level_split()` groups all validated cases by `subject_id` (extracted from `subject_manifest.json` or filename prefix) and partitions subjects deterministically (`seed=42`) into three disjoint splits:
  - **Train:** 70% of subjects
  - **Validation (`val`):** 15% of subjects (used exclusively for checkpoint selection)
  - **Held-out Test (`test`):** 15% of subjects (evaluated only once after training completes)
- `verify_zero_split_leakage()` asserts zero subject overlap and zero voxel-SHA-256 overlap across `train`, `val`, and `test`, and writes `<checkpoint>.split_manifest.json`.

## 4. Preprocessing & Class-Imbalance Loss (`train_umd.py`)

- **MRI Intensity Normalization (`preprocess_mri_volume`):**
  Clips voxel intensities to the `[1st, 99th]` percentile range to suppress MRI coil/spike artifacts, followed by per-volume z-score standardization `(v - mean) / std`. Spatial dimensions and physical coordinates are never altered.
- **Combined Weighted Cross-Entropy + Multi-Class Soft Dice Loss:**
  Addresses foreground class imbalance using class weights `(0.20, 1.00, 2.50, 3.00, 3.50)` for `(background, uterine_wall, cavity, myoma, nabothian)` combined 50/50 with multi-class soft Dice loss over the 4 foreground classes.

## 5. Honest Evaluation & Absent-Class Policy (`app/evaluation.py`)

- Previously, `train_umd.py` assigned `Dice = 1.0` whenever `pred_sum + ref_sum == 0` (e.g., when a Nabothian cyst was absent in both prediction and ground truth), artificially inflating foreground Dice scores.
- In `app/metrics.py` and `app/evaluation.py`:
  - **`absent_in_both` (`TP=0, FP=0, FN=0`):** `dice`, `iou`, `precision`, and `sensitivity` return `None` and are excluded from the numeric mean, while `cases_absent_in_both` is counted separately.
  - **`false_positive_when_absent` (`TP=0, FP>0, FN=0`):** `dice = 0.0`, `iou = 0.0`, `precision = 0.0`, `sensitivity = None`, and spurious false-positive volume (`fp_volume_ml`) and disconnected components (`spurious_fp_components`) are recorded.
  - **`missed_when_present` (`TP=0, FP=0, FN>0`):** `dice = 0.0`, `iou = 0.0`, `precision = 0.0`, `sensitivity = 0.0`, and missed reference volume (`fn_volume_ml`) and missed lesion count (`missed_fn_components`) are recorded.
  - **`present_in_both` (`TP>0` or both non-empty):** Standard physical-spacing metrics (`dice`, `iou`, `precision`, `sensitivity`, `hd95_mm`, `volume_difference_ml`, `fp_volume_ml`, `fn_volume_ml`) are computed.

## 6. Running Training & Connecting a Checkpoint

```bash
cd imaging-service

# 1. Verify pipeline end-to-end on synthetic multi-class 3D MRI phantoms:
python3 train_umd.py \
  --data-dir /tmp/umd_synth \
  --out /tmp/umd_synth_checkpoint.pt \
  --epochs 5 \
  --base-channels 8 \
  --seed 42 \
  --synthetic \
  --synthetic-subjects 10

# 2. Train on downloaded UMD NIfTI dataset (images/ and labels/):
python3 train_umd.py \
  --data-dir /path/to/UMD_dataset \
  --out ./checkpoints/umd_unet3d_v1.pt \
  --epochs 50 \
  --lr 0.001 \
  --base-channels 16 \
  --seed 42 \
  --data-category public_research_dataset

# 3. Point the imaging service at the verified checkpoint:
export ANATOMYBRIDGE_UMD_WEIGHTS=./checkpoints/umd_unet3d_v1.pt
uvicorn app.main:app --port 8100
```
