"""Comprehensive Sprint 2 test suite for AI segmentation, geometry preservation,
dataset validation, subject-level splitting, training, evaluation, and privacy guards.
"""
from __future__ import annotations

import base64
import json
from pathlib import Path
import zlib

from fastapi.testclient import TestClient
import numpy as np
import pytest

import app  # noqa: F401
from app import (
    dataset_governance,
    dataset_split,
    dataset_validation,
    evaluation,
    metrics,
    models,
    nifti_io,
    privacy,
    series,
    unet,
)
from app.main import app as fastapi_app
from tests.conftest import make_series
from train_umd import generate_synthetic_umd_dataset, run_training_pipeline

sitk = nifti_io.register_sitk_fallback()
client = TestClient(fastapi_app)


def _upload_files(blobs: list[bytes]):
    return [("files", (f"slice_{i:03d}.dcm", b, "application/dicom")) for i, b in enumerate(blobs)]


def _write_nii(path: Path, arr_zyx: np.ndarray, spacing_xyz=(1.0, 1.0, 3.0), origin_xyz=(0.0, 0.0, 0.0), direction=None):
    img = sitk.GetImageFromArray(arr_zyx)
    img.SetSpacing(spacing_xyz)
    img.SetOrigin(origin_xyz)
    if direction is not None:
        img.SetDirection(direction)
    sitk.WriteImage(img, str(path))


# ============================================================================
# 1 & 2. Dataset Validation & Image-Mask Pairing / Geometry Checks
# ============================================================================


def test_dataset_validation_valid_and_pairing_errors(tmp_path: Path):
    manifest = generate_synthetic_umd_dataset(tmp_path, num_subjects=4, scans_per_subject=1, shape_zyx=(8, 16, 16), seed=7)
    summary = dataset_validation.validate_umd_dataset_directory(tmp_path, subject_manifest=manifest)
    assert summary.dataset_ready_for_training is True
    assert summary.valid_cases_count == 4
    assert summary.invalid_cases_count == 0
    assert summary.unpaired_images == []
    assert summary.unpaired_masks == []
    assert summary.duplicate_volume_groups == []

    # Add an orphan image without a mask
    _write_nii(tmp_path / "images" / "orphan_case.nii.gz", np.random.rand(8, 16, 16).astype(np.float32) * 100 + 10)
    bad_summary = dataset_validation.validate_umd_dataset_directory(tmp_path, subject_manifest=manifest)
    assert bad_summary.dataset_ready_for_training is False
    assert "orphan_case" in bad_summary.unpaired_images


