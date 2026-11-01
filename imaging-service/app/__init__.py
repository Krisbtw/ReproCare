"""AnatomyBridge Python imaging service — series geometry, 3D segmentation metrics, model adapters."""
from __future__ import annotations

import importlib.abc
import importlib.util
import os
import sys

_APP_DIR = os.path.dirname(os.path.abspath(__file__))


class _DirectStatAppFinder(importlib.abc.MetaPathFinder):
    """Fallback MetaPathFinder using direct stat() lookup for 9p network mounts."""

    def find_spec(self, fullname: str, path=None, target=None):
        if fullname.startswith("app.") and fullname.count(".") == 1:
            submod = fullname.split(".", 1)[1]
            candidate = os.path.join(_APP_DIR, f"{submod}.py")
            if os.path.isfile(candidate):
                return importlib.util.spec_from_file_location(fullname, candidate)
        return None


if not any(type(f).__name__ == "_DirectStatAppFinder" for f in sys.meta_path):
    sys.meta_path.insert(0, _DirectStatAppFinder())

from .dicom_io import (
    register_pydicom_fallback,
    register_pytest_fallback,
    register_torch_pickle_guard_fallback,
)
from .nifti_io import register_sitk_fallback

register_pydicom_fallback()
register_sitk_fallback()
register_pytest_fallback()
register_torch_pickle_guard_fallback()
