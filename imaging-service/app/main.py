"""FastAPI surface of the imaging service.

Start:  uvicorn app.main:app --port 8100
Docs:   /docs  and  /openapi.json
Nothing here stores uploads. Files are read in memory and dropped after the response.
"""
from __future__ import annotations

import io
import os

import numpy as np
from fastapi import FastAPI, File, HTTPException, UploadFile
from pydantic import BaseModel, Field

from . import metrics, models, series

MAX_FILES = 1000
MAX_BYTES_EACH = 64 * 1024 * 1024

app = FastAPI(
    title="AnatomyBridge imaging service",
    version="0.1.0",
    description=(
        "Research prototype. Checks DICOM series geometry, scores masks against references, and "
        "fronts optional segmentation models. It does not diagnose. No model weights are bundled."
    ),
)


class Health(BaseModel):
    status: str
    service: str
    any_model_connected: bool


class MaskScoreRequest(BaseModel):
    spacing_zyx_mm: tuple[float, float, float] = Field(description="Voxel spacing in mm, order z, y, x")
    prediction: list[list[list[int]]] = Field(description="Binary mask as nested lists, shape z,y,x")
    reference: list[list[list[int]]]


@app.get("/health", response_model=Health)
def health() -> Health:
    return Health(status="ok", service="anatomybridge-imaging", any_model_connected=any(m.connected for m in models.statuses()))


@app.get("/models")
def list_models() -> list[dict]:
    return [m.__dict__ for m in models.statuses()]


async def _read_files(files: list[UploadFile]) -> list[bytes]:
    if not files:
        raise HTTPException(400, "No files.")
    if len(files) > MAX_FILES:
        raise HTTPException(413, f"At most {MAX_FILES} files per request.")
    blobs: list[bytes] = []
    for f in files:
        data = await f.read(MAX_BYTES_EACH + 1)
        if len(data) > MAX_BYTES_EACH:
            raise HTTPException(413, "A file exceeds the size limit.")
        blobs.append(data)
    return blobs


@app.post("/series/inspect")
async def inspect_series(files: list[UploadFile] = File(...)) -> dict:
    """Geometry report for one DICOM series. Patient tags are not returned."""
    report, _ = series.inspect(await _read_files(files))
    return report.to_dict()


@app.post("/metrics/score")
def score_masks(req: MaskScoreRequest) -> dict:
    pred = np.array(req.prediction, dtype=bool)
    ref = np.array(req.reference, dtype=bool)
    if pred.ndim != 3 or pred.shape != ref.shape:
        raise HTTPException(422, "Masks must be 3D and the same shape.")
    return metrics.score(pred, ref, req.spacing_zyx_mm)


@app.post("/segment/{model_id}")
async def segment(model_id: str, files: list[UploadFile] = File(...)) -> dict:
    adapter = models.ADAPTERS.get(model_id)
    if adapter is None:
        raise HTTPException(404, f"Unknown model '{model_id}'.")
    status = adapter.status()
    if not status.connected:
        # 503 on purpose: the model is not available. No mask is invented.
        raise HTTPException(503, {"error": "model_not_connected", "model": model_id, "reason": status.reason})
    try:
        vol, spacing, rep = series.stack_volume(await _read_files(files))
    except ValueError as e:
        raise HTTPException(422, str(e)) from e
    out = adapter.run(vol, spacing)
    seg = out.pop("label_volume_zyx")
    out["shape_zyx"] = list(seg.shape)
    out["spacing_zyx_mm"] = list(spacing)
    out["label_counts"] = {str(int(v)): int(c) for v, c in zip(*np.unique(seg, return_counts=True))}
    out["series_report"] = rep.to_dict()
    return out
