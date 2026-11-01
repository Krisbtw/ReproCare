# REPROCARE IMPLEMENTATION PLAN
**Planning Agent Audit — 2026-11-01**  
**For: Gemini Implementation Agent**

---

## 1. REPOSITORY SNAPSHOT

| Field | Value |
|---|---|
| Repository | https://github.com/Krisbtw/ReproCare.git |
| Branch | `main` |
| Latest Commit | `98d8eac` |
| Commit Summary | "Complete 10 prioritized components: UMD U-Net, patient coordinates, RBAC, registration, service auth, and browser verification" |
| Total TS Application Tests | 203 passing, 0 failing |
| Total Python Tests | 25 (BLOCKED — see P0 bug below) |

---

## 2. EXECUTIVE AUDIT

### What is Currently Working

- **Frontend application** renders on desktop (1280×800) and mobile (390×844) with zero console errors, verified via Playwright.
- **DICOM series processing**: browser-side parsing via `dicom-parser`, slice ordering, gap/duplicate/orientation validation, pixel decode with rescale slope/intercept.
- **Volume Lab**: drop-zone upload, series picker, 3D region-growing segmentation from user-placed seed, Taubin-smoothed marching-tetrahedra surface, STL/OBJ export, processing record export.
- **DICOM LPS coordinate transformation** (`src/lib/imaging/patient-coords.ts`): creates `PatientFrame` from orientation cosines, transforms mesh vertices to DICOM patient space.
- **Preprocessing suite** (`preprocess.ts`): median filter, percentile normalization, z-score normalization, Gaussian smoothing, non-destructive revert.
- **Rigid registration module** (`registration.ts`): volume moments, 3x3 Jacobi eigensolver, NCC quality gate.
- **ReproTrace rules engine**: correspondence proposals (5 categories), discrepancy detection (5 classes), append-only versioning.
- **Clinical report ingestion**: TXT, DOCX, PDF text extraction; scanned-PDF detection; rule-based de-identification; evidence quote linking.
- **Server-side RBAC** (`clinic/server.ts`): `setRole` blocks patient→clinician/admin and clinician→admin self-escalation; protected actions check verified role; patient ownership enforced.
- **Database migrations 0001–0005**: auth, clinical schema, append-only triggers, menarche year, report storage.
- **Python imaging service** (`imaging-service/`): FastAPI with DICOM geometry inspection, mask scoring, model listing, and segmentation endpoint — but see P0 bug below.

### What is Partially Working

- **AI segmentation end-to-end**: The Python adapter and training pipeline exist but the Volume Lab **never calls** the Python `/segment/{model_id}` endpoint. Only classical seeded region-growing is available in the browser.
- **CORS for service token**: `VITE_IMAGING_SERVICE_TOKEN` is a `VITE_`-prefixed build-time variable exposed in browser JavaScript bundles — a long-lived secret in browser-accessible code.
- **Image registration in ReproTrace**: `registerVolumes()` is implemented and tested but is **never called** with real uploaded data. It is only used in unit tests.
- **Follow-up study linking**: `insertLabVersion` accepts `newStudy`/`newSeries`, but there is no UI confirmation that the uploaded series matches the study the finding cites.

### What is Broken (Critical)

**P0 — FastAPI service CANNOT START on authenticated routes.**

`Depends` and `Header` are used in `verify_service_auth` (lines 68–71) and in every protected route decorator, but are **not imported**. Line 13 of `imaging-service/app/main.py` reads:

```python
from fastapi import FastAPI, File, HTTPException, UploadFile
```

`Depends` and `Header` are absent. The service raises `NameError: name 'Depends' is not defined` on the first request to `/models`, `/series/inspect`, `/metrics/score`, or `/segment/{model_id}`. This means **all 25 pytest tests fail** (the test client imports `app.main`, which triggers the function definitions that reference `Depends` and `Header`).

### What is Missing

- **No AI inference in the browser UI**: No UI button, no API call, no server route calls `POST /segment/{model_id}`.
- **No GPU training execution**: `train_umd.py` exists but no UMD dataset access nor GPU training has been executed.
- **LLM integration for explanations**: `explainFinding()` is rule-based only. No LLM API calls.

---

## 3. BUG AND TASK REGISTER