def test_dataset_validation_detects_geometry_label_and_duplicate_errors(tmp_path: Path):
    img_dir = tmp_path / "images"
    lbl_dir = tmp_path / "labels"
    img_dir.mkdir(parents=True)
    lbl_dir.mkdir(parents=True)

    rng = np.random.default_rng(11)
    base_vol = (rng.normal(200, 30, size=(8, 16, 16))).astype(np.float32)
    valid_mask = np.zeros((8, 16, 16), dtype=np.uint8)
    valid_mask[2:6, 4:12, 4:12] = 1
    valid_mask[3:5, 6:10, 6:10] = 3

    # Case 1: valid
    _write_nii(img_dir / "patient_01.nii.gz", base_vol, spacing_xyz=(1.0, 1.0, 3.0))
    _write_nii(lbl_dir / "patient_01.nii.gz", valid_mask, spacing_xyz=(1.0, 1.0, 3.0))

    # Case 2: shape mismatch between image and mask
    vol2 = (rng.normal(170, 25, size=(8, 16, 16))).astype(np.float32)
    _write_nii(img_dir / "patient_02.nii.gz", vol2, spacing_xyz=(1.0, 1.0, 3.0))
    _write_nii(lbl_dir / "patient_02.nii.gz", valid_mask[:6], spacing_xyz=(1.0, 1.0, 3.0))

    # Case 3: spacing mismatch between image and mask
    vol3 = (rng.normal(180, 25, size=(8, 16, 16))).astype(np.float32)
    _write_nii(img_dir / "patient_03.nii.gz", vol3, spacing_xyz=(1.0, 1.0, 3.0))
    _write_nii(lbl_dir / "patient_03.nii.gz", valid_mask, spacing_xyz=(1.5, 1.5, 4.0))

    # Case 4: invalid label value (label 9 not in UMD {0..4})
    vol4 = (rng.normal(190, 25, size=(8, 16, 16))).astype(np.float32)
    bad_label_mask = valid_mask.copy()
    bad_label_mask[1, 1, 1] = 9
    _write_nii(img_dir / "patient_04.nii.gz", vol4, spacing_xyz=(1.0, 1.0, 3.0))
    _write_nii(lbl_dir / "patient_04.nii.gz", bad_label_mask, spacing_xyz=(1.0, 1.0, 3.0))

    # Case 5: empty mask (all zeros)
    vol5 = (rng.normal(210, 25, size=(8, 16, 16))).astype(np.float32)
    _write_nii(img_dir / "patient_05.nii.gz", vol5, spacing_xyz=(1.0, 1.0, 3.0))
    _write_nii(lbl_dir / "patient_05.nii.gz", np.zeros((8, 16, 16), dtype=np.uint8), spacing_xyz=(1.0, 1.0, 3.0))

    # Case 6: duplicate voxel volume of Case 1
    _write_nii(img_dir / "patient_06.nii.gz", base_vol, spacing_xyz=(1.0, 1.0, 3.0))
    _write_nii(lbl_dir / "patient_06.nii.gz", valid_mask, spacing_xyz=(1.0, 1.0, 3.0))

    summary = dataset_validation.validate_umd_dataset_directory(tmp_path)
    assert summary.dataset_ready_for_training is False
    by_id = {c.case_id: c for c in summary.cases}
    assert by_id["patient_01"].valid is True
    assert any("shape" in e.lower() for e in by_id["patient_02"].errors)
    assert any("spacing mismatch" in e.lower() for e in by_id["patient_03"].errors)
    assert any("invalid label" in e.lower() for e in by_id["patient_04"].errors)
    assert any("empty" in e.lower() for e in by_id["patient_05"].errors)
    assert ["patient_01", "patient_06"] in summary.duplicate_volume_groups


# ============================================================================
# 3. Reproducible Subject-Level Splitting Without Data Leakage
# ============================================================================


def test_subject_level_split_groups_multi_scan_patients_with_zero_leakage(tmp_path: Path):
    manifest = generate_synthetic_umd_dataset(
        tmp_path, num_subjects=10, scans_per_subject=2, shape_zyx=(8, 16, 16), seed=99
    )
    summary = dataset_validation.validate_umd_dataset_directory(tmp_path, subject_manifest=manifest)
    assert summary.dataset_ready_for_training is True
    assert summary.valid_cases_count == 20
    assert summary.unique_subjects_count == 10

    split1 = dataset_split.create_subject_level_split(summary.cases, seed=42)
    split2 = dataset_split.create_subject_level_split(summary.cases, seed=42)

    # Deterministic reproducibility
    assert split1.split_sha256 == split2.split_sha256
    assert split1.train_subjects == split2.train_subjects
    assert split1.val_subjects == split2.val_subjects
    assert split1.test_subjects == split2.test_subjects

    # Zero subject or volume-hash overlap across train, val, and test
    assert split1.zero_subject_leakage_verified is True
    assert split1.zero_volume_hash_leakage_verified is True
    assert set(split1.train_subjects).isdisjoint(split1.val_subjects)
    assert set(split1.train_subjects).isdisjoint(split1.test_subjects)
    assert set(split1.val_subjects).isdisjoint(split1.test_subjects)

    # Every subject's 2 scans stay together in the same split
    for subj_id in split1.train_subjects:
        assert f"{subj_id}_scan1" in split1.train_cases
        assert f"{subj_id}_scan2" in split1.train_cases
    for subj_id in split1.test_subjects:
        assert f"{subj_id}_scan1" in split1.test_cases
        assert f"{subj_id}_scan2" in split1.test_cases


