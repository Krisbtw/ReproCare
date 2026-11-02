import json

from fastapi.testclient import TestClient

from app.main import app
from tests.conftest import make_series

client = TestClient(app)


def files(blobs):
    return [("files", (f"s{i}.dcm", b, "application/dicom")) for i, b in enumerate(blobs)]


def test_health_reports_no_model_connected(monkeypatch):
    for k in ("ANATOMYBRIDGE_NNUNET_RESULTS", "ANATOMYBRIDGE_NNUNET_DATASET", "ANATOMYBRIDGE_NNUNET_LABELS"):
        monkeypatch.delenv(k, raising=False)
    r = client.get("/health")
    assert r.status_code == 200 and r.json()["any_model_connected"] is False


def test_models_list_says_not_connected_with_a_reason(monkeypatch):
    monkeypatch.delenv("ANATOMYBRIDGE_NNUNET_RESULTS", raising=False)
    monkeypatch.delenv("ANATOMYBRIDGE_UMD_WEIGHTS", raising=False)
    models_list = client.get("/models").json()
    assert len(models_list) >= 2
    model_ids = [m["id"] for m in models_list]
    assert "nnunet_umd" in model_ids
    assert "umd_monai_fibroid" in model_ids

    for m in models_list:
        assert m["connected"] is False
        assert m["reason"]
        assert m["is_learned_model"] is True


def test_umd_monai_segment_refuses_with_503(monkeypatch):
    monkeypatch.delenv("ANATOMYBRIDGE_UMD_WEIGHTS", raising=False)
    r = client.post("/segment/umd_monai_fibroid", files=files(make_series(n=4)))
    assert r.status_code == 503
    body = r.json()["detail"]
    assert body["error"] == "model_not_connected"
    assert "ANATOMYBRIDGE_UMD_WEIGHTS" in body["reason"]


def test_segment_refuses_with_503_and_returns_no_mask(monkeypatch):
    monkeypatch.delenv("ANATOMYBRIDGE_NNUNET_RESULTS", raising=False)
    r = client.post("/segment/nnunet_umd", files=files(make_series(n=4)))
    assert r.status_code == 503
    body = r.json()["detail"]
    assert body["error"] == "model_not_connected"
    assert "mask" not in json.dumps(body).lower().replace("model_not_connected", "")


def test_label_map_is_never_assumed(monkeypatch, tmp_path):
    monkeypatch.setenv("ANATOMYBRIDGE_NNUNET_RESULTS", str(tmp_path))
    monkeypatch.setenv("ANATOMYBRIDGE_NNUNET_DATASET", "501")
    monkeypatch.delenv("ANATOMYBRIDGE_NNUNET_LABELS", raising=False)
    from app import models
    reason = models.ADAPTERS["nnunet_umd"].status().reason
    assert not models.ADAPTERS["nnunet_umd"].status().connected and reason


def test_unknown_model_404():
    assert client.post("/segment/nope", files=files(make_series(n=3))).status_code == 404


def test_inspect_endpoint_clean_and_no_patient_data():
    r = client.post("/series/inspect", files=files(make_series()))
    assert r.status_code == 200
    j = r.json()
    assert j["volume_ready"] is True and j["slice_count"] == 12
    assert "SECRET-ID-7" not in r.text and "Doe" not in r.text


def test_inspect_endpoint_flags_gap():
    j = client.post("/series/inspect", files=files(make_series(drop=(5,)))).json()
    assert j["volume_ready"] is False and any(p["code"] == "slice_gap" for p in j["problems"])


def test_score_endpoint_and_validation():
    m = [[[1, 1], [1, 0]], [[0, 0], [0, 0]]]
    r = client.post("/metrics/score", json={"spacing_zyx_mm": [1, 1, 1], "prediction": m, "reference": m})
    assert r.status_code == 200 and r.json()["dice"] == 1.0
    bad = client.post("/metrics/score", json={"spacing_zyx_mm": [1, 1, 1], "prediction": m, "reference": [[[1]]]})
    assert bad.status_code == 422


def test_inspect_without_files_is_rejected():
    assert client.post("/series/inspect").status_code in (400, 422)


def test_openapi_lists_the_routes():
    paths = client.get("/openapi.json").json()["paths"]
    for p in ("/health", "/models", "/series/inspect", "/metrics/score", "/segment/{model_id}"):
        assert p in paths


def test_vercel_rewrite_prefix_routes_match_identically():
    r_health = client.get("/api/imaging-service/health")
    assert r_health.status_code == 200
    assert r_health.json()["service"] == "anatomybridge-imaging"

    r_models = client.get("/api/imaging-service/models")
    assert r_models.status_code == 200
    assert isinstance(r_models.json(), list)
    assert any(m["id"] == "umd_monai_fibroid" for m in r_models.json())

    r_inspect = client.post("/api/imaging-service/series/inspect", files=files(make_series(n=4)))
    assert r_inspect.status_code == 200
    assert r_inspect.json()["volume_ready"] is True


