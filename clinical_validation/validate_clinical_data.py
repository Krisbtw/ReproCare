"""Clinical validation script for testing real-world DICOMs and reports against ReproCare.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

# Configuration
API_BASE = os.environ.get("REPROCARE_API_BASE", "http://localhost:8080")
IMAGING_BASE = os.environ.get("ANATOMYBRIDGE_SERVICE_URL", "http://localhost:8100")
AUTH_TOKEN = os.environ.get("ANATOMYBRIDGE_SERVICE_API_KEY", "")
TEST_DIR = Path("clinical_validation/dataset")


def validate_imaging_service_health() -> bool:
    """Verifies that the imaging service is reachable and healthy."""
    try:
        import urllib.request
        import json

        req = urllib.request.Request(f"{IMAGING_BASE}/health")
        if AUTH_TOKEN:
            req.add_header("Authorization", f"Bearer {AUTH_TOKEN}")
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode())
            print(f"✔ Imaging service healthy: {data.get('service')} (models connected: {data.get('any_model_connected')})")
            return True
    except Exception as e:
        print(f"⚠ Imaging service check failed: {e}")
        return False


def main():
    print("=== ReproCare Clinical Validation Workflow ===")
    health_ok = validate_imaging_service_health()

    if not TEST_DIR.exists():
        print(f"Note: Dataset directory {TEST_DIR} does not exist yet. Create it and place pilot DICOM/reports there.")
        return

    dicoms = list(TEST_DIR.glob("*.dcm"))
    print(f"Found {len(dicoms)} DICOM file(s) in {TEST_DIR}")


if __name__ == "__main__":
    main()

