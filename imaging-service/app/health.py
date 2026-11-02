"""Health, liveness, and deep readiness diagnostics for the imaging service.

Provides:
- /health/live: Lightweight liveness probe verifying process viability (zero dependencies).
- /health/ready: Deep readiness probe inspecting Python runtime, dependencies (SimpleITK,
  NumPy, SciPy, Pydicom, PyTorch/NumPy backend), model checkpoint integrity, Supabase
  Storage connectivity, and Tesseract OCR availability.
"""
from __future__ import annotations

from datetime import datetime, timezone
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
from typing import Any

import fastapi
import numpy as np
import pydicom
import scipy

from . import models, storage_client
from .unet import HAS_TORCH, get_available_training_devices

try:
    import SimpleITK as _real_sitk  # type: ignore

    _HAS_NATIVE_SITK = True
    _SITK_VERSION = getattr(_real_sitk, "__version__", "unknown")
except ImportError:
    _HAS_NATIVE_SITK = False
    _SITK_VERSION = None


def check_fastapi() -> dict[str, Any]:
    return {
        "status": "available",
        "version": getattr(fastapi, "__version__", "unknown"),
    }


def check_python() -> dict[str, Any]:
    return {
        "status": "available",
        "version": platform.python_version(),
        "implementation": platform.python_implementation(),
        "executable": sys.executable,
        "platform": sys.platform,
    }


def check_numpy_scipy() -> dict[str, Any]:
    return {
        "status": "available",
        "numpy_version": getattr(np, "__version__", "unknown"),
        "scipy_version": getattr(scipy, "__version__", "unknown"),
    }


def check_pydicom() -> dict[str, Any]:
    return {
        "status": "available",
        "version": getattr(pydicom, "__version__", "unknown"),
    }


def check_simpleitk() -> dict[str, Any]:
    if _HAS_NATIVE_SITK:
        return {
            "status": "available",
            "installed": True,
            "version": _SITK_VERSION,
            "fallback_active": False,
            "mode": "native_c++",
        }
    return {
        "status": "available",
        "installed": False,
        "version": "fallback_pure_python",
        "fallback_active": True,
        "mode": "pure_python_nifti_fallback",
        "reason": "Native SimpleITK not installed; bit-compatible pure-Python NIfTI reader/writer fallback active.",
    }


def check_pytorch() -> dict[str, Any]:
    devices = get_available_training_devices()
    if HAS_TORCH:
        return {
            "status": "available",
            "installed": True,
            "version": devices.get("pytorch_version"),
            "cuda_available": devices.get("cuda_available", False),
            "mps_available": devices.get("mps_available", False),
            "backend": "pytorch_cuda" if devices.get("cuda_available") else "pytorch_cpu",
            "execution_backend": "pytorch_cuda" if devices.get("cuda_available") else "pytorch_cpu",
        }
    return {
        "status": "not_applicable",
        "installed": False,
        "version": None,
        "cuda_available": False,
        "mps_available": False,
        "backend": "numpy_cpu_fallback",
        "execution_backend": "numpy_cpu_fallback",
        "reason": (
            "PyTorch omitted in serverless deployment to satisfy Vercel 500MB function size limit; "
            "bit-identical pure-NumPy tensor inference active."
        ),
    }


def check_models_and_checkpoints() -> tuple[dict[str, Any], dict[str, Any]]:
    st = models.statuses()
    connected_models = [m.id for m in st if m.connected]
    weights_env = (os.environ.get("ANATOMYBRIDGE_UMD_WEIGHTS") or "").strip()

    if not weights_env:
        model_status = "not_configured"
        model_reason = "ANATOMYBRIDGE_UMD_WEIGHTS is not set; model weights intentionally postponed."
        ckpt_status = "not_configured"
        ckpt_reason = "ANATOMYBRIDGE_UMD_WEIGHTS is not set."
        ckpt_path = None
        ckpt_sha256 = None
        ckpt_meta = None
    else:
        ckpt_file = Path(weights_env)
        ckpt_path = str(ckpt_file)
        if not ckpt_file.exists():
            model_status = "unavailable"
            model_reason = f"Configured weights file does not exist: {ckpt_file}"
            ckpt_status = "unavailable"
            ckpt_reason = f"Checkpoint file '{ckpt_file}' does not exist on disk."
            ckpt_sha256 = None
            ckpt_meta = None
        else:
            try:
                _, meta, sha256_hex = models.load_checkpoint_bundle(ckpt_file)
                ckpt_sha256 = sha256_hex
                ckpt_meta = meta
                if connected_models:
                    model_status = "available"
                    model_reason = f"Models connected: {', '.join(connected_models)}"
                    ckpt_status = "available"
                    ckpt_reason = "Checkpoint verified and loaded."
                else:
                    model_status = "degraded"
                    model_reason = "Checkpoint file exists but failed verification or architecture compatibility."
                    ckpt_status = "degraded"
                    ckpt_reason = "Checkpoint file exists but failed verification or architecture compatibility."
            except Exception as e:
                model_status = "degraded"
                model_reason = f"Corrupted or invalid checkpoint: {e}"
                ckpt_status = "degraded"
                ckpt_reason = f"Corrupted or invalid checkpoint: {e}"
                ckpt_sha256 = None
                ckpt_meta = None

    execution_backend = "numpy_cpu_fallback" if not HAS_TORCH else "pytorch_cpu"

    unet_model_info = {
        "status": model_status,
        "connected_count": len(connected_models),
        "connected_models": connected_models,
        "execution_backend": execution_backend,
        "trained_checkpoint_loaded": bool(connected_models),
        "models": [m.to_dict() for m in st],
        "reason": model_reason,
    }

    model_checkpoint_info = {
        "status": ckpt_status,
        "path": ckpt_path,
        "sha256": ckpt_sha256,
        "reason": ckpt_reason,
    }
    if ckpt_meta:
        model_checkpoint_info["model_version"] = ckpt_meta.get("model_version")
        model_checkpoint_info["architecture"] = ckpt_meta.get("architecture")

    return unet_model_info, model_checkpoint_info


