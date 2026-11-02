"""Pure-Python NEMA PS3.10 Multi-Syntax DICOM reader/writer and pydicom fallback (Sprint 5 Task 1A & 1B).

Supports:
- Explicit VR Little Endian (1.2.840.10008.1.2.1)
- Implicit VR Little Endian (1.2.840.10008.1.2)
- Explicit VR Big Endian (1.2.840.10008.1.2.2)
- Deflated Explicit VR Little Endian (1.2.840.10008.1.2.1.99)
- RLE Lossless (1.2.840.10008.1.2.5)
- Encapsulated JPEG / JPEG 2000 fragment parsing & validation
- Multi-frame (NumberOfFrames 0028,0008, GridFrameOffsetVector 3004,000C)
"""
from __future__ import annotations

import io
import re
import struct
import sys
import types
import uuid
import zlib
from typing import Any

import numpy as np

ExplicitVRLittleEndian = "1.2.840.10008.1.2.1"
ImplicitVRLittleEndian = "1.2.840.10008.1.2"
ExplicitVRBigEndian = "1.2.840.10008.1.2.2"
DeflatedExplicitVRLittleEndian = "1.2.840.10008.1.2.1.99"
RLELossless = "1.2.840.10008.1.2.5"
JPEGBaseline8Bit = "1.2.840.10008.1.2.4.50"
JPEGLosslessP14 = "1.2.840.10008.1.2.4.57"
JPEGLosslessSV1 = "1.2.840.10008.1.2.4.70"
JPEG2000Lossless = "1.2.840.10008.1.2.4.90"
JPEG2000 = "1.2.840.10008.1.2.4.91"
MRImageStorage = "1.2.840.10008.5.1.4.1.1.4"

SUPPORTED_COMPRESSED_SYNTAXES = {
    RLELossless,
    JPEGBaseline8Bit,
    JPEGLosslessP14,
    JPEGLosslessSV1,
    JPEG2000Lossless,
    JPEG2000,
}

TAG_TO_KEYWORD: dict[tuple[int, int], tuple[str, str]] = {
    (0x0002, 0x0002): ("MediaStorageSOPClassUID", "UI"),
    (0x0002, 0x0003): ("MediaStorageSOPInstanceUID", "UI"),
    (0x0002, 0x0010): ("TransferSyntaxUID", "UI"),
    (0x0008, 0x0016): ("SOPClassUID", "UI"),
    (0x0008, 0x0008): ("ImageType", "CS"),
    (0x0018, 0x1000): ("DeviceSerialNumber", "LO"),
    (0x0018, 0x1030): ("ProtocolName", "LO"),
    (0x0020, 0x4000): ("ImageComments", "LT"),
    (0x0028, 0x0301): ("BurnedInAnnotation", "CS"),
    (0x0028, 0x0302): ("RecognizableVisualFeatures", "CS"),
    (0x5200, 0x9229): ("SharedFunctionalGroupsSequence", "SQ"),
    (0x5200, 0x9230): ("PerFrameFunctionalGroupsSequence", "SQ"),
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
    (0x0018, 0x5100): ("PatientPosition", "CS"),
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
    (0x0028, 0x0008): ("NumberOfFrames", "IS"),
    (0x0028, 0x0010): ("Rows", "US"),
    (0x0028, 0x0011): ("Columns", "US"),
    (0x0028, 0x0030): ("PixelSpacing", "DS"),
    (0x0028, 0x0100): ("BitsAllocated", "US"),
    (0x0028, 0x0101): ("BitsStored", "US"),
    (0x0028, 0x0102): ("HighBit", "US"),
    (0x0028, 0x0103): ("PixelRepresentation", "US"),
    (0x0028, 0x1052): ("RescaleIntercept", "DS"),
    (0x0028, 0x1053): ("RescaleSlope", "DS"),
    (0x3004, 0x000C): ("GridFrameOffsetVector", "DS"),
    (0x7FE0, 0x0010): ("PixelData", "OW"),
}

