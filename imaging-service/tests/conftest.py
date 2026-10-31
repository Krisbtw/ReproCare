import io

import numpy as np
import pydicom
from pydicom.dataset import FileDataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, MRImageStorage, generate_uid


def make_series(n=12, rows=32, cols=32, px=(1.0, 1.0), step=3.0, drop=(), dup=(), tilt_idx=None, series_uid=None, other_series_idx=None, ellipsoid=True):
    """Synthetic MR series. Patient tags are deliberately filled so tests can prove they never leak."""
    uid = series_uid or generate_uid()
    study = generate_uid()
    zz, yy, xx = np.mgrid[0:n, 0:rows, 0:cols]
    cz, cy, cx = (n - 1) / 2, (rows - 1) / 2, (cols - 1) / 2
    body = (((zz - cz) * step / 9) ** 2 + ((yy - cy) * px[0] / 8) ** 2 + ((xx - cx) * px[1] / 10) ** 2) <= 1
    vol = (100 + 400 * body).astype(np.uint16) if ellipsoid else np.full((n, rows, cols), 100, np.uint16)
    blobs = []
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
            ds.SOPClassUID, ds.SOPInstanceUID = MRImageStorage, meta.MediaStorageSOPInstanceUID
            ds.PatientName, ds.PatientID, ds.PatientBirthDate = "Doe^Jane", "SECRET-ID-7", "19900101"
            ds.Modality, ds.SeriesDescription = "MR", "SYNTHETIC T2 sag"
            ds.StudyInstanceUID = study
            ds.SeriesInstanceUID = generate_uid() if other_series_idx == i else uid
            ds.Rows, ds.Columns = rows, cols
            ds.PixelSpacing = [px[0], px[1]]
            ds.SliceThickness = step
            ds.ImageOrientationPatient = [1, 0, 0, 0, 1, 0] if tilt_idx != i else [1, 0, 0, 0, 0.9, 0.436]
            ds.ImagePositionPatient = [0.0, 0.0, i * step]
            ds.BitsAllocated, ds.BitsStored, ds.HighBit = 16, 16, 15
            ds.SamplesPerPixel, ds.PhotometricInterpretation, ds.PixelRepresentation = 1, "MONOCHROME2", 0
            ds.RescaleSlope, ds.RescaleIntercept = 1, 0
            ds.PixelData = vol[i].tobytes()
            buf = io.BytesIO()
            pydicom.dcmwrite(buf, ds, enforce_file_format=True)
            blobs.append(buf.getvalue())
    return blobs
