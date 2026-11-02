"""Supabase Storage client for the Python FastAPI imaging-service.

Allows `imaging-service` to download DICOM series/NIfTI volumes directly from private
Supabase Storage buckets (`reprocare-imaging`) and upload derived segmentation masks
or meshes to `reprocare-derived` using server-side `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`.

Why this matters for Vercel & Cloud Deployment:
- Standard Vercel serverless request payloads are capped at 4.5 MB.
- By fetching DICOM series or NIfTI volumes directly from `reprocare-imaging` via
  object references (with SHA-256 verification), `imaging-service` can inspect and
  segment full multi-slice 3D MRI studies without routing large binary payloads
  through frontend/serverless request bodies.
"""
from __future__ import annotations

import hashlib
import os
import re
from typing import Callable
from urllib.parse import quote

import httpx

ALLOWED_BUCKETS = {"reprocare-imaging", "reprocare-reports", "reprocare-derived"}
MAX_STORAGE_OBJECT_BYTES = 512 * 1024 * 1024  # 512 MB

_PLACEHOLDER_RE = re.compile(r"\[YOUR-[^\]]+\]|<YOUR-[^>]+>|YOUR_SERVICE_ROLE_KEY", re.IGNORECASE)


def redact_secrets(text: str) -> str:
    if not text:
        return ""
    out = re.sub(r"Bearer\s+[A-Za-z0-9._-]+", "Bearer [REDACTED]", str(text), flags=re.IGNORECASE)
    out = re.sub(r"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}", "[REDACTED_JWT]", out)
    return out