def check_supabase(
    env: dict[str, str] | None = None,
    client: storage_client.SupabaseStorageClient | None = None,
    timeout_sec: float = 3.0,
) -> dict[str, Any]:
    return dict(storage_client.probe_supabase_connectivity(env=env, client=client, timeout_sec=timeout_sec))


def check_tesseract() -> dict[str, Any]:
    candidates = [
        shutil.which("tesseract"),
        "/usr/bin/tesseract",
        "/usr/local/bin/tesseract",
        r"C:\Program Files\Tesseract-OCR\tesseract.exe",
        r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
    ]
    tess_path: str | None = None
    for cand in candidates:
        if cand and os.path.exists(cand):
            tess_path = cand
            break

    if not tess_path:
        return {
            "status": "unavailable",
            "installed": False,
            "executable": None,
            "version": None,
            "languages": [],
            "english_available": False,
            "english_supported": False,
            "reason": "tesseract binary not found on system PATH or standard binary locations.",
        }

    ver_str: str | None = None
    try:
        ver_proc = subprocess.run(
            [tess_path, "--version"],
            capture_output=True,
            text=True,
            timeout=3,
        )
        if ver_proc.returncode == 0:
            lines = (ver_proc.stdout or ver_proc.stderr or "").strip().splitlines()
            ver_str = lines[0].strip() if lines else "tesseract"
    except Exception:
        ver_str = None

    langs: list[str] = []
    try:
        lang_proc = subprocess.run(
            [tess_path, "--list-langs"],
            capture_output=True,
            text=True,
            timeout=3,
        )
        if lang_proc.returncode == 0:
            lines = [l.strip() for l in (lang_proc.stdout or "").splitlines() if l.strip()]
            if lines and "List of available languages" in lines[0]:
                lines = lines[1:]
            langs = lines
    except Exception:
        langs = []

    has_eng = "eng" in langs
    status = "available" if has_eng else "degraded"
    return {
        "status": status,
        "installed": True,
        "executable": tess_path,
        "path": tess_path,
        "version": ver_str,
        "languages": langs,
        "english_available": has_eng,
        "english_supported": has_eng,
        "reason": (
            "Tesseract OCR binary and English language pack verified."
            if has_eng
            else "Tesseract installed but 'eng' traineddata language pack not found."
        ),
    }


def liveness_probe() -> dict[str, Any]:
    return {
        "status": "alive",
        "service": "anatomybridge-imaging",
        "version": "0.2.0",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


def readiness_probe(
    env: dict[str, str] | None = None,
    storage_probe_timeout: float = 3.0,
) -> tuple[int, dict[str, Any]]:
    python_info = check_python()
    fastapi_info = check_fastapi()
    numpy_scipy_info = check_numpy_scipy()
    pydicom_info = check_pydicom()
    sitk_info = check_simpleitk()
    torch_info = check_pytorch()
    unet_info, ckpt_info = check_models_and_checkpoints()
    supa_info = check_supabase(env=env, timeout_sec=storage_probe_timeout)
    tess_info = check_tesseract()

    dependencies = {
        "python": python_info,
        "fastapi": fastapi_info,
        "numpy_scipy": numpy_scipy_info,
        "pydicom": pydicom_info,
        "simpleitk": sitk_info,
        "pytorch": torch_info,
        "unet_model": unet_info,
        "model_checkpoint": ckpt_info,
        "supabase_storage": supa_info,
        "tesseract_ocr": tess_info,
    }

    core_ok = all(
        dependencies[k]["status"] == "available"
        for k in ["python", "fastapi", "numpy_scipy", "pydicom", "simpleitk"]
    )

    overall_status = "ready" if core_ok else "degraded"
    status_code = 200 if core_ok else 503

    payload = {
        "status": overall_status,
        "service": "anatomybridge-imaging",
        "version": "0.2.0",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "dependencies": dependencies,
        "checks": dependencies,
    }
    return status_code, payload