| ID | Priority | Problem | Exact File | Function/Component | Root Cause | Required Change | Acceptance Test |
|---|---|---|---|---|---|---|---|
| **T01** | **P0** | `Depends` and `Header` not imported; service crashes on all authenticated routes | `imaging-service/app/main.py` | `verify_service_auth`, all route handlers with `Depends(verify_service_auth)` | Line 13 imports only `FastAPI, File, HTTPException, UploadFile` | Add `Depends, Header` to the line 13 import | `python -c "from app.main import app"` exits 0; all 25 pytest tests pass |
| **T02** | **P1** | `VITE_IMAGING_SERVICE_TOKEN` is browser-accessible; long-lived service secret in JS bundle | `src/lib/imaging/service-client.ts` | `serviceToken()` | `VITE_*` env vars are inlined by Vite into client JS | Replace with server-side proxy; remove `VITE_IMAGING_SERVICE_TOKEN` | `grep -r "IMAGING_SERVICE_TOKEN" .vercel/output/static/` → empty |
| **T03** | **P1** | Volume Lab has no AI segmentation path | `src/components/volume-lab.tsx` | `VolumeLab` component | No UI element or API call reaches `POST /segment/{model_id}` | Add optional AI segmentation card calling proxy route, rendering multi-label mask | Browser: load sample → AI segment button → label counts displayed |
| **T04** | **P1** | No server-side proxy route for imaging service | New file needed | `src/routes/api/imaging-proxy.ts` | Entire direct browser→Python service call chain exposes token | Create TanStack Start server function that forwards to Python service with server-side credentials | Proxy route responds 200; token not in browser bundle |
| **T05** | **P1** | `roleOf()` falls back to `"clinician"` when profile row is missing | `src/lib/clinic/server.ts` | `roleOf()`, line 39 | `return rows[0]?.role ?? "clinician"` — missing profile grants elevated access silently | Change fallback to `"patient"` | Unit test: user without profile row gets role `"patient"` |
| **T06** | **P1** | `ensure()` inserts new profiles with `role = 'clinician'` | `src/lib/clinic/server.ts` | `ensure()`, line 118 | `INSERT` hardcodes `'clinician'` as default for every new account | Change to `'patient'` | New account in browser gets `patient` role |
| **T07** | **P2** | No UI confirmation that uploaded series matches finding's cited study | `src/components/volume-lab.tsx` | `recordAsVersion()` | No check compares series date/accession to finding's existing study reference | Add explicit clinician confirmation step before recording | Attempt to record without confirming → button stays disabled |
| **T08** | **P2** | `registerVolumes()` result never fed to `matchStudies()` in real data path | `src/lib/reprotrace/engine.ts` | `matchChronology()` | `matchChronology` calls `matchStudies` with no `registration` argument | Document gap in UI; add optional `registrations?` map parameter to `matchChronology` | Engine test: calling with registration map reduces provisional count |
| **T09** | **P2** | CORS does not whitelist `Authorization` or `X-API-Key` in `allow_headers` | `imaging-service/app/main.py` | `CORSMiddleware`, lines 53–59 | `allow_headers=["content-type"]` only | Add `"authorization"`, `"x-api-key"` to `allow_headers` | Browser preflight `OPTIONS` with `Access-Control-Request-Headers: authorization` → 200 |
| **T10** | **P2** | Segmentation endpoint pops and discards the actual mask voxel array | `imaging-service/app/main.py` | `segment()`, lines 164–168 | `seg = out.pop("label_volume_zyx")` removes mask; only shape and label counts returned | Serialize mask as base64+zlib (`mask_b64_zlib`) in response | Client reconstructs mask from response matching reported label counts |
| **T11** | **P2** | `SimpleUnet3D` docstring says "4-class" but `num_classes=5` is correct | `imaging-service/app/unet.py` | `SimpleUnet3D` class docstring | Off-by-one labeling (background class implicit but undocumented) | Update docstring: "5-class (0=background, 1–4=anatomical structures)"; add `"0":"background"` to `UmdMonaiAdapter.labels` | Documentation review only |
| **T12** | **P2** | `matchChronology` cannot accept registration results | `src/lib/reprotrace/engine.ts` | `matchChronology()` | No parameter for per-study-pair registration objects | Add optional `registrations?: Map<string, RegistrationResult>` parameter | Engine test with registration map parameter passes |
| **T13** | **P3** | Compressed DICOM transfer syntaxes silently skip without user explanation | `src/lib/dicom/codec.ts` | `loadDicomParser` | Files with JPEG/JPEG2000 encoding are skipped; user may not know why files are missing | Detect compressed UIDs and show explicit "Compressed DICOM not supported" error | Upload a JPEG-compressed DICOM → clear error message shown |
| **T14** | **P3** | Scanned PDF detection threshold (80 chars) may be too low | `src/lib/reports/text.ts` | `decodePdf()`, line 279 | `isScanned = images > 0 && extractedText.trim().length < 80` | Change to 200 characters; add test for short-but-valid PDF with logo image | New test: PDF with logo and 150 chars of text → NOT flagged as scanned |
| **T15** | **P3** | Missing database index on `finding_versions.study_id` | `migrations/0002_anatomybridge.sql` | Table `finding_versions` | FK column without index; full table scans on study lookups | Add `migrations/0006_performance_indices.sql` with index | `EXPLAIN` shows index scan on `WHERE study_id = $1` |
| **T16** | **P3** | Dead `import io` in `main.py` | `imaging-service/app/main.py` | Line 9 | `io` is imported but never referenced | Remove line 9 | `ruff check imaging-service/app/main.py` → 0 warnings |