# ============================================================================
# 4. Honest Dice & IoU Evaluation (Absent-Class Handling)
# ============================================================================


def test_absent_class_never_inflates_dice_or_iou():
    shape = (8, 16, 16)
    pred = np.zeros(shape, dtype=np.uint8)
    ref = np.zeros(shape, dtype=np.uint8)

    # Class 1 (uterine_wall): identical overlap -> Dice = 1.0, IoU = 1.0
    pred[0:3, 4:12, 4:12] = 1
    ref[0:3, 4:12, 4:12] = 1

    # Class 2 (cavity): partial overlap on slices 3..5
    pred[3:5, 6:10, 6:10] = 2
    ref[3:5, 6:10, 8:12] = 2

    # Class 3 (myoma): present in reference on slices 6..8, missed in prediction -> Dice = 0.0, missed_when_present
    ref[6:8, 2:6, 2:6] = 3

    # Class 4 (nabothian): ABSENT in both prediction and reference -> Dice MUST be None (NOT 1.0!)
    case_ev = evaluation.evaluate_multiclass_case(pred, ref, spacing_zyx_mm=(3.0, 1.0, 1.0))
    pc = case_ev["per_class"]

    assert pc["uterine_wall"]["dice"] == 1.0
    assert pc["uterine_wall"]["iou"] == 1.0
    assert pc["uterine_wall"]["presence_state"] == "present_in_both"

    assert 0.0 < pc["cavity"]["dice"] < 1.0
    assert 0.0 < pc["cavity"]["iou"] < pc["cavity"]["dice"]

    assert pc["myoma"]["dice"] == 0.0
    assert pc["myoma"]["sensitivity"] == 0.0
    assert pc["myoma"]["presence_state"] == "missed_when_present"
    assert pc["myoma"]["missed_fn_components"] == 1

    assert pc["nabothian"]["dice"] is None
    assert pc["nabothian"]["iou"] is None
    assert pc["nabothian"]["precision"] is None
    assert pc["nabothian"]["sensitivity"] is None
    assert pc["nabothian"]["presence_state"] == "absent_in_both"

    # Macro foreground averages only the 3 present classes (1.0, 0.5, 0.0 -> 0.5), NOT (1.0+0.5+0.0+1.0)/4 = 0.625!
    assert case_ev["macro_foreground"]["evaluated_foreground_classes"] == 3
    assert case_ev["macro_foreground"]["dice"] == pytest.approx((1.0 + pc["cavity"]["dice"] + 0.0) / 3.0, abs=1e-4)

    agg = evaluation.aggregate_split_evaluations([case_ev], split_name="test")
    assert agg["per_class"]["nabothian"]["mean_dice"] is None
    assert agg["per_class"]["nabothian"]["cases_absent_in_both"] == 1


# ============================================================================
# 5, 6, 7, 8, 9. Training Pipeline, Checkpoint Validation, Missing/Corrupt
# Checkpoints, Genuine Model Inference & 3D DICOM Geometry Preservation
# ============================================================================


