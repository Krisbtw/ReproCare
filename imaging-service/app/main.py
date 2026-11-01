"""FastAPI surface of the AnatomyBridge / ReproCare imaging service.

Start:  uvicorn app.main:app --port 8100
Docs:   /docs  and  /openapi.json
Nothing here stores uploads. Files are read in memory and dropped after the response.
"""
from __future__ import annotations

import base64
from datetime import datetime
import hmac
import os
from typing import Any
import zlib

import numpy as np
from fastapi import Depends, FastAPI, File, Header, HTTPException, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse
from pydantic import BaseModel, Field

from . import metrics, models, series, trends

MAX_FILES = 1000
MAX_BYTES_EACH = 64 * 1024 * 1024

app = FastAPI(
    title="AnatomyBridge imaging service",
    version="0.2.0",
    docs_url="/docs",
    redoc_url="/redoc",
    openapi_url="/openapi.json",
    description=(
        "Research prototype. Checks DICOM series geometry, scores masks against references, and "
        "fronts validated SimpleUnet3D / nnU-Net v2 segmentation models. It does not diagnose. "
        "No clinical model weights are bundled."
    ),
)


def cors_origins(raw: str | None = None) -> list[str]:
    """Explicit browser origins allowed to call this service, from ANATOMYBRIDGE_CORS_ORIGINS (comma-separated).

    Default is none: a browser on another origin cannot read responses unless an operator lists it.
    A wildcard is refused on purpose.
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
        allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
        allow_headers=["authorization", "content-type", "x-api-key"],
        allow_credentials=True,
        max_age=86400,
    )


@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains; preload"
    response.headers["X-XSS-Protection"] = "1; mode=block"
    response.headers["Content-Security-Policy"] = "default-src 'self'"
    return response


def redact_sensitive_data(data: Any) -> Any:
    """Removes or masks sensitive information from API error payloads or log responses."""
    if isinstance(data, dict):
        redacted = {}
        for key, value in data.items():
            if key in [
                "patient_ssn",
                "patient_dob",
                "emergency_contact",
                "medical_history",
                "referring_physician",
                "clinician_notes",
            ]:
                continue
            elif key in ["email", "phone"]:
                redacted[key] = "REDACTED"
            elif isinstance(value, (dict, list)):
                redacted[key] = redact_sensitive_data(value)
            else:
                redacted[key] = value
        return redacted
    elif isinstance(data, list):
        return [redact_sensitive_data(item) for item in data]
    return data


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    """Handles request validation errors with structured responses."""
    errors = []
    for error in exc.errors():
        loc = error.get("loc", [])
        field = str(loc[-1]) if loc else "body"
        errors.append(
            {
                "field": field,
                "message": error.get("msg", "Validation error"),
                "type": error.get("type", "value_error"),
            }
        )
    return JSONResponse(
        status_code=422,
        content={
            "success": False,
            "error": "Validation Error",
            "details": errors,
            "timestamp": datetime.utcnow().isoformat(),
            "request": request.url.path,
        },
    )


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    """Standardizes HTTP error responses and prevents data leakage."""
    detail = exc.detail
    if isinstance(detail, dict):
        detail = redact_sensitive_data(detail)
    error_msg = (
        detail
        if isinstance(detail, str)
        else (detail.get("error", "Error") if isinstance(detail, dict) else str(detail))
    )
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "success": False,
            "error": error_msg,
            "detail": detail,
            "timestamp": datetime.utcnow().isoformat(),
            "request": request.url.path,
        },
    )


@app.exception_handler(Exception)
async def generic_exception_handler(request: Request, exc: Exception):
    """Catch-all for unhandled exceptions that avoids leaking internal stack traces."""
    return JSONResponse(
        status_code=500,
        content={
            "success": False,
            "error": "Internal Server Error",
            "message": "An unexpected error occurred. Please try again later.",
            "timestamp": datetime.utcnow().isoformat(),
            "request": request.url.path,
        },
    )


def verify_service_auth(
    auth_header: str | None = Header(None, alias="Authorization"),
    api_key_header: str | None = Header(None, alias="X-API-Key"),
) -> bool:
    """Verifies service authentication. Fails closed in production if no key is configured."""
    expected = os.environ.get("ANATOMYBRIDGE_SERVICE_API_KEY")
    dev_mode = os.environ.get("ANATOMYBRIDGE_DEV_NO_AUTH", "").strip().lower() in ("1", "true", "yes")

    if not expected:
        if dev_mode:
            return True
        raise HTTPException(
            status_code=401,
            detail=(
                "Authentication failed: ANATOMYBRIDGE_SERVICE_API_KEY is not configured "
                "and dev mode (ANATOMYBRIDGE_DEV_NO_AUTH=1) is not enabled."
            ),
        )

    provided = None
    if auth_header and auth_header.startswith("Bearer "):
        provided = auth_header[7:].strip()
    elif api_key_header:
        provided = api_key_header.strip()

    if not provided or not hmac.compare_digest(provided, expected):
        raise HTTPException(401, "Unauthorized: valid service API key or Bearer token is required.")
    return True


class MaskScoreRequest(BaseModel):
    spacing_zyx_mm: tuple[float, float, float] = Field(description="Voxel spacing in mm, order z, y, x")
    prediction: list[list[list[int]]] = Field(description="Binary mask as nested lists, shape z,y,x")
    reference: list[list[list[int]]]


@app.get("/health")
def health() -> dict:
    st = models.statuses()
    return {
        "status": "ok",
        "service": "anatomybridge-imaging",
        "version": "0.2.0",
        "any_model_connected": any(m.connected for m in st),
        "connected_models": [m.id for m in st if m.connected],
        "models": [m.to_dict() for m in st],
    }


@app.get("/metrics", response_class=PlainTextResponse)
def prometheus_metrics() -> str:
    """Prometheus scrape endpoint for service monitoring."""
    return (
        "# HELP anatomybridge_imaging_up Service operational status\n"
        "# TYPE anatomybridge_imaging_up gauge\n"
        "anatomybridge_imaging_up 1\n"
    )


@app.get("/models")
def list_models(auth_ok: bool = Depends(verify_service_auth)) -> list[dict]:
    return [m.to_dict() for m in models.statuses()]


@app.get("/models/{model_id}")
def get_model_status(model_id: str, auth_ok: bool = Depends(verify_service_auth)) -> dict:
    adapter = models.ADAPTERS.get(model_id)
    if adapter is None:
        raise HTTPException(status_code=404, detail=f"unknown model_id '{model_id}'")
    return adapter.status().to_dict()


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
    return redact_sensitive_data(report.to_dict())


@app.post("/metrics/score")
def score_masks(
    req: MaskScoreRequest,
    auth_ok: bool = Depends(verify_service_auth),
) -> dict:
    pred = np.array(req.prediction, dtype=bool)
    ref = np.array(req.reference, dtype=bool)
    if pred.ndim != 3 or pred.shape != ref.shape or any(x <= 0 or x > 1000 for x in req.spacing_zyx_mm):
        raise HTTPException(422, "Masks must be 3D and the same shape with positive spacing.")
    return metrics.score(pred, ref, req.spacing_zyx_mm)


@app.post("/segment/{model_id}")
async def segment(
    model_id: str,
    files: list[UploadFile] = File(...),
    auth_ok: bool = Depends(verify_service_auth),
) -> dict:
    adapter = models.ADAPTERS.get(model_id)
    if adapter is None:
        raise HTTPException(status_code=404, detail=f"Unknown model '{model_id}'.")

    st = adapter.status()
    if not st.connected:
        raise HTTPException(
            status_code=503,
            detail={
                "error": "model_not_connected",
                "model_id": model_id,
                "reason": st.reason,
                "hint": "Set the environment variables documented in imaging-service/README.md after training weights.",
            },
        )

    raw = await _read_files(files)
    try:
        vol, geometry, report = series.stack_volume_with_geometry(raw)
    except ValueError as e:
        raise HTTPException(status_code=422, detail={"error": "unsafe_series", "reason": str(e)}) from e

    try:
        seg, labels, provenance = adapter.run(vol, geometry.spacing_zyx_mm, geometry=geometry)
    except models.ModelNotConnected as e:
        raise HTTPException(status_code=503, detail={"error": "model_not_connected", "reason": str(e)}) from e
    except models.InvalidVolumeError as e:
        raise HTTPException(status_code=422, detail={"error": "invalid_input_volume", "reason": str(e)}) from e
    except models.GeometryMismatchError as e:
        raise HTTPException(status_code=500, detail={"error": "geometry_alignment_failed", "reason": str(e)}) from e
    except Exception as e:
        raise HTTPException(status_code=500, detail={"error": "inference_failed", "reason": str(e)}) from e

    compressed = base64.b64encode(zlib.compress(np.ascontiguousarray(seg, dtype=np.uint8).tobytes())).decode("ascii")
    str_labels = {str(k): str(v) for k, v in labels.items()}
    note_str = (
        f"Experimental learned model output ({st.architecture}, version {provenance.get('model_version', '1.0.0')}). "
        "Not clinically validated; requires clinician verification."
    )
    return {
        "model_id": model_id,
        "model": {
            "id": model_id,
            "name": st.name,
            "is_learned_model": True,
            "architecture": st.architecture,
            "model_version": provenance.get("model_version"),
            "dataset_version": provenance.get("dataset_version"),
            "checkpoint_sha256": provenance.get("checkpoint_sha256"),
            "training_mode": provenance.get("training_mode"),
            "is_clinical_grade": provenance.get("is_clinical_grade", False),
        },
        "shape_zyx": list(seg.shape),
        "spacing_zyx_mm": list(geometry.spacing_zyx_mm),
        "origin_lps_mm": list(geometry.origin_lps_mm),
        "direction_cosines": list(geometry.direction_cosines),
        "frame_of_reference_uid": geometry.frame_of_reference_uid,
        "geometry": geometry.to_dict(),
        "label_map": labels,
        "labels": str_labels,
        "label_counts": {str(int(v)): int(c) for v, c in zip(*np.unique(seg, return_counts=True))},
        "dtype": "uint8",
        "mask_dtype": "uint8",
        "encoding": "zlib+base64",
        "mask": compressed,
        "mask_b64_zlib": compressed,
        "note": note_str,
        "series": redact_sensitive_data(report.to_dict()),
        "series_report": redact_sensitive_data(report.to_dict()),
        "provenance": provenance,
    }


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
    dates = []
    vols = []
    for obs in req.observations:
        try:
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
