# ReproCare / AnatomyBridge — AI Segmentation Model Training & Validation Report

**Last Updated:** 2026-11-02  
**Primary Modules:** `imaging-service/app/unet.py`, `imaging-service/train_umd.py`, `imaging-service/app/evaluation.py`, `imaging-service/app/models.py`, `imaging-service/tests/test_sprint2_segmentation_and_training.py`

---

## 1. Model Architecture & Training Backend (`SimpleUnet3D`)

* **Architecture:** Custom 3D Encoder–Decoder U-Net (`SimpleUnet3D` in `imaging-service/app/unet.py`), **not** MONAI (`monai` is not imported or claimed).
  * **Input:** 1-channel 3D z-score / percentile-normalized MRI subvolume `(B, 1, D, H, W)`.
  * **Output:** 5-channel voxelwise logits `(B, 5, D, H, W)` corresponding to `0=background`, `1=uterine_wall`, `2=cavity`, `3=myoma`, `4=nabothian`.
  * **Topology:** 4 encoder levels (`inc`, `down1`, `down2`, `down3` with `2×2×2` MaxPool3d and `DoubleConv3D` blocks of `Conv3d(3×3×3) -> GroupNorm -> SiLU`) + 3 decoder levels (`up1`+`conv_up1`, `up2`+`conv_up2`, `up3`+`conv_up3` with `ConvTranspose3d(2×2×2)` and skip concatenations) + `1×1×1` output projection (`outc`).
  * **Trainable Parameter Tensors:** **50 trainable parameter tensors** (44 `Conv3d`/`ConvTranspose3d` weight and bias tensors + 6 `GroupNorm` affine weight and bias tensors).
* **Training Backend & Non-Fallback Guarantee:**
  * When `torch` is installed, `train_umd.py` trains a persistent `SimpleUnet3D` (`torch.nn.Module`) on `cuda` or `cpu` using `torch.optim.AdamW` and differentiable `compute_torch_combined_ce_dice_loss()`.
  * **No Silent Fallback:** `run_training_pipeline()` defaults to `allow_numpy_fallback=False`. If `torch` is absent, CLI execution raises a `RuntimeError` rather than silently substituting a non-PyTorch backend.
  * When `--allow-numpy-fallback` (`allow_numpy_fallback=True`) is explicitly passed in CPU-only sandbox tests, `NumpySimpleUnet3D` executes full-graph analytical backpropagation across all 11 blocks and updates all 50 parameter tensors via AdamW (`<ckpt>.optim.npz` preserves AdamW moments `m`, `v`, and `step` across `--resume-from`).

---

## 2. Gradient & Parameter Update Verification Evidence

Executed via `verify_parameter_gradients_and_optimizer_updates()` in `imaging-service/tests/test_sprint2_segmentation_and_training.py`:
- **Total Trainable Parameter Tensors:** `50`
- **Tensors Receiving Finite Non-Zero Gradients:** `50 / 50` (`missing_gradient_parameters = []`, `zero_or_nonfinite_gradient_parameters = []`)
- **Tensors Updated After Single AdamW Step:** `50 / 50` (`unchanged_parameters = []`)
- **Single-Step Optimization Loss:** `2.1636 -> 1.8492` (`loss_decreased = True`)

---

## 3. Dataset Availability & Training Execution Status

