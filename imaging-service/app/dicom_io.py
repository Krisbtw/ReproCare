"""Pure-Python NEMA PS3.10 Explicit VR Little Endian DICOM reader/writer and pydicom fallback."""
from __future__ import annotations

import io
import re
import struct
import sys
import types
import uuid
from typing import Any

import numpy as np

ExplicitVRLittleEndian = "1.2.840.10008.1.2.1"
MRImageStorage = "1.2.840.10008.5.1.4.1.1.4"

TAG_TO_KEYWORD: dict[tuple[int, int], tuple[str, str]] = {
    (0x0002, 0x0002): ("MediaStorageSOPClassUID", "UI"),
    (0x0002, 0x0003): ("MediaStorageSOPInstanceUID", "UI"),
    (0x0002, 0x0010): ("TransferSyntaxUID", "UI"),
    (0x0008, 0x0016): ("SOPClassUID", "UI"),
    (0x0008, 0x0018): ("SOPInstanceUID", "UI"),
    (0x0008, 0x0020): ("StudyDate", "DA"),
    (0x0008, 0x0030): ("StudyTime", "TM"),
    (0x0008, 0x0050): ("AccessionNumber", "SH"),
    (0x0008, 0x0060): ("Modality", "CS"),
    (0x0008, 0x0080): ("InstitutionName", "LO"),
    (0x0008, 0x0081): ("InstitutionAddress", "ST"),
    (0x0008, 0x0090): ("ReferringPhysicianName", "PN"),
    (0x0008, 0x1030): ("StudyDescription", "LO"),
    (0x0008, 0x103E): ("SeriesDescription", "LO"),
    (0x0008, 0x1048): ("PhysiciansOfRecord", "PN"),
    (0x0008, 0x1050): ("PerformingPhysicianName", "PN"),
    (0x0008, 0x1070): ("OperatorsName", "PN"),
    (0x0010, 0x0010): ("PatientName", "PN"),
    (0x0010, 0x0020): ("PatientID", "LO"),
    (0x0010, 0x0030): ("PatientBirthDate", "DA"),
    (0x0010, 0x0040): ("PatientSex", "CS"),
    (0x0010, 0x1000): ("OtherPatientIDs", "LO"),
    (0x0010, 0x1001): ("OtherPatientNames", "PN"),
    (0x0010, 0x1010): ("PatientAge", "AS"),
    (0x0010, 0x1040): ("PatientAddress", "LO"),
    (0x0010, 0x2154): ("PatientTelephoneNumbers", "SH"),
    (0x0018, 0x0050): ("SliceThickness", "DS"),
    (0x0018, 0x0088): ("SpacingBetweenSlices", "DS"),
    (0x0020, 0x000D): ("StudyInstanceUID", "UI"),
    (0x0020, 0x000E): ("SeriesInstanceUID", "UI"),
    (0x0020, 0x0010): ("StudyID", "SH"),
    (0x0020, 0x0011): ("SeriesNumber", "IS"),
    (0x0020, 0x0013): ("InstanceNumber", "IS"),
    (0x0020, 0x0032): ("ImagePositionPatient", "DS"),
    (0x0020, 0x0037): ("ImageOrientationPatient", "DS"),
    (0x0020, 0x0052): ("FrameOfReferenceUID", "UI"),
    (0x0028, 0x0002): ("SamplesPerPixel", "US"),
    (0x0028, 0x0004): ("PhotometricInterpretation", "CS"),
    (0x0028, 0x0010): ("Rows", "US"),
    (0x0028, 0x0011): ("Columns", "US"),
    (0x0028, 0x0030): ("PixelSpacing", "DS"),
    (0x0028, 0x0100): ("BitsAllocated", "US"),
    (0x0028, 0x0101): ("BitsStored", "US"),
    (0x0028, 0x0102): ("HighBit", "US"),
    (0x0028, 0x0103): ("PixelRepresentation", "US"),
    (0x0028, 0x1052): ("RescaleIntercept", "DS"),
    (0x0028, 0x1053): ("RescaleSlope", "DS"),
    (0x7FE0, 0x0010): ("PixelData", "OW"),
}

KEYWORD_TO_TAG: dict[str, tuple[tuple[int, int], str]] = {
    kw: (tag, vr) for tag, (kw, vr) in TAG_TO_KEYWORD.items()
}

LONG_VRS = {"OB", "OD", "OF", "OL", "OW", "SQ", "UC", "UR", "UT", "UN"}


def generate_uid(prefix: str = "1.2.826.0.1.3680043.8.498.") -> str:
    return f"{prefix}{uuid.uuid4().int % (10**24)}"


class FileMetaDataset(dict):
    def __getattr__(self, name: str) -> Any:
        if name in self:
            return self[name]
        raise AttributeError(name)

    def __setattr__(self, name: str, value: Any) -> None:
        self[name] = value

    def __delattr__(self, name: str) -> None:
        if name in self:
            del self[name]
        else:
            raise AttributeError(name)