def test_training_pipeline_checkpoint_validation_and_inference_geometry_preservation(tmp_path: Path, monkeypatch):
    ckpt_path = tmp_path / "checkpoints" / "umd_sprint2.pt"
    meta = run_training_pipeline(
        data_dir=tmp_path / "synth_umd",
        output_checkpoint=ckpt_path,
        epochs=2,
        lr=0.015,
        base_channels=8,
        seed=42,
        synthetic=True,
        synthetic_subjects=7,
    )

    assert ckpt_path.exists()
    assert Path(f"{ckpt_path}.metadata.json").exists()
    assert len(meta["checkpoint_sha256"]) == 64
    assert "SimpleUnet3D" in meta["architecture"]
    assert "MONAI not used" in meta["architecture"]
    assert len(meta["training_history"]) == 2
    # Loss decreased after optimization
    assert meta["training_history"][-1]["train_loss"] < meta["training_history"][0]["train_loss"]
    # Separate train, val, and held-out test reports exist
    for split_key in ("train", "val", "test"):
        assert split_key in meta["evaluation_splits"]
        assert meta["evaluation_splits"][split_key]["num_cases"] >= 1

    # Resume training from saved checkpoint for 1 additional epoch
    resumed_ckpt = tmp_path / "checkpoints" / "umd_resumed.pt"
    meta_resumed = run_training_pipeline(
        data_dir=tmp_path / "synth_umd",
        output_checkpoint=resumed_ckpt,
        epochs=1,
        lr=0.01,
        base_channels=8,
        seed=42,
        synthetic=False,
        resume_from=ckpt_path,
    )
    assert len(meta_resumed["training_history"]) == 3

    # Connect checkpoint to imaging service and verify /health, /models, and /segment/umd_monai_fibroid
    monkeypatch.setenv("ANATOMYBRIDGE_UMD_WEIGHTS", str(ckpt_path))
    h = client.get("/health").json()
    assert h["any_model_connected"] is True
    assert "umd_monai_fibroid" in h["connected_models"]

    m_info = client.get("/models/umd_monai_fibroid").json()
    assert m_info["connected"] is True
    assert m_info["checkpoint_sha256"] == meta["checkpoint_sha256"]
    assert m_info["model_version"] == "1.0.0-sprint2"
    assert "MONAI not used" in m_info["architecture"]

    # Create a 3D DICOM series with non-zero origin, custom spacing, and odd slice count (n=7, not divisible by 8)
    origin_lps = (-42.5, -68.25, 15.0)
    orientation = (0.0, 1.0, 0.0, 0.0, 0.0, -1.0)  # Sagittal T2W orientation
    for_uid = "1.2.826.0.1.3680043.8.498.777777"
    dicom_blobs = make_series(
        n=7,
        rows=24,
        cols=24,
        px=(0.85, 0.85),
        step=3.5,
        origin=origin_lps,
        orientation=orientation,
        frame_of_reference_uid=for_uid,
    )

    seg_res = client.post("/segment/umd_monai_fibroid", files=_upload_files(dicom_blobs))
    assert seg_res.status_code == 200
    payload = seg_res.json()

    # Verify exact preservation of 3D scan geometry
    assert payload["shape_zyx"] == [7, 24, 24]
    assert payload["spacing_zyx_mm"] == pytest.approx([3.5, 0.85, 0.85], abs=1e-4)
    assert payload["origin_lps_mm"] == pytest.approx(list(origin_lps), abs=1e-4)
    assert payload["frame_of_reference_uid"] == for_uid
    assert payload["direction_cosines"][:6] == pytest.approx(list(orientation), abs=1e-4)

    # Verify decompressed mask shape and valid labels
    raw_mask = np.frombuffer(zlib.decompress(base64.b64decode(payload["mask"])), dtype=np.uint8).reshape(7, 24, 24)
    assert set(np.unique(raw_mask)).issubset({0, 1, 2, 3, 4})
    assert payload["provenance"]["checkpoint_sha256"] == meta["checkpoint_sha256"]
    assert "classes" in payload["provenance"]["postprocessing"]

    # Verify PHI never leaked into segmentation response
    raw_text = json.dumps(payload)
    for forbidden in ("Doe", "Jane", "SECRET-ID-7", "19900101"):
        assert forbidden not in raw_text


