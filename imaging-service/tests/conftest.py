import io
import os

import numpy as np
import pytest

import app  # noqa: F401 - ensures dicom_io / nifti_io fallback registration when pydicom is absent
import pydicom
from pydicom.dataset import FileDataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, MRImageStorage, generate_uid


@pytest.fixture(autouse=True)
def default_dev_mode(monkeypatch):
    if "ANATOMYBRIDGE_DEV_NO_AUTH" not in os.environ and "ANATOMYBRIDGE_SERVICE_API_KEY" not in os.environ:
        monkeypatch.setenv("ANATOMYBRIDGE_DEV_NO_AUTH", "1")


def make_series(
    n=12,
    rows=32,
    cols=32,
    px=(1.0, 1.0),
    step=3.0,
    drop=(),
    dup=(),
    tilt_idx=None,
    series_uid=None,
    other_series_idx=None,
    ellipsoid=True,
    origin=(0.0, 0.0, 0.0),
    orientation=(1.0, 0.0, 0.0, 0.0, 1.0, 0.0),
    frame_of_reference_uid="1.2.826.0.1.3680043.8.498.99990001",
):
    """Synthetic MR series. Patient tags are deliberately filled so tests can prove they never leak."""
    uid = series_uid or generate_uid()
    study = generate_uid()
    zz, yy, xx = np.mgrid[0:n, 0:rows, 0:cols]
    cz, cy, cx = (n - 1) / 2, (rows - 1) / 2, (cols - 1) / 2
    body = (((zz - cz) * step / 9) ** 2 + ((yy - cy) * px[0] / 8) ** 2 + ((xx - cx) * px[1] / 10) ** 2) <= 1
    vol = (100 + 400 * body).astype(np.uint16) if ellipsoid else np.full((n, rows, cols), 100, np.uint16)
    blobs = []
    row_vec = np.asarray(orientation[:3], dtype=np.float64)
    col_vec = np.asarray(orientation[3:6], dtype=np.float64)
    normal_vec = np.cross(row_vec, col_vec)
    n_norm = np.linalg.norm(normal_vec)
    if n_norm > 0:
        normal_vec = normal_vec / n_norm

    pydicom_major = int(str(getattr(pydicom, "__version__", "2.4.4")).split(".")[0])

    for i in range(n):
        if i in drop:
            continue
        reps = 2 if i in dup else 1
        for _ in range(reps):
            meta = FileMetaDataset()
            meta.MediaStorageSOPClassUID = MRImageStorage
            meta.MediaStorageSOPInstanceUID = generate_uid()
            meta.TransferSyntaxUID = ExplicitVRLittleEndian
            ds = FileDataset(None, {}, file_meta=meta, preamble=b"\0" * 128)
            if pydicom_major < 3:
                ds.is_little_endian = True
                ds.is_implicit_VR = False
            ds.SOPClassUID, ds.SOPInstanceUID = MRImageStorage, meta.MediaStorageSOPInstanceUID
            ds.PatientName, ds.PatientID, ds.PatientBirthDate = "Doe^Jane", "SECRET-ID-7", "19900101"
            ds.Modality, ds.SeriesDescription = "MR", "SYNTHETIC T2 sag"
            ds.StudyInstanceUID = study
            ds.SeriesInstanceUID = generate_uid() if other_series_idx == i else uid
            if frame_of_reference_uid:
                ds.FrameOfReferenceUID = frame_of_reference_uid
            ds.Rows, ds.Columns = rows, cols
            ds.PixelSpacing = [px[0], px[1]]
            ds.SliceThickness = step
            ds.ImageOrientationPatient = list(orientation) if tilt_idx != i else [1, 0, 0, 0, 0.9, 0.436]
            pos = np.asarray(origin, dtype=np.float64) + (i * step) * normal_vec
            ds.ImagePositionPatient = [float(pos[0]), float(pos[1]), float(pos[2])]
            ds.BitsAllocated, ds.BitsStored, ds.HighBit = 16, 16, 15
            ds.SamplesPerPixel, ds.PhotometricInterpretation, ds.PixelRepresentation = 1, "MONOCHROME2", 0
            ds.RescaleSlope, ds.RescaleIntercept = 1, 0
            ds.PixelData = vol[i].tobytes()
            buf = io.BytesIO()
            pydicom.dcmwrite(buf, ds, enforce_file_format=True)
            blobs.append(buf.getvalue())
    return blobs
