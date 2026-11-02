"""Sprint 5 Task 1A, 1B & 1D: Python backend DICOM multi-syntax and multi-frame tests."""
from __future__ import annotations

import io
import numpy as np

from app.dicom_io import (
    ExplicitVRLittleEndian,
    ImplicitVRLittleEndian,
    register_pydicom_fallback,
)
from app.series import inspect, stack_volume_with_geometry

pydicom = register_pydicom_fallback()


def test_sprint5_implicit_vr_little_endian_read_and_write():
    """Verify Python backend reads and writes Implicit VR Little Endian (1.2.840.10008.1.2)."""
    from pydicom.dataset import FileDataset, FileMetaDataset

    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = "1.2.840.10008.5.1.4.1.1.4"
    meta.MediaStorageSOPInstanceUID = "1.2.826.0.1.3680043.2.1125.99.1"
    meta.TransferSyntaxUID = ImplicitVRLittleEndian

    ds = FileDataset(None, {}, file_meta=meta, preamble=b"\x00" * 128)
    ds.is_little_endian = True
    ds.is_implicit_VR = True
    ds.StudyInstanceUID = "1.2.826.0.1.3680043.2.1125.99"
    ds.SeriesInstanceUID = "1.2.826.0.1.3680043.2.1125.99.2"
    ds.SOPInstanceUID = "1.2.826.0.1.3680043.2.1125.99.1"
    ds.Modality = "MR"
    ds.Rows = 4
    ds.Columns = 4
    ds.BitsAllocated = 16
    ds.BitsStored = 16
    ds.HighBit = 15
    ds.PixelRepresentation = 0
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.PixelSpacing = [1.5, 1.5]
    ds.SliceThickness = 3.0
    ds.ImagePositionPatient = [12.0, -18.0, 24.0]
    ds.ImageOrientationPatient = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0]
    arr = np.arange(16, dtype=np.uint16).reshape(4, 4) * 10
    ds.PixelData = arr.tobytes()

    buf = io.BytesIO()
    pydicom.dcmwrite(buf, ds)
    parsed = pydicom.dcmread(io.BytesIO(buf.getvalue()))
    assert str(parsed.file_meta.TransferSyntaxUID) == ImplicitVRLittleEndian
    assert parsed.pixel_array.shape == (4, 4)
    assert int(parsed.pixel_array[0, 3]) == 30


def test_sprint5_multiframe_dicom_expansion_and_geometry_preservation():
    """Verify Python backend expands multi-frame DICOM (NumberOfFrames + SpacingBetweenSlices) into a 3D volume."""
    from pydicom.dataset import FileDataset, FileMetaDataset

    meta_mf = FileMetaDataset()
    meta_mf.MediaStorageSOPClassUID = "1.2.840.10008.5.1.4.1.1.4"
    meta_mf.MediaStorageSOPInstanceUID = "1.2.826.0.1.3680043.2.1125.99.50"
    meta_mf.TransferSyntaxUID = ExplicitVRLittleEndian

    ds_mf = FileDataset(None, {}, file_meta=meta_mf, preamble=b"\x00" * 128)
    ds_mf.is_little_endian = True
    ds_mf.is_implicit_VR = False
    ds_mf.StudyInstanceUID = "1.2.826.0.1.3680043.2.1125.99"
    ds_mf.SeriesInstanceUID = "1.2.826.0.1.3680043.2.1125.99.5"
    ds_mf.SOPInstanceUID = "1.2.826.0.1.3680043.2.1125.99.50"
    ds_mf.Modality = "MR"
    ds_mf.Rows = 8
    ds_mf.Columns = 8
    ds_mf.NumberOfFrames = "4"
    ds_mf.BitsAllocated = 16
    ds_mf.BitsStored = 16
    ds_mf.HighBit = 15
    ds_mf.PixelRepresentation = 0
    ds_mf.SamplesPerPixel = 1
    ds_mf.PhotometricInterpretation = "MONOCHROME2"
    ds_mf.PixelSpacing = [1.25, 1.25]
    ds_mf.SliceThickness = 2.5
    ds_mf.SpacingBetweenSlices = 2.5
    ds_mf.PatientPosition = "HFS"
    ds_mf.ImagePositionPatient = [-10.0, -20.0, 5.0]
    ds_mf.ImageOrientationPatient = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0]
    arr_mf = np.ones((4, 8, 8), dtype=np.uint16) * 120
    ds_mf.PixelData = arr_mf.tobytes()

    buf_mf = io.BytesIO()
    pydicom.dcmwrite(buf_mf, ds_mf, )

    report, ordered = inspect([buf_mf.getvalue()])
    assert report.volume_ready is True
    assert report.slice_count == 4
    assert report.slice_spacing_mm == 2.5
    assert report.origin_lps_mm == (-10.0, -20.0, 5.0)
    assert len(ordered) == 4

    vol, geom, _ = stack_volume_with_geometry([buf_mf.getvalue()])
    assert vol.shape == (4, 8, 8)
    assert geom.shape_zyx == (4, 8, 8)
    assert geom.spacing_zyx_mm == (2.5, 1.25, 1.25)
    assert geom.origin_lps_mm == (-10.0, -20.0, 5.0)
    assert geom.patient_position == "HFS"