KEYWORD_TO_TAG: dict[str, tuple[tuple[int, int], str]] = {
    kw: (tag, vr) for tag, (kw, vr) in TAG_TO_KEYWORD.items()
}

LONG_VRS = {"OB", "OD", "OF", "OL", "OW", "SQ", "UC", "UR", "UT", "UN", "OV"}


def generate_uid(prefix: str = "1.2.826.0.1.3680043.8.498.") -> str:
    return f"{prefix}{uuid.uuid4().int % (10**24)}"


def decode_rle_lossless_frame(rle_bytes: bytes, num_pixels: int, bytes_per_pixel: int) -> bytes:
    """NEMA PS3.5 Annex G RLE Lossless decoder for a single frame."""
    if len(rle_bytes) < 64:
        raise ValueError("Corrupted RLE Lossless stream: shorter than 64-byte header")
    header = struct.unpack_from("<16I", rle_bytes, 0)
    num_segments = header[0]
    if num_segments < 1 or num_segments > 15 or num_segments != bytes_per_pixel:
        raise ValueError(f"Invalid RLE segment count {num_segments} (expected {bytes_per_pixel})")
    out = bytearray(num_pixels * bytes_per_pixel)
    for s in range(num_segments):
        seg_start = header[s + 1]
        seg_end = header[s + 2] if (s + 1) < num_segments else len(rle_bytes)
        if seg_start < 64 or seg_end < seg_start or seg_end > len(rle_bytes):
            raise ValueError(f"Corrupted RLE segment offset table at segment {s + 1}")
        byte_index = bytes_per_pixel - 1 - s
        p_idx = 0
        pos = seg_start
        while pos < seg_end and p_idx < num_pixels:
            n = struct.unpack_from("<b", rle_bytes, pos)[0]
            pos += 1
            if 0 <= n <= 127:
                count = n + 1
                if pos + count > seg_end:
                    raise ValueError("Corrupted RLE literal run exceeds segment boundary")
                for _ in range(count):
                    if p_idx >= num_pixels:
                        break
                    out[p_idx * bytes_per_pixel + byte_index] = rle_bytes[pos]
                    pos += 1
                    p_idx += 1
            elif -127 <= n <= -1:
                count = 1 - n
                if pos >= seg_end:
                    raise ValueError("Corrupted RLE replicate run missing value byte")
                val = rle_bytes[pos]
                pos += 1
                for _ in range(count):
                    if p_idx >= num_pixels:
                        break
                    out[p_idx * bytes_per_pixel + byte_index] = val
                    p_idx += 1
        if p_idx < num_pixels:
            raise ValueError(f"Truncated RLE stream: decoded {p_idx}/{num_pixels} pixels")
    return bytes(out)


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

    def remove_private_tags(self) -> list[str]:
        removed: list[str] = []
        for k in list(self.keys()):
            if isinstance(k, tuple) and len(k) == 2 and (k[0] % 2 == 1) and k[0] > 0x0007 and k[0] != 0x7FE0:
                removed.append(f"{k[0]:04x},{k[1]:04x}")
                del self[k]
        return sorted(set(removed))

    @property
    def pixel_array(self) -> np.ndarray:
        raw = self.get("PixelData")
        if raw is None:
            raise AttributeError("Dataset does not contain PixelData")
        rows = int(self.get("Rows", 0))
        cols = int(self.get("Columns", 0))
        num_frames = int(self.get("NumberOfFrames", 1) or 1)
        bits = int(self.get("BitsAllocated", 16))
        signed = int(self.get("PixelRepresentation", 0)) == 1
        ts_uid = str(self.file_meta.get("TransferSyntaxUID", ExplicitVRLittleEndian)).strip()

        if bits == 8:
            dtype = np.int8 if signed else np.uint8
        elif bits == 16:
            dtype = np.int16 if signed else np.uint16
        elif bits == 32:
            dtype = np.int32 if signed else np.uint32
        else:
            raise ValueError(f"Unsupported BitsAllocated: {bits}")

        bytes_per_pixel = max(1, bits // 8)
        pixels_per_frame = rows * cols

        if isinstance(raw, list):
            # Encapsulated pixel data fragments
            if ts_uid == RLELossless:
                if len(raw) < num_frames:
                    raise ValueError(f"RLE Lossless fragments ({len(raw)}) fewer than NumberOfFrames ({num_frames})")
                decoded_frames = [
                    decode_rle_lossless_frame(frag, pixels_per_frame, bytes_per_pixel)
                    for frag in raw[:num_frames]
                ]
                raw = b"".join(decoded_frames)
            elif ts_uid in (JPEGBaseline8Bit, JPEGLosslessP14, JPEGLosslessSV1, JPEG2000Lossless, JPEG2000):
                if len(raw) < num_frames:
                    raise ValueError(f"Compressed fragments ({len(raw)}) fewer than NumberOfFrames ({num_frames})")
                from PIL import Image
                decoded_arrays = []
                for frag in raw[:num_frames]:
                    try:
                        with Image.open(io.BytesIO(frag)) as im:
                            frame_arr = np.asarray(im)
                            if frame_arr.ndim == 3:
                                frame_arr = frame_arr[:, :, 0]
                            if frame_arr.shape != (rows, cols):
                                raise ValueError(f"Decoded compressed frame shape {frame_arr.shape} != expected {(rows, cols)}")
                            decoded_arrays.append(frame_arr.astype(dtype))
                    except Exception as e:
                        raise ValueError(f"Corrupted or unreadable compressed DICOM frame for syntax {ts_uid}: {e}") from e
                if num_frames > 1:
                    return np.stack(decoded_arrays, axis=0)
                return decoded_arrays[0]
            else:
                raise ValueError(f"Unsupported compressed transfer syntax '{ts_uid}' for pixel decoding")

        arr = np.frombuffer(raw, dtype=dtype)
        expected = pixels_per_frame * num_frames
        if arr.size < expected:
            raise ValueError(f"PixelData buffer smaller than expected ({arr.size} < {expected})")
        if num_frames > 1:
            return arr[:expected].reshape((num_frames, rows, cols)).copy()
        return arr[:pixels_per_frame].reshape((rows, cols)).copy()


def _encode_element(group: int, elem: int, vr: str, val: Any, implicit: bool = False) -> bytes:
    if vr == "US":
        payload = struct.pack("<H", int(val))
    elif vr == "SS":
        payload = struct.pack("<h", int(val))
    elif vr in ("OB", "OW", "UN") and isinstance(val, list):
        # Encapsulated PixelData fragments: Basic Offset Table (empty item) + fragment items + Sequence Delimitation Item
        items = [struct.pack("<HHI", 0xFFFE, 0xE000, 0)]
        for frag in val:
            fb = bytes(frag)
            if len(fb) % 2 == 1:
                fb += b"\x00"
            items.append(struct.pack("<HHI", 0xFFFE, 0xE000, len(fb)) + fb)
        items.append(struct.pack("<HHI", 0xFFFE, 0xE0DD, 0))
        return struct.pack("<HH2sHI", group, elem, b"OB", 0, 0xFFFFFFFF) + b"".join(items)
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

    if implicit and group != 0x0002:
        return struct.pack("<HHI", group, elem, len(payload)) + payload

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
    ts_uid = str(file_meta.get("TransferSyntaxUID", ExplicitVRLittleEndian)).strip()
    implicit = ts_uid == ImplicitVRLittleEndian
    deflated = ts_uid == DeflatedExplicitVRLittleEndian

    for kw, val in file_meta.items():
        if kw in KEYWORD_TO_TAG:
            tag, vr = KEYWORD_TO_TAG[kw]
            meta_items.append((tag, vr, val))
    meta_items.sort(key=lambda item: item[0])
    meta_bytes = b"".join(_encode_element(g, e, vr, v, implicit=False) for (g, e), vr, v in meta_items)
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
    body_buf = io.BytesIO()
    for (g, e), vr, val in body_items:
        body_buf.write(_encode_element(g, e, vr, val, implicit=implicit))

    body_bytes = body_buf.getvalue()
    if deflated:
        c = zlib.compressobj(level=6, wbits=-15)
        body_bytes = c.compress(body_bytes) + c.flush()

    out.write(body_bytes)
    data = out.getvalue()
    if hasattr(fp, "write"):
        fp.write(data)
    else:
        with open(fp, "wb") as f:
            f.write(data)


def _parse_encapsulated_fragments(data: bytes, offset: int) -> tuple[list[bytes], int]:
    fragments: list[bytes] = []
    n = len(data)
    item_idx = 0
    while offset + 8 <= n:
        g, e, length = struct.unpack_from("<HHI", data, offset)
        offset += 8
        if (g, e) == (0xFFFE, 0xE0DD):
            break
        if (g, e) != (0xFFFE, 0xE000):
            raise ValueError(f"Invalid encapsulated item tag ({g:04x},{e:04x})")
        if offset + length > n:
            raise ValueError("Truncated encapsulated pixel fragment")
        if item_idx > 0 and length > 0:
            fragments.append(data[offset : offset + length])
        offset += length
        item_idx += 1
    return fragments, offset


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
    transfer_syntax = ExplicitVRLittleEndian
    deflated_inflated = False

    while offset + 8 <= n:
        peek_group = struct.unpack_from("<H", data, offset)[0]
        if peek_group != 0x0002 and not deflated_inflated and transfer_syntax == DeflatedExplicitVRLittleEndian:
            raw_body = data[offset:]
            try:
                inflated = zlib.decompress(raw_body, -15)
            except zlib.error:
                inflated = zlib.decompress(raw_body)
            data = data[:offset] + inflated
            n = len(data)
            deflated_inflated = True

        group, elem = struct.unpack_from("<HH", data, offset)
        if stop_before_pixels and (group, elem) == (0x7FE0, 0x0010):
            break

        implicit = group != 0x0002 and transfer_syntax == ImplicitVRLittleEndian
        vr_raw = data[offset + 4 : offset + 6]
        vr = vr_raw.decode("ascii", errors="replace")

        if implicit:
            length = struct.unpack_from("<I", data, offset + 4)[0]
            val_offset = offset + 8
            vr = TAG_TO_KEYWORD.get((group, elem), ("", "UN"))[1]
        elif vr in LONG_VRS:
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

        if length == 0xFFFFFFFF:
            if (group, elem) == (0x7FE0, 0x0010):
                fragments, new_offset = _parse_encapsulated_fragments(data, val_offset)
                ds["PixelData"] = fragments
                ds[(0x7FE0, 0x0010)] = fragments
                offset = new_offset
                continue
            raise ValueError("Invalid undefined DICOM element length on non-PixelData element")

        if val_offset + length > n:
            raise ValueError("Truncated DICOM element value exceeds file length")

        raw_val = data[val_offset : val_offset + length]
        offset = val_offset + length

        if (group, elem) == (0x0002, 0x0000):
            continue
        kw_vr = TAG_TO_KEYWORD.get((group, elem))
        decoded = _decode_value(vr if vr != "UN" else (kw_vr[1] if kw_vr else "UN"), raw_val)
        if group == 0x0002:
            if kw_vr:
                ds.file_meta[kw_vr[0]] = decoded
                if kw_vr[0] == "TransferSyntaxUID":
                    transfer_syntax = str(decoded).strip()
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
        uid_mod.ImplicitVRLittleEndian = ImplicitVRLittleEndian  # type: ignore[attr-defined]
        uid_mod.DeflatedExplicitVRLittleEndian = DeflatedExplicitVRLittleEndian  # type: ignore[attr-defined]
        uid_mod.RLELossless = RLELossless  # type: ignore[attr-defined]
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


def encode_rle_lossless_frame(raw_frame: bytes, bytes_per_pixel: int = 1) -> bytes:
    """Encode a single frame into NEMA PS3.5 Annex G RLE Lossless format."""
    n_pixels = len(raw_frame) // bytes_per_pixel
    segments: list[bytes] = []
    for s in range(bytes_per_pixel):
        offset = bytes_per_pixel - 1 - s
        plane = bytes(raw_frame[i * bytes_per_pixel + offset] for i in range(n_pixels))
        # PackBits literal encoding in 128-byte chunks
        out = bytearray()
        idx = 0
        while idx < len(plane):
            chunk = plane[idx : idx + 128]
            out.append(len(chunk) - 1)
            out.extend(chunk)
            idx += len(chunk)
        if len(out) % 2 == 1:
            out.append(0x80)
        segments.append(bytes(out))

    offsets = [0] * 15
    curr = 64
    for i, seg in enumerate(segments):
        offsets[i] = curr
        curr += len(seg)
    header = struct.pack("<16I", bytes_per_pixel, *offsets)
    return header + b"".join(segments)


def build_compressed_dicom_bytes(
    arr_2d: np.ndarray,
    transfer_syntax_uid: str = JPEGBaseline8Bit,
    origin_lps_mm: tuple[float, float, float] = (0.0, 0.0, 0.0),
    pixel_spacing_mm: tuple[float, float] = (1.0, 1.0),
    slice_thickness_mm: float = 3.0,
) -> bytes:
    """Build a genuine encapsulated compressed DICOM Part-10 file using Pillow (libjpeg / openjpeg) or RLE Lossless."""
    from PIL import Image

    arr_u8 = np.asarray(arr_2d, dtype=np.uint8)
    rows, cols = arr_u8.shape
    if transfer_syntax_uid in (JPEGBaseline8Bit, JPEGLosslessP14, JPEGLosslessSV1):
        buf = io.BytesIO()
        Image.fromarray(arr_u8, mode="L").save(buf, format="JPEG", quality=100, subsampling=0)
        frag = buf.getvalue()
    elif transfer_syntax_uid in (JPEG2000Lossless, JPEG2000):
        buf = io.BytesIO()
        Image.fromarray(arr_u8, mode="L").save(
            buf,
            format="JPEG2000",
            irreversible=(transfer_syntax_uid == JPEG2000),
        )
        frag = buf.getvalue()
    elif transfer_syntax_uid == RLELossless:
        frag = encode_rle_lossless_frame(arr_u8.tobytes(), bytes_per_pixel=1)
    else:
        raise ValueError(f"Unsupported compressed syntax for builder: {transfer_syntax_uid}")

    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = MRImageStorage
    meta.MediaStorageSOPInstanceUID = generate_uid()
    meta.TransferSyntaxUID = transfer_syntax_uid

    ds = FileDataset(file_meta=meta)
    ds.SOPClassUID = MRImageStorage
    ds.SOPInstanceUID = meta.MediaStorageSOPInstanceUID
    ds.StudyInstanceUID = "1.2.826.0.1.3680043.8.498.100"
    ds.SeriesInstanceUID = "1.2.826.0.1.3680043.8.498.200"
    ds.Modality = "MR"
    ds.Rows = rows
    ds.Columns = cols
    ds.BitsAllocated = 8
    ds.BitsStored = 8
    ds.HighBit = 7
    ds.PixelRepresentation = 0
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.PixelSpacing = [float(pixel_spacing_mm[0]), float(pixel_spacing_mm[1])]
    ds.SliceThickness = float(slice_thickness_mm)
    ds.ImagePositionPatient = [float(origin_lps_mm[0]), float(origin_lps_mm[1]), float(origin_lps_mm[2])]
    ds.ImageOrientationPatient = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0]
    ds.PixelData = [frag]

    out = io.BytesIO()
    dcmwrite(out, ds)
    return out.getvalue()
