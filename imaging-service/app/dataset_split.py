"""Reproducible subject-level dataset splitting into train, validation, and held-out test sets (Task 2E)."""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
import hashlib
import json
from pathlib import Path
from typing import Any

import numpy as np

from .dataset_validation import CaseValidationRecord


@dataclass
class SubjectSplitManifest:
    seed: int
    ratios: dict[str, float]
    total_subjects: int
    total_cases: int
    train_subjects: list[str]
    val_subjects: list[str]
    test_subjects: list[str]
    train_cases: list[str]
    val_cases: list[str]
    test_cases: list[str]
    zero_subject_leakage_verified: bool
    zero_volume_hash_leakage_verified: bool
    subject_id_provenance_note: str
    split_sha256: str = ""
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def verify_zero_split_leakage(
    train_subjects: list[str],
    val_subjects: list[str],
    test_subjects: list[str],
    train_hashes: set[str] | None = None,
    val_hashes: set[str] | None = None,
    test_hashes: set[str] | None = None,
) -> tuple[bool, bool, list[str]]:
    errors: list[str] = []
    s_tr, s_va, s_te = set(train_subjects), set(val_subjects), set(test_subjects)

    if s_tr & s_va:
        errors.append(f"Subject leakage between train and val: {sorted(s_tr & s_va)}")
    if s_tr & s_te:
        errors.append(f"Subject leakage between train and test: {sorted(s_tr & s_te)}")
    if s_va & s_te:
        errors.append(f"Subject leakage between val and test: {sorted(s_va & s_te)}")

    subject_ok = len(errors) == 0
    hash_ok = True
    if train_hashes is not None and val_hashes is not None and test_hashes is not None:
        if train_hashes & val_hashes:
            hash_ok = False
            errors.append("Duplicate voxel SHA-256 detected between train and val splits")
        if train_hashes & test_hashes:
            hash_ok = False
            errors.append("Duplicate voxel SHA-256 detected between train and test splits")
        if val_hashes & test_hashes:
            hash_ok = False
            errors.append("Duplicate voxel SHA-256 detected between val and test splits")

    return subject_ok, hash_ok, errors


def create_subject_level_split(
    valid_cases: list[CaseValidationRecord],
    train_ratio: float = 0.70,
    val_ratio: float = 0.15,
    test_ratio: float = 0.15,
    seed: int = 42,
) -> SubjectSplitManifest:
    if abs((train_ratio + val_ratio + test_ratio) - 1.0) > 1e-5:
        raise ValueError(
            f"Split ratios must sum to 1.0, got {train_ratio} + {val_ratio} + {test_ratio}"
        )
    if any(r <= 0.0 for r in (train_ratio, val_ratio, test_ratio)):
        raise ValueError("All three split ratios (train, val, test) must be strictly positive")

    subject_to_cases: dict[str, list[CaseValidationRecord]] = {}
    for c in valid_cases:
        if not c.valid:
            raise ValueError(f"Cannot include invalid case '{c.case_id}' in dataset split")
        subject_to_cases.setdefault(c.subject_id, []).append(c)

    unique_subjects = sorted(subject_to_cases.keys())
    n_subj = len(unique_subjects)
    if n_subj < 3:
        raise ValueError(
            f"Need at least 3 distinct subjects to create disjoint train/val/test splits, got {n_subj}"
        )

    rng = np.random.default_rng(seed)
    shuffled = list(unique_subjects)
    rng.shuffle(shuffled)

    n_test = max(1, int(round(n_subj * test_ratio)))
    n_val = max(1, int(round(n_subj * val_ratio)))
    if n_test + n_val >= n_subj:
        n_test = 1
        n_val = 1
    n_train = n_subj - n_val - n_test

    train_subjects = sorted(shuffled[:n_train])
    val_subjects = sorted(shuffled[n_train : n_train + n_val])
    test_subjects = sorted(shuffled[n_train + n_val :])

    train_cases = sorted(c.case_id for s in train_subjects for c in subject_to_cases[s])
    val_cases = sorted(c.case_id for s in val_subjects for c in subject_to_cases[s])
    test_cases = sorted(c.case_id for s in test_subjects for c in subject_to_cases[s])

    train_hashes = {c.image_sha256 for s in train_subjects for c in subject_to_cases[s] if c.image_sha256}
    val_hashes = {c.image_sha256 for s in val_subjects for c in subject_to_cases[s] if c.image_sha256}
    test_hashes = {c.image_sha256 for s in test_subjects for c in subject_to_cases[s] if c.image_sha256}

    subj_ok, hash_ok, leak_errors = verify_zero_split_leakage(
        train_subjects,
        val_subjects,
        test_subjects,
        train_hashes,
        val_hashes,
        test_hashes,
    )
    if not subj_ok or not hash_ok:
        raise RuntimeError("Dataset split failed leakage verification: " + "; ".join(leak_errors))

    fallback_count = sum(1 for c in valid_cases if c.subject_id_source == "case_index_fallback")
    warnings: list[str] = []
    if fallback_count > 0:
        provenance_note = (
            f"{fallback_count}/{len(valid_cases)} case(s) rely on case-index subject IDs (e.g., case_XXXX). "
            "While Pan et al. (2024) describe 300 patient cases in UMD, case-index filenames alone cannot prove "
            "absence of multi-scan repeat visits if an upstream hospital did not encode patient IDs. "
            "Cross-split SHA-256 voxel duplicate verification was enforced."
        )
        warnings.append(provenance_note)
    else:
        provenance_note = "All cases mapped via explicit patient/subject identifiers."

    canonical_payload = json.dumps(
        {
            "seed": seed,
            "train_subjects": train_subjects,
            "val_subjects": val_subjects,
            "test_subjects": test_subjects,
            "train_cases": train_cases,
            "val_cases": val_cases,
            "test_cases": test_cases,
        },
        sort_keys=True,
    ).encode("utf-8")
    split_sha = hashlib.sha256(canonical_payload).hexdigest()

    return SubjectSplitManifest(
        seed=seed,
        ratios={"train": train_ratio, "val": val_ratio, "test": test_ratio},
        total_subjects=n_subj,
        total_cases=len(valid_cases),
        train_subjects=train_subjects,
        val_subjects=val_subjects,
        test_subjects=test_subjects,
        train_cases=train_cases,
        val_cases=val_cases,
        test_cases=test_cases,
        zero_subject_leakage_verified=subj_ok,
        zero_volume_hash_leakage_verified=hash_ok,
        subject_id_provenance_note=provenance_note,
        split_sha256=split_sha,
        warnings=warnings,
    )


def save_split_manifest(manifest: SubjectSplitManifest, path: str | Path) -> Path:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(manifest.to_dict(), indent=2, sort_keys=True), encoding="utf-8")
    return p