---

## 4. DEPENDENCY ANALYSIS

```
T01 (FastAPI imports fix)
  └── T09 (CORS Authorization header — in same file, same commit)
  └── Python test suite can run
  └── T02 (service token → proxy)
       └── T04 (server-side proxy route)
            └── T03 (AI segmentation UI)
                 └── T10 (mask serialization)

T05 + T06 (RBAC default role = patient)
  └── T07 (Volume Lab recording confirmation)
  └── T12 (matchChronology parameter extension)

T15, T13, T14, T11, T16 — all independent of each other and of the above chain
```

**Strict ordering:**
1. T01 before any Python tests can pass.
2. T04 (proxy) before T02 (remove browser token).
3. T03 (AI UI) after both T04 and T10.
4. T05, T06 before T07.

---

## 5. IMPLEMENTATION STAGES

### Stage 1 — Fix FastAPI Startup (T01, T09, T16) — Do This First

**Objective**: Python service imports, starts, and all 25 tests pass.

**Files**: `imaging-service/app/main.py`

**Change 1 (T01)**: Line 13 — add `Depends, Header`:
```python
# BEFORE
from fastapi import FastAPI, File, HTTPException, UploadFile
# AFTER
from fastapi import Depends, FastAPI, File, Header, HTTPException, UploadFile
```

**Change 2 (T09)**: Lines 53–59 — add auth headers to CORS:
```python
app.add_middleware(
    CORSMiddleware,
    allow_origins=_ORIGINS,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["content-type", "authorization", "x-api-key"],
    allow_credentials=False,
)
```

**Change 3 (T16)**: Remove `import io` (line 9).

**Verification commands**:
```bash
cd imaging-service
python -c "from app.main import app; print('IMPORT OK')"
python -m pytest -v
```
**Expected**: `IMPORT OK` prints; 25 passed, 0 failed.

**Rollback**: Revert 3 lines.

---

### Stage 2 — Fix RBAC Defaults (T05, T06)

**Objective**: New accounts get `patient` role; missing profiles fail closed.

**Files**: `src/lib/clinic/server.ts`, `src/lib/clinic/rbac.test.ts`

**Change 1 (T06)**: `ensure()` line 118:
```typescript
// BEFORE
await sql`insert into profiles (user_id, display_name, role) values (${userId}, ${""}, ${"clinician"}) on conflict (user_id) do nothing`;
// AFTER
await sql`insert into profiles (user_id, display_name, role) values (${userId}, ${""}, ${"patient"}) on conflict (user_id) do nothing`;
```

**Change 2 (T05)**: `roleOf()` line 39:
```typescript
// BEFORE
return rows[0]?.role ?? "clinician";
// AFTER
return rows[0]?.role ?? "patient";
```

**Update test**: Add to `rbac.test.ts` a test that inserts no profile row and verifies `roleOf()` returns `"patient"`.

> **IMPORTANT**: This changes behavior for new accounts only. Existing users with profiles in the DB are unaffected. Synthetic seeded data inserted by `seed()` is called inside `ensure()` which also creates the profile, so seeded workspaces continue to work.

**Verification commands**:
```bash
npm run test:app
```
**Expected**: 203+ tests pass.

---

### Stage 3 — Server-Side Proxy (T04, T02)

**Objective**: Browser never sends service credentials; proxy injects them server-side.

**New file**: `src/routes/api/imaging-proxy.ts`