def supabase_storage_status(env: dict[str, str] | None = None) -> dict[str, object]:
    e = env if env is not None else os.environ
    url = (e.get("SUPABASE_URL") or "").strip().rstrip("/")
    key = (e.get("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    if not url or not key:
        return {
            "configured": False,
            "supabase_url": None,
            "project_ref": None,
            "buckets": sorted(ALLOWED_BUCKETS),
            "reason": "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set.",
        }
    if _PLACEHOLDER_RE.search(url) or _PLACEHOLDER_RE.search(key):
        return {
            "configured": False,
            "supabase_url": None,
            "project_ref": None,
            "buckets": sorted(ALLOWED_BUCKETS),
            "reason": "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY contains an unreplaced placeholder.",
        }
    m = re.match(r"^https?://([a-z0-9-]+)\.supabase\.co$", url, re.IGNORECASE)
    project_ref = m.group(1) if m else e.get("SUPABASE_PROJECT_REF")
    return {
        "configured": True,
        "supabase_url": url,
        "project_ref": project_ref,
        "buckets": sorted(ALLOWED_BUCKETS),
        "reason": "Connected to private Supabase Storage buckets.",
    }


def probe_supabase_connectivity(
    env: dict[str, str] | None = None,
    client: SupabaseStorageClient | None = None,
    timeout_sec: float = 5.0,
) -> dict[str, object]:
    """Inspects Supabase configuration and tests live REST connectivity."""
    stat = supabase_storage_status(env)
    if not stat.get("configured"):
        return {
            "status": "not_configured",
            "configured": False,
            "reachable": False,
            "supabase_url": None,
            "project_ref": None,
            "buckets_found": [],
            "reason": str(stat.get("reason", "Supabase Storage credentials not configured.")),
        }

    if client is not None:
        c = client
    else:
        e = env if env is not None else os.environ
        try:
            c = SupabaseStorageClient(
                supabase_url=e.get("SUPABASE_URL"),
                service_role_key=e.get("SUPABASE_SERVICE_ROLE_KEY"),
            )
        except Exception as err:
            return {
                "status": "unavailable",
                "configured": True,
                "reachable": False,
                "supabase_url": stat.get("supabase_url"),
                "project_ref": stat.get("project_ref"),
                "buckets_found": [],
                "reason": redact_secrets(str(err)),
            }

    probe = c.probe_connectivity(timeout_sec=timeout_sec)
    return {
        "status": probe["status"],
        "configured": True,
        "reachable": probe["reachable"],
        "http_status": probe.get("http_status"),
        "supabase_url": stat.get("supabase_url"),
        "project_ref": stat.get("project_ref"),
        "buckets_found": probe.get("buckets_found", []),
        "reason": probe["reason"],
    }


def _validate_bucket_and_path(bucket: str, object_path: str) -> tuple[str, str]:
    clean_bucket = (bucket or "").strip()
    if clean_bucket not in ALLOWED_BUCKETS:
        raise ValueError(f"Disallowed or unknown storage bucket '{clean_bucket}'.")
    clean_path = (object_path or "").strip().lstrip("/")
    if not clean_path or ".." in clean_path or "\\" in clean_path or "\0" in clean_path:
        raise ValueError("Invalid or manipulated storage object_path.")
    encoded_path = "/".join(quote(seg, safe="") for seg in clean_path.split("/"))
    return clean_bucket, encoded_path


class SupabaseStorageClient:
    def __init__(
        self,
        supabase_url: str | None = None,
        service_role_key: str | None = None,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self.supabase_url = (supabase_url or os.environ.get("SUPABASE_URL") or "").strip().rstrip("/")
        self.service_role_key = (
            service_role_key or os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or ""
        ).strip()
        self.transport = transport

        if not self.supabase_url or not self.service_role_key:
            raise RuntimeError(
                "Supabase Storage is not configured: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required."
            )
        if _PLACEHOLDER_RE.search(self.supabase_url) or _PLACEHOLDER_RE.search(self.service_role_key):
            raise RuntimeError(
                "Supabase Storage configuration contains an unreplaced credential placeholder."
            )

    def probe_connectivity(self, timeout_sec: float = 5.0) -> dict[str, object]:
        """Probes Supabase Storage connectivity by querying bucket metadata."""
        url = f"{self.supabase_url}/storage/v1/bucket"
        try:
            with httpx.Client(transport=self.transport, timeout=timeout_sec) as client:
                res = client.get(url, headers=self._headers())
            if res.status_code == 200:
                raw_buckets = res.json()
                found = [
                    b.get("name") or b.get("id")
                    for b in raw_buckets
                    if isinstance(b, dict) and (b.get("name") or b.get("id"))
                ]
                return {
                    "status": "available",
                    "reachable": True,
                    "http_status": 200,
                    "buckets_found": sorted(found),
                    "reason": "Supabase Storage REST API reachable and verified.",
                }
            return {
                "status": "degraded",
                "reachable": False,
                "http_status": res.status_code,
                "buckets_found": [],
                "reason": f"Supabase Storage returned HTTP {res.status_code}.",
            }
        except Exception as e:
            return {
                "status": "unavailable",
                "reachable": False,
                "http_status": None,
                "buckets_found": [],
                "reason": redact_secrets(str(e)),
            }

    def _headers(self, extra: dict[str, str] | None = None) -> dict[str, str]:
        h = {
            "Authorization": f"Bearer {self.service_role_key}",
            "apikey": self.service_role_key,
        }
        if extra:
            h.update(extra)
        return h

    def download_object(
        self,
        bucket: str,
        object_path: str,
        expected_sha256: str | None = None,
    ) -> bytes:
        clean_bucket, encoded_path = _validate_bucket_and_path(bucket, object_path)
        url = f"{self.supabase_url}/storage/v1/object/{clean_bucket}/{encoded_path}"
        with httpx.Client(transport=self.transport, timeout=60.0) as client:
            res = client.get(url, headers=self._headers())
        if res.status_code in (400, 404):
            raise FileNotFoundError(
                f"Object '{object_path}' not found in private bucket '{clean_bucket}'."
            )
        if res.status_code >= 400:
            raise RuntimeError(
                f"Supabase Storage download failed (HTTP {res.status_code}): {redact_secrets(res.text[:200])}"
            )
        data = res.content
        if len(data) > MAX_STORAGE_OBJECT_BYTES:
            raise ValueError(
                f"Downloaded object exceeds maximum limit ({MAX_STORAGE_OBJECT_BYTES} bytes)."
            )
        if expected_sha256:
            actual_sha = hashlib.sha256(data).hexdigest()
            if actual_sha.lower() != expected_sha256.strip().lower():
                raise ValueError(
                    f"SHA-256 integrity mismatch for '{object_path}': expected {expected_sha256[:12]}…, got {actual_sha[:12]}…."
                )
        return data

    def upload_object(
        self,
        bucket: str,
        object_path: str,
        data: bytes,
        mime_type: str = "application/octet-stream",
        upsert: bool = False,
    ) -> dict[str, str]:
        clean_bucket, encoded_path = _validate_bucket_and_path(bucket, object_path)
        url = f"{self.supabase_url}/storage/v1/object/{clean_bucket}/{encoded_path}"
        headers = self._headers(
            {
                "Content-Type": mime_type,
                "x-upsert": "true" if upsert else "false",
                "Cache-Control": "private, no-store",
            }
        )
        with httpx.Client(transport=self.transport, timeout=60.0) as client:
            res = client.post(url, headers=headers, content=data)
        if res.status_code >= 400:
            raise RuntimeError(
                f"Supabase Storage upload failed (HTTP {res.status_code}): {redact_secrets(res.text[:200])}"
            )
        sha256 = hashlib.sha256(data).hexdigest()
        return {
            "bucket": clean_bucket,
            "object_path": object_path.lstrip("/"),
            "sha256": sha256,
            "bytes": str(len(data)),
        }
