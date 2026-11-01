"""Score a predicted mask file against a reference mask file (NIfTI or any SimpleITK format).

  python -m app.score pred.nii.gz ref.nii.gz [--label N]

Use it on UMD cases once you have downloaded them under their licence. Prints JSON.
Both files must share shape; spacing is taken from the reference.
"""
from __future__ import annotations

import argparse
import json

import numpy as np

from . import metrics
from .nifti_io import register_sitk_fallback

sitk = register_sitk_fallback()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("pred")
    ap.add_argument("ref")
    ap.add_argument("--label", type=int, default=None, help="Score only this label value. Default: any non-zero.")
    a = ap.parse_args()
    pr, rf = sitk.ReadImage(a.pred), sitk.ReadImage(a.ref)
    p, r = sitk.GetArrayFromImage(pr), sitk.GetArrayFromImage(rf)
    if a.label is not None:
        p, r = p == a.label, r == a.label
    else:
        p, r = p != 0, r != 0
    sp = rf.GetSpacing()
    print(json.dumps(metrics.score(p, r, (sp[2], sp[1], sp[0])), indent=2))


if __name__ == "__main__":
    main()
