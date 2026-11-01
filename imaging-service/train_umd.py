#!/usr/bin/env python3
"""Reproducible training and evaluation pipeline for the UMD (Uterine Myoma Dataset).

Dataset reference:
  Scientific Data 11:410 (2024), DOI: 10.1038/s41597-024-03170-x.
  Figshare: https://figshare.com/articles/dataset/UMD/23541312
  Licence: CC BY 4.0

Labels:
  0: background
  1: uterine_wall
  2: cavity
  3: myoma (uterine fibroid)
  4: nabothian (nabothian cyst)

Usage:
  python train_umd.py --data-dir /path/to/UMD --output-weights models/umd_best.pt --epochs 40
  python train_umd.py --synthetic-verify --epochs 2
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import numpy as np


def compute_dice_score(pred: np.ndarray, target: np.ndarray, num_classes: int = 5) -> dict[str, float]:
    """Computes multi-class Dice scores."""
    labels = {1: "uterine_wall", 2: "cavity", 3: "myoma", 4: "nabothian"}
    dices = {}
    for c, name in labels.items():
        p_c = (pred == c)
        t_c = (target == c)
        intersect = 2.0 * np.logical_and(p_c, t_c).sum()
        total = p_c.sum() + t_c.sum()
        if total == 0:
            dices[name] = 1.0 if not t_c.any() else 0.0
        else:
            dices[name] = float(intersect / total)
    dices["mean_foreground"] = float(np.mean([dices[k] for k in labels.values()]))
    return dices


def generate_synthetic_umd_case(case_id: int, shape=(32, 64, 64)) -> tuple[np.ndarray, np.ndarray]:
    """Generates a realistic synthetic pelvic MRI phantom with uterus and fibroid for testing/verification."""
    z, y, x = shape
    volume = np.random.normal(loc=100.0, scale=10.0, size=shape).astype(np.float32)
    mask = np.zeros(shape, dtype=np.int64)

    # Uterine body (class 1)
    cz, cy, cx = z // 2, y // 2, x // 2
    zz, yy, xx = np.ogrid[:z, :y, :x]
    uterus = (((zz - cz) / (z * 0.35)) ** 2 + ((yy - cy) / (y * 0.3)) ** 2 + ((xx - cx) / (x * 0.25)) ** 2) <= 1.0
    volume[uterus] += 120.0
    mask[uterus] = 1

    # Uterine cavity (class 2)
    cavity = (((zz - cz) / (z * 0.2)) ** 2 + ((yy - (cy - 3)) / (y * 0.12)) ** 2 + ((xx - cx) / (x * 0.08)) ** 2) <= 1.0
    volume[cavity] += 80.0
    mask[cavity] = 2

    # Myoma / fibroid (class 3)
    fz, fy, fx = cz + int(z * 0.05), cy + int(y * 0.12), cx + int(x * 0.08)
    fibroid = (((zz - fz) / (z * 0.15)) ** 2 + ((yy - fy) / (y * 0.15)) ** 2 + ((xx - fx) / (x * 0.15)) ** 2) <= 1.0
    volume[fibroid] -= 50.0  # T2 hypointense typical of uterine leiomyoma
    mask[fibroid] = 3

    # Normalize to [0, 1]
    p1, p99 = np.percentile(volume, 1), np.percentile(volume, 99)
    volume = np.clip((volume - p1) / (p99 - p1 + 1e-6), 0.0, 1.0)
    return volume, mask


def train_pipeline(args):
    try:
        import torch
        import torch.nn as nn
        from torch.utils.data import DataLoader, Dataset
        from app.unet import SimpleUnet3D
    except ImportError:
        print("ERROR: PyTorch is required to run the UMD training pipeline.", file=sys.stderr)
        print("Install with: pip install torch", file=sys.stderr)
        return 1

    device = torch.device(args.device if torch.cuda.is_available() and args.device == "cuda" else "cpu")
    print(f"[*] Training device: {device}")

    class UMDDataset(Dataset):
        def __init__(self, data_list):
            self.data = data_list

        def __len__(self):
            return len(self.data)

        def __getitem__(self, idx):
            item = self.data[idx]
            vol, mask = item
            return torch.from_numpy(vol).unsqueeze(0).float(), torch.from_numpy(mask).long()

    if args.synthetic_verify:
        print("[*] Running in synthetic verification mode (generating realistic test phantoms)...")
        train_data = [generate_synthetic_umd_case(i) for i in range(args.synthetic_cases)]
        val_data = [generate_synthetic_umd_case(i + 100) for i in range(max(2, args.synthetic_cases // 4))]
    else:
        if not args.data_dir or not Path(args.data_dir).is_dir():
            print(f"ERROR: Dataset directory '{args.data_dir}' does not exist.", file=sys.stderr)
            return 1
        # Real UMD data loader: reads NIfTI imagesTr / labelsTr
        print(f"[*] Loading real UMD dataset from: {args.data_dir}")
        import SimpleITK as sitk

        data_path = Path(args.data_dir)
        img_dir = data_path / "imagesTr"
        lbl_dir = data_path / "labelsTr"
        if not img_dir.is_dir() or not lbl_dir.is_dir():
            print("ERROR: UMD data directory must contain imagesTr/ and labelsTr/ subdirectories.", file=sys.stderr)
            return 1

        img_files = sorted(list(img_dir.glob("*.nii.gz")) + list(img_dir.glob("*.nii")))
        cases = []
        for img_path in img_files:
            case_name = img_path.name
            lbl_path = lbl_dir / case_name
            if not lbl_path.is_file():
                continue
            vol = sitk.GetArrayFromImage(sitk.ReadImage(str(img_path))).astype(np.float32)
            lbl = sitk.GetArrayFromImage(sitk.ReadImage(str(lbl_path))).astype(np.int64)
            p1, p99 = np.percentile(vol, 1), np.percentile(vol, 99)
            vol = np.clip((vol - p1) / (p99 - p1 + 1e-6), 0.0, 1.0)
            cases.append((img_path, vol, lbl))

        if not cases:
            print("ERROR: No matching image and label pairs found.", file=sys.stderr)
            return 1

        # Patient-level splitting: prevent patient data leakage between train and val
        from collections import defaultdict
        import random

        patient_groups = defaultdict(list)
        for img_path, vol, lbl in cases:
            base_name = img_path.name.replace(".nii.gz", "").replace(".nii", "")
            if "_0000" in base_name:
                patient_id = base_name.split("_0000")[0]
            elif "_" in base_name:
                patient_id = base_name.rsplit("_", 1)[0]
            else:
                patient_id = base_name
            patient_groups[patient_id].append((vol, lbl))

        unique_patients = sorted(patient_groups.keys())
        rng = random.Random(42)
        rng.shuffle(unique_patients)

        split_idx = int(0.8 * len(unique_patients))
        train_patients = set(unique_patients[:split_idx])
        val_patients = set(unique_patients[split_idx:])

        train_data = [item for pid in train_patients for item in patient_groups[pid]]
        val_data = [item for pid in val_patients for item in patient_groups[pid]]
        print(f"[*] Loaded {len(cases)} cases across {len(unique_patients)} unique patients (Train: {len(train_data)} cases / {len(train_patients)} patients, Val: {len(val_data)} cases / {len(val_patients)} patients)")

    train_loader = DataLoader(UMDDataset(train_data), batch_size=args.batch_size, shuffle=True)
    val_loader = DataLoader(UMDDataset(val_data), batch_size=1, shuffle=False)

    model = SimpleUnet3D(in_channels=1, num_classes=5, base_filters=16).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    criterion = nn.CrossEntropyLoss()

    best_myoma_dice = 0.0
    out_path = Path(args.output_weights)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    print(f"[*] Starting training for {args.epochs} epoch(s)...")
    for epoch in range(1, args.epochs + 1):
        model.train()
        train_loss = 0.0
        for x, y in train_loader:
            x, y = x.to(device), y.to(device)
            optimizer.zero_grad()
            out = model(x)
            loss = criterion(out, y)
            loss.backward()
            optimizer.step()
            train_loss += loss.item()

        # Validation
        model.eval()
        val_dices = []
        with torch.no_grad():
            for x, y in val_loader:
                x = x.to(device)
                logits = model(x)
                pred = torch.argmax(logits, dim=1).squeeze(0).cpu().numpy()
                target = y.squeeze(0).numpy()
                val_dices.append(compute_dice_score(pred, target))

        avg_myoma = np.mean([d["myoma"] for d in val_dices])
        avg_fg = np.mean([d["mean_foreground"] for d in val_dices])
        print(f"Epoch {epoch:02d}/{args.epochs:02d} - Loss: {train_loss / len(train_loader):.4f} - Val Myoma Dice: {avg_myoma:.4f} - Mean FG Dice: {avg_fg:.4f}")

        if avg_myoma >= best_myoma_dice or epoch == args.epochs:
            best_myoma_dice = avg_myoma
            torch.save(
                {
                    "epoch": epoch,
                    "state_dict": model.state_dict(),
                    "best_myoma_dice": float(best_myoma_dice),
                    "labels": {1: "uterine_wall", 2: "cavity", 3: "myoma", 4: "nabothian"},
                },
                str(out_path),
            )

    print(f"[+] Training complete. Best weights saved to: {out_path}")
    metrics_report = {
        "dataset": "UMD (Sci Data 11:410)",
        "intended_modality": "T2WI Sagittal Pelvic MRI",
        "best_myoma_dice": float(best_myoma_dice),
        "weights_path": str(out_path),
        "synthetic_verify": args.synthetic_verify,
    }
    with open(out_path.with_suffix(".json"), "w") as f:
        json.dump(metrics_report, f, indent=2)
    return 0


def main():
    parser = argparse.ArgumentParser(description="UMD Uterine Myoma Segmentation Training Pipeline")
    parser.add_argument("--data-dir", type=str, default="", help="Path to UMD dataset root directory")
    parser.add_argument("--output-weights", type=str, default="weights/umd_myoma_unet3d.pt", help="Path to save weights")
    parser.add_argument("--epochs", type=int, default=30, help="Number of training epochs")
    parser.add_argument("--batch-size", type=int, default=1, help="Batch size")
    parser.add_argument("--lr", type=float, default=1e-3, help="Learning rate")
    parser.add_argument("--device", type=str, default="cuda", help="Device (cuda or cpu)")
    parser.add_argument("--synthetic-verify", action="store_true", help="Run self-verification on synthetic pelvic phantoms")
    parser.add_argument("--synthetic-cases", type=int, default=8, help="Number of synthetic cases for verification")
    args = parser.parse_args()
    sys.exit(train_pipeline(args))


if __name__ == "__main__":
    main()

