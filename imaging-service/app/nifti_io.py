"""Pure-Python NIfTI-1 (.nii / .nii.gz) reader/writer and SimpleITK fallback."""
from __future__ import annotations

import gzip
import struct
import sys
import types
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

DT_UINT8 = 2
DT_INT16 = 4
DT_INT32 = 8
DT_FLOAT32 = 16
DT_FLOAT64 = 64
DT_INT8 = 256
DT_UINT16 = 512
DT_UINT32 = 768

CODE_TO_DTYPE: dict[int, tuple[np.dtype, int]] = {
    DT_UINT8: (np.dtype("<u1"), 8),
    DT_INT8: (np.dtype("<i1"), 8),
    DT_INT16: (np.dtype("<i2"), 16),
    DT_UINT16: (np.dtype("<u2"), 16),
    DT_INT32: (np.dtype("<i4"), 32),
    DT_UINT32: (np.dtype("<u4"), 32),
    DT_FLOAT32: (np.dtype("<f4"), 32),
    DT_FLOAT64: (np.dtype("<f8"), 64),
}

DTYPE_TO_CODE: dict[str, tuple[int, int]] = {
    "uint8": (DT_UINT8, 8),
    "bool": (DT_UINT8, 8),
    "int8": (DT_INT8, 8),
    "int16": (DT_INT16, 16),
    "uint16": (DT_UINT16, 16),
    "int32": (DT_INT32, 32),
    "int64": (DT_INT32, 32),
    "uint32": (DT_UINT32, 32),
    "float32": (DT_FLOAT32, 32),
    "float64": (DT_FLOAT64, 64),
}


@dataclass
class SimpleImage:
    array_zyx: np.ndarray
    spacing_xyz: tuple[float, float, float] = (1.0, 1.0, 1.0)
    origin_xyz: tuple[float, float, float] = (0.0, 0.0, 0.0)
    direction_3x3: tuple[float, ...] = (1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0)

    def GetSize(self) -> tuple[int, int, int]:
        z, y, x = self.array_zyx.shape
        return (int(x), int(y), int(z))

    def GetSpacing(self) -> tuple[float, float, float]:
        return self.spacing_xyz

    def SetSpacing(self, spacing: tuple[float, float, float] | list[float]) -> None:
        self.spacing_xyz = (float(spacing[0]), float(spacing[1]), float(spacing[2]))

    def GetOrigin(self) -> tuple[float, float, float]:
        return self.origin_xyz

    def SetOrigin(self, origin: tuple[float, float, float] | list[float]) -> None:
        self.origin_xyz = (float(origin[0]), float(origin[1]), float(origin[2]))

    def GetDirection(self) -> tuple[float, ...]:
        return self.direction_3x3

    def SetDirection(self, direction: tuple[float, ...] | list[float]) -> None:
        if len(direction) != 9:
            raise ValueError("Direction must have 9 elements (3x3 row-major matrix)")
        self.direction_3x3 = tuple(float(v) for v in direction)

    def CopyInformation(self, src_image: "SimpleImage") -> None:
        self.spacing_xyz = src_image.GetSpacing()
        self.origin_xyz = src_image.GetOrigin()
        self.direction_3x3 = src_image.GetDirection()


def GetImageFromArray(arr_zyx: np.ndarray) -> SimpleImage:
    arr = np.asarray(arr_zyx)
    if arr.ndim != 3:
        raise ValueError(f"Expected 3D array (Z, Y, X), got shape {arr.shape}")
    return SimpleImage(array_zyx=arr.copy())


def GetArrayFromImage(img: SimpleImage) -> np.ndarray:
    return img.array_zyx.copy()


def WriteImage(img: SimpleImage, path: str | Path) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    arr_zyx = np.asarray(img.array_zyx)
    if arr_zyx.ndim != 3:
        raise ValueError(f"NIfTI writer requires 3D volume, got {arr_zyx.ndim}D")

    dtype_name = arr_zyx.dtype.name
    if dtype_name not in DTYPE_TO_CODE:
        arr_zyx = arr_zyx.astype(np.float32)
        dtype_name = "float32"
    elif dtype_name == "int64":
        arr_zyx = arr_zyx.astype(np.int32)
        dtype_name = "int32"
    elif dtype_name == "bool":
        arr_zyx = arr_zyx.astype(np.uint8)
        dtype_name = "uint8"

    dt_code, bitpix = DTYPE_TO_CODE[dtype_name]
    target_dtype = CODE_TO_DTYPE[dt_code][0]

    z, y, x = arr_zyx.shape
    sx, sy, sz = img.GetSpacing()
    ox, oy, oz = img.GetOrigin()
    d = img.GetDirection()

    hdr = bytearray(352)
    struct.pack_into("<i", hdr, 0, 348)
    struct.pack_into("<8h", hdr, 40, 3, int(x), int(y), int(z), 1, 1, 1, 1)
    struct.pack_into("<hh", hdr, 70, dt_code, bitpix)
    struct.pack_into("<8f", hdr, 76, 1.0, float(sx), float(sy), float(sz), 0.0, 0.0, 0.0, 0.0)
    struct.pack_into("<f", hdr, 108, 352.0)
    struct.pack_into("<ff", hdr, 112, 1.0, 0.0)
    struct.pack_into("<B", hdr, 123, 2)
    struct.pack_into("<hh", hdr, 252, 1, 1)
    struct.pack_into("<fff", hdr, 268, float(ox), float(oy), float(oz))
    struct.pack_into("<4f", hdr, 280, float(d[0] * sx), float(d[1] * sy), float(d[2] * sz), float(ox))
    struct.pack_into("<4f", hdr, 296, float(d[3] * sx), float(d[4] * sy), float(d[5] * sz), float(oy))
    struct.pack_into("<4f", hdr, 312, float(d[6] * sx), float(d[7] * sy), float(d[8] * sz), float(oz))
    hdr[344:348] = b"n+1\x00"

    payload = bytes(hdr) + np.ascontiguousarray(arr_zyx, dtype=target_dtype).tobytes()
    if str(p).endswith(".gz"):
        with gzip.open(p, "wb", compresslevel=1) as gz:
            gz.write(payload)
    else:
        p.write_bytes(payload)


