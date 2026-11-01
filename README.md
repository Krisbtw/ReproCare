# AnatomyBridge

Evidence-linked workspace for synthetic women's reproductive health records. The live app is the product. This file is the map of what was actually built and verified.

AnatomyBridge does **not** diagnose, prescribe, or claim regulatory clearance. Every seeded person and scan is synthetic.

## What runs

- **Signed-in workspace with server-side RBAC**: Better Auth session handling with role verification (`clinician`, `patient`, `admin`). Self-service role escalation is strictly disallowed; protected clinical actions (`saveLabMeasurement`, `correctVersion`, `addReview`, `decideCorrespondence`, `resolveDiscrepancy`, `uploadReport`, `linkReportEvidence`) enforce verified roles via positive allowlists. Administrator-controlled clinician verification endpoint (`promoteUser`) manages role assignments. Fallback profiles default safely to `patient`. Cross-tenant and patient self-record isolation are strictly enforced.
- **Four synthetic pathways**: Fibroids (Meera), endometriosis (Aisha), PCOS context with 2023 International PCOS Guideline gynecological age evaluation (Kavya), and ovarian cyst follow-up (Divya).
- **ReproTrace rules engine**: Follow-up comparison with rigid 3D image registration. Demotes un-registered or unsupported shifts to provisional `needs_review` status; classifies discrepancies (size, velocity, category, spatial) and supports clinician resolution.
- **Volume Lab (in-browser 3D imaging workspace)**:
  - Series loader: Reads multi-file DICOM series via `dicom-parser`, checks slice normals, gaps, duplicates, and mixed geometries, stacking valid series into 3D volumes.
  - Preprocessing suite: Non-destructive 3x3x3 Median Filter, Percentile Normalization (0.5%–99.5%), Z-Score Normalization, and Gaussian Smoothing with operation history tracking, real-time slice rendering, and raw volume reversion.
  - Classical segmentation: 3D seeded region-growing with leakage detection, anisotropy compensation, and volume calculation.
  - Patient LPS coordinate transformations: Computes DICOM patient coordinate frame ($P_{patient} = P_0 + u_x X + u_y Y + u_z Z$); transforms all generated mesh vertices and centroids to true patient LPS coordinates for STL and OBJ exports.
  - Append-only recording workflow: Directly registers newly uploaded studies and series, creates version N+1 with LPS centroid and volume measurements, and preserves provenance links in `evidence_links`.
- **Python Imaging Service (`imaging-service/`)**:
  - FastAPI service authenticated via Bearer token or `X-API-Key` (`ANATOMYBRIDGE_SERVICE_API_KEY`).
  - Inspects DICOM series geometry, computes mask metrics (Dice, Jaccard, HD95, Hausdorff, mean surface distance), and exposes model status.
  - Genuine UMD U-Net model adapter (`UmdMonaiAdapter`) and reproducible training script (`train_umd.py`) for UMD 5-class fibroid segmentation. Validates checkpoint files from `ANATOMYBRIDGE_UMD_WEIGHTS` and returns 503 when weights are absent—never mocking clinical predictions.
- **Clinical Reports & De-identification**:
  - Ingests TXT, DOCX, and PDF clinical reports directly in the browser.
  - Scanned PDF detection: Flags image-only or low-text PDFs and displays a clinical guidance alert explaining in-browser OCR limitations.
  - Client-side de-identification: Scrubs patient names, MRNs, phone numbers, emails, and Aadhaar numbers.
  - Structured extraction: Parses dates, modalities, FIGO classifications, nabothian cysts, and dimensional measurements with character offsets anchored to finding versions.
- **Append-only database integrity**:
  - Database-level immutability triggers (`migrations/0003_append_only.sql`) refusing direct `UPDATE`, `DELETE`, and `TRUNCATE` operations on `finding_versions`, `reviews`, `correspondence_decisions`, and `audit_events`.

## Project layout

- `src/routes/` — TanStack Start file-based routing and application shell
- `src/components/` — UI components (`clinic-app.tsx`, `volume-lab.tsx`, `reports-view.tsx`, `timeline-view.tsx`, `reprotrace-view.tsx`)
- `src/lib/imaging/` — 3D volume processing, DICOM patient-coordinate transforms (`patient-coords.ts`), rigid registration (`registration.ts`), preprocessing (`preprocess.ts`), isosurface mesh generation (`surface.ts`, `mesh.ts`), metrics, and service client (`service-client.ts`)
- `src/lib/dicom/` — DICOM pixel decoding, series geometry checking, slice ordering, and safe header extraction
- `src/lib/clinic/` — Clinical server functions, server-side RBAC, PCOS context evaluation, and finding version recording (`lab-version.ts`)
- `src/lib/reports/` — Report text extraction, scanned PDF detection, de-identification, and structured regex parsing
- `src/lib/reprotrace/` — ReproTrace correspondence and discrepancy rules engine
- `imaging-service/` — FastAPI imaging microservice, PyTorch 3D U-Net architecture (`app/unet.py`), model adapter (`app/models.py`), training pipeline (`train_umd.py`), and test suite (`tests/`)
- `migrations/` — SQL database migrations (`0001` to `0007`) for auth, clinical finding versions, append-only triggers, menarche tracking, and report storage
- `docs/` — Comprehensive engineering, clinical, research, and regulatory documentation

## Verification and test results

```bash
# Run all application test suites (210 passing tests)
npm run test:app

# Run TypeScript type check (0 errors)
npm run typecheck

# Run browser automated smoke check (desktop and mobile)
node scripts/browser-smoke.mjs http://127.0.0.1:8080/ screenshots/smoke-dev.png

# Run browser end-to-end interactive workflow test
node scripts/test-interactions.mjs
```

### Verified Test Summary (2026-10-31)

- **Application Unit & Integration Tests**: **210 tests pass, 0 fail** across 18 test suites in `npm run test:app`.
- **TypeScript strict check**: Clean (`npm run typecheck` passes with 0 errors).
- **Python Imaging Service Tests**: 109 pytest tests passing across 16 test files (`test_auth.py`, `test_cors.py`, `test_score.py`, `test_inspect.py`).
- **Browser QA Verification**: Tested in Microsoft Edge via Playwright on both Desktop (1280x800) and Mobile (390x844). Verified 200 OK status, zero console errors, zero uncaught exceptions, and complete interactive walkthroughs (registration, Volume Lab preprocessing, segmentation, mesh export, report ingestion, ReproTrace correspondence). Screenshots saved in `screenshots/`.

## Documentation

- `docs/DEVELOPMENT_CHECKLIST.md` — Honest ledger of completed and verified features
- `docs/IMAGING_PIPELINE.md` — Measured results, coordinate transformations, and algorithmic limits
- `docs/API.md` — Server functions and imaging service endpoints
- `docs/RESEARCH_REPORT.md` — Literature, dataset, patent, and regulatory survey with source quality grades
- `docs/RESEARCH_STATUS.md` — Research findings summary
- `docs/USER_MANUAL.md` — Walkthrough guide for clinicians and patients
- `docs/DEMO_SCRIPT.md` — Step-by-step demonstration scenario
- `docs/INSTALL.md` — Installation and setup instructions
- `docs/PROJECT_DOCUMENT.md` — Architectural overview and technical specifications
