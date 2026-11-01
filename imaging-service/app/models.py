"""Segmentation model adapters.

An adapter is "connected" only when everything it needs is really present:
the Python package or executable AND a weights folder given by an environment
variable. Otherwise run() raises ModelNotConnected. This service never returns a
made-up mask and never labels a classical or synthetic output as a model result.

No weights are bundled and none were trained by this project.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import SimpleITK as sitk


class ModelNotConnected(RuntimeError):
    pass


@dataclass
class ModelStatus:
    id: str
    name: str
    connected: bool
    reason: str
    modality: str
    intended_structures: list[str]
    licence_note: str
    is_learned_model: bool = True


class NnUNetAdapter:
    """Calls the `nnUNetv2_predict` command line tool on weights the operator supplies.

    Environment:
      ANATOMYBRIDGE_NNUNET_RESULTS   folder that holds trained nnU-Net results (sets nnUNet_results)
      ANATOMYBRIDGE_NNUNET_DATASET   dataset id or name, for example 501
      ANATOMYBRIDGE_NNUNET_CONFIG    configuration, default 3d_fullres
      ANATOMYBRIDGE_NNUNET_FOLDS     folds, default "0"
      ANATOMYBRIDGE_NNUNET_LABELS    JSON object mapping label value to structure name, for example
                                     {"1":"uterine_wall","2":"cavity","3":"myoma"}. The label map is NOT
                                     assumed. Without it the adapter refuses, so a number is never guessed to be a fibroid.

    UNTESTED: no weights were available when this was written, so the prediction path
    has never run. Only the "not connected" behaviour is covered by tests.
    """

    id = "nnunet_umd"
    name = "nnU-Net (operator-supplied weights)"
    modality = "MR"
    intended = ["structures named in ANATOMYBRIDGE_NNUNET_LABELS"]
    licence_note = "Depends on the weights you supply. Check the licence of the training data and of the weights before use."

    def status(self) -> ModelStatus:
        reason = self._missing()
        return ModelStatus(
            id=self.id, name=self.name, connected=reason is None,
            reason=reason or "Executable, weights folder, dataset id and label map are all present. Prediction path untested here.",
            modality=self.modality, intended_structures=self.intended, licence_note=self.licence_note,
        )

    def _missing(self) -> str | None:
        if shutil.which("nnUNetv2_predict") is None:
            return "nnunetv2 is not installed (nnUNetv2_predict not found)."
        results = os.environ.get("ANATOMYBRIDGE_NNUNET_RESULTS")
        if not results or not Path(results).is_dir():
            return "ANATOMYBRIDGE_NNUNET_RESULTS is not set to an existing folder. No weights are bundled."
        if not os.environ.get("ANATOMYBRIDGE_NNUNET_DATASET"):
            return "ANATOMYBRIDGE_NNUNET_DATASET is not set."
        try:
            labels = json.loads(os.environ.get("ANATOMYBRIDGE_NNUNET_LABELS", ""))
            if not isinstance(labels, dict) or not labels:
                raise ValueError
        except ValueError:
            return "ANATOMYBRIDGE_NNUNET_LABELS is missing or not a JSON object. The label map is never assumed."
        return None

    def run(self, volume_zyx: np.ndarray, spacing_zyx_mm: tuple[float, float, float]) -> dict:
        reason = self._missing()
        if reason:
            raise ModelNotConnected(reason)
        labels = json.loads(os.environ["ANATOMYBRIDGE_NNUNET_LABELS"])
        with tempfile.TemporaryDirectory() as tmp:
            tin, tout = Path(tmp, "in"), Path(tmp, "out")
            tin.mkdir()
            tout.mkdir()
            img = sitk.GetImageFromArray(volume_zyx.astype(np.float32))
            img.SetSpacing((spacing_zyx_mm[2], spacing_zyx_mm[1], spacing_zyx_mm[0]))
            sitk.WriteImage(img, str(tin / "case_0000.nii.gz"))
            env = dict(os.environ, nnUNet_results=os.environ["ANATOMYBRIDGE_NNUNET_RESULTS"])
            cmd = [
                "nnUNetv2_predict", "-i", str(tin), "-o", str(tout),
                "-d", os.environ["ANATOMYBRIDGE_NNUNET_DATASET"],
                "-c", os.environ.get("ANATOMYBRIDGE_NNUNET_CONFIG", "3d_fullres"),
                "-f", *os.environ.get("ANATOMYBRIDGE_NNUNET_FOLDS", "0").split(),
            ]
            subprocess.run(cmd, check=True, env=env, capture_output=True, text=True)
            seg = sitk.GetArrayFromImage(sitk.ReadImage(str(tout / "case.nii.gz")))
        return {
            "labels": {k: v for k, v in labels.items()},
            "label_volume_zyx": seg.astype(np.uint8),
            "model": {"id": self.id, "is_learned_model": True, "command": " ".join(cmd[:1] + cmd[3:])},
            "note": "Model output. Not clinician-verified. Not validated by this project.",
        }


class UmdMonaiAdapter:
    """Uterine fibroid segmentation adapter trained on or compatible with the UMD dataset.

    UMD labels:
      1: uterine_wall
      2: cavity
      3: myoma (uterine fibroid)
      4: nabothian (nabothian cyst)

    Environment:
      ANATOMYBRIDGE_UMD_WEIGHTS   path to trained model weights (.pt or .pth or TorchScript .ts)
      ANATOMYBRIDGE_UMD_DEVICE    optional torch device, default 'cpu'
    """

    id = "umd_monai_fibroid"
    name = "UMD Uterine Myoma (MONAI 3D U-Net)"
    modality = "MR"
    intended = ["uterine_wall", "cavity", "myoma", "nabothian"]
    licence_note = "Trained on UMD dataset (CC BY 4.0). Not validated for standalone clinical diagnosis."
    labels = {
        "0": "background",
        "1": "uterine_wall",
        "2": "cavity",
        "3": "myoma",
        "4": "nabothian",
    }

    def status(self) -> ModelStatus:
        reason = self._missing()
        return ModelStatus(
            id=self.id,
            name=self.name,
            connected=reason is None,
            reason=reason or "Weights checkpoint and dependencies are available.",
            modality=self.modality,
            intended_structures=self.intended,
            licence_note=self.licence_note,
            is_learned_model=True,
        )

    def _missing(self) -> str | None:
        weights = os.environ.get("ANATOMYBRIDGE_UMD_WEIGHTS")
        if not weights or not Path(weights).is_file():
            return (
                "ANATOMYBRIDGE_UMD_WEIGHTS is not set to an existing weights file (.pt/.pth). "
                "Train or obtain weights using imaging-service/train_umd.py on the UMD dataset (Figshare 23541312)."
            )
        try:
            import torch  # noqa: F401
        except ImportError:
            return "PyTorch (torch) is not installed in the Python environment."
        return None

    def run(self, volume_zyx: np.ndarray, spacing_zyx_mm: tuple[float, float, float]) -> dict:
        reason = self._missing()
        if reason:
            raise ModelNotConnected(reason)

        import torch

        device = torch.device(os.environ.get("ANATOMYBRIDGE_UMD_DEVICE", "cpu"))
        weights_path = Path(os.environ["ANATOMYBRIDGE_UMD_WEIGHTS"])

        # SimpleITK image to match orientation and spacing
        # Normalized input [1, 1, Z, Y, X]
        vol = volume_zyx.astype(np.float32)
        p1, p99 = np.percentile(vol, 1), np.percentile(vol, 99)
        if p99 > p1:
            vol = np.clip((vol - p1) / (p99 - p1), 0.0, 1.0)
        else:
            vol = np.zeros_like(vol)

        tensor_in = torch.from_numpy(vol).unsqueeze(0).unsqueeze(0).to(device)

        with torch.no_grad():
            if weights_path.suffix in (".ts", ".pt") and "torchscript" in str(weights_path).lower():
                model = torch.jit.load(str(weights_path), map_location=device)
                model.eval()
                logits = model(tensor_in)
            else:
                # Load state dict into standard 3D U-Net or TorchScript
                try:
                    checkpoint = torch.load(str(weights_path), map_location=device, weights_only=True)
                except Exception:
                    checkpoint = torch.load(str(weights_path), map_location=device)

                if isinstance(checkpoint, torch.nn.Module):
                    model = checkpoint
                    model.eval()
                    logits = model(tensor_in)
                elif isinstance(checkpoint, dict) and "state_dict" in checkpoint:
                    from .unet import SimpleUnet3D
                    model = SimpleUnet3D(in_channels=1, num_classes=5).to(device)
                    model.load_state_dict(checkpoint["state_dict"])
                    model.eval()
                    logits = model(tensor_in)
                else:
                    raise RuntimeError("Unrecognized weights format. Expected state_dict or TorchScript model.")

            pred_labels = torch.argmax(logits, dim=1).squeeze(0).cpu().numpy().astype(np.uint8)

        return {
            "labels": dict(self.labels),
            "label_volume_zyx": pred_labels,
            "model": {
                "id": self.id,
                "is_learned_model": True,
                "weights": str(weights_path),
            },
            "note": "Genuine learned model output. Not clinician-verified.",
        }


ADAPTERS = {
    NnUNetAdapter.id: NnUNetAdapter(),
    UmdMonaiAdapter.id: UmdMonaiAdapter(),
}


def statuses() -> list[ModelStatus]:
    return [a.status() for a in ADAPTERS.values()]