def test_health_live_endpoint():
    r = client.get("/health/live")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "alive"
    assert body["service"] == "anatomybridge-imaging"
    assert "timestamp" in body

    # Also test via rewrite prefix
    r_prefix = client.get("/api/imaging-service/health/live")
    assert r_prefix.status_code == 200
    assert r_prefix.json()["status"] == "alive"


def test_health_ready_endpoint():
    r = client.get("/health/ready")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] in ("ready", "degraded")
    deps = body["dependencies"]

    assert deps["python"]["status"] == "available"
    assert deps["fastapi"]["status"] == "available"
    assert deps["numpy_scipy"]["status"] == "available"
    assert deps["pydicom"]["status"] == "available"
    assert deps["simpleitk"]["status"] == "available"
    assert deps["pytorch"]["status"] in ("available", "not_applicable")
    assert deps["unet_model"]["status"] in ("available", "not_configured", "unavailable", "degraded")
    assert deps["model_checkpoint"]["status"] in ("available", "not_configured", "unavailable", "degraded")
    assert deps["supabase_storage"]["status"] in ("available", "not_configured", "degraded")
    assert deps["tesseract_ocr"]["status"] in ("available", "unavailable", "degraded")

    # Verify no secret values leaked in health payload
    body_str = json.dumps(body)
    assert "eyj" not in body_str.lower()
    assert "bearer" not in body_str.lower()
    assert "vjihfnk" not in body_str.lower()  # live db password substring


def test_health_ready_checkpoint_statuses(monkeypatch, tmp_path):
    # Case 1: Point to nonexistent checkpoint file -> degraded / unavailable
    missing_path = tmp_path / "nonexistent.npz"
    monkeypatch.setenv("ANATOMYBRIDGE_UMD_WEIGHTS", str(missing_path))
    r = client.get("/health/ready")
    assert r.status_code == 200
    deps = r.json()["dependencies"]
    assert deps["model_checkpoint"]["status"] == "unavailable"
    assert deps["unet_model"]["status"] == "unavailable"

    # Case 2: Empty / corrupted file -> degraded
    corrupt_path = tmp_path / "corrupt.npz"
    corrupt_path.write_bytes(b"NOT_A_VALID_NPZ")
    monkeypatch.setenv("ANATOMYBRIDGE_UMD_WEIGHTS", str(corrupt_path))
    r2 = client.get("/health/ready")
    assert r2.status_code == 200
    deps2 = r2.json()["dependencies"]
    assert deps2["model_checkpoint"]["status"] == "degraded"
    assert deps2["unet_model"]["status"] == "degraded"


def test_models_endpoint_reports_honest_backend_and_no_weights():
    r = client.get("/models")
    assert r.status_code == 200
    models_list = r.json()
    for m in models_list:
        assert "execution_backend" in m
        assert "trained_checkpoint_loaded" in m
        if not m["connected"]:
            assert m["trained_checkpoint_loaded"] is False


def test_service_auth_verification(monkeypatch):
    test_key = "test-service-key-xyz-789"
    monkeypatch.setenv("ANATOMYBRIDGE_SERVICE_API_KEY", test_key)
    monkeypatch.setenv("ANATOMYBRIDGE_DEV_NO_AUTH", "0")

    # 1. Missing auth headers -> 401
    r_no_auth = client.get("/models")
    assert r_no_auth.status_code == 401
    assert "Unauthorized" in r_no_auth.text

    # 2. Invalid auth header -> 401
    r_bad_auth = client.get("/models", headers={"Authorization": "Bearer wrong-key"})
    assert r_bad_auth.status_code == 401

    r_bad_apikey = client.get("/models", headers={"X-API-Key": "wrong-key"})
    assert r_bad_apikey.status_code == 401

    r_bad_svc = client.get("/models", headers={"X-Service-Key": "wrong-key"})
    assert r_bad_svc.status_code == 401

    # 3. Valid Bearer Token -> 200
    r_bearer = client.get("/models", headers={"Authorization": f"Bearer {test_key}"})
    assert r_bearer.status_code == 200

    # 4. Valid X-API-Key -> 200
    r_x_api = client.get("/models", headers={"X-API-Key": test_key})
    assert r_x_api.status_code == 200

    # 5. Valid X-Service-Key -> 200
    r_x_svc = client.get("/models", headers={"X-Service-Key": test_key})
    assert r_x_svc.status_code == 200

    # 6. Health endpoints remain public and accessible without auth
    assert client.get("/health").status_code == 200
    assert client.get("/health/live").status_code == 200
    assert client.get("/health/ready").status_code == 200
