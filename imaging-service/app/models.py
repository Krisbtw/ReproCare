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


ADAPTERS = {NnUNetAdapter.id: NnUNetAdapter()}


def statuses() -> list[ModelStatus]:
    return [a.status() for a in ADAPTERS.values()]
