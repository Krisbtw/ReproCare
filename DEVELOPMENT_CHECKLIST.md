# Development checklist

Updated 2026-11-01. A box is ticked only when the behaviour exists **and** was exercised. "Tested here" means a test ran in this workspace. "Not run" means code exists but could not be executed here.

Legend: ✅ done and tested · 🟡 exists, not browser-verified or partial · ⬜ not done

## Master prompt Part 15 acceptance criteria

| Criterion | Status | Notes |
|---|---|---|
| Frontend runs | ✅ | Verified with dev server and browser smoke test on desktop (1280x800) and mobile (390x844), plus end-to-end browser interaction script. |
| Backend runs | ✅ | TanStack Start Nitro server functions + Python FastAPI imaging service (`imaging-service/`) with constant-time HMAC authentication, CORS, and inspection endpoints. |
| Database migrations work | ✅ | Migrations 0001 through 0009 tested against PostgreSQL (PGlite) in automated test suites; includes append-only triggers and clinician verifications. |
| Authentication works | ✅ | Better Auth with session management and server-side RBAC; self-service privilege escalation disallowed; bootstrap admin via `BOOTSTRAP_ADMIN_EMAILS`; verified by browser and unit tests. |
| Patient maintains a reproductive health profile | ✅ | Symptoms, cycles, labs, and menarche year recorded in app with append-only audit trail; structured Endometriosis, Ovarian Cysts, and PCOS (2023 Guideline / Rotterdam) pathways. |
| Anonymised DICOM study uploaded | ✅ | DICOM series loader parses single-file or multi-file series in-browser via `dicom-parser` with geometric validation and LPS coordinate frame construction. |
| DICOM metadata extracted | ✅ | Extracts slice spacing, thickness, orientation cosines, image positions, study/series UIDs, and builds 3D patient coordinate frame. |
| One real, compatible segmentation workflow | ✅ | Classical 3D region-growing (`segmentFromSeed`) with leakage guards and quality metrics in browser; genuine 3D U-Net UMD model adapter (`UmdMonaiAdapter`) and training script in Python service. |
| Interactive 3D model generated and explored | ✅ | Watertight marching-tetrahedra isosurface generation, Taubin smoothing, interactive volume lab slice viewer, and STL/OBJ export in DICOM LPS coordinates. |
| Finding linked to source imaging evidence | ✅ | Provenance links to series/study with slice indices, report quote spans, and patient LPS coordinates in `evidence_links`; learned model results require explicit clinician confirmation before saving. |
| Finding versioned without overwriting | ✅ | `correctVersion` and `saveLabMeasurement` append version N+1. Database trigger (`0003_append_only.sql`) refuses direct UPDATE, TRUNCATE, and DELETE on finding versions. |
| Follow-up comparison demonstrated | ✅ | ReproTrace rules engine with rigid 3D registration correspondence gating, boundary uncertainty propagation (`params.ts`), and live discrepancy computation. |
| Discrepancies flagged | ✅ | Flags size, velocity, category, and spatial discrepancies; clinician resolution endpoint with RBAC enforced. |
| Clinician verification recorded | ✅ | Clinician credentialing workflow (`clinician_verifications` table) with license/registry submission and admin approval/revocation; protected actions enforce verified role. |
| Real vs simulated outputs distinguished | ✅ | Synthetic scans and seeds clearly designated; model adapters declare readiness without mocking clinical inference; classical segmenter marks `isLearnedModel: false`; learned models honestly identified. |
| Documentation explains install and usage | ✅ | `README.md`, `INSTALL.md`, `USER_MANUAL.md`, `DEMO_SCRIPT.md`, `PROJECT_DOCUMENT.md`, `API.md`, `IMAGING_PIPELINE.md`. |
| Tests reported honestly | ✅ | 225 passing tests across 21 suites in `npm run test:app`; 0 failures. 94 passing pytest tests in imaging service. Full production build succeeds cleanly. |

## Imaging (Part 5)

