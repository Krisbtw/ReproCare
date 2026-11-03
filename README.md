# ReproCare (AnatomyBridge Clinical & 3D Imaging Workspace)

**ReproCare** is an evidence-linked reproductive-health imaging, longitudinal lesion tracking (`ReproTrace`), and clinical report intelligence proof-of-principle. Within the user interface, the 3D imaging and longitudinal workspace is branded as **AnatomyBridge**.

ReproCare does **not** autonomously diagnose, prescribe, or claim regulatory clearance (CDSCO / FDA / CE). Every seeded patient record and scan in the repository is synthetic (`SYNTHETIC_VERIFICATION_ONLY`).

---

## 1. What Runs & What Is Verified

- **Authenticated Workspace with Fail-Closed Server-Side RBAC & Consent (`src/lib/clinic/server.ts`, `src/lib/clinic/collaboration.ts`)**:
  - Better Auth session handling with server-side role resolution (`patient`, `clinician`, `admin`).
  - Self-service privilege escalation is blocked (`setRole` forbids elevating to `clinician` or `admin`).
  - Clinicians require an administrator-approved record in `clinician_verifications` (`status IN ('verified', 'approved')` with non-empty `licence_no` and `registry`) **and** an active, non-expired, non-revoked patient consent grant in `patient_clinician_consents` with granular permission scopes (`view_demographics`, `view_imaging`, `view_reports`, `view_findings`, `view_longitudinal_history`, `add_annotations`, `review_ai_findings`, `approve_or_reject_findings`).
  - Consent revocation (`revokeClinicianConsent`) takes effect immediately while preserving immutable `audit_events`.
- **Persistent Medical Imaging Storage, Atomic Purge & Backup Restoration (`src/lib/imaging/storage.server.ts`)**:
  - Content-addressed SHA-256 storage on dedicated persistent volumes (`imaging_storage_data`, `imaging_backup_data`), decoupled from PostgreSQL (`postgres_data`).
  - Two-phase atomic purge (`purgeImagingArtifact`) with `.Trash-staging` rollback if DB transactions fail, durable `.audit/audit-outbox.jsonl` queue with `flushPendingAuditOutbox()`, and verified backup/restoration (`createImagingStorageBackup`, `restoreImagingStorageBackup`, `reconcileImagingStorageConsistency`).
- **DICOM Interoperability, Multi-Frame Expansion & PS3.15 / NIfTI De-identification (`src/lib/dicom/codec.ts`, `src/lib/dicom/deidentify.ts`, `src/lib/imaging/series.ts`)**:
  - Supports Explicit VR Little Endian (`.1.2.1`), Implicit VR Little Endian (`.1.2`), Deflated Explicit VR Little Endian (`.1.2.1.99`), RLE Lossless (`.1.2.5`), JPEG Baseline/Extended/Lossless (`.1.2.4.50`, `.51`, `.57`, `.70`), and JPEG 2000 Lossless/Lossy (`.1.2.4.90`, `.91`).
  - Expands Enhanced MR multi-frame series (`SharedFunctionalGroupsSequence`, `PerFrameFunctionalGroupsSequence`, `GridFrameOffsetVector`, `SpacingBetweenSlices`) and validates 3D physical LPS geometry (`originMm`, `spacingMm`, `directionCosines`, 4×4 `affine4x4`, `frameOfReferenceUid`) through watertight 3D STL/OBJ mesh export.
  - Scrubs DICOM PS3.15 identifying tags, odd-group private tags, and nested sequences (`deidentifyDicomBytes`) and NIfTI-1 headers/extensions (`deidentifyNiftiBytes`), preserving original source bytes and flagging burned-in pixel annotation risk (`manualReviewRequired: true`, `claimCompleteAnonymisation: false`).
- **Python FastAPI Medical Imaging & 3D U-Net Service (`imaging-service/`)**:
  - Protected by constant-time `X-Service-Key` / `X-API-Key` verification (`ANATOMYBRIDGE_SERVICE_API_KEY`) and origin-restricted CORS (`ANATOMYBRIDGE_CORS_ORIGINS`).
  - Custom 3D U-Net (`SimpleUnet3D` in `imaging-service/app/unet.py` — PyTorch `nn.Module` + full-graph differentiable backend across all **50 trainable parameter tensors**; MONAI is not used).
  - Reproducible training pipeline (`imaging-service/train_umd.py`) with non-fallback guard (`allow_numpy_fallback=False`), subject-level 70/15/15 split with zero leakage, absent-class evaluation (`dice = None` when absent in both masks), and SHA-256 checkpoint registry with rollback (`checkpoint_registry.json`).
  - Returns HTTP `503` (`connected: false`) when validated UMD weights are not mounted, and stamps synthetic phantom checkpoints explicitly as `SYNTHETIC_VERIFICATION_ONLY`.
- **ReproTrace Longitudinal Intelligence (`src/lib/reprotrace/`)**:
  - Rigid 6-DOF ($\det(R)=+1$, $R^T R = I$) and affine 12-DOF registration validation (`src/lib/imaging/registration.ts`), demoting unregistered or low-NCC ($<0.50$) pairs to `uncertain` / `provisional`.
  - Classifies pairs across 6 states (`confirmed_match`, `probable_match`, `possible_match`, `new_finding`, `resolved_finding`, `uncertain`) and attributes longitudinal differences across 7 categories (`genuine_anatomical_change` / `true_growth_or_regression`, `measurement_method_difference`, `segmentation_difference`, `registration_uncertainty`, `protocol_or_spacing_difference`, `scanner_difference`, `report_vs_image_discrepancy`).
