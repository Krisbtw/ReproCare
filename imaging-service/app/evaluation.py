"""Multi-class segmentation cohort evaluation with strict absent-class handling,
per-patient performance aggregation, and explicit failed-case reporting (Task 2D & 2G).
"""
from __future__ import annotations

from typing import Any

import numpy as np

from . import metrics
from .models import UMD_DEFAULT_LABEL_MAP


def evaluate_multiclass_case(
    pred_labels_zyx: np.ndarray,
    ref_labels_zyx: np.ndarray,
    spacing_zyx_mm: tuple[float, float, float] = (1.0, 1.0, 1.0),
    label_map: dict[int, str] | None = None,
    include_surface_distances: bool = False,
    case_id: str | None = None,
    subject_id: str | None = None,
) -> dict[str, Any]:
    if pred_labels_zyx.shape != ref_labels_zyx.shape or pred_labels_zyx.ndim != 3:
        raise ValueError(
            f"Prediction shape {pred_labels_zyx.shape} does not match reference shape {ref_labels_zyx.shape}"
        )
    labels = label_map or UMD_DEFAULT_LABEL_MAP
    per_class: dict[str, dict[str, Any]] = {}

    foreground_dices: list[float] = []
    foreground_ious: list[float] = []
    foreground_precisions: list[float] = []
    foreground_sensitivities: list[float] = []
    failure_reasons: list[str] = []

    for cls_id, cls_name in sorted(labels.items()):
        if cls_id == 0:
            continue
        p_bin = pred_labels_zyx == cls_id
        r_bin = ref_labels_zyx == cls_id

        d_val = metrics.dice(p_bin, r_bin)
        i_val = metrics.iou(p_bin, r_bin)
        p_val = metrics.precision(p_bin, r_bin)
        s_val = metrics.sensitivity(p_bin, r_bin)
        fp_fn = metrics.false_positive_negative_analysis(p_bin, r_bin, spacing_zyx_mm)

        entry: dict[str, Any] = {
            "label_id": int(cls_id),
            "dice": round(d_val, 4) if d_val is not None else None,
            "iou": round(i_val, 4) if i_val is not None else None,
            "precision": round(p_val, 4) if p_val is not None else None,
            "sensitivity": round(s_val, 4) if s_val is not None else None,
            "predicted_volume_ml": round(metrics.volume_ml(p_bin, spacing_zyx_mm), 4),
            "reference_volume_ml": round(metrics.volume_ml(r_bin, spacing_zyx_mm), 4),
            **fp_fn,
        }
        if include_surface_distances:
            hd95_val = metrics.hd95(p_bin, r_bin, spacing_zyx_mm)
            entry["hd95_mm"] = round(hd95_val, 4) if hd95_val is not None else None

        per_class[cls_name] = entry

        st = fp_fn.get("presence_state")
        if st == "missed_when_present":
            failure_reasons.append(f"missed_present_class:{cls_name}")
        elif st == "false_positive_when_absent":
            failure_reasons.append(f"spurious_false_positive_when_absent:{cls_name}")
        elif d_val is not None and d_val < 0.50:
            failure_reasons.append(f"low_dice_under_0.50:{cls_name}({d_val:.4f})")

        if d_val is not None:
            foreground_dices.append(d_val)
        if i_val is not None:
            foreground_ious.append(i_val)
        if p_val is not None:
            foreground_precisions.append(p_val)
        if s_val is not None:
            foreground_sensitivities.append(s_val)

    macro_dice = round(float(np.mean(foreground_dices)), 4) if foreground_dices else None
    macro_iou = round(float(np.mean(foreground_ious)), 4) if foreground_ious else None

    result: dict[str, Any] = {
        "case_id": case_id,
        "subject_id": subject_id,
        "per_class": per_class,
        "macro_foreground": {
            "dice": macro_dice,
            "iou": macro_iou,
            "precision": round(float(np.mean(foreground_precisions)), 4) if foreground_precisions else None,
            "sensitivity": round(float(np.mean(foreground_sensitivities)), 4) if foreground_sensitivities else None,
            "evaluated_foreground_classes": len(foreground_dices),
        },
        "failed": len(failure_reasons) > 0,
        "failure_reasons": failure_reasons,
    }
    return result