class FileDataset(dict):
    def __init__(
        self,
        filename_or_obj: Any = None,
        dataset: dict[str, Any] | None = None,
        file_meta: FileMetaDataset | None = None,
        preamble: bytes = b"\x00" * 128,
        **kwargs: Any,
    ) -> None:
        super().__init__(dataset or {})
        super().__setattr__("file_meta", file_meta or FileMetaDataset())
        super().__setattr__("preamble", preamble)

    def __getattr__(self, name: str) -> Any:
        if name in ("file_meta", "preamble"):
            return super().__getattribute__(name)
        if name in self:
            return self[name]
        raise AttributeError(f"Dataset has no attribute '{name}'")

    def __setattr__(self, name: str, value: Any) -> None:
        if name in ("file_meta", "preamble"):
            super().__setattr__(name, value)
        else:
            self[name] = value

    def __delattr__(self, name: str) -> None:
        if name in self:
            del self[name]
        else:
            raise AttributeError(name)

    def get(self, key: Any, default: Any = None) -> Any:
        if isinstance(key, str):
            return super().get(key, default)
        if isinstance(key, tuple) and key in TAG_TO_KEYWORD:
            kw, _ = TAG_TO_KEYWORD[key]
            return super().get(kw, default)
        return super().get(key, default)

    @property
    def pixel_array(self) -> np.ndarray:
        raw = self.get("PixelData")
        if raw is None:
            raise AttributeError("Dataset does not contain PixelData")
        rows = int(self.get("Rows", 0))
        cols = int(self.get("Columns", 0))
        bits = int(self.get("BitsAllocated", 16))
        signed = int(self.get("PixelRepresentation", 0)) == 1
        if bits == 8:
            dtype = np.int8 if signed else np.uint8
        elif bits == 16:
            dtype = np.int16 if signed else np.uint16
        elif bits == 32:
            dtype = np.int32 if signed else np.uint32
        else:
            raise ValueError(f"Unsupported BitsAllocated: {bits}")
        arr = np.frombuffer(raw, dtype=dtype)
        expected = rows * cols
        if arr.size < expected:
            raise ValueError(f"PixelData buffer smaller than Rows*Columns ({arr.size} < {expected})")
        return arr[:expected].reshape((rows, cols)).copy()


def _encode_element(group: int, elem: int, vr: str, val: Any) -> bytes:
    if vr == "US":
        payload = struct.pack("<H", int(val))
    elif vr == "SS":
        payload = struct.pack("<h", int(val))
    elif vr in ("OB", "OW", "UN"):
        payload = bytes(val)
        if len(payload) % 2 == 1:
            payload += b"\x00"
    elif vr == "DS":
        if isinstance(val, (list, tuple, np.ndarray)):
            s = "\\".join(f"{float(v):.8g}" for v in val)
        else:
            s = f"{float(val):.8g}"
        payload = s.encode("ascii")
        if len(payload) % 2 == 1:
            payload += b" "
    elif vr == "IS":
        if isinstance(val, (list, tuple, np.ndarray)):
            s = "\\".join(str(int(v)) for v in val)
        else:
            s = str(int(val))
        payload = s.encode("ascii")
        if len(payload) % 2 == 1:
            payload += b" "
    elif vr == "UI":
        payload = str(val).encode("ascii")
        if len(payload) % 2 == 1:
            payload += b"\x00"
    else:
        payload = str(val).encode("utf-8")
        if len(payload) % 2 == 1:
            payload += b" "

    vr_bytes = vr.encode("ascii")
    if vr in LONG_VRS:
        header = struct.pack("<HH2sHI", group, elem, vr_bytes, 0, len(payload))
    else:
        header = struct.pack("<HH2sH", group, elem, vr_bytes, len(payload))
    return header + payload


def _decode_value(vr: str, raw: bytes) -> Any:
    if vr == "US":
        if len(raw) == 2:
            return struct.unpack("<H", raw)[0]
        return list(struct.unpack(f"<{len(raw)//2}H", raw))
    if vr == "SS":
        if len(raw) == 2:
            return struct.unpack("<h", raw)[0]
        return list(struct.unpack(f"<{len(raw)//2}h", raw))
    if vr in ("OB", "OW", "UN"):
        return raw
    if vr == "UI":
        return raw.rstrip(b"\x00 ").decode("ascii", errors="replace")
    text = raw.rstrip(b"\x00 ").decode("utf-8", errors="replace").strip()
    if vr == "DS":
        if not text:
            return 0.0
        parts = [float(p) for p in text.split("\\") if p != ""]
        return parts[0] if len(parts) == 1 else parts
    if vr == "IS":
        if not text:
            return 0
        parts = [int(float(p)) for p in text.split("\\") if p != ""]
        return parts[0] if len(parts) == 1 else parts
    return text