- **Clinical Report OCR & Source-Grounded Intelligence (`src/lib/reports/`)**:
  - Page-selective extraction for native PDFs, scanned/hybrid multi-page PDFs, PNG/JPEG report images (via `/usr/bin/tesseract`), DOCX, and TXT files while preserving page numbers (`1..N`) and verbatim `[start, end)` character spans.
  - Explicitly marks handwriting as unsupported (`handwritingSupported: false`, `ocrAccuracyClaimed: false`).
  - Defaults to zero-network `local_extractive` report interpretation (`src/lib/reports/llm-interpreter.ts`); extracted and AI-summarized items remain `unreviewed` until clinician sign-off (`decideExtractedFinding`).
- **Four Distinct Reproductive-Health Condition Workflows (`src/lib/clinic/workflows.ts`)**:
  - **Uterine Fibroids**: FIGO `0–8` subclassification, 3-axis dimensions, physical volume ($\text{mm}^3$), and longitudinal delta tracking.
  - **Endometriosis**: Enforces `normal_imaging_excludes_endometriosis: false` so normal ultrasound/MRI never rules out superficial endometriosis.
  - **Ovarian Cysts**: Descriptive morphology (`simple_unilocular`, `hemorrhagic`, `endometrioma_compatible`, `dermoid_compatible`, `indeterminate_incomplete`) with `benign_malignant_classified: false`.
  - **PCOS**: Separates adult Rotterdam (2-of-3) vs adolescent ($<8\text{ years}$ post-menarche, PCOM ultrasound criterion suppressed) cohorts and blocks PCOS diagnosis from ovarian imaging alone.

---

## 2. Project Layout

- `src/routes/` — TanStack Start file-based routes and API proxies
- `src/components/` — React UI components (`clinic-app.tsx`, `volume-lab.tsx`, `reports-view.tsx`, `timeline-view.tsx`, `reprotrace-view.tsx`)
- `src/lib/clinic/` — Server functions (`server.ts`), RBAC, collaboration/consent (`collaboration.ts`), and 4 condition pathways (`workflows.ts`)
- `src/lib/imaging/` — Persistent storage (`storage.server.ts`), 3D volume assembly (`series.ts`), patient LPS coordinates (`patient-coords.ts`), rigid registration (`registration.ts`), preprocessing (`preprocess.ts`), classical seeded segmentation (`segment.ts`), and STL/OBJ mesh export (`isosurface.ts`, `mesh.ts`)
- `src/lib/dicom/` — Multi-syntax DICOM codec (`codec.ts`), PS3.15 & NIfTI-1 de-identification (`deidentify.ts`), and series loader
- `src/lib/reports/` — `/usr/bin/tesseract` OCR (`ocr.ts`), PDF/DOCX/TXT extraction (`text.ts`), structured parsing (`extract.ts`), and source-grounded LLM interpreter (`llm-interpreter.ts`)
- `src/lib/reprotrace/` — Longitudinal registration gating, 6-state correspondence (`matching.ts`), and 7-category attribution (`trends.ts`, `params.ts`, `engine.ts`)
- `imaging-service/` — Python 3.12 FastAPI service, `SimpleUnet3D` (`app/unet.py`), `UmdMonaiAdapter` (`app/models.py`), `train_umd.py`, and pytest suite (`tests/`)
- `migrations/` — 13 sequential PostgreSQL migrations (`0001_auth.sql` through `0013_sprint5_dicom_and_condition_workflows.sql`) executed under `pg_advisory_lock(72839401)` via `scripts/migrate.mjs`
- `docs/` — Complete engineering, security, dataset governance, model validation, DICOM, ReproTrace, OCR, regulatory readiness, deployment, testing, and demo documentation

---

## 3. Verification & Test Results

```bash
# 1. Verify authentication invariant gate
npm run check:auth

# 2. Run the TypeScript application test suites
npm run test:app

# 3. Run the scaffold, migration advisory-lock & production Dockerfile test suites
npm run test:scaffold

# 4. Run the Python imaging-service test suites
cd imaging-service && ANATOMYBRIDGE_DEV_NO_AUTH=1 python -m pytest tests/ -v --tb=short
```

### Verified Test Summary (2026-11-03, local Windows run)
- **TypeScript Application Tests (`test:app`)**: **326 passed, 0 failed, 0 skipped** (includes `src/lib/clinic/reprotrace-workflow.test.ts`, 13 tests, `src/lib/imaging/auto-seed.test.ts`, 2 tests, and `src/lib/reprotrace/scenarios.test.ts`, 16 tests).
- **Scaffold Tests (`test:scaffold`)**: **201 passed, 0 failed**.
- **TypeScript strict check (`tsc --noEmit`)** clean; **`npm run build`** succeeds.
- **Python tests**: not re-run on 2026-11-03 (no Python interpreter on the verifying machine). Last recorded result below.
- **CI / Docker / Vercel / Supabase**: not re-verified on 2026-11-03.

### Earlier Test Summary (2026-11-02, historical)
- **TypeScript Application Tests (`test:app`)**: **282 passed, 0 failed** across 39 `.test.ts` files (including `src/lib/clinic/hackathon-demo-e2e.test.ts`).
- **Scaffold & Production Architecture Tests (`test:scaffold`)**: **200 passed, 0 failed** across 9 `scripts/*.test.mjs` files.
- **Python Medical Imaging & AI Tests (`pytest`)**: **111 passed, 0 failed** across 13 `imaging-service/tests/test_*.py` files.
- **Total Automated Tests**: **593 passed, 0 failed**.
