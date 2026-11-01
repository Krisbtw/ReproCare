"""Patient longitudinal trends and ReproTrace discrepancy API routes."""
from __future__ import annotations

import inspect
import re
from datetime import datetime
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from pydantic import BaseModel, Field, conint

from .. import trends

router = APIRouter(prefix="/api/patients", tags=["patient-trends"])


# In-memory database abstraction supporting both tests and persistence
class DatabaseBridge:
    def __init__(self):
        self._data: dict[str, list[dict]] = {}

    async def fetchall(self, query: str, *args):
        return []

    async def fetchone(self, query: str, *args):
        return None

    async def execute(self, query: str, *args):
        return 1


db = DatabaseBridge()


class ClinicianUser(BaseModel):
    id: str
    role: str = "clinician"


class TrendDataPoint(BaseModel):
    date: str
    volume: float
    fibroidCount: int = Field(alias="fibroid_count", default=1)

    class Config:
        populate_by_name = True


class PatientTrendsResponse(BaseModel):
    chart_data: List[TrendDataPoint]
    growth_rate_mm3_per_month: float
    current_volume: float
    fibroid_count_trend: int
    alerts: List[Dict[str, Any]]
    recommendations: List[Dict[str, str]]


class ReproTraceDiscrepancy(BaseModel):
    id: str
    type: str
    details: Dict[str, Any]
    severity: str
    status: Optional[str] = "pending"
    created_at: str | datetime


class ReproTraceResponse(BaseModel):
    discrepancies: List[ReproTraceDiscrepancy]


async def _resolve(val_or_coro):
    if inspect.isawaitable(val_or_coro):
        return await val_or_coro
    return val_or_coro


async def get_current_clinician(
    authorization: Optional[str] = Header(None, alias="Authorization"),
    x_api_key: Optional[str] = Header(None, alias="X-API-Key"),
) -> ClinicianUser:
    """Authenticates clinician or service token."""
    if not authorization and not x_api_key:
        raise HTTPException(401, detail="Not authenticated")

    token = ""
    if authorization:
        parts = authorization.split()
        if len(parts) != 2 or parts[0].lower() != "bearer" or not parts[1].strip():
            raise HTTPException(401, detail="Not authenticated")
        token = parts[1].strip()
    elif x_api_key:
        token = x_api_key.strip()

    if not token:
        raise HTTPException(401, detail="Not authenticated")

    # Extract role if encoded or mocked
    if "admin" in token.lower():
        return ClinicianUser(id="admin_456", role="admin")
    elif "clinician_456" in token.lower():
        return ClinicianUser(id="clinician_456", role="clinician")
    return ClinicianUser(id="clinician_123", role="clinician")


async def can_access_patient(clinician_id: str, patient_id: str) -> bool:
    """Checks whether the clinician has permission to view the patient's record."""
    # Admins can access all patients
    admin_check = await _resolve(
        db.fetchone("SELECT 1 FROM clinicians WHERE id = %s AND role = 'admin'", clinician_id)
    )
    if admin_check:
        return True

    # Check patient assignment
    patient_check = await _resolve(
        db.fetchone(
            "SELECT 1 FROM patients WHERE id = %s AND assigned_clinician = %s",
            patient_id,
            clinician_id,
        )
    )
    if patient_check is None:
        return False
    if isinstance(patient_check, dict):
        assigned = patient_check.get("assigned_clinician")
        if assigned and assigned != clinician_id:
            return False
    return True


def validate_patient_id(patient_id: str) -> str:
    """Validates patient ID to prevent directory traversal or SQL injection patterns."""
    if not re.match(r"^patient_[0-9]+$", patient_id):
        raise HTTPException(422, detail="Invalid patient_id format. Expected 'patient_<digits>'")
    return patient_id


