# ReproCare / AnatomyBridge — Hackathon Demonstration Script & Live Verification Guide

**Last Updated:** 2026-11-02  
**Scope:** Controlled synthetic-data demonstration of ReproCare's end-to-end clinical, imaging, longitudinal ReproTrace, OCR, and 3D Volume Lab workflows.

---

## 1. Pre-Demo Verification (1 Command)

Before starting a live demonstration, verify all 592 automated tests and runtime capabilities:

```bash
# 1. Verify scaffold, migration advisory lock, and production Dockerfile invariants (200 tests)
npm run test:scaffold

# 2. Verify all 38 TypeScript clinical, RBAC, consent, storage, DICOM, ReproTrace & OCR suites (281 tests)
npm run test:app

# 3. Verify all 13 Python 3D U-Net, DICOM codec, de-identification & FastAPI suites (111 tests)
cd imaging-service && ANATOMYBRIDGE_DEV_NO_AUTH=1 python -m pytest tests/ -v --tb=short
```

---

## 2. Starting the Full Stack for Demonstration

### Option A: Docker Compose (Recommended Full-Stack Mode)
```bash
docker compose up --build -d
# Web Application: http://localhost:8080
# Imaging Service Health: http://127.0.0.1:8100/health
```

### Option B: Local Synthetic Verification Checkpoint (Optional for Live 3D U-Net Demo)
To demonstrate live 3D U-Net execution using a clearly labeled `SYNTHETIC_VERIFICATION_ONLY` phantom checkpoint (never presented as a clinical UMD model):
```bash
cd imaging-service
python train_umd.py \
  --data-dir /tmp/reprocare_demo_phantom \
  --out /tmp/reprocare_demo_phantom/umd_synth_demo.pt \
  --synthetic \
  --synthetic-subjects 10 \
  --epochs 3 \
  --allow-numpy-fallback
export ANATOMYBRIDGE_UMD_WEIGHTS=/tmp/reprocare_demo_phantom/umd_synth_demo.pt
```

---

## 3. Step-by-Step 5-Minute Live Walkthrough

1. **Clinician Verification & Patient Consent (`Collaborate` / `Admin` View):**
   - Show that unverified clinicians cannot access patient records (`403 Forbidden`).
   - Approve a clinician licence in the Administrator panel (`clinician_verifications`), then grant granular patient consent (`view_imaging`, `view_reports`, `create_or_edit_findings`) and demonstrate immediate access revocation (`revokeClinicianConsent`).
2. **DICOM Ingestion, Multi-Frame Validation & 3D Volume Lab (`Volume Lab` View):**
   - Load a multi-slice or multi-frame pelvic MRI series (`Explicit VR LE`, `JPEG`, `JPEG 2000`, or `RLE Lossless`).
   - Highlight the preserved 3D physical LPS geometry (`originMm`, `spacingMm`, `directionCosines`, 4×4 `affine4x4`, `frameOfReferenceUid`), multi-planar reconstruction (axial/sagittal/coronal), and STL/OBJ mesh export.
   - Show the **Model Status Badge**: when `ANATOMYBRIDGE_UMD_WEIGHTS` is unset, the UI honestly displays `Model Disconnected (No Validated UMD Weights)` rather than fabricating a mask; when connected to a synthetic phantom checkpoint, it displays the SHA-256 hash and `Experimental / Non-Clinical` provenance badge.
3. **ReproTrace Longitudinal Tracking (`ReproTrace` View):**
   - Compare baseline and follow-up pelvic MRI studies registered in physical LPS space ($\text{mm}$).
   - Show the 6-state correspondence badge (`confirmed_match`, `probable_match`, `possible_match`, `new_finding`, `resolved_finding`, `uncertain`), physical volume trajectory ($\text{mm}^3$ and $\text{mL}$ with $\pm\text{uncertainty}$ intervals), and the **7-category difference attribution** distinguishing `true_growth_or_regression` from `measurement_method_difference`, `segmentation_difference`, `registration_uncertainty`, `protocol_or_spacing_difference`, `scanner_difference`, and `report_vs_image_discrepancy`.
4. **Clinical Report OCR & Source-Grounded Extraction (`Reports` View):**
   - Upload a multi-page PDF, scanned PNG/PDF report (processed via `/usr/bin/tesseract`), DOCX, or TXT report.
   - Show that every extracted measurement and local extractive summary statement links directly to its verbatim `quote`, `[start, end)` character span, and `pageNumber`, remains `unreviewed` until clinician sign-off, and explicitly labels handwriting as unsupported (`handwritingSupported: false`).
5. **Four Distinct Reproductive-Health Condition Pathways (`Conditions` View):**
   - **Uterine Fibroids:** FIGO `0–8` classification, 3-axis dimensions, and longitudinal volume tracking.
   - **Endometriosis:** Explicit safeguard banner confirming that normal ultrasound/MRI never excludes superficial peritoneal endometriosis.
   - **Ovarian Cysts:** Descriptive morphology and O-RADS risk stratification without autonomous benign/malignant diagnosis.
   - **PCOS:** Separate adult Rotterdam (2-of-3) vs adolescent ($<8\text{ years}$ post-menarche, PCOM ultrasound criterion suppressed) evaluation, blocking PCOS diagnosis from ovarian imaging alone.