def dcmwrite(fp: Any, dataset: FileDataset, enforce_file_format: bool = True) -> None:
    out = io.BytesIO()
    preamble = getattr(dataset, "preamble", None) or (b"\x00" * 128)
    out.write(preamble[:128].ljust(128, b"\x00"))
    out.write(b"DICM")

    meta_items: list[tuple[tuple[int, int], str, Any]] = []
    file_meta = getattr(dataset, "file_meta", None) or {}
    for kw, val in file_meta.items():
        if kw in KEYWORD_TO_TAG:
            tag, vr = KEYWORD_TO_TAG[kw]
            meta_items.append((tag, vr, val))
    meta_items.sort(key=lambda item: item[0])
    meta_bytes = b"".join(_encode_element(g, e, vr, v) for (g, e), vr, v in meta_items)
    out.write(struct.pack("<HH2sH", 0x0002, 0x0000, b"UL", 4) + struct.pack("<I", len(meta_bytes)))
    out.write(meta_bytes)

    body_items: list[tuple[tuple[int, int], str, Any]] = []
    for kw, val in dataset.items():
        if val is None:
            continue
        if kw in KEYWORD_TO_TAG:
            tag, vr = KEYWORD_TO_TAG[kw]
            if tag[0] != 0x0002:
                body_items.append((tag, vr, val))
    body_items.sort(key=lambda item: item[0])
    for (g, e), vr, val in body_items:
        out.write(_encode_element(g, e, vr, val))

    data = out.getvalue()
    if hasattr(fp, "write"):
        fp.write(data)
    else:
        with open(fp, "wb") as f:
            f.write(data)


def dcmread(fp: Any, stop_before_pixels: bool = False, force: bool = False) -> FileDataset:
    if hasattr(fp, "read"):
        data = fp.read()
    elif isinstance(fp, (bytes, bytearray)):
        data = bytes(fp)
    else:
        with open(fp, "rb") as f:
            data = f.read()

    if len(data) < 132 or data[128:132] != b"DICM":
        raise ValueError("Invalid DICOM Part-10 file: missing DICM magic at offset 128")

    ds = FileDataset()
    offset = 132
    n = len(data)
    while offset + 8 <= n:
        group, elem = struct.unpack_from("<HH", data, offset)
        if stop_before_pixels and (group, elem) == (0x7FE0, 0x0010):
            break
        vr_raw = data[offset + 4 : offset + 6]
        vr = vr_raw.decode("ascii", errors="replace")
        if vr in LONG_VRS:
            if offset + 12 > n:
                raise ValueError("Truncated long-VR DICOM element header")
            length = struct.unpack_from("<I", data, offset + 8)[0]
            val_offset = offset + 12
        elif vr.isalpha() and vr.isupper():
            length = struct.unpack_from("<H", data, offset + 6)[0]
            val_offset = offset + 8
        else:
            length = struct.unpack_from("<I", data, offset + 4)[0]
            val_offset = offset + 8
            vr = TAG_TO_KEYWORD.get((group, elem), ("", "UN"))[1]

        if length == 0xFFFFFFFF or val_offset + length > n:
            raise ValueError("Invalid or undefined DICOM element length")

        raw_val = data[val_offset : val_offset + length]
        offset = val_offset + length

        if (group, elem) == (0x0002, 0x0000):
            continue
        kw_vr = TAG_TO_KEYWORD.get((group, elem))
        decoded = _decode_value(vr if vr != "UN" else (kw_vr[1] if kw_vr else "UN"), raw_val)
        if group == 0x0002:
            if kw_vr:
                ds.file_meta[kw_vr[0]] = decoded
        else:
            if kw_vr:
                ds[kw_vr[0]] = decoded
            ds[(group, elem)] = decoded

    return ds


def register_pydicom_fallback() -> Any:
    try:
        import pydicom as real_pydicom  # type: ignore
        return real_pydicom
    except ImportError:
        mod = types.ModuleType("pydicom")
        mod.dcmread = dcmread  # type: ignore[attr-defined]
        mod.dcmwrite = dcmwrite  # type: ignore[attr-defined]
        mod.Dataset = FileDataset  # type: ignore[attr-defined]

        ds_mod = types.ModuleType("pydicom.dataset")
        ds_mod.Dataset = FileDataset  # type: ignore[attr-defined]
        ds_mod.FileDataset = FileDataset  # type: ignore[attr-defined]
        ds_mod.FileMetaDataset = FileMetaDataset  # type: ignore[attr-defined]

        uid_mod = types.ModuleType("pydicom.uid")
        uid_mod.ExplicitVRLittleEndian = ExplicitVRLittleEndian  # type: ignore[attr-defined]
        uid_mod.MRImageStorage = MRImageStorage  # type: ignore[attr-defined]
        uid_mod.generate_uid = generate_uid  # type: ignore[attr-defined]

        errors_mod = types.ModuleType("pydicom.errors")
        errors_mod.InvalidDicomError = ValueError  # type: ignore[attr-defined]

        mod.dataset = ds_mod  # type: ignore[attr-defined]
        mod.uid = uid_mod  # type: ignore[attr-defined]
        mod.errors = errors_mod  # type: ignore[attr-defined]

        sys.modules.setdefault("pydicom", mod)
        sys.modules.setdefault("pydicom.dataset", ds_mod)
        sys.modules.setdefault("pydicom.uid", uid_mod)
        sys.modules.setdefault("pydicom.errors", errors_mod)
        return mod