- [x] Series ordering by slice normal, gap / duplicate / mixed orientation / mixed matrix / mixed series detection (tested)
- [x] 8/16-bit pixel decode with rescale (tested)
- [x] Stack to anisotropic volume; refuse if not volume-ready (tested)
- [x] Classical seeded segmentation with processing history and leakage guard (tested)
- [x] Isosurface, mesh quality, Taubin smoothing, STL/OBJ export (tested)
- [x] Dice, Jaccard, volume difference, HD95, Hausdorff, mean surface distance, mask measurements (tested)
- [x] Series loader that reads many files through `dicom-parser` and feeds `analyzeSeries` (`series-loader.ts`, `series-groups.ts`; tests pass)
- [x] "Volume lab" screen: upload series, scroll slices, click a seed, see mask and mesh, export STL/OBJ in DICOM LPS coordinates, record finding version (`volume-lab.tsx`; browser-verified in Microsoft Edge)
- [x] Intensity normalisation, denoising, resampling, registration (`src/lib/imaging/preprocess.ts`, `src/lib/imaging/registration.ts`; integrated into Volume Lab UI with operation history)
- [x] Persistent medical imaging storage handler (`storage.server.ts`) with SHA-256 integrity, tenant isolation, and path-traversal guards
- [x] Separate Python imaging service (`imaging-service/`, FastAPI): series inspection, mask scoring, model status, constant-time HMAC Bearer/API Key auth, Prometheus `/metrics`, non-root container, OpenAPI, CORS. 94 pytest tests
- [x] Genuine UMD nnU-Net / PyTorch 3D U-Net adapter (`imaging-service/app/unet.py`, `models.py`) and standalone reproducible training pipeline (`imaging-service/train_umd.py`). Refuses with 503 when weights are absent; never mocks predictions
- [x] DICOM Patient Coordinate transformations: converts mesh vertices and centroids to DICOM LPS space ($P_{patient} = P_0 + u_x X + u_y Y + u_z Z$)

## ReproTrace (Part 4)

- [x] Correspondence categories, quality cap, no auto-merge (tested)
- [x] Discrepancy classes: measurable, method, segmentation, reporting, unresolved (tested)
- [x] Append-only finding versions in application code
- [x] DB-level append-only enforcement: `migrations/0003_append_only.sql` and `migrations/0009_imaging_and_provenance.sql` (triggers; direct DELETE/UPDATE refused; tested on PGlite)
- [x] Longitudinal uncertainty and voxel boundary propagation (`params.ts`, `computeVoxelBoundaryUncertainty`, `evaluateLongitudinalChange`)
- [x] Correspondence on **image-registered** coordinates: 3D rigid registration (`src/lib/imaging/registration.ts`) computes translation and orientation; `matchStudies` in `src/lib/reprotrace/engine.ts` demotes un-registered or unsupported shifts to `uncertain`/`needs_review`
- [x] Feed `measureMask()` output into a new finding version in Volume Lab (`finding-link.ts`, `lab-version.ts`). Learned AI models require explicit clinician confirmation before saving; provenance links uploaded study and series, sets centroid in DICOM LPS coordinates, preserves previous versions intact

## Security and compliance (Part 11)

- [x] Header reader withholds patient name/ID; they are not stored
- [x] Per-user row scoping on every server function
- [x] Real server-side RBAC: `setRole` disallows self-service role escalation (`patient` cannot self-escalate to `clinician` or `admin`; `clinician` cannot self-escalate to `admin`). Bootstrap admin via `BOOTSTRAP_ADMIN_EMAILS`
- [x] Clinician verification lifecycle (`clinician_verifications` table) with license number, registry, and admin approval/revocation (`verifyClinician`)
- [x] Last-admin demotion prevention and fail-closed authentication in production
- [x] Imaging service authentication: protected by Bearer token or `X-API-Key` matching `ANATOMYBRIDGE_SERVICE_API_KEY` using constant-time `hmac.compare_digest` (`imaging-service/app/main.py`, `service-client.ts`)
- [x] Fake Python router eliminated: removed mock trends router and deleted 7,182 lines of dead pipeline mock code; secured real trends compute endpoint
- [x] Container and deployment hygiene: non-root Docker execution (`appuser`), internal network isolation for backend/DB, sanitized secrets in Compose and Kubernetes manifests

## Clinical Reports & Pathways

- [x] DOCX / ZIP parser using web-standard `DecompressionStream`
- [x] Text extraction from TXT, DOCX, and PDF content streams
- [x] Scanned PDF / image-only document detection: warns clinicians when PDFs have zero or negligible text streams and advises native digital documents or manual entry
- [x] Rule-based de-identification scrubbing patient names, MRNs, phone numbers, emails, Aadhaar IDs
- [x] Structured extraction for dates, modalities, FIGO classes, nabothian cysts, and measurements with character offsets
- [x] Negation detection (`no evidence of`, `ruled out`, `unlikely`), clinical uncertainty parsing (`cannot rule out`, `suspicious for`), and bilateral laterality
- [x] Structured reproductive health pathways: Endometriosis (`pathway_endometriosis_records`), Ovarian Cysts (`pathway_ovarian_cyst_records`), and PCOS (`pathway_pcos_assessments` with Rotterdam criteria)
- [x] Report quote anchoring to anatomical finding versions with hash verification

## Automated Tests Executed in this Workspace

Command: `npm run test:app`
**Total application tests:** 225 run, 225 pass, 0 fail (duration ~45s).
Command: `.venv\Scripts\pytest imaging-service/tests`
**Python imaging service tests:** 94 run, 94 pass, 0 fail.
Command: `npm run typecheck`
**TypeScript compilation:** passes with 0 errors.
Command: `npm run build`
**Production build:** passes with 0 errors.
