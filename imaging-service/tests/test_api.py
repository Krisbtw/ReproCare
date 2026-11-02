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