Create two TanStack Start API routes:
- `POST /api/imaging-proxy/inspect` — forwards DICOM FormData to Python `/series/inspect` with server-side `Authorization: Bearer $ANATOMYBRIDGE_SERVICE_API_KEY`.
- `POST /api/imaging-proxy/segment/:modelId` — forwards to Python `/segment/{modelId}`.

Both routes:
- Require `authMiddleware` (user must be signed in).
- Read `ANATOMYBRIDGE_SERVICE_URL` and `ANATOMYBRIDGE_SERVICE_API_KEY` from server-side `process.env` only.
- Forward files as multipart/form-data.
- Return the Python service response as-is.

**Update `service-client.ts`**: Remove `serviceToken()` function or make it return null unconditionally. Remove the `VITE_IMAGING_SERVICE_TOKEN` env var read.

**Update `volume-lab.tsx`**: Change the cross-check call from `inspectWithService(SERVICE_BASE, ...)` to `fetch("/api/imaging-proxy/inspect", ...)`.

**Environment variables** (server-side only, never `VITE_`-prefixed):
- `ANATOMYBRIDGE_SERVICE_URL` — URL of the Python service.
- `ANATOMYBRIDGE_SERVICE_API_KEY` — authentication token.

**Verification**:
```bash
npm run typecheck
npm run build
grep -r "IMAGING_SERVICE_TOKEN" .vercel/output/static/ 2>/dev/null
```
**Expected**: typecheck 0 errors; build succeeds; grep returns empty.

---

### Stage 4 — Mask Serialization + AI Segmentation UI (T10, T03)

**Objective**: Volume Lab can call Python service for AI segmentation and render multi-label result.

**Change T10** in `imaging-service/app/main.py`, `segment()` function:
```python
import base64, zlib
# Replace lines 164-168:
seg = out.pop("label_volume_zyx")
flat_bytes = seg.flatten().tobytes()
out["mask_b64_zlib"] = base64.b64encode(zlib.compress(flat_bytes, level=6)).decode()
out["mask_shape_zyx"] = list(seg.shape)
out["mask_spacing_zyx_mm"] = list(spacing)
out["label_counts"] = {str(int(v)): int(c) for v, c in zip(*np.unique(seg, return_counts=True))}
```

**Change T03** in `src/components/volume-lab.tsx`:

Add new Card "5. AI Segmentation (Optional)" with:
1. Model selector — populated from a health check against the proxy endpoint.
2. "Segment with AI model" button — calls `POST /api/imaging-proxy/segment/:modelId` with current series files.
3. On success: decode `mask_b64_zlib` (base64 → ArrayBuffer → zlib decompress using `DecompressionStream("deflate")` → `Uint8Array`) and reshape to `[Z, Y, X]`.
4. Create a secondary `Volume` or `Mask` from label 3 (myoma) and render it as an overlay in `PlaneView`.
5. Pass label 3 mask to `meshFromMask` for 3D surface generation.
6. Display label counts per class in a stats grid.
7. Show prominent label: "AI segmentation output — not clinician verified, not clinically validated."
8. Classical seeded region-growing remains in its existing Card — AI segmentation is additive, not replacing it.

**Verification**:
```bash
npm run typecheck
npm run test:app
node scripts/browser-smoke.mjs http://127.0.0.1:8080/ screenshots/smoke.png
```
**Expected**: 0 TS errors; 203+ tests pass; smoke test passes on desktop and mobile.

---

### Stage 5 — Volume Lab Recording Confirmation (T07)

**Files**: `src/components/volume-lab.tsx`

Before calling `recordFinding()`, require an explicit confirmation section:
- Show series metadata: study date from `LoadedSeries`, accession, modality, slice count.
- Show finding's existing study date and accession (from `findings` data passed down from `clinic-app.tsx`).
- If dates differ by more than 7 days, show a warning: "Series date and finding study date differ by X days."
- Add a checkbox: "I confirm this series corresponds to the study referenced by this finding."
- "Add as new version" button requires the checkbox to be checked.

**Verification**:
```bash
npm run test:app
```
**Expected**: 203+ tests pass. Browser test: unchecked → button disabled.

---

### Stage 6 — Performance Index Migration (T15)

**New file**: `migrations/0006_performance_indices.sql`
```sql
-- Production performance: indices for common query patterns
create index if not exists finding_versions_study_idx on finding_versions (study_id);
create index if not exists evidence_study_idx on evidence_links (study_id);
create index if not exists series_study_idx on series (study_id);
```

