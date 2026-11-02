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


def test_sprint6_pillow_jpeg_and_jpeg2000_dicom_decoding():
    """Sprint 6 Task 2A: Verify genuine Pillow libjpeg (1.2.840.10008.1.2.4.50) and OpenJPEG JPEG 2000 (1.2.840.10008.1.2.4.90) DICOM decoding."""
    from PIL import Image
    from pydicom.dataset import FileDataset, FileMetaDataset
    from app.dicom_io import JPEGBaseline8Bit, JPEG2000Lossless

    rows, cols = 16, 16
    pattern = np.zeros((rows, cols), dtype=np.uint8)
    pattern[4:12, 4:12] = 200

    # 1. Encode frame as genuine ITU-T T.81 JPEG via Pillow (libjpeg)
    jpeg_buf = io.BytesIO()
    Image.fromarray(pattern, mode="L").save(jpeg_buf, format="JPEG", quality=100)
    jpeg_bytes = jpeg_buf.getvalue()
    assert jpeg_bytes[:2] == b"\xff\xd8"

    meta_jpg = FileMetaDataset()
    meta_jpg.MediaStorageSOPClassUID = "1.2.840.10008.5.1.4.1.1.4"
    meta_jpg.MediaStorageSOPInstanceUID = "1.2.826.0.1.3680043.2.1125.99.201"
    meta_jpg.TransferSyntaxUID = JPEGBaseline8Bit

    ds_jpg = FileDataset(None, {}, file_meta=meta_jpg, preamble=b"\x00" * 128)
    ds_jpg.StudyInstanceUID = "1.2.826.0.1.3680043.2.1125.99"
    ds_jpg.SeriesInstanceUID = "1.2.826.0.1.3680043.2.1125.99.20"
    ds_jpg.SOPInstanceUID = "1.2.826.0.1.3680043.2.1125.99.201"
    ds_jpg.Modality = "MR"
    ds_jpg.Rows = rows
    ds_jpg.Columns = cols
    ds_jpg.BitsAllocated = 8
    ds_jpg.BitsStored = 8
    ds_jpg.HighBit = 7
    ds_jpg.PixelRepresentation = 0
    ds_jpg.SamplesPerPixel = 1
    ds_jpg.PhotometricInterpretation = "MONOCHROME2"
    ds_jpg.PixelSpacing = [1.0, 1.0]
    ds_jpg.SliceThickness = 3.0
    ds_jpg.ImagePositionPatient = [0.0, 0.0, 0.0]
    ds_jpg.ImageOrientationPatient = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0]
    ds_jpg.PixelData = [jpeg_bytes]

    out_jpg = io.BytesIO()
    pydicom.dcmwrite(out_jpg, ds_jpg)
    parsed_jpg = pydicom.dcmread(io.BytesIO(out_jpg.getvalue()))
    assert parsed_jpg.pixel_array.shape == (rows, cols)
    assert int(parsed_jpg.pixel_array[8, 8]) > 180
    assert int(parsed_jpg.pixel_array[0, 0]) < 15

    # 2. Encode frame as genuine ISO/IEC 15444-1 JPEG 2000 Lossless via Pillow (OpenJPEG)
    j2k_buf = io.BytesIO()
    Image.fromarray(pattern, mode="L").save(j2k_buf, format="JPEG2000", irreversible=False)
    j2k_bytes = j2k_buf.getvalue()

    meta_j2k = FileMetaDataset()
    meta_j2k.MediaStorageSOPClassUID = "1.2.840.10008.5.1.4.1.1.4"
    meta_j2k.MediaStorageSOPInstanceUID = "1.2.826.0.1.3680043.2.1125.99.202"
    meta_j2k.TransferSyntaxUID = JPEG2000Lossless

    ds_j2k = FileDataset(None, {}, file_meta=meta_j2k, preamble=b"\x00" * 128)
    ds_j2k.StudyInstanceUID = "1.2.826.0.1.3680043.2.1125.99"
    ds_j2k.SeriesInstanceUID = "1.2.826.0.1.3680043.2.1125.99.21"
    ds_j2k.SOPInstanceUID = "1.2.826.0.1.3680043.2.1125.99.202"
    ds_j2k.Modality = "MR"
    ds_j2k.Rows = rows
    ds_j2k.Columns = cols
    ds_j2k.BitsAllocated = 8
    ds_j2k.BitsStored = 8
    ds_j2k.HighBit = 7
    ds_j2k.PixelRepresentation = 0
    ds_j2k.SamplesPerPixel = 1
    ds_j2k.PhotometricInterpretation = "MONOCHROME2"
    ds_j2k.PixelSpacing = [1.0, 1.0]
    ds_j2k.SliceThickness = 3.0
    ds_j2k.ImagePositionPatient = [0.0, 0.0, 0.0]
    ds_j2k.ImageOrientationPatient = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0]
    ds_j2k.PixelData = [j2k_bytes]

    out_j2k = io.BytesIO()
    pydicom.dcmwrite(out_j2k, ds_j2k)
    parsed_j2k = pydicom.dcmread(io.BytesIO(out_j2k.getvalue()))
    assert parsed_j2k.pixel_array.shape == (rows, cols)
    assert np.array_equal(parsed_j2k.pixel_array, pattern)


