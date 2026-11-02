# ReproCare — Authoritative Development & Verification Checklist

**Last Updated:** 2026-11-02  
**Legend:** ✅ Implemented & verified by automated tests in this repository · 🟧 Blocked by external dataset, clinical cohort, or hosting credentials · ⚖️ Requires external clinical, ethics (IEC), or regulatory (CDSCO) authority

---

## 1. Master Engineering & Acceptance Checklist

| Subsystem / Requirement | Status | Verification Evidence & Notes |
| :--- | :---: | :--- |
| **Frontend & Production Server (`Dockerfile`)** | ✅ | Multi-stage `node:22-bookworm-slim` build compiling `.output/server/index.mjs` (`npm run build` decoupled from `npm run db:migrate`), running under `tini` as non-root `USER node` (`uid=1000`) with `HEALTHCHECK`. |
| **Database Schema & Advisory-Locked Migrations (`0001`–`0013`)** | ✅ | 13 SQL migrations in `migrations/` (`0001_auth.sql` through `0013_sprint5_dicom_and_condition_workflows.sql`), applied under PostgreSQL session advisory lock `pg_advisory_lock(72839401)` in `scripts/migrate.mjs`. |
| **Authentication, RBAC & Clinician Verification** | ✅ | Fail-closed role resolution (`src/lib/clinic/server.ts`), self-escalation blocked, clinician actions gated on `clinician_verifications.status IN ('verified', 'approved')` (`src/lib/clinic/rbac.test.ts`). |
| **Patient–Clinician Collaboration & Granular Consent** | ✅ | 8-permission granular consent (`src/lib/clinic/collaboration.ts`), expiry validation, and immediate access revocation (`src/lib/clinic/collaboration-consent.test.ts`). |
| **Persistent Medical Imaging Storage, Atomic Purge & Backup/Restore** | ✅ | Content-addressed SHA-256 storage on dedicated volumes (`imaging_storage_data`, `imaging_backup_data`), two-phase `.Trash-staging` atomic purge, durable `.audit/audit-outbox.jsonl`, and verified `restoreImagingStorageBackup()` (`src/lib/imaging/storage.test.ts`). |
| **DICOM Uncompressed & Compressed Transfer Syntaxes** | ✅ | Explicit VR LE (`.1.2.1`), Implicit VR LE (`.1.2`), Deflated Explicit VR LE (`.1.2.1.99`), RLE Lossless (`.1.2.5`), JPEG (`.50`, `.51`, `.57`, `.70`), and JPEG 2000 (`.90`, `.91`) verified in both TS (`src/lib/dicom/interoperability.test.ts`) and Python (`imaging-service/tests/test_dicom_io.py`). |
| **Enhanced Multi-Frame DICOM & 4×4 LPS Affine Geometry** | ✅ | `SharedFunctionalGroupsSequence` and `PerFrameFunctionalGroupsSequence` validation, slice ordering, and 4×4 physical LPS `affine4x4` preservation through STL/OBJ mesh export (`src/lib/dicom/interoperability.test.ts`). |
| **DICOM PS3.15 & NIfTI-1 De-identification** | ✅ | Scrubs standard PHI tags, odd-group private tags, nested sequences, and NIfTI headers/extensions; remaps UIDs deterministically via HMAC-SHA256; preserves original bytes; flags burned-in pixel overlay risk (`manualReviewRequired: true`, `claimCompleteAnonymisation: false`). |
| **3D U-Net (`SimpleUnet3D`) Architecture & Full-Graph Backpropagation** | ✅ | Custom 3D U-Net (`imaging-service/app/unet.py`, MONAI not used). All **50/50 trainable parameter tensors** receive finite non-zero gradients and update under AdamW (`verify_parameter_gradients_and_optimizer_updates`); `allow_numpy_fallback=False` blocks silent fallback (`test_sprint2_segmentation_and_training.py`). |
| **Real 300-Patient UMD Model Training & Clinical Weights** | 🟧 | Blocked by external dataset: the public [UMD Figshare NIfTI archive](https://pmc.ncbi.nlm.nih.gov/articles/PMC11035617/) (`https://doi.org/10.6084/m9.figshare.23541312`, CC BY 4.0) is not bundled in the repository. `/models` honestly reports `connected: false` until trained weights are mounted at `ANATOMYBRIDGE_UMD_WEIGHTS`; synthetic phantom checkpoints are stamped `SYNTHETIC_VERIFICATION_ONLY`. |
| **ReproTrace Registration, 6-State Correspondence & 7-Category Attribution** | ✅ | Rigid 6-DOF ($\det(R)=+1$) + affine 12-DOF validation, 6 correspondence states (`confirmed_match` through `uncertain`), and 7 attribution categories (including `scanner_difference`) verified in `src/lib/reprotrace/longitudinal-intelligence.test.ts`. |
| **OCR (`/usr/bin/tesseract`) & Source-Grounded Report Intelligence** | ✅ | Live `/usr/bin/tesseract` (`tesseract 5.3.0`, `eng`) verified on PNG reports; multi-page hybrid PDF, DOCX, and TXT extraction with page numbers and `[start, end)` quote offsets; `handwritingSupported: false`; safe `local_extractive` default (`src/lib/reports/report-intelligence.test.ts`). |
| **Four Reproductive-Health Clinical Workflows** | ✅ | Uterine Fibroids (FIGO 0–8), Endometriosis (`normal_imaging_excludes_endometriosis: false`), Ovarian Cysts (`benign_malignant_classified: false`), and PCOS (adult Rotterdam 2-of-3 vs adolescent $<8\text{y}$ post-menarche PCOM suppression) verified (`src/lib/clinic/condition-workflows.test.ts`). |
| **Complete 6-Stage End-to-End Hackathon Demo Journey** | ✅ | Verified in `src/lib/clinic/hackathon-demo-e2e.test.ts` (Stages A through F on a continuous synthetic patient record). |
| **Multi-Centre Clinical Validation, IEC Ethics & CDSCO Licensing** | ⚖️ | Technical pre-regulatory documentation and ISO 14971 risk matrix completed in `docs/REGULATORY_READINESS.md`; requires external clinical experts, IEC ethical approval, and formal CDSCO MDR-2017 licensing prior to any clinical use. |

---

## 2. Verified Automated Test Counts (2026-11-02)

- **TypeScript Application Test Suites (`npm run test:app` — 39 `.test.ts` files):** **282 passed, 0 failed**
- **Scaffold, Migration & Production Architecture Tests (`npm run test:scaffold` — 9 `.test.mjs` files):** **200 passed, 0 failed**
- **Python Medical Imaging & AI Segmentation Tests (`pytest` — 13 `test_*.py` files):** **111 passed, 0 failed**
- **Total Automated Tests Executed:** **593 passed, 0 failed**