def ReadImage(path: str | Path) -> SimpleImage:
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"Medical image file does not exist: {p}")
    raw_bytes = p.read_bytes()
    if raw_bytes[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw_bytes)
    else:
        raw = raw_bytes

    if len(raw) < 352:
        raise ValueError(f"Invalid or corrupted NIfTI file (too short: {len(raw)} bytes): {p.name}")

    sizeof_hdr = struct.unpack_from("<i", raw, 0)[0]
    magic = raw[344:348]
    if sizeof_hdr != 348 or magic not in (b"n+1\x00", b"ni1\x00"):
        raise ValueError(f"Invalid NIfTI-1 header in {p.name} (sizeof_hdr={sizeof_hdr}, magic={magic!r})")

    dims = struct.unpack_from("<8h", raw, 40)
    ndim = dims[0]
    if ndim < 3:
        raise ValueError(f"Expected 3D NIfTI volume, got {ndim}D in {p.name}")
    nx, ny, nz = int(dims[1]), int(dims[2]), int(dims[3])
    if nx <= 0 or ny <= 0 or nz <= 0:
        raise ValueError(f"Invalid non-positive NIfTI dimensions {(nz, ny, nx)} in {p.name}")

    dt_code, _ = struct.unpack_from("<hh", raw, 70)
    if dt_code not in CODE_TO_DTYPE:
        raise ValueError(f"Unsupported NIfTI datatype code {dt_code} in {p.name}")
    dtype, _ = CODE_TO_DTYPE[dt_code]

    pixdim = struct.unpack_from("<8f", raw, 76)
    sx, sy, sz = float(pixdim[1]), float(pixdim[2]), float(pixdim[3])
    if sx <= 0 or sy <= 0 or sz <= 0:
        sx = abs(sx) if sx != 0 else 1.0
        sy = abs(sy) if sy != 0 else 1.0
        sz = abs(sz) if sz != 0 else 1.0

    vox_offset = int(struct.unpack_from("<f", raw, 108)[0])
    if vox_offset < 348:
        vox_offset = 352

    sform_code = struct.unpack_from("<h", raw, 254)[0]
    if sform_code > 0:
        srow_x = struct.unpack_from("<4f", raw, 280)
        srow_y = struct.unpack_from("<4f", raw, 296)
        srow_z = struct.unpack_from("<4f", raw, 312)
        ox, oy, oz = float(srow_x[3]), float(srow_y[3]), float(srow_z[3])
        direction = (
            float(srow_x[0] / sx) if sx else 1.0,
            float(srow_x[1] / sy) if sy else 0.0,
            float(srow_x[2] / sz) if sz else 0.0,
            float(srow_y[0] / sx) if sx else 0.0,
            float(srow_y[1] / sy) if sy else 1.0,
            float(srow_y[2] / sz) if sz else 0.0,
            float(srow_z[0] / sx) if sx else 0.0,
            float(srow_z[1] / sy) if sy else 0.0,
            float(srow_z[2] / sz) if sz else 1.0,
        )
    else:
        ox, oy, oz = struct.unpack_from("<fff", raw, 268)
        direction = (1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0)

    expected_voxels = nz * ny * nx
    expected_bytes = expected_voxels * dtype.itemsize
    if vox_offset + expected_bytes > len(raw):
        raise ValueError(
            f"Truncated NIfTI voxel payload in {p.name}: expected {expected_bytes} bytes, got {len(raw) - vox_offset}"
        )

    arr = np.frombuffer(raw, dtype=dtype, count=expected_voxels, offset=vox_offset).reshape((nz, ny, nx)).copy()
    return SimpleImage(
        array_zyx=arr,
        spacing_xyz=(sx, sy, sz),
        origin_xyz=(ox, oy, oz),
        direction_3x3=direction,
    )


def register_sitk_fallback() -> Any:
    try:
        import SimpleITK as real_sitk  # type: ignore
        return real_sitk
    except ImportError:
        mod = types.ModuleType("SimpleITK")
        mod.Image = SimpleImage  # type: ignore[attr-defined]
        mod.ReadImage = ReadImage  # type: ignore[attr-defined]
        mod.WriteImage = WriteImage  # type: ignore[attr-defined]
        mod.GetImageFromArray = GetImageFromArray  # type: ignore[attr-defined]
        mod.GetArrayFromImage = GetArrayFromImage  # type: ignore[attr-defined]
        sys.modules.setdefault("SimpleITK", mod)
        return mod