def test_incompatible_or_corrupt_checkpoints_are_rejected_with_503(tmp_path: Path, monkeypatch):
    # 1. Truncated / corrupt file
    bad_file = tmp_path / "corrupt.pt"
    bad_file.write_bytes(b"not a valid checkpoint")
    monkeypatch.setenv("ANATOMYBRIDGE_UMD_WEIGHTS", str(bad_file))
    st = models.ADAPTERS["umd_monai_fibroid"].status()
    assert st.connected is False
    r = client.post("/segment/umd_monai_fibroid", files=_upload_files(make_series(n=4, rows=16, cols=16)))
    assert r.status_code == 503

    # 2. Incompatible state_dict (missing keys / wrong tensor shape)
    bad_state_ckpt = tmp_path / "wrong_arch.pt"
    models.save_checkpoint_bundle(
        bad_state_ckpt,
        state_dict={"outc.weight": np.zeros((5, 99, 1, 1, 1), dtype=np.float32)},
        metadata={"in_channels": 1, "out_channels": 5, "base_channels": 16},
    )
    monkeypatch.setenv("ANATOMYBRIDGE_UMD_WEIGHTS", str(bad_state_ckpt))
    st2 = models.ADAPTERS["umd_monai_fibroid"].status()
    assert st2.connected is False
    assert "Incompatible SimpleUnet3D checkpoint architecture" in st2.reason

    # 3. SHA-256 tamper detection against sidecar metadata
    valid_net = unet.NumpySimpleUnet3D(in_channels=1, out_channels=5, base_channels=8)
    tampered_ckpt = tmp_path / "tampered.pt"
    models.save_checkpoint_bundle(
        tampered_ckpt,
        state_dict=valid_net.state_dict(),
        metadata={"in_channels": 1, "out_channels": 5, "base_channels": 8},
    )
    sidecar = Path(f"{tampered_ckpt}.metadata.json")
    meta_obj = json.loads(sidecar.read_text(encoding="utf-8"))
    meta_obj["checkpoint_sha256"] = "0" * 64
    sidecar.write_text(json.dumps(meta_obj), encoding="utf-8")

    monkeypatch.setenv("ANATOMYBRIDGE_UMD_WEIGHTS", str(tampered_ckpt))
    st3 = models.ADAPTERS["umd_monai_fibroid"].status()
    assert st3.connected is False
    assert "SHA-256 mismatch" in st3.reason


def test_blank_or_nan_input_volumes_are_rejected_with_422(tmp_path: Path, monkeypatch):
    valid_net = unet.NumpySimpleUnet3D(in_channels=1, out_channels=5, base_channels=8)
    ckpt = tmp_path / "valid.pt"
    models.save_checkpoint_bundle(
        ckpt,
        state_dict=valid_net.state_dict(),
        metadata={"in_channels": 1, "out_channels": 5, "base_channels": 8},
    )
    monkeypatch.setenv("ANATOMYBRIDGE_UMD_WEIGHTS", str(ckpt))

    # Flat constant-intensity DICOM series (ellipsoid=False -> all voxels = 100)
    flat_blobs = make_series(n=6, rows=16, cols=16, ellipsoid=False)
    r = client.post("/segment/umd_monai_fibroid", files=_upload_files(flat_blobs))
    assert r.status_code == 422
    assert r.json()["detail"]["error"] == "invalid_input_volume"


# ============================================================================
# 11. Privacy & Data Governance Safeguards
# ============================================================================