**Verification**:
```bash
npm run build
```
**Expected**: `db:migrate` step succeeds (or reports skipping if no DATABASE_URL).

---

### Stage 7 — Documentation and Minor Fixes (T11, T12, T13, T14, T16)

Run these in any order after Stages 1–6 are complete.

**T11**: `imaging-service/app/unet.py` — fix docstring. `imaging-service/app/models.py` — add `"0": "background"` to `UmdMonaiAdapter.labels`.

**T12**: `src/lib/reprotrace/engine.ts` — add optional `registrations?: Map<string, RegistrationResult>` parameter to `matchChronology`. Pass it through to `matchStudies` for the matching study pair.

**T13**: `src/lib/dicom/codec.ts` — when loading a DICOM file, check transfer syntax UID against known compressed UIDs (1.2.840.10008.1.2.4.*); if detected, return a clear error string "Compressed DICOM (JPEG/JPEG 2000) is not supported. Export uncompressed DICOM from your PACS and try again." instead of silently skipping.

**T14**: `src/lib/reports/text.ts` — line 279: change `< 80` to `< 200`. Add test case.

**T16**: Already handled in Stage 1 (remove `import io`).

**Verification**:
```bash
npm run test:app
npm run typecheck
cd imaging-service && python -m pytest -v
```
**Expected**: 203+ TS tests pass; 25+ Python tests pass; 0 TS errors.

---

## 6. DATASET AND MODEL PLAN

### UMD Dataset Facts

| Field | Value |
|---|---|
| Publication | Scientific Data 11:410 (2024), DOI: 10.1038/s41597-024-03170-x |
| Source | Figshare ID 23541312 — manual download required, no API |
| Licence | CC BY 4.0 — training is permitted with attribution |
| Modality | T2-weighted MRI (1.5T and 3T) |
| Cases | 50 patients, multiple timepoints per patient |
| Format | NIfTI (.nii.gz) — not DICOM |
| Official Labels | 0=background, 1=uterine wall, 2=endometrial cavity, 3=uterine myoma, 4=nabothian cyst |

**Label mapping verification**: The UMD official label schema matches `train_umd.py` and `UmdMonaiAdapter.labels` exactly. No correction needed to the label mapping.

### Patient-Level Split (no data leakage)

```
Total: 50 patients
  Train:      35 patients (70%)
  Validation: 10 patients (20%)
  Test:        5 patients (10%)
```

All scans from one patient go into the same split.

### Preprocessing (must match inference)

```python
p1, p99 = np.percentile(volume, 1), np.percentile(volume, 99)
volume = np.clip((volume - p1) / (p99 - p1), 0.0, 1.0)
```
This matches `UmdMonaiAdapter.run()` exactly.

### Computational Requirements

| Task | GPU Required | Time Estimate |
|---|---|---|
| Training (40 epochs, 50 cases) | Yes — 8+ GB VRAM | 4–12 hours |
| CPU inference (1 case) | No | 2–10 minutes |
| GPU inference (1 case) | Optional | 10–30 seconds |

### Current Blocker

No GPU hardware is available in the current development environment. No training has been executed. No model weights exist. The `UmdMonaiAdapter` correctly returns HTTP 503 with setup instructions when `ANATOMYBRIDGE_UMD_WEIGHTS` is unset. Classical seeded region-growing remains the working fallback.

---

## 7. SECURITY PLAN

### Critical Issues (must fix before production)

| ID | Issue | Risk | Fix |
|---|---|---|---|
| T02 | `VITE_IMAGING_SERVICE_TOKEN` in browser bundle | Long-lived secret readable via DevTools by any user | Server-side proxy (T04); remove VITE_ prefix |
| T05 | `roleOf()` missing-profile fallback = `"clinician"` | An attacker with a valid session but corrupted/missing profile gets clinician access | Change fallback to `"patient"` |
| T06 | New accounts default to `"clinician"` role | Any registered user immediately has clinical data write access | Change `ensure()` default to `"patient"` |

### Remaining Security Properties (currently correct)

| Property | Status |
|---|---|
| DICOM pixels stored server-side | Never — pixels stay in browser only |
| Patient name/ID in DICOM header | Stripped; `identifiers_withheld=true` stored |
| Report full text stored | De-identified text only; original file never persisted |
| Audit trail | Append-only DB triggers (migration 0003) |
| Patient self-record boundary | `is_self` column checked in all patient-scoped writes |
| Cross-tenant isolation | `user_id` scoped on every query |
| Role escalation | `setRole()` blocks patient→clinician/admin and clinician→admin |

