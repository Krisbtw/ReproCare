"""FastAPI surface of the imaging service.

Start:  uvicorn app.main:app --port 8100
Docs:   /docs  and  /openapi.json
Nothing here stores uploads. Files are read in memory and dropped after the response.
"""
from __future__ import annotations

import base64
import os
import zlib

import numpy as np
from fastapi import Depends, FastAPI, File, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from . import metrics, models, series, trends

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


def cors_origins(raw: str | None) -> list[str]:
    """Explicit browser origins allowed to call this service, from ANATOMYBRIDGE_CORS_ORIGINS (comma-separated).

    Default is none: a browser on another origin cannot read responses unless an operator lists it.
    A wildcard is refused on purpose, because the service has no authentication of its own.
    """
    if not raw:
        return []
    out: list[str] = []
    for part in raw.split(","):
        o = part.strip().rstrip("/")
        if not o or o == "*":
            continue
        if not (o.startswith("http://") or o.startswith("https://")):
            continue
        out.append(o)
    return out


_ORIGINS = cors_origins(os.environ.get("ANATOMYBRIDGE_CORS_ORIGINS"))
if _ORIGINS:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_ORIGINS,
        allow_methods=["GET", "POST"],
        allow_headers=["authorization", "content-type", "x-api-key"],
        allow_credentials=False,
    )


@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains"
    return response


class Health(BaseModel):
    status: str
    service: str
    any_model_connected: bool


def verify_service_auth(
    auth_header: str | None = Header(None, alias="Authorization"),
    api_key_header: str | None = Header(None, alias="X-API-Key"),
) -> bool:
    """Verifies service authentication if ANATOMYBRIDGE_SERVICE_API_KEY is configured in the environment.

    Supports either:
      Authorization: Bearer <token>
      X-API-Key: <token>
    When ANATOMYBRIDGE_SERVICE_API_KEY is unset, requests proceed without authentication (for local preview/dev).
    """
    expected = os.environ.get("ANATOMYBRIDGE_SERVICE_API_KEY")
    if not expected:
        return True

    provided = None
    if auth_header and auth_header.startswith("Bearer "):
        provided = auth_header[7:].strip()
    elif api_key_header:
        provided = api_key_header.strip()

    if not provided or provided != expected:
        raise HTTPException(401, "Unauthorized: valid service API key or Bearer token is required.")
    return True


class MaskScoreRequest(BaseModel):
    spacing_zyx_mm: tuple[float, float, float] = Field(description="Voxel spacing in mm, order z, y, x")
    prediction: list[list[list[int]]] = Field(description="Binary mask as nested lists, shape z,y,x")
    reference: list[list[list[int]]]


@app.get("/health", response_model=Health)
def health() -> Health:
    return Health(status="ok", service="anatomybridge-imaging", any_model_connected=any(m.connected for m in models.statuses()))


@app.get("/models")
def list_models(auth_ok: bool = Depends(verify_service_auth)) -> list[dict]:
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
async def inspect_series(
    files: list[UploadFile] = File(...),
    auth_ok: bool = Depends(verify_service_auth),
) -> dict:
    """Geometry report for one DICOM series. Patient tags are not returned."""
    report, _ = series.inspect(await _read_files(files))
    return report.to_dict()


@app.post("/metrics/score")
def score_masks(
    req: MaskScoreRequest,
    auth_ok: bool = Depends(verify_service_auth),
) -> dict:
    pred = np.array(req.prediction, dtype=bool)
    ref = np.array(req.reference, dtype=bool)
    if pred.ndim != 3 or pred.shape != ref.shape:
        raise HTTPException(422, "Masks must be 3D and the same shape.")
    return metrics.score(pred, ref, req.spacing_zyx_mm)


@app.post("/segment/{model_id}")
async def segment(
    model_id: str,
    files: list[UploadFile] = File(...),
    auth_ok: bool = Depends(verify_service_auth),
) -> dict:
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
    seg: np.ndarray = out.pop("label_volume_zyx")
    # Serialize the mask as base64-encoded zlib-compressed bytes so the browser
    # can reconstruct the voxel array without a separate binary endpoint.
    seg_u8 = seg.astype(np.uint8)
    compressed = zlib.compress(seg_u8.tobytes(), level=6)
    out["mask_b64_zlib"] = base64.b64encode(compressed).decode("ascii")
    out["mask_dtype"] = "uint8"
    out["shape_zyx"] = list(seg_u8.shape)
    out["spacing_zyx_mm"] = list(spacing)
    out["label_counts"] = {str(int(v)): int(c) for v, c in zip(*np.unique(seg_u8, return_counts=True))}
    out["series_report"] = rep.to_dict()
    return out


class TrendPoint(BaseModel):
    date: str = Field(description="ISO date string")
    volume_mm3: float = Field(description="Lesion volume in mm3")


class TrendCalculationRequest(BaseModel):
    observations: list[TrendPoint]
    historical_findings: list[dict] = []
    current_findings: list[dict] = []


@app.post("/trends/calculate")
def calculate_trends_endpoint(
    req: TrendCalculationRequest,
    auth_ok: bool = Depends(verify_service_auth),
) -> dict:
    from datetime import datetime
    dates = []
    vols = []
    for obs in req.observations:
        try:
            # Handle YYYY-MM-DD or full ISO
            clean_date = obs.date.replace("Z", "+00:00")
            if len(clean_date) == 10:
                d = datetime.strptime(clean_date, "%Y-%m-%d")
            else:
                d = datetime.fromisoformat(clean_date)
            dates.append(d)
            vols.append(obs.volume_mm3)
        except Exception:
            pass

    growth_rate = trends.calculate_growth_rate(dates, vols)
    direction = trends.calculate_trend(vols)
    discrepancies = trends.detect_discrepancies(req.current_findings, req.historical_findings)

    return {
        "growth_rate_mm3_per_month": growth_rate,
        "trend_direction": direction,
        "observations_count": len(dates),
        "discrepancies": discrepancies,
    }