def aggregate_split_evaluations(
    case_evaluations: list[dict[str, Any]],
    split_name: str,
    label_map: dict[int, str] | None = None,
) -> dict[str, Any]:
    labels = label_map or UMD_DEFAULT_LABEL_MAP
    class_summary: dict[str, dict[str, Any]] = {}

    all_class_mean_dices: list[float] = []
    all_class_mean_ious: list[float] = []
    all_class_mean_precisions: list[float] = []
    all_class_mean_sensitivities: list[float] = []

    for cls_id, cls_name in sorted(labels.items()):
        if cls_id == 0:
            continue
        dices: list[float] = []
        ious: list[float] = []
        precisions: list[float] = []
        sensitivities: list[float] = []
        fp_vols: list[float] = []
        fn_vols: list[float] = []
        spurious_comp = 0
        missed_comp = 0
        state_counts = {
            "present_in_both": 0,
            "absent_in_both": 0,
            "false_positive_when_absent": 0,
            "missed_when_present": 0,
        }

        for ev in case_evaluations:
            c_info = ev.get("per_class", {}).get(cls_name)
            if not c_info:
                continue
            st = c_info.get("presence_state", "absent_in_both")
            state_counts[st] = state_counts.get(st, 0) + 1
            if c_info.get("dice") is not None:
                dices.append(float(c_info["dice"]))
            if c_info.get("iou") is not None:
                ious.append(float(c_info["iou"]))
            if c_info.get("precision") is not None:
                precisions.append(float(c_info["precision"]))
            if c_info.get("sensitivity") is not None:
                sensitivities.append(float(c_info["sensitivity"]))
            fp_vols.append(float(c_info.get("fp_volume_ml", 0.0)))
            fn_vols.append(float(c_info.get("fn_volume_ml", 0.0)))
            spurious_comp += int(c_info.get("spurious_fp_components", 0))
            missed_comp += int(c_info.get("missed_fn_components", 0))

        mean_dice = round(float(np.mean(dices)), 4) if dices else None
        mean_iou = round(float(np.mean(ious)), 4) if ious else None
        mean_prec = round(float(np.mean(precisions)), 4) if precisions else None
        mean_sens = round(float(np.mean(sensitivities)), 4) if sensitivities else None

        if mean_dice is not None:
            all_class_mean_dices.append(mean_dice)
        if mean_iou is not None:
            all_class_mean_ious.append(mean_iou)
        if mean_prec is not None:
            all_class_mean_precisions.append(mean_prec)
        if mean_sens is not None:
            all_class_mean_sensitivities.append(mean_sens)

        class_summary[cls_name] = {
            "label_id": int(cls_id),
            "cases_evaluated_for_overlap": len(dices),
            "cases_absent_in_both": state_counts["absent_in_both"],
            "cases_present_in_both": state_counts["present_in_both"],
            "cases_false_positive_when_absent": state_counts["false_positive_when_absent"],
            "cases_missed_when_present": state_counts["missed_when_present"],
            "mean_dice": mean_dice,
            "mean_iou": mean_iou,
            "mean_precision": mean_prec,
            "mean_sensitivity": mean_sens,
            "mean_fp_volume_ml": round(float(np.mean(fp_vols)), 4) if fp_vols else 0.0,
            "mean_fn_volume_ml": round(float(np.mean(fn_vols)), 4) if fn_vols else 0.0,
            "total_spurious_fp_components": spurious_comp,
            "total_missed_fn_components": missed_comp,
        }

    # Per-patient & per-case aggregation and explicit failed-cases list
    per_case: list[dict[str, Any]] = []
    failed_cases: list[dict[str, Any]] = []
    by_subject: dict[str, list[dict[str, Any]]] = {}

    for idx, ev in enumerate(case_evaluations):
        cid = ev.get("case_id") or f"case_{idx + 1:04d}"
        sid = ev.get("subject_id") or cid
        macro = ev.get("macro_foreground", {})
        reasons = list(ev.get("failure_reasons", []))
        case_summary = {
            "case_id": cid,
            "subject_id": sid,
            "macro_dice": macro.get("dice"),
            "macro_iou": macro.get("iou"),
            "failed": bool(reasons),
            "failure_reasons": reasons,
            "per_class_dice": {
                cname: ev.get("per_class", {}).get(cname, {}).get("dice")
                for k, cname in sorted(labels.items())
                if k != 0
            },
        }
        per_case.append(case_summary)
        by_subject.setdefault(sid, []).append(ev)
        if reasons:
            failed_cases.append(case_summary)

    per_patient: dict[str, dict[str, Any]] = {}
    for sid, subj_evals in sorted(by_subject.items()):
        s_dices = [
            float(e["macro_foreground"]["dice"])
            for e in subj_evals
            if e.get("macro_foreground", {}).get("dice") is not None
        ]
        s_ious = [
            float(e["macro_foreground"]["iou"])
            for e in subj_evals
            if e.get("macro_foreground", {}).get("iou") is not None
        ]
        cls_means: dict[str, float | None] = {}
        for k, cname in sorted(labels.items()):
            if k == 0:
                continue
            c_vals = [
                float(e["per_class"][cname]["dice"])
                for e in subj_evals
                if e.get("per_class", {}).get(cname, {}).get("dice") is not None
            ]
            cls_means[cname] = round(float(np.mean(c_vals)), 4) if c_vals else None
        per_patient[sid] = {
            "subject_id": sid,
            "num_cases": len(subj_evals),
            "mean_macro_dice": round(float(np.mean(s_dices)), 4) if s_dices else None,
            "mean_macro_iou": round(float(np.mean(s_ious)), 4) if s_ious else None,
            "per_class_mean_dice": cls_means,
            "any_failed_case": any(bool(e.get("failure_reasons")) for e in subj_evals),
        }

    return {
        "split_name": split_name,
        "num_cases": len(case_evaluations),
        "num_subjects": len(per_patient),
        "per_class": class_summary,
        "per_patient": per_patient,
        "per_case": per_case,
        "failed_cases_count": len(failed_cases),
        "failed_cases": failed_cases,
        "macro_foreground": {
            "mean_dice": round(float(np.mean(all_class_mean_dices)), 4) if all_class_mean_dices else None,
            "mean_iou": round(float(np.mean(all_class_mean_ious)), 4) if all_class_mean_ious else None,
            "mean_precision": round(float(np.mean(all_class_mean_precisions)), 4) if all_class_mean_precisions else None,
            "mean_sensitivity": round(float(np.mean(all_class_mean_sensitivities)), 4)
            if all_class_mean_sensitivities
            else None,
            "absent_class_policy": (
                "Classes absent in both prediction and ground truth return None and are excluded from mean_dice/mean_iou "
                "rather than being assigned 1.0."
            ),
        },
    }