---

## 8. VERIFICATION MATRIX

### Python Service

```bash
# After T01 fix
cd imaging-service
python -c "from app.main import app; print('IMPORT OK')"
# → IMPORT OK

python -m pytest -v
# → 25 passed, 0 failed

python -m pytest tests/test_auth.py -v
# → 5 passed

python -m pytest tests/test_cors.py -v
# → all pass; confirm Authorization header preflight tested
```

### TypeScript / Frontend

```bash
npm run typecheck
# → 0 errors

npm run test:app
# → 203+ passed, 0 failed

npm run build
# → exit code 0

# After Stage 3:
grep -r "IMAGING_SERVICE_TOKEN" .vercel/output/static/ 2>/dev/null
# → (empty output)
```

### Browser Tests

```bash
node scripts/browser-smoke.mjs http://127.0.0.1:8080/ screenshots/smoke.png
# → JSON verdict: desktop=pass, mobile=pass, 0 console errors

node scripts/test-interactions.mjs
# → all interactions pass
```

### Patient Coordinate Validation

```bash
npm run test:app -- --test-name-pattern="patient"
# → 3 tests pass (axial, sagittal, mesh vertex transforms)
```

### AI Inference (requires running service + weights)

```bash
# Service health (after T01 fix)
curl -H "Authorization: Bearer $ANATOMYBRIDGE_SERVICE_API_KEY" http://localhost:8100/health
# → {"status":"ok","any_model_connected":false}

# Segmentation (requires weights file at ANATOMYBRIDGE_UMD_WEIGHTS)
curl -H "Authorization: Bearer $ANATOMYBRIDGE_SERVICE_API_KEY" \
     -F "files=@slice.dcm" \
     http://localhost:8100/segment/umd_monai_fibroid
# → JSON with mask_b64_zlib, mask_shape_zyx, label_counts
```

---

## 9. KNOWN LIMITATIONS (not to be marked complete without evidence)

1. **No trained model weights**: All UMD validation is on synthetic phantoms. Clinical inference cannot produce meaningful output until weights are trained on real data.
2. **Rigid registration only**: Not sufficient for precise fibroid centroid comparison across exams. Deformable registration (ANTs, SimpleElastix) is required for research-grade spatial correspondence.
3. **No browser OCR**: Scanned PDFs produce a warning but cannot be read.
4. **Compressed DICOM unsupported**: Many PACS systems export JPEG/JPEG-LS by default.
5. **PGlite in browser only**: Production requires a real `DATABASE_URL`.
6. **All data is synthetic**: Not for real patient care without regulatory clearance.
7. **No LLM explanations implemented**: `explainFinding()` is rule-based only.

---

## 10. HANDOFF INSTRUCTION FOR GEMINI

**You are the implementation agent. The planning audit above is complete. Do not redesign the application.**

**Start with Stage 1 (T01, T09, T16)** — a three-line change to `imaging-service/app/main.py` that unblocks all 25 Python tests. This is the highest-leverage change in the entire codebase.

**Then Stage 2 (T05, T06)** — two-line change with critical security impact.

**Then Stages 3 → 4 → 5 → 6 → 7** in order.

**Rules for every stage**:
1. Read the exact file paths and function names in the plan. Make only the specified changes.
2. Run the verification commands. Confirm expected output before proceeding.
3. Never mark a task complete without running the specified test and seeing the expected output.
4. Never invent model weights, inference results, or dataset access.
5. Preserve existing UI styling, component names, and database schema.
6. Update `docs/DEVELOPMENT_CHECKLIST.md` and `README.md` after all stages complete.

**The very first action, right now, is:**

```python
# File: imaging-service/app/main.py, line 13
# Change FROM:
from fastapi import FastAPI, File, HTTPException, UploadFile
# Change TO:
from fastapi import Depends, FastAPI, File, Header, HTTPException, UploadFile
```

Then run `cd imaging-service && python -m pytest -v` and verify 25 tests pass.

---

*End of REPROCARE_IMPLEMENTATION_PLAN.md*  
*Planning Agent: Claude Sonnet 4.6 — 2026-11-01*  
*Commit audited: 98d8eac on branch main*

