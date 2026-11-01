"""Authentication, authorization, and service key security tests."""
import os
import tempfile
from pathlib import Path
import numpy as np
import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.models import UmdMonaiAdapter, ModelNotConnected

client = TestClient(app)


def test_fake_patient_routes_are_strictly_404():
    """Confirms the fake Python trends router has been completely eliminated."""
    res = client.get("/api/patients/patient_123/trends")
    assert res.status_code == 404
    res = client.get("/api/patients/patient_123/reprotrace")
    assert res.status_code == 404


def test_trends_calculate_fails_closed_without_key(monkeypatch):
    """Endpoints require valid service key or dev opt-in."""
    monkeypatch.delenv("ANATOMYBRIDGE_SERVICE_API_KEY", raising=False)
    monkeypatch.delenv("ANATOMYBRIDGE_DEV_NO_AUTH", raising=False)
    
    res = client.post("/trends/calculate", json={"observations": []})
    assert res.status_code == 401
    assert "ANATOMYBRIDGE_SERVICE_API_KEY is not configured" in res.text


def test_trends_calculate_rejects_arbitrary_bearer(monkeypatch):
    """No arbitrary Bearer token acceptance."""
    monkeypatch.setenv("ANATOMYBRIDGE_SERVICE_API_KEY", "real-service-key")
    res = client.post(
        "/trends/calculate",
        json={"observations": []},
        headers={"Authorization": "Bearer fake_token"},
    )
    assert res.status_code == 401


def test_no_token_sniffing_for_admin_role(monkeypatch):
    """Tokens with 'admin' substring must not grant access."""
    monkeypatch.setenv("ANATOMYBRIDGE_SERVICE_API_KEY", "real-service-key")
    res = client.post(
        "/trends/calculate",
        json={"observations": []},
        headers={"Authorization": "Bearer admin_token_sniff"},
    )
    assert res.status_code == 401


def test_trends_calculate_accepts_valid_service_auth(monkeypatch):
    """Valid service key in Bearer or X-API-Key is accepted using constant-time check."""
    monkeypatch.setenv("ANATOMYBRIDGE_SERVICE_API_KEY", "prod-secret-key-12345")
    
    # Bearer header
    res1 = client.post(
        "/trends/calculate",
        json={"observations": [{"date": "2026-01-01", "volume_mm3": 1000.0}]},
        headers={"Authorization": "Bearer prod-secret-key-12345"},
    )
    assert res1.status_code == 200
    assert "growth_rate_mm3_per_month" in res1.json()

    # X-API-Key header
    res2 = client.post(
        "/trends/calculate",
        json={"observations": []},
        headers={"X-API-Key": "prod-secret-key-12345"},
    )
    assert res2.status_code == 200


def test_models_adapter_rejects_unsafe_pickle(monkeypatch):
    """Verifies that weights_only=True prevents arbitrary unpickling."""
    import torch

    class MaliciousPayload:
        def __reduce__(self):
            import os
            return (os.system, ('echo unsafe',))

    with tempfile.NamedTemporaryFile(suffix=".pt", delete=False) as f:
        temp_path = f.name
        # Save an arbitrary object that fails weights_only=True
        torch.save({"payload": MaliciousPayload()}, temp_path)

    try:
        adapter = UmdMonaiAdapter()
        monkeypatch.setenv("ANATOMYBRIDGE_UMD_WEIGHTS", temp_path)
        dummy_vol = np.zeros((16, 16, 16), dtype=np.float32)
        
        with pytest.raises(RuntimeError) as exc_info:
            adapter.run(dummy_vol, (1.0, 1.0, 1.0))
        assert "weights_only=True" in str(exc_info.value) or "Unsafe or corrupted weights" in str(exc_info.value)
    finally:
        if os.path.exists(temp_path):
            os.remove(temp_path)