def test_sprint6_real_pillow_jpeg_jpeg2000_rle_and_ps315_deidentification():
    """Sprint 6 Task 2A, 2E & 2F: Verify real Pillow (libjpeg & OpenJPEG) DICOM decoding and PS3.15 de-identification."""
    from app.dicom_io import (
        JPEGBaseline8Bit,
        JPEG2000Lossless,
        JPEG2000,
        RLELossless,
        build_compressed_dicom_bytes,
    )
    from app.dicom_deidentify import deidentify_dataset

    # 1. Real JPEG Baseline (libjpeg), JPEG 2000 Lossless (OpenJPEG), and RLE Lossless DICOM decoding
    orig_slice = np.zeros((16, 16), dtype=np.uint8)
    orig_slice[4:12, 4:12] = 200

    for syntax in (JPEGBaseline8Bit, JPEG2000Lossless, JPEG2000, RLELossless):
        raw_bytes = build_compressed_dicom_bytes(
            orig_slice,
            transfer_syntax_uid=syntax,
            origin_lps_mm=(-12.5, 18.0, 30.0),
            pixel_spacing_mm=(1.2, 1.2),
            slice_thickness_mm=3.0,
        )
        ds = pydicom.dcmread(io.BytesIO(raw_bytes))
        assert str(ds.file_meta.TransferSyntaxUID) == syntax
        decoded = ds.pixel_array
        assert decoded.shape == (16, 16)
        if syntax in (JPEG2000Lossless, RLELossless):
            assert np.array_equal(decoded, orig_slice)
        else:
            # Lossy JPEG / J2K within close tolerance
            assert float(np.abs(decoded.astype(np.float32) - orig_slice.astype(np.float32)).mean()) < 5.0

    # 2. Unsupported transfer syntax raises explicit ValueError (never silently interprets compressed bytes as raw)
    ds_bad = pydicom.dcmread(io.BytesIO(build_compressed_dicom_bytes(orig_slice, RLELossless)))
    ds_bad.file_meta["TransferSyntaxUID"] = "1.2.840.10008.1.2.4.999"
    try:
        _ = ds_bad.pixel_array
        raise AssertionError("Expected ValueError for unsupported compressed transfer syntax")
    except ValueError as e:
        assert "Unsupported compressed transfer syntax" in str(e)

    # 3. PS3.15 De-identification: private tags, nested sequences, UID remapping, burned-in detection, original preserved
    ds_phi = pydicom.dcmread(io.BytesIO(build_compressed_dicom_bytes(orig_slice, JPEG2000Lossless, origin_lps_mm=(-12.5, 18.0, 30.0))))
    ds_phi.PatientName = "SHARMA^ANYA"
    ds_phi.PatientID = "PT-9988"
    ds_phi.InstitutionName = "PUNE CLINIC"
    ds_phi.BurnedInAnnotation = "YES"
    ds_phi[(0x0009, 0x1001)] = "PRIVATE_TAG_SECRET"
    ds_phi.RequestAttributesSequence = [
        {"AccessionNumber": "NESTED-ACC-1", "ReferencedSOPInstanceUID": "1.2.826.0.1.3680043.8.498.777"}
    ]
    orig_study_uid = ds_phi.StudyInstanceUID

    derived_ds, rep = deidentify_dataset(ds_phi, uid_salt="py-test-salt", date_shift_days=-14)
    # Original dataset is unchanged
    assert ds_phi.PatientName == "SHARMA^ANYA"
    assert (0x0009, 0x1001) in ds_phi
    # Derived dataset has PHI and private tags removed, UIDs remapped, geometry preserved
    assert "PatientName" not in derived_ds
    assert "PatientID" not in derived_ds
    assert (0x0009, 0x1001) not in derived_ds
    assert "0009,1001" in rep["private_tags_removed"]
    assert derived_ds.StudyInstanceUID != orig_study_uid
    assert derived_ds.ImagePositionPatient == [-12.5, 18.0, 30.0]
    assert rep["burned_in_annotation_risk"] == "high"
    assert rep["manual_review_required"] is True
    assert rep["claim_complete_anonymisation"] is False