| Training Regime | Dataset Available Locally? | Execution Status | Resulting Checkpoint Tag | Clinical Claim |
| :--- | :---: | :--- | :--- | :--- |
| **Synthetic 3D Pelvic Phantom Verification** | Yes (generated in test suite) | **Executed & Verified** (`test_sprint2_segmentation_and_training.py`) | `SYNTHETIC_VERIFICATION_ONLY` (`is_real_umd_trained: False`) | **None** — verifies software pipeline, gradient flow, split hygiene, and evaluation math only. |
| **Real 300-Patient UMD NIfTI Cohort ([DOI: 10.1038/s41597-024-03170-x](https://pmc.ncbi.nlm.nih.gov/articles/PMC11035617/))** | **No** (external Figshare archive not mounted in offline VM) | **Blocked by External Data Mount** | No `REAL_UMD_TRAINED` `.pt` file is shipped in the repo | **None** — `/models` and `/segment/umd_monai_fibroid` explicitly report `model_not_connected` (`503`) until a real checkpoint is provided. |

---

## 4. Independent Held-Out Evaluation Methodology (`imaging-service/app/evaluation.py`)

`evaluate_segmentation_case()` and `aggregate_split_evaluations()` evaluate the independent held-out `test` split (which is never used for gradient updates, early stopping, or hyperparameter selection):

1. **Per-Class Metrics (`uterine_wall`, `cavity`, `myoma`, `nabothian`):**
   - **Dice Similarity Coefficient (`DSC`)** and **Intersection-over-Union (`IoU` / Jaccard)**
   - **Voxel Precision (PPV)**, **Sensitivity (Recall)**, and **Specificity**
   - **95th Percentile Hausdorff Distance (`HD95` in $\text{mm}$)** and **Average Symmetric Surface Distance (`ASSD` in $\text{mm}$)** using physical `spacing_zyx_mm`
   - **Physical Volume ($\text{mm}^3$ and $\text{mL}$)**, **Absolute Volume Error ($\text{mm}^3$)**, and **Relative Volume Error (`RVE %`)**
2. **Honest Empty-Mask Handling (Anti-Inflation Rule):**
   - When both ground truth and prediction have `0` voxels for a class (`gt_voxels == 0 and pred_voxels == 0`, e.g., absent `nabothian` cyst), `evaluate_class_binary()` returns `dice = None, iou = None, status = "absent_true_negative"` and increments `absent_true_negative_cases`. It **never** assigns `dice = 1.0` to empty cases or includes them in the mean Dice denominator.
   - When `gt_voxels == 0` and `pred_voxels > 0`, it records `status = "absent_false_positive"` with `dice = 0.0, iou = 0.0`, penalising false-positive hallucinations.
3. **Per-Case, Per-Patient & Failure-Case Reporting:**
   - Reports per-case metrics, `per_patient_summary` (aggregated by `subject_id` with mean/min/max foreground Dice and myoma volume error), and `failed_cases` (cases where mean foreground Dice `< 0.50`, a ground-truth myoma is missed, or a false-positive myoma is predicted on an empty case).

---

## 5. Model Registry, Versioning & Controlled Rollback (`imaging-service/app/models.py`)

* Every saved checkpoint writes a companion `<checkpoint>.meta.json` containing `model_name`, `model_version`, `architecture` (`SimpleUnet3D`), `checkpoint_sha256`, `training_mode` (`real_umd` vs `synthetic_verification`), `is_real_umd_trained`, `dataset_provenance`, `split_seed`, `label_map`, `preprocessing`, `hyperparameters`, `held_out_test_metrics`, and `known_limitations`.
* `register_checkpoint_version()` records each version in `checkpoint_registry.json` without silently overwriting evaluated checkpoints.
* `rollback_checkpoint(registry_path, target_version)` restores a previously validated checkpoint version after verifying its on-disk SHA-256 checksum and records the rollback event in the registry history.

---

## 6. Reproducible Commands for Real UMD Training & Evaluation

Once the UMD NIfTI dataset is downloaded from [Figshare](https://figshare.com/articles/dataset/Uterine_myoma_MRI_dataset/24769965) onto a GPU workstation with PyTorch installed:

```bash
cd imaging-service
pip install -r requirements.txt

python3 train_umd.py \
  --data-dir /path/to/UMD_221129 \
  --output-checkpoint /var/lib/reprocare/models/umd_unet3d_v1.pt \
  --model-version 1.0.0-umd \
  --epochs 50 \
  --learning-rate 1e-3 \
  --seed 42 \
  --device cuda
```
