import hashlib
import httpx
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app import storage_client
from tests.conftest import make_series

client = TestClient(app)


def test_supabase_storage_status_validation():
    st_unset = storage_client.supabase_storage_status({})
    assert st_unset["configured"] is False

    st_placeholder = storage_client.supabase_storage_status(
        {
            "SUPABASE_URL": "https://mfbqdesghtvalkywzsdb.supabase.co",
            "SUPABASE_SERVICE_ROLE_KEY": "[YOUR-SUPABASE-SERVICE-ROLE-KEY]",
        }
    )
    assert st_placeholder["configured"] is False
    assert "placeholder" in str(st_placeholder["reason"]).lower()

    st_ok = storage_client.supabase_storage_status(
        {
            "SUPABASE_URL": "https://mfbqdesghtvalkywzsdb.supabase.co",
            "SUPABASE_SERVICE_ROLE_KEY": "sb_secret_valid_test_key_12345",
        }
    )
    assert st_ok["configured"] is True
    assert st_ok["project_ref"] == "mfbqdesghtvalkywzsdb"


def test_supabase_storage_client_download_and_upload_with_checksum():
    slices = make_series(n=4)
    store: dict[str, bytes] = {
        f"reprocare-imaging:pat_1/slice_{i}.dcm": b for i, b in enumerate(slices)
    }

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers.get("Authorization") == "Bearer sb_secret_test_key"
        assert request.headers.get("apikey") == "sb_secret_test_key"
        path = request.url.path
        prefix = "/storage/v1/object/"
        assert path.startswith(prefix)
        rest = path[len(prefix) :]
        bucket, obj_path = rest.split("/", 1)
        key = f"{bucket}:{obj_path}"
        if request.method == "GET":
            if key not in store:
                return httpx.Response(404, json={"error": "Not found"})
            return httpx.Response(200, content=store[key])
        if request.method == "POST":
            store[key] = request.content
            return httpx.Response(200, json={"Key": f"{bucket}/{obj_path}"})
        return httpx.Response(405)

    transport = httpx.MockTransport(handler)
    supa = storage_client.SupabaseStorageClient(
        supabase_url="https://mfbqdesghtvalkywzsdb.supabase.co",
        service_role_key="sb_secret_test_key",
        transport=transport,
    )

    sha0 = hashlib.sha256(slices[0]).hexdigest()
    downloaded = supa.download_object(
        "reprocare-imaging", "pat_1/slice_0.dcm", expected_sha256=sha0
    )
    assert downloaded == slices[0]

    with pytest.raises(ValueError, match="SHA-256 integrity mismatch"):
        supa.download_object(
            "reprocare-imaging",
            "pat_1/slice_0.dcm",
            expected_sha256="0" * 64,
        )

    with pytest.raises(ValueError, match="Disallowed or unknown storage bucket"):
        supa.download_object("public-bucket", "pat_1/slice_0.dcm")

    with pytest.raises(ValueError, match="Invalid or manipulated"):
        supa.download_object("reprocare-imaging", "../etc/passwd")

    uploaded = supa.upload_object(
        "reprocare-derived",
        "pat_1/mask_v1.bin",
        b"compressed_mask_bytes",
        mime_type="application/octet-stream",
        upsert=True,
    )
    assert uploaded["bucket"] == "reprocare-derived"
    assert store["reprocare-derived:pat_1/mask_v1.bin"] == b"compressed_mask_bytes"


def test_storage_inspect_endpoint_fetches_from_supabase_storage(monkeypatch):
    slices = make_series(n=6)
    slice_map = {f"pat_1/slice_{i}.dcm": b for i, b in enumerate(slices)}

    class FakeClient:
        def download_object(self, bucket: str, object_path: str, expected_sha256: str | None = None) -> bytes:
            assert bucket == "reprocare-imaging"
            blob = slice_map[object_path]
            if expected_sha256:
                assert hashlib.sha256(blob).hexdigest() == expected_sha256
            return blob

    monkeypatch.setattr(storage_client, "SupabaseStorageClient", FakeClient)

    refs = [
        {
            "bucket": "reprocare-imaging",
            "object_path": f"pat_1/slice_{i}.dcm",
            "sha256": hashlib.sha256(b).hexdigest(),
        }
        for i, b in enumerate(slices)
    ]
    res = client.post("/storage/inspect", json={"objects": refs})
    assert res.status_code == 200
    body = res.json()
    assert body["volume_ready"] is True
    assert body["slice_count"] == 6