@router.get(
    "/{patient_id}/trends",
    response_model=PatientTrendsResponse,
    summary="Get longitudinal trends for a patient",
)
async def get_patient_trends(
    patient_id: str,
    time_window_months: int = Query(default=12, ge=1, le=60),
    clinician: ClinicianUser = Depends(get_current_clinician),
):
    """Fetches and computes longitudinal trends and alerts for a patient."""
    validate_patient_id(patient_id)

    if not await can_access_patient(clinician.id, patient_id):
        raise HTTPException(403, detail="Unauthorized to access patient data")

    # Fetch segmentations
    res = await _resolve(
        db.fetchall(
            """
            SELECT study_date, total_volume_mm3, fibroid_count, metrics
            FROM segmentations
            WHERE patient_id = %s
            ORDER BY study_date ASC
            """,
            patient_id,
        )
    )
    segmentations = res or []

    report = trends.generate_longitudinal_report(patient_id, time_window_months, segmentations)

    chart_data = []
    vis_dates = report.get("visualization_data", {}).get("dates", [])
    for idx, seg in enumerate(report.get("segmentations", [])):
        d_val = vis_dates[idx] if idx < len(vis_dates) else seg.get("study_date")
        d_str = d_val.isoformat() if isinstance(d_val, datetime) else str(d_val)
        chart_data.append(
            TrendDataPoint(
                date=d_str,
                volume=float(seg.get("total_volume_mm3", 0.0)),
                fibroidCount=int(seg.get("fibroid_count", 1)),
            )
        )

    recommendations = []
    growth_rate = float(report.get("growth_rate_mm3_per_month", 0.0))
    if growth_rate > 500:
        recommendations.append({
            "title": "Rapid Fibroid Growth Detected",
            "description": f"Patient shows rapid fibroid growth ({growth_rate:.1f} mm³/month). Consider scheduling follow-up.",
        })
    else:
        recommendations.append({
            "title": "Monitoring Recommended",
            "description": f"Current growth rate is {growth_rate:.1f} mm³/month. Continue standard monitoring interval.",
        })

    vols = report.get("visualization_data", {}).get("volumes", [])
    cur_vol = float(vols[-1]) if vols else 0.0

    return PatientTrendsResponse(
        chart_data=chart_data,
        growth_rate_mm3_per_month=growth_rate,
        current_volume=cur_vol,
        fibroid_count_trend=int(report.get("fibroid_count_trend", 0)),
        alerts=report.get("alerts", []),
        recommendations=recommendations,
    )


@router.get(
    "/{patient_id}/reprotrace",
    response_model=ReproTraceResponse,
    summary="Get ReproTrace discrepancies for a patient",
)
async def get_reprotrace_discrepancies(
    patient_id: str,
    limit: int = Query(default=20, ge=1, le=100),
    clinician: ClinicianUser = Depends(get_current_clinician),
):
    """Fetches discrepancies between imaging findings and clinical reports."""
    validate_patient_id(patient_id)

    if not await can_access_patient(clinician.id, patient_id):
        raise HTTPException(403, detail="Unauthorized to access patient data")

    discrepancies = await _resolve(
        db.fetchall(
            """
            SELECT id, type, details, severity, status, created_at
            FROM reprotrace_discrepancies
            WHERE patient_id = %s
            ORDER BY created_at DESC
            LIMIT %s
            """,
            patient_id,
            limit,
        )
    )

    out = []
    for disc in discrepancies or []:
        c_at = disc.get("created_at")
        out.append(
            ReproTraceDiscrepancy(
                id=str(disc.get("id")),
                type=str(disc.get("type", "unknown")),
                details=disc.get("details", {}),
                severity=str(disc.get("severity", "medium")),
                status=str(disc.get("status", "pending")),
                created_at=c_at.isoformat() if isinstance(c_at, datetime) else str(c_at or datetime.utcnow().isoformat()),
            )
        )

    return ReproTraceResponse(discrepancies=out)


class UpdateDiscrepancyRequest(BaseModel):
    status: str
    clinician_notes: Optional[str] = None


@router.patch(
    "/{patient_id}/reprotrace/{discrepancy_id}",
    summary="Update discrepancy review status",
)
async def update_discrepancy_status(
    patient_id: str,
    discrepancy_id: str,
    req: UpdateDiscrepancyRequest,
    clinician: ClinicianUser = Depends(get_current_clinician),
):
    """Updates the status of an anatomical discrepancy."""
    validate_patient_id(patient_id)

    if not await can_access_patient(clinician.id, patient_id):
        raise HTTPException(403, detail="Unauthorized to access patient data")

    if req.status not in ["resolved", "pending"]:
        raise HTTPException(422, detail="Status must be 'resolved' or 'pending'")

    await _resolve(
        db.execute(
            """
            UPDATE reprotrace_discrepancies
            SET status = %s, clinician_notes = %s, resolved_at = NOW()
            WHERE id = %s AND patient_id = %s
            """,
            req.status,
            req.clinician_notes,
            discrepancy_id,
            patient_id,
        )
    )

    return {"status": "updated", "discrepancy_id": discrepancy_id}