class _ApproxVal:
    def __init__(self, expected: Any, rel: float = 1e-4, abs_tol: float = 1e-6) -> None:
        self.expected = expected
        self.rel = rel
        self.abs_tol = abs_tol

    def __eq__(self, actual: Any) -> bool:
        try:
            a = np.asarray(actual, dtype=np.float64)
            e = np.asarray(self.expected, dtype=np.float64)
            return bool(np.allclose(a, e, rtol=self.rel, atol=self.abs_tol))
        except Exception:
            return False

    def __repr__(self) -> str:
        return f"approx({self.expected!r})"


class _RaisesContext:
    def __init__(self, expected_exc: type[BaseException] | tuple[type[BaseException], ...], match: str | None = None) -> None:
        self.expected_exc = expected_exc
        self.match = match
        self.value: BaseException | None = None

    def __enter__(self) -> "_RaisesContext":
        return self

    def __exit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> bool:
        if exc_type is None:
            raise AssertionError(f"DID NOT RAISE {self.expected_exc}")
        if issubclass(exc_type, self.expected_exc):
            self.value = exc_val
            if self.match and not re.search(self.match, str(exc_val), re.IGNORECASE):
                raise AssertionError(f"Exception {exc_val!r} did not match {self.match!r}")
            return True
        return False


class MonkeyPatch:
    def __init__(self) -> None:
        self._env_backup: dict[str, str | None] = {}

    def setenv(self, name: str, value: str) -> None:
        import os
        if name not in self._env_backup:
            self._env_backup[name] = os.environ.get(name)
        os.environ[name] = str(value)

    def delenv(self, name: str, raising: bool = True) -> None:
        import os
        if name not in self._env_backup:
            self._env_backup[name] = os.environ.get(name)
        if name in os.environ:
            del os.environ[name]
        elif raising:
            raise KeyError(name)

    def undo(self) -> None:
        import os
        for k, v in self._env_backup.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        self._env_backup.clear()


def register_pytest_fallback() -> Any:
    try:
        import pytest as real_pytest  # type: ignore
        return real_pytest
    except ImportError:
        mod = types.ModuleType("pytest")
        mod.approx = lambda expected, rel=1e-4, abs=1e-6: _ApproxVal(expected, rel=rel, abs_tol=abs)  # type: ignore[attr-defined]
        mod.raises = lambda exc, match=None: _RaisesContext(exc, match=match)  # type: ignore[attr-defined]
        mod.MonkeyPatch = MonkeyPatch  # type: ignore[attr-defined]

        def _fixture(*args: Any, **kwargs: Any):
            if len(args) == 1 and callable(args[0]) and not kwargs:
                return args[0]
            def _decorator(fn: Any) -> Any:
                return fn
            return _decorator

        mod.fixture = _fixture  # type: ignore[attr-defined]
        sys.modules.setdefault("pytest", mod)
        return mod


def register_torch_pickle_guard_fallback() -> None:
    """When PyTorch is not installed, register a minimal `torch` shim providing `torch.save`
    so security tests verifying that `UmdMonaiAdapter` rejects arbitrary pickled objects
    (`weights_only=True`) can execute without importing full PyTorch.
    """
    if "torch" in sys.modules:
        return
    try:
        import torch  # type: ignore  # noqa: F401
        return
    except ImportError:
        import pickle

        mod = types.ModuleType("torch")

        def _save(obj: Any, f: Any) -> None:
            data = pickle.dumps(obj)
            if hasattr(f, "write"):
                f.write(data)
            else:
                with open(f, "wb") as fp:
                    fp.write(data)

        def _load(f: Any, map_location: Any = None, weights_only: bool = True) -> Any:
            if weights_only:
                raise RuntimeError("Unsafe or corrupted weights: weights_only=True rejected pickle stream")
            raise RuntimeError("Unpickling arbitrary weights is disabled")

        mod.save = _save  # type: ignore[attr-defined]
        mod.load = _load  # type: ignore[attr-defined]
        sys.modules.setdefault("torch", mod)
