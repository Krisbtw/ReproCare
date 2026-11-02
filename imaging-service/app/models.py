"""External segmentation model adapters, checkpoint validation, preprocessing, and provenance.

Design principles:
  1. Model Honesty: Never fabricate a segmentation mask when trained weights are absent,
     corrupt, or incompatible. Return `connected=False` in `/models` and raise
     `ModelNotConnected` (HTTP 503) on `/segment/{model_id}`.
  2. Architectural Transparency: `SimpleUnet3D` is a custom 3D U-Net implemented in
     `app/unet.py` (with PyTorch `nn.Module` and bit-compatible NumPy execution backends),
     NOT a MONAI framework model. The legacy adapter ID `umd_monai_fibroid` is preserved
     for API backwards compatibility alongside `umd_unet3d_fibroid`, while metadata
     explicitly states `architecture: "SimpleUnet3D (custom 3D U-Net, MONAI not used)"`.
  3. Medical Image Integrity: Input volumes are validated for 3D shape, finite intensities,
     dynamic range, and positive voxel spacing. Output masks are validated for exact shape,
     voxel spacing, origin, direction cosines, and label set alignment before returning.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import shutil
import subprocess
import tempfile
import zipfile
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
from scipy import ndimage

from .nifti_io import register_sitk_fallback
from .series import VolumeGeometry
from .unet import (
    HAS_TORCH,
    NumpySimpleUnet3D,
    SimpleUnet3D,
    torch,
    validate_state_dict_compatibility,
)

sitk = register_sitk_fallback()

UMD_DEFAULT_LABEL_MAP: dict[int, str] = {
    0: "background",
    1: "uterine_wall",
    2: "cavity",
    3: "myoma",
    4: "nabothian",
}


@dataclass
class ModelStatus:
    id: str
    name: str
    connected: bool
    reason: str
    label_map: dict[int, str] | None = None
    is_learned_model: bool = True
    architecture: str = "SimpleUnet3D (custom 3D U-Net, MONAI not used)"
    model_version: str | None = None
    dataset_version: str | None = None
    checkpoint_sha256: str | None = None
    training_mode: str | None = None
    is_clinical_grade: bool = False
    trained_at: str | None = None
    validation_metrics: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class ModelNotConnected(RuntimeError):
    """Raised when `/segment/{model_id}` is called for a model that is not ready."""


class InvalidVolumeError(ValueError):
    """Raised when an input 3D MRI volume or its geometry fails integrity validation."""


class GeometryMismatchError(RuntimeError):
    """Raised when a segmentation output does not align with the input scan geometry."""


def compute_file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(65536):
            h.update(chunk)
    return h.hexdigest()


def save_checkpoint_bundle(
    path: str | Path,
    state_dict: dict[str, Any],
    metadata: dict[str, Any],
    allow_overwrite: bool = False,
) -> dict[str, Any]:
    """Save a SimpleUnet3D checkpoint in a safe, pickle-free portable format with SHA-256 provenance.

    Writes:
      1. The checkpoint archive at `path` (containing `__metadata_json__` and all `state_dict` arrays
         so it can be loaded safely with `allow_pickle=False` in both NumPy and PyTorch runtimes).
      2. A human-readable sidecar `<path>.metadata.json` containing full model provenance and SHA-256.
    """
    ckpt_path = Path(path)
    if ckpt_path.exists() and not allow_overwrite:
        raise FileExistsError(
            f"Refusing to silently replace existing checkpoint '{ckpt_path.name}'. "
            "Write to a new versioned checkpoint path or pass allow_overwrite=True after validation."
        )
    ckpt_path.parent.mkdir(parents=True, exist_ok=True)

    arrays_to_save: dict[str, np.ndarray] = {}
    for k, v in state_dict.items():
        if HAS_TORCH and torch is not None and isinstance(v, torch.Tensor):
            arr = v.detach().cpu().numpy()
        else:
            arr = np.asarray(v)
        arrays_to_save[f"param__{k}"] = arr

    meta_copy = dict(metadata)
    meta_json_bytes = json.dumps(meta_copy, indent=2, sort_keys=True).encode("utf-8")
    arrays_to_save["__metadata_json__"] = np.frombuffer(meta_json_bytes, dtype=np.uint8)

    with open(ckpt_path, "wb") as f:
        np.savez_compressed(f, **arrays_to_save)

    sha256_hex = compute_file_sha256(ckpt_path)
    meta_copy["checkpoint_sha256"] = sha256_hex
    meta_copy["checkpoint_filename"] = ckpt_path.name

    sidecar_path = Path(f"{ckpt_path}.metadata.json")
    sidecar_path.write_text(json.dumps(meta_copy, indent=2, sort_keys=True), encoding="utf-8")

    # Record versioned model artefact in checkpoint_registry.json for lifecycle governance & rollback
    registry_path = ckpt_path.parent / "checkpoint_registry.json"
    registry: dict[str, Any] = {"active_checkpoint": None, "history": []}
    if registry_path.exists():
        try:
            registry = json.loads(registry_path.read_text(encoding="utf-8"))
        except Exception:
            registry = {"active_checkpoint": None, "history": []}
    prev_active = registry.get("active_checkpoint")
    entry = {
        "model_version": meta_copy.get("model_version", "1.0.0-experimental"),
        "checkpoint_filename": ckpt_path.name,
        "checkpoint_path": str(ckpt_path),
        "checkpoint_sha256": sha256_hex,
        "dataset_version": meta_copy.get("dataset_version", "UMD-v1"),
        "dataset_license": meta_copy.get("dataset_license_reference", "CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/)"),
        "training_mode": meta_copy.get("training_mode", "unknown"),
        "is_clinical_grade": bool(meta_copy.get("is_clinical_grade", False)),
        "external_validation_performed": bool(meta_copy.get("external_validation_performed", False)),
        "trained_at": meta_copy.get("trained_at"),
        "previous_active_checkpoint": prev_active,
    }
    registry.setdefault("history", []).append(entry)
    registry["active_checkpoint"] = entry
    registry_path.write_text(json.dumps(registry, indent=2, sort_keys=True), encoding="utf-8")

    return meta_copy


def rollback_checkpoint(registry_dir: str | Path, target_version_or_sha: str | None = None) -> dict[str, Any]:
    """Roll back the active checkpoint in `checkpoint_registry.json` to the previous validated checkpoint
    or a specific `model_version` / `checkpoint_sha256`, verifying on-disk SHA-256 integrity before activating.
    """
    reg_dir = Path(registry_dir)
    registry_path = reg_dir / "checkpoint_registry.json"
    if not registry_path.exists():
        raise FileNotFoundError(f"No checkpoint_registry.json found in {reg_dir}")
    registry = json.loads(registry_path.read_text(encoding="utf-8"))
    history: list[dict[str, Any]] = registry.get("history", [])
    if len(history) < 2 and target_version_or_sha is None:
        raise ValueError("Cannot roll back: fewer than 2 checkpoints recorded in registry history.")

    target: dict[str, Any] | None = None
    if target_version_or_sha is not None:
        for item in reversed(history):
            if (
                item.get("model_version") == target_version_or_sha
                or item.get("checkpoint_sha256") == target_version_or_sha
                or item.get("checkpoint_filename") == target_version_or_sha
            ):
                target = item
                break
        if target is None:
            raise ValueError(f"Target checkpoint '{target_version_or_sha}' not found in registry history.")
    else:
        target = history[-2]

    target_path = Path(target["checkpoint_path"])
    if not target_path.exists():
        target_path = reg_dir / target["checkpoint_filename"]
    state_dict, meta, actual_sha = load_checkpoint_bundle(target_path)
    if actual_sha != target["checkpoint_sha256"]:
        raise ValueError("Rollback aborted: target checkpoint SHA-256 does not match registry record.")
    ok, errs = validate_state_dict_compatibility(
        state_dict,
        in_channels=int(meta.get("in_channels", 1)),
        out_channels=int(meta.get("out_channels", 5)),
        base_channels=int(meta.get("base_channels", 16)),
    )
    if not ok:
        raise ValueError(f"Rollback aborted: target checkpoint failed architecture validation ({'; '.join(errs)})")

    registry["active_checkpoint"] = target
    registry.setdefault("rollback_events", []).append(
        {
            "rolled_back_to_version": target.get("model_version"),
            "rolled_back_to_sha256": actual_sha,
            "checkpoint_filename": target.get("checkpoint_filename"),
        }
    )
    registry_path.write_text(json.dumps(registry, indent=2, sort_keys=True), encoding="utf-8")
    return target


def load_checkpoint_bundle(path: str | Path) -> tuple[dict[str, np.ndarray], dict[str, Any], str]:
    """Load and verify a SimpleUnet3D checkpoint bundle.

    Returns `(state_dict_numpy, metadata_dict, sha256_hex)`.
    Raises `ValueError` or `RuntimeError` if the file is missing, corrupt, or incompatible.
    """
    ckpt_path = Path(path)
    if not ckpt_path.exists() or not ckpt_path.is_file():
        raise FileNotFoundError(f"Checkpoint file does not exist: {ckpt_path}")
    if ckpt_path.stat().st_size == 0:
        raise ValueError(f"Checkpoint file is empty or truncated ({ckpt_path.stat().st_size} bytes)")

    sha256_hex = compute_file_sha256(ckpt_path)
    sidecar_path = Path(f"{ckpt_path}.metadata.json")
    sidecar_meta: dict[str, Any] = {}
    if sidecar_path.exists():
        try:
            sidecar_meta = json.loads(sidecar_path.read_text(encoding="utf-8"))
        except Exception as e:
            raise ValueError(f"Corrupt checkpoint metadata sidecar {sidecar_path.name}: {e}") from e
        recorded_sha = sidecar_meta.get("checkpoint_sha256")
        if recorded_sha and recorded_sha != sha256_hex:
            raise ValueError(
                f"Checkpoint SHA-256 mismatch: expected {recorded_sha[:12]}..., got {sha256_hex[:12]}..."
            )

    # 1. Check if portable pickle-free NPZ bundle
    if zipfile.is_zipfile(ckpt_path):
        with zipfile.ZipFile(ckpt_path, "r") as zf:
            names = set(zf.namelist())
        if "__metadata_json__.npy" in names or any(n.startswith("param__") for n in names):
            with open(ckpt_path, "rb") as f:
                npz = np.load(f, allow_pickle=False)
                state_dict: dict[str, np.ndarray] = {}
                metadata: dict[str, Any] = {}
                if "__metadata_json__" in npz.files:
                    raw_meta = npz["__metadata_json__"].tobytes().decode("utf-8")
                    metadata = json.loads(raw_meta)
                for key in npz.files:
                    if key.startswith("param__"):
                        param_name = key[len("param__") :]
                        state_dict[param_name] = npz[key]
                metadata.update(sidecar_meta)
                metadata["checkpoint_sha256"] = sha256_hex
                return state_dict, metadata, sha256_hex

    # 2. Fallback to PyTorch native checkpoint if torch is available
    if HAS_TORCH and torch is not None:
        try:
            raw_ckpt = torch.load(str(ckpt_path), map_location="cpu", weights_only=True)
        except Exception as e:
            raise ValueError(
                f"Unsafe or corrupted weights (weights_only=True enforced): {e}"
            ) from e
        if not isinstance(raw_ckpt, dict):
            raise ValueError("Unsupported PyTorch checkpoint structure (expected dict)")
        raw_state = raw_ckpt.get("model_state_dict", raw_ckpt)
        if not isinstance(raw_state, dict):
            raise ValueError("Checkpoint does not contain a valid model_state_dict dictionary")
        state_dict_np: dict[str, np.ndarray] = {}
        for k, v in raw_state.items():
            if isinstance(v, torch.Tensor):
                state_dict_np[k] = v.detach().cpu().numpy()
            else:
                state_dict_np[k] = np.asarray(v)
        metadata = {k: v for k, v in raw_ckpt.items() if k != "model_state_dict"}
        metadata.update(sidecar_meta)
        metadata["checkpoint_sha256"] = sha256_hex
        return state_dict_np, metadata, sha256_hex

    raise ValueError(
        "Unsafe or corrupted weights (weights_only=True enforced; arbitrary pickle checkpoints are rejected)"
    )


def validate_input_volume(
    volume_zyx: np.ndarray,
    spacing_zyx_mm: tuple[float, float, float],
    geometry: VolumeGeometry | None = None,
) -> None:
    """Validate 3D MRI input volume dimensions, data types, finite intensities, and geometry."""
    if not isinstance(volume_zyx, np.ndarray):
        raise InvalidVolumeError("Input volume must be a NumPy ndarray")
    if volume_zyx.ndim != 3:
        raise InvalidVolumeError(f"Expected 3D volume (Z, Y, X), got {volume_zyx.ndim}D shape {volume_zyx.shape}")
    z, y, x = volume_zyx.shape
    if z < 2 or y < 4 or x < 4:
        raise InvalidVolumeError(
            f"Volume dimensions {(z, y, x)} are too small for 3D volumetric segmentation (minimum 2x4x4)"
        )
    if z > 1024 or y > 1024 or x > 1024:
        raise InvalidVolumeError(f"Volume dimensions {(z, y, x)} exceed maximum supported dimension (1024)")

    if len(spacing_zyx_mm) != 3 or not all(np.isfinite(s) and float(s) > 0.0 for s in spacing_zyx_mm):
        raise InvalidVolumeError(f"Invalid voxel spacing {spacing_zyx_mm}; all 3 axes must be finite and > 0 mm")

    if not np.all(np.isfinite(volume_zyx)):
        raise InvalidVolumeError("Input MRI volume contains non-finite (NaN or Inf) voxel intensities")

    vmin = float(volume_zyx.min())
    vmax = float(volume_zyx.max())
    if vmax - vmin <= 1e-6:
        raise InvalidVolumeError(
            f"Input MRI volume has constant intensity (min={vmin}, max={vmax}); refusing inference on blank volume"
        )

    if geometry is not None:
        if tuple(geometry.shape_zyx) != (z, y, x):
            raise InvalidVolumeError(
                f"Geometry shape {geometry.shape_zyx} does not match array shape {(z, y, x)}"
            )
        if not all(np.isfinite(v) for v in geometry.origin_lps_mm):
            raise InvalidVolumeError("Geometry origin_lps_mm contains non-finite coordinates")
        if len(geometry.direction_cosines) != 9 or not all(np.isfinite(v) for v in geometry.direction_cosines):
            raise InvalidVolumeError("Geometry direction_cosines must contain 9 finite values")
        d_mat = np.asarray(geometry.direction_cosines, dtype=np.float64).reshape(3, 3)
        det = float(np.linalg.det(d_mat))
        if abs(abs(det) - 1.0) > 0.05:
            raise InvalidVolumeError(
                f"Geometry direction_cosines matrix is not orthonormal (det={det:.4f})"
            )


def preprocess_mri_volume(volume_zyx: np.ndarray) -> tuple[np.ndarray, dict[str, Any]]:
    """Apply robust MRI percentile clipping (1st–99th) and z-score intensity normalization.

    Preserves exact spatial dimensions `(Z, Y, X)`.
    """
    v = volume_zyx.astype(np.float32, copy=True)
    p01, p99 = np.percentile(v, [1.0, 99.0])
    if p99 > p01:
        v = np.clip(v, float(p01), float(p99))
    mean = float(v.mean())
    std = float(v.std())
    if std <= 1e-6:
        raise InvalidVolumeError("Volume standard deviation after percentile clipping is zero")
    normed = ((v - mean) / std).astype(np.float32)
    prep_info = {
        "method": "percentile_clip_1_99_and_zscore",
        "p01": round(float(p01), 4),
        "p99": round(float(p99), 4),
        "mean": round(mean, 4),
        "std": round(std, 4),
        "input_shape_zyx": list(volume_zyx.shape),
        "output_shape_zyx": list(normed.shape),
    }
    return normed, prep_info


def postprocess_segmentation(
    raw_mask_zyx: np.ndarray,
    spacing_zyx_mm: tuple[float, float, float],
    label_map: dict[int, str],
    min_component_voxels: int = 0,
) -> tuple[np.ndarray, dict[str, Any]]:
    """Post-process multi-class 3D segmentation mask and compute per-class physical metrics."""
    mask = raw_mask_zyx.astype(np.uint8, copy=True)
    voxel_mm3 = float(spacing_zyx_mm[0]) * float(spacing_zyx_mm[1]) * float(spacing_zyx_mm[2])
    removed_components = 0

    if min_component_voxels > 1:
        for cls_id in sorted(label_map.keys()):
            if cls_id == 0:
                continue
            cls_binary = mask == cls_id
            if not cls_binary.any():
                continue
            labeled, n_comp = ndimage.label(cls_binary)
            for comp_idx in range(1, int(n_comp) + 1):
                comp_voxels = labeled == comp_idx
                if int(comp_voxels.sum()) < min_component_voxels:
                    mask[comp_voxels] = 0
                    removed_components += 1

    class_summary: dict[str, dict[str, Any]] = {}
    for cls_id, cls_name in sorted(label_map.items()):
        if cls_id == 0:
            continue
        cls_binary = mask == cls_id
        voxels = int(cls_binary.sum())
        vol_mm3 = round(voxels * voxel_mm3, 2)
        vol_ml = round(vol_mm3 / 1000.0, 4)
        _, n_comp = ndimage.label(cls_binary)
        class_summary[cls_name] = {
            "label_id": int(cls_id),
            "voxel_count": voxels,
            "volume_mm3": vol_mm3,
            "volume_ml": vol_ml,
            "connected_components": int(n_comp),
        }

    post_info = {
        "min_component_voxels": int(min_component_voxels),
        "removed_small_components": removed_components,
        "voxel_volume_mm3": round(voxel_mm3, 6),
        "classes": class_summary,
    }
    return mask, post_info


def validate_output_segmentation(
    mask_zyx: np.ndarray,
    expected_shape_zyx: tuple[int, int, int],
    label_map: dict[int, str],
    input_geometry: VolumeGeometry | None = None,
    output_geometry: VolumeGeometry | None = None,
) -> None:
    """Verify output mask shape, dtype, label integrity, and physical coordinate alignment."""
    if not isinstance(mask_zyx, np.ndarray) or mask_zyx.ndim != 3:
        raise GeometryMismatchError("Predicted segmentation mask is not a 3D array")
    if tuple(mask_zyx.shape) != tuple(expected_shape_zyx):
        raise GeometryMismatchError(
            f"Output mask shape {tuple(mask_zyx.shape)} does not match input volume shape {tuple(expected_shape_zyx)}"
        )
    unique_labels = {int(v) for v in np.unique(mask_zyx)}
    valid_labels = {int(k) for k in label_map.keys()}
    unknown_labels = unique_labels - valid_labels
    if unknown_labels:
        raise GeometryMismatchError(
            f"Predicted mask contains unknown label value(s) {sorted(unknown_labels)} outside {sorted(valid_labels)}"
        )

    if input_geometry is not None and output_geometry is not None:
        if tuple(input_geometry.shape_zyx) != tuple(output_geometry.shape_zyx):
            raise GeometryMismatchError("Output geometry shape_zyx differs from input scan geometry")
        if not np.allclose(input_geometry.spacing_zyx_mm, output_geometry.spacing_zyx_mm, atol=1e-5):
            raise GeometryMismatchError("Output geometry spacing_zyx_mm differs from input scan geometry")
        if not np.allclose(input_geometry.origin_lps_mm, output_geometry.origin_lps_mm, atol=1e-4):
            raise GeometryMismatchError("Output geometry origin_lps_mm differs from input scan geometry")
        if not np.allclose(input_geometry.direction_cosines, output_geometry.direction_cosines, atol=1e-4):
            raise GeometryMismatchError("Output geometry direction_cosines differ from input scan geometry")
        if input_geometry.frame_of_reference_uid != output_geometry.frame_of_reference_uid:
            raise GeometryMismatchError("Output frame_of_reference_uid differs from input scan geometry")


class NnUnetAdapter:
    id = "nnunet_umd"
    name = "nnU-Net v2 (UMD uterine MRI — external CLI)"
    architecture = "nnU-Net v2 CLI (external subprocess)"

    def _config(self) -> tuple[str | None, Path | None, str | None, dict[int, str] | None, str | None]:
        binary = shutil.which("nnUNetv2_predict")
        results_env = os.environ.get("ANATOMYBRIDGE_NNUNET_RESULTS")
        dataset = os.environ.get("ANATOMYBRIDGE_NNUNET_DATASET")
        labels_raw = os.environ.get("ANATOMYBRIDGE_NNUNET_LABELS")

        if not binary:
            return None, None, None, None, "nnUNetv2_predict binary not on PATH"
        if not results_env:
            return binary, None, None, None, "ANATOMYBRIDGE_NNUNET_RESULTS is not set"
        results = Path(results_env)
        if not results.is_dir():
            return binary, None, None, None, f"ANATOMYBRIDGE_NNUNET_RESULTS ({results}) is not a directory"
        if not dataset:
            return binary, results, None, None, "ANATOMYBRIDGE_NNUNET_DATASET is not set"
        if not any(results.glob(f"*{dataset}*")):
            return binary, results, dataset, None, f"no trained folder matching *{dataset}* in {results}"
        if not labels_raw:
            return (
                binary,
                results,
                dataset,
                None,
                "ANATOMYBRIDGE_NNUNET_LABELS is not set (refusing to guess which label integer is a fibroid)",
            )
        try:
            parsed = {int(k): str(v) for k, v in json.loads(labels_raw).items()}
        except Exception as e:
            return binary, results, dataset, None, f"ANATOMYBRIDGE_NNUNET_LABELS is not valid JSON ({e})"
        return binary, results, dataset, parsed, None

    def status(self) -> ModelStatus:
        _, _, _, labels, problem = self._config()
        if problem is not None:
            return ModelStatus(
                id=self.id,
                name=self.name,
                connected=False,
                reason=problem,
                is_learned_model=True,
                architecture=self.architecture,
            )
        return ModelStatus(
            id=self.id,
            name=self.name,
            connected=True,
            reason="ready",
            label_map=labels,
            is_learned_model=True,
            architecture=self.architecture,
        )

    def run(
        self,
        volume_zyx: np.ndarray,
        spacing_zyx_mm: tuple[float, float, float],
        geometry: VolumeGeometry | None = None,
    ) -> tuple[np.ndarray, dict[int, str], dict[str, Any]]:
        binary, results, dataset, labels, problem = self._config()
        if problem is not None or binary is None or results is None or dataset is None or labels is None:
            raise ModelNotConnected(problem or "model not connected")

        validate_input_volume(volume_zyx, spacing_zyx_mm, geometry)
        with tempfile.TemporaryDirectory() as tmp:
            inp = Path(tmp) / "in"
            out = Path(tmp) / "out"
            inp.mkdir()
            out.mkdir()
            img = sitk.GetImageFromArray(volume_zyx.astype(np.float32))
            img.SetSpacing((spacing_zyx_mm[2], spacing_zyx_mm[1], spacing_zyx_mm[0]))
            if geometry is not None:
                img.SetOrigin(geometry.origin_lps_mm)
                img.SetDirection(geometry.direction_cosines)
            sitk.WriteImage(img, str(inp / "case_0000.nii.gz"))

            env = {**os.environ, "nnUNet_results": str(results)}
            cmd = [
                binary,
                "-i",
                str(inp),
                "-o",
                str(out),
                "-d",
                dataset,
                "-c",
                os.environ.get("ANATOMYBRIDGE_NNUNET_CONFIG", "3d_fullres"),
                "-f",
                os.environ.get("ANATOMYBRIDGE_NNUNET_FOLD", "0"),
            ]
            proc = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=600)
            if proc.returncode != 0:
                raise RuntimeError(f"nnUNetv2_predict failed (exit {proc.returncode}): {proc.stderr[-400:]}")
            seg_path = out / "case.nii.gz"
            if not seg_path.exists():
                raise RuntimeError("nnUNetv2_predict produced no case.nii.gz")
            seg_raw = sitk.GetArrayFromImage(sitk.ReadImage(str(seg_path))).astype(np.uint8)
            seg_post, post_info = postprocess_segmentation(seg_raw, spacing_zyx_mm, labels)
            validate_output_segmentation(seg_post, tuple(volume_zyx.shape), labels, geometry, geometry)
            return seg_post, labels, {"postprocessing": post_info}


class UmdMonaiAdapter:
    """Adapter for the ReproCare custom 3D U-Net (`SimpleUnet3D`) on UMD uterine MRI.

    Note on naming: The adapter ID `umd_monai_fibroid` is retained for backwards compatibility
    with existing API routes and database records, while `name` and `architecture` explicitly
    document that the implementation uses `SimpleUnet3D` (custom 3D U-Net in PyTorch/NumPy)
    and does NOT use the MONAI library.
    """

    def __init__(
        self,
        adapter_id: str = "umd_monai_fibroid",
        adapter_name: str = "UMD Uterine Myoma (SimpleUnet3D Custom 3D U-Net)",
    ) -> None:
        self.id = adapter_id
        self.name = adapter_name
        self.architecture = "SimpleUnet3D (custom 3D U-Net — PyTorch/NumPy, MONAI not used)"

    @staticmethod
    def _resolve_weights_env() -> str | None:
        return (
            os.environ.get("ANATOMYBRIDGE_UMD_WEIGHTS")
            or os.environ.get("REPROCARE_MODEL_CHECKPOINT_PATH")
            or None
        )

    def _inspect_checkpoint(
        self,
    ) -> tuple[
        Path | None,
        dict[str, np.ndarray] | None,
        dict[int, str] | None,
        dict[str, Any] | None,
        str | None,
        str | None,
    ]:
        weights_env = self._resolve_weights_env()
        if not weights_env:
            return (
                None,
                None,
                None,
                None,
                None,
                "ANATOMYBRIDGE_UMD_WEIGHTS is not set (no trained model weights configured)",
            )

        weights_path = Path(weights_env)
        if not weights_path.exists() or not weights_path.is_file():
            return (
                weights_path,
                None,
                None,
                None,
                None,
                f"ANATOMYBRIDGE_UMD_WEIGHTS ({weights_path}) does not exist or is not a file",
            )

        try:
            state_dict, metadata, sha256_hex = load_checkpoint_bundle(weights_path)
        except Exception as e:
            return weights_path, None, None, None, None, f"Invalid or unreadable checkpoint ({e})"

        in_channels = int(metadata.get("in_channels", 1))
        out_channels = int(metadata.get("out_channels", 5))
        base_channels = int(metadata.get("base_channels", 16))

        ok, errors = validate_state_dict_compatibility(
            state_dict,
            in_channels=in_channels,
            out_channels=out_channels,
            base_channels=base_channels,
        )
        if not ok:
            return (
                weights_path,
                None,
                None,
                metadata,
                sha256_hex,
                f"Incompatible SimpleUnet3D checkpoint architecture: {'; '.join(errors)}",
            )

        raw_labels = metadata.get("label_map")
        if raw_labels is not None:
            if not isinstance(raw_labels, dict):
                return weights_path, None, None, metadata, sha256_hex, "Checkpoint label_map is not a valid mapping"
            try:
                labels = {int(k): str(v) for k, v in raw_labels.items()}
            except Exception as e:
                return weights_path, None, None, metadata, sha256_hex, f"Invalid label_map keys in checkpoint: {e}"
            if len(labels) != out_channels or 0 not in labels:
                return (
                    weights_path,
                    None,
                    None,
                    metadata,
                    sha256_hex,
                    f"Checkpoint label_map ({len(labels)} labels) does not match out_channels ({out_channels})",
                )
        else:
            labels = dict(UMD_DEFAULT_LABEL_MAP)

        return weights_path, state_dict, labels, metadata, sha256_hex, None

    def status(self) -> ModelStatus:
        _, _, labels, metadata, sha256_hex, problem = self._inspect_checkpoint()
        if problem is not None:
            return ModelStatus(
                id=self.id,
                name=self.name,
                connected=False,
                reason=problem,
                is_learned_model=True,
                architecture=self.architecture,
            )
        meta = metadata or {}
        return ModelStatus(
            id=self.id,
            name=self.name,
            connected=True,
            reason="ready (SimpleUnet3D weights verified)",
            label_map=labels,
            is_learned_model=True,
            architecture=self.architecture,
            model_version=str(meta.get("model_version", "1.0.0-experimental")),
            dataset_version=str(meta.get("dataset_version", "UMD-v1")),
            checkpoint_sha256=sha256_hex,
            training_mode=str(meta.get("training_mode", "unknown")),
            is_clinical_grade=bool(meta.get("is_clinical_grade", False)),
            trained_at=meta.get("trained_at"),
            validation_metrics=meta.get("validation_metrics"),
        )

    def run(
        self,
        volume_zyx: np.ndarray,
        spacing_zyx_mm: tuple[float, float, float],
        geometry: VolumeGeometry | None = None,
    ) -> tuple[np.ndarray, dict[int, str], dict[str, Any]]:
        weights_path, state_dict, labels, metadata, sha256_hex, problem = self._inspect_checkpoint()
        if problem is not None or weights_path is None or state_dict is None or labels is None:
            raise ModelNotConnected(problem or "model not connected")

        validate_input_volume(volume_zyx, spacing_zyx_mm, geometry)
        meta = metadata or {}
        in_channels = int(meta.get("in_channels", 1))
        out_channels = int(meta.get("out_channels", 5))
        base_channels = int(meta.get("base_channels", 16))
        min_comp_voxels = int(os.environ.get("ANATOMYBRIDGE_MIN_COMPONENT_VOXELS", meta.get("min_component_voxels", 0)))

        norm_vol, prep_info = preprocess_mri_volume(volume_zyx)

        if HAS_TORCH and torch is not None:
            model = SimpleUnet3D(in_channels=in_channels, out_channels=out_channels, base_channels=base_channels)
            torch_state = model.state_dict()
            for k, v in state_dict.items():
                torch_state[k] = torch.from_numpy(np.asarray(v))
            model.load_state_dict(torch_state, strict=True)
            model.eval()
            with torch.no_grad():
                tensor_in = torch.from_numpy(norm_vol[None, None, ...])
                logits = model(tensor_in)
                raw_pred = torch.argmax(logits, dim=1).squeeze(0).cpu().numpy().astype(np.uint8)
            execution_backend = "pytorch_cpu"
        else:
            model_np = NumpySimpleUnet3D(
                in_channels=in_channels,
                out_channels=out_channels,
                base_channels=base_channels,
            )
            model_np.load_state_dict(state_dict, strict=True)
            model_np.eval()
            logits_np = model_np.forward(norm_vol[None, None, ...])
            raw_pred = np.argmax(logits_np, axis=1)[0].astype(np.uint8)
            execution_backend = "numpy_cpu"

        post_mask, post_info = postprocess_segmentation(
            raw_pred,
            spacing_zyx_mm=spacing_zyx_mm,
            label_map=labels,
            min_component_voxels=min_comp_voxels,
        )

        validate_output_segmentation(
            post_mask,
            expected_shape_zyx=(int(volume_zyx.shape[0]), int(volume_zyx.shape[1]), int(volume_zyx.shape[2])),
            label_map=labels,
            input_geometry=geometry,
            output_geometry=geometry,
        )

        provenance = {
            "model_id": self.id,
            "model_name": self.name,
            "architecture": self.architecture,
            "execution_backend": execution_backend,
            "model_version": str(meta.get("model_version", "1.0.0-experimental")),
            "dataset_version": str(meta.get("dataset_version", "UMD-v1")),
            "checkpoint_sha256": sha256_hex,
            "training_mode": str(meta.get("training_mode", "unknown")),
            "is_clinical_grade": bool(meta.get("is_clinical_grade", False)),
            "trained_at": meta.get("trained_at"),
            "preprocessing": prep_info,
            "postprocessing": post_info,
        }
        return post_mask, labels, provenance


ADAPTERS: dict[str, Any] = {
    NnUnetAdapter.id: NnUnetAdapter(),
    "umd_monai_fibroid": UmdMonaiAdapter(
        adapter_id="umd_monai_fibroid",
        adapter_name="UMD Uterine Myoma (SimpleUnet3D Custom 3D U-Net)",
    ),
    "umd_unet3d_fibroid": UmdMonaiAdapter(
        adapter_id="umd_unet3d_fibroid",
        adapter_name="UMD Uterine Myoma (SimpleUnet3D Custom 3D U-Net)",
    ),
}


def statuses() -> list[ModelStatus]:
    return [a.status() for a in ADAPTERS.values()]