def test_privacy_guards_block_identifiable_patient_data_and_dicom_phi(tmp_path: Path):
    # 1. Identifiable / production patient data category is unconditionally blocked
    with pytest.raises(PermissionError, match="GOVERNANCE BLOCK"):
        privacy.verify_training_data_governance(
            data_dir=tmp_path,
            data_category="pseudonymised_or_identifiable_patient_data",
        )

    # 2. Anonymised research data without IEC ethics approval reference is blocked
    with pytest.raises(PermissionError, match="ethics"):
        privacy.verify_training_data_governance(
            data_dir=tmp_path,
            data_category="anonymised_research_data",
            ethics_approval_ref=None,
        )

    # 3. Directory containing unredacted DICOM PHI tags is blocked
    phi_blobs = make_series(n=2, rows=16, cols=16)
    (tmp_path / "raw_slice.dcm").write_bytes(phi_blobs[0])
    insp = privacy.inspect_dicom_privacy(phi_blobs[0])
    assert insp.is_deidentified is False
    assert "PatientName" in insp.detected_phi_tags
    assert "PatientID" in insp.detected_phi_tags

    with pytest.raises(PermissionError, match="unredacted PHI"):
        privacy.verify_training_data_governance(
            data_dir=tmp_path,
            data_category="public_research_dataset",
        )

    # 4. Scrubbing removes PHI tags and passes inspection
    scrubbed = privacy.scrub_dicom_phi_bytes(phi_blobs[0])
    insp_clean = privacy.inspect_dicom_privacy(scrubbed)
    assert insp_clean.is_deidentified is True
    assert insp_clean.detected_phi_tags == []

    # 5. Provenance registry explicitly marks clinical diagnostic use as unverified/restricted
    prov = dataset_governance.get_umd_provenance()
    assert prov["declared_license"].startswith("Creative Commons Attribution 4.0")
    assert "UNVERIFIED" in prov["unverified_or_restricted_uses"]["regulated_clinical_diagnostic_deployment"]


def test_model_lifecycle_non_overwrite_per_patient_failure_analysis_and_rollback(tmp_path: Path):
    """Verify per-patient metrics, explicit failed_cases reporting, non-overwrite guard, and checkpoint rollback."""
    ckpt_v1 = tmp_path / "models" / "umd_v1.pt"
    meta_v1 = run_training_pipeline(
        data_dir=tmp_path / "synth_lifecycle",
        output_checkpoint=ckpt_v1,
        epochs=2,
        lr=0.015,
        base_channels=8,
        seed=42,
        synthetic=True,
        synthetic_subjects=7,
        model_version="1.0.0-exp",
    )

    test_split = meta_v1["evaluation_splits"]["test"]
    assert "per_patient" in test_split and len(test_split["per_patient"]) >= 1
    assert "per_case" in test_split and len(test_split["per_case"]) >= 1
    assert "failed_cases" in test_split and isinstance(test_split["failed_cases"], list)
    assert meta_v1["external_validation_performed"] is False
    assert "CC BY 4.0" in meta_v1["dataset_license_reference"]

    # Attempting to silently overwrite ckpt_v1 without allow_overwrite=True MUST raise FileExistsError
    with pytest.raises(FileExistsError, match="Refusing to silently replace existing checkpoint"):
        run_training_pipeline(
            data_dir=tmp_path / "synth_lifecycle",
            output_checkpoint=ckpt_v1,
            epochs=1,
            lr=0.01,
            base_channels=8,
            seed=42,
            synthetic=False,
            model_version="1.0.1-exp",
        )

    # Save version 2 to a distinct path and verify checkpoint_registry.json + rollback_checkpoint
    ckpt_v2 = tmp_path / "models" / "umd_v2.pt"
    meta_v2 = run_training_pipeline(
        data_dir=tmp_path / "synth_lifecycle",
        output_checkpoint=ckpt_v2,
        epochs=1,
        lr=0.01,
        base_channels=8,
        seed=42,
        synthetic=False,
        resume_from=ckpt_v1,
        model_version="1.1.0-exp",
    )

    reg_path = tmp_path / "models" / "checkpoint_registry.json"
    assert reg_path.exists()
    reg_data = json.loads(reg_path.read_text(encoding="utf-8"))
    assert reg_data["active_checkpoint"]["model_version"] == "1.1.0-exp"
    assert len(reg_data["history"]) == 2

    rolled = models.rollback_checkpoint(tmp_path / "models")
    assert rolled["model_version"] == "1.0.0-exp"
    assert rolled["checkpoint_sha256"] == meta_v1["checkpoint_sha256"]
    reg_after = json.loads(reg_path.read_text(encoding="utf-8"))
    assert reg_after["active_checkpoint"]["model_version"] == "1.0.0-exp"
    assert len(reg_after["rollback_events"]) == 1
