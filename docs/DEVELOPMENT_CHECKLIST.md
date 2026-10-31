# Development checklist

Updated 2026-10-31. A box is ticked only when the behaviour exists **and** was exercised. "Tested here" means a test ran in this workspace. "Not run" means code exists but could not be executed here (no `node_modules`, no network).

Legend: ✅ done and tested · 🟡 exists, not browser-verified or partial · ⬜ not done

## Master prompt Part 15 acceptance criteria

| Criterion | Status | Notes |
|---|---|---|
| Frontend runs | 🟡 | Built in an earlier session; not re-run here |
| Backend runs | 🟡 | Server functions in the same app; not re-run here. There is no Python/FastAPI backend |
| Database migrations work | 🟡 | `0001`, `0002` exist; migrate script not run here |
| Authentication works | 🟡 | Better Auth wired; not re-run here |
| Patient maintains a reproductive health profile | 🟡 | Symptoms, cycles, labs recorded in the app (synthetic records) |
| Anonymised DICOM study uploaded | 🟡 | Single-file header upload exists. Multi-file series upload UI: ⬜ |
| DICOM metadata extracted | ✅/🟡 | Reader exists; its test needs `dicom-parser`, not run here |
| One real, compatible segmentation workflow | ✅ (classical) | `segmentFromSeed`, tested on synthetic phantoms. It is not a learned model. A trained-model workflow: ⬜ |
| Interactive 3D model generated and explored | 🟡 | Schematic Three.js anatomy + cuberille surface exist. New marching-tetrahedra mesh is not wired into the viewer |
| Finding linked to source imaging evidence | 🟡 | `evidence_links` + report quote + slice index, schematic slices |
| Finding versioned without overwriting | ✅ | `correctVersion` inserts N+1. Migration `0003` also refuses UPDATE, TRUNCATE and direct DELETE on `finding_versions`, `reviews`, `correspondence_decisions`, `audit_events` (6 tests on PGlite). A table owner or superuser can still drop the triggers |
| Follow-up comparison demonstrated | ✅ | Engine tests pass (7/7 here) |
| Discrepancies flagged | ✅ | Engine tests pass |
| Clinician verification recorded | 🟡 | `addReview`; gated by a role *lens* a user can switch themselves |
| Real vs simulated outputs distinguished | ✅ | Model list marks demo vs active vs not connected; new segmenter reports `isLearnedModel:false` |
| Documentation explains install and usage | 🟡 | `INSTALL.md`, `USER_MANUAL.md`, `DEMO_SCRIPT.md`, `PROJECT_DOCUMENT.md` written 2026-10-31 from reading code. Steps not run end to end (no network in that session) |
| Tests reported honestly | ✅ | Below |

## Imaging (Part 5)

- [x] Series ordering by slice normal, gap / duplicate / mixed orientation / mixed matrix / mixed series detection (tested)
- [x] 8/16-bit pixel decode with rescale (tested)
- [x] Stack to anisotropic volume; refuse if not volume-ready (tested)
- [x] Classical seeded segmentation with processing history and leakage guard (tested)
- [x] Isosurface, mesh quality, Taubin smoothing, STL/OBJ export (tested)
- [x] Dice, Jaccard, volume difference, HD95, Hausdorff, mean surface distance, mask measurements (tested)
- [x] Series loader that reads many files through `dicom-parser` and feeds `analyzeSeries` (`series-loader.ts`, `series-groups.ts`; tests pass)
- [x] "Volume lab" screen: upload series, scroll slices, click a seed, see mask and mesh, export STL (`volume-lab.tsx`; pipeline run headlessly on the synthetic series 2026-10-31; **not** browser-verified)
- [ ] Intensity normalisation, denoising, resampling, registration
- [ ] Compressed transfer syntaxes
- [x] Separate Python imaging service (`imaging-service/`, FastAPI): series inspection, mask scoring, model status, OpenAPI. 25 pytest tests, synthetic data only
- [ ] nnU-Net adapter **prediction path**: code written, never run (no weights, none trained). MONAI adapter: not written. Web app does not call the service yet

## ReproTrace (Part 4)

- [x] Correspondence categories, quality cap, no auto-merge (tests)
- [x] Discrepancy classes: measurable, method, segmentation, reporting, unresolved (tests)
- [x] Append-only finding versions in application code
- [x] DB-level append-only enforcement: `migrations/0003_append_only.sql` (triggers; direct DELETE refused, cascade from deleting the whole patient still allowed so erasure and reset work; tested on PGlite). `resetWorkspace` no longer deletes audit rows. Not run against a real Postgres server, only PGlite
- [ ] Correspondence on **image-registered** coordinates. Today most frames are schematic, so proposals stay provisional
- [x] Feed `measureMask()` output into a new finding version (button in Volume lab; `finding-link.ts`, `lab-version.ts`; append-only insert tested on PGlite). Clinician chooses the finding and states a reason. Not automatic by design. Centroid withheld and frame `unavailable` because lab coordinates are not registered; so no auto-pairing. Server function and button **not driven in a browser**

## Security and compliance (Part 11)

- [x] Header reader withholds patient name/ID; they are not stored
- [x] Per-user row scoping on every server function
- [ ] Real RBAC. `setRole` lets any signed-in account switch between patient, clinician, admin. Treat the roles as demonstration lenses only
- [ ] Encryption at rest, consent enforcement beyond a `consents` table, de-identification workflow for uploads
- [ ] Verified DPDP / CDSCO primary sources (see `RESEARCH_STATUS.md`)

## Research (Part 2)

- [x] UMD dataset core facts verified (see `RESEARCH_STATUS.md`)
- [x] Literature, patent, dataset and regulatory tables written with source grades (`RESEARCH_REPORT.md`, 2026-10-31). Partly secondary sources; full papers and patent claims not read; several topics not searched (see report section 2 and 3)
- [ ] Open the primary DPDP Gazette and CDSCO guidance; read patent claims with an attorney

## Tests run in this workspace (2026-10-31)

Command: `node --experimental-strip-types --test <files>`

| File | Tests | Result |
|---|---|---|
| `reprotrace/engine.test.ts`, `reprotrace/spans.test.ts`, `imaging/surface.test.ts`, `imaging/phantom.test.ts` | 7 | pass |
| `src/lib/imaging/pipeline.test.ts` (new) | 18 | pass |
| `src/lib/dicom/pixels.test.ts` (new) | 3 | pass |
| `src/lib/dicom/codec.test.ts` | 1 | **not run** — needs `dicom-parser` |
| `scripts/**/*.test.mjs`, auth/app-data/preview tests | — | **not run** here |
| `npm run typecheck`, `npm run build`, browser smoke | — | **not run** — no `node_modules`, no network |

New imaging modules were type-checked in isolation with `tsc 6.0.3 --strict` (clean). They have not been checked as part of the full project.

Total run here: 28 tests, 28 pass, 0 fail.

## Update 2026-10-31 (volume lab session)

With `npm ci` done: 56 tests in `reprotrace/`, `imaging/`, `dicom/` pass (includes the `dicom-parser` tests that were previously not run). `tsc --noEmit` clean. `vite build` succeeds. Full `npm test`: 183 pass, 14 fail, all in `scripts/*.test.mjs` (platform scaffold checks), not investigated.

Headless run of the lab pipeline on the synthetic sample (96x96x28, 1.2x1.2x4 mm, ellipsoid radii 20/16/28 mm): seed (48,48,14), region growing accepted 6520 voxels, mask volume 37.56 mL vs analytic 37.53 mL, mesh watertight (Euler 2, 0 boundary edges, 1 component), mesh volume 36.70 mL after smoothing, binary STL 828,884 bytes = 84 + 50 x 16,576 triangles. Synthetic phantom only; not clinical accuracy.

Not done: browser drive of the screen (no browser installable here), real MRI, compressed transfer syntaxes, patient-coordinate transform of meshes.

## Update 2026-10-31 (record-as-version)

New: "Record as a finding version" in Volume lab. 6 new tests (`finding-link.test.ts` 4, `lab-version.test.ts` 2 on embedded Postgres via PGlite with `0002` migration; v1 untouched, v2 appended with previous link, other user refused). With them, 62 AnatomyBridge tests pass. `tsc` clean, eslint clean on touched files, `vite build` ok.

Found by test: with no centroid the engine does not label a lab version "needs review". It leaves earlier and lab findings unpaired, both provisional. UI copy was corrected to say that.

Limits: the loaded series is not stored and not tied to the study the finding cites; the version keeps the earlier version's study and date. No DB-level append-only trigger yet.

## Update 2026-10-31 (research and documents session)

Done: web research with source grades; `RESEARCH_REPORT.md`; `RESEARCH_STATUS.md` rewritten; unverified claims removed from `research-view.tsx` (UT-EndoMRI authors and Zenodo DOI, MMOTU patient count, two carried-forward patents, Egorov paper, Visible Patient class); DPDP and CDSCO text updated; `API.md` now lists `saveLabMeasurement` and the `addCycle`/`addLab` shapes; new `INSTALL.md`, `USER_MANUAL.md`, `DEMO_SCRIPT.md`, `PROJECT_DOCUMENT.md`.

Not run: `npm ci`, tests, `tsc`, `vite build` (no network, no `node_modules` in this session). The edited `research-view.tsx` was syntax-checked with a global `tsc` (only missing-React-types noise) and tag balance was counted. Run the full suite before presenting.

New findings that change the plan:
- Report-to-image linking and serial finding tracking appear in earlier patents (see report). Do not call them new.
- CDSCO final software guidance reported 21 Jul 2026; DPDP shortening not found notified.
- 2023 PCOS guideline: adolescents need ovulatory dysfunction **and** hyperandrogenism, and ultrasound is not recommended for diagnosis. Adolescent guard added 2026-10-31 (see update below).

## Update 2026-10-31 (verification, PCOS guard, append-only)

Run in this workspace after `npm ci`: `tsc --noEmit` clean; `vite build` ok; `npm run test:app` 133 pass, 0 fail (includes the new tests below).

New:
- `src/lib/clinic/pcos-context.ts` + 6 tests. Under-20 by year of birth, or no usable year, shows an adolescent/age-unknown note in the Context view for PCOS-pathway patients. The age 20 line is this app's own conservative choice: the guideline counts time since first period, which is not stored. Ultrasound is never offered as support in any state. The app applies no follicle or AMH threshold, so there is no ultrasound-plus-AMH double use to guard. Seeded patient Kavya (born 1997) shows the adult note. Not seen in a browser.
- `migrations/0003_append_only.sql` + `append-only.test.ts` (6 tests).
- `npm test` is now `test:app` then `test:scaffold`. Before, the 14 failing scaffold tests stopped `&&` and the AnatomyBridge tests never ran under `npm test`.

Scaffold failures (`npm run test:scaffold`): still 14 of 197 fail. Cause read for 11 of the 14: the share-card/PWA tests expect the template's sample app name "Wild Race" while this project is branded AnatomyBridge, and the auth and app-env tests assert the unmodified template (auth off, identical auth schema copy). The other 3 were not read. Not fixed, and not AnatomyBridge code.

Still not done: browser drive of any screen, real MRI, trained model, Python imaging service, real Postgres server run of `0003`.

## Update 2026-10-31 (Python imaging service)

New `imaging-service/` (Python 3.12, FastAPI, pydicom, SimpleITK, scipy): `/series/inspect`, `/metrics/score`, `/models`, `/health`, `/segment/{model_id}`, `python -m app.score`, `openapi.json`, Dockerfile. `python -m pytest` 25 pass. Checked by hand: shifted balls give the shift in mm on anisotropic spacing (5.0 mm in-plane, 6.0 mm through-plane); the score CLI ran on a NIfTI pair. Patient tags (name, ID, birth date) are tested not to appear in any response.

Honest limits: the nnU-Net adapter answers 503 and returns no mask without operator weights and a label map; its prediction code has never executed. Uncompressed DICOM only. No authentication on the service. The web app does not call it. No real MRI, no UMD data (figshare is not reachable from this sandbox), so there is still no real-data Dice.

## Update 2026-10-31 (Menarche year, PCOS guideline cycle bands, Imaging service CORS & Client)

Run in this workspace: `tsc --noEmit` clean; `vite build` ok; `npm run test:app` 159 pass, 0 fail.

New:
- `migrations/0004_menarche_year.sql`: stores year of first period on patient record with range constraint (1900-2200).
- `src/lib/clinic/menarche.ts` + `menarche.test.ts`: `applyMenarcheYear` handles permission checks and records previous values to append-only audit events.
- `src/lib/clinic/pcos-context.ts` + tests: upgraded according to the 2023 International PCOS Guideline (Teede et al.) to compute gynecological age (`GynAge`), enforce adolescent ultrasound caution, and evaluate cycle length bands (`cycleBand`, `outsideBand`).
- `src/lib/clinic/server.ts` + `src/lib/clinic/types.ts`: added `setMenarcheYear` server function and updated `PatientRow`.
- `imaging-service/app/main.py` + `imaging-service/tests/test_cors.py`: added `CORSMiddleware` configured via `ANATOMYBRIDGE_CORS_ORIGINS`.
- `src/lib/imaging/service-client.ts` + `service-client.test.ts`: browser client for independent series geometry verification against the Python service (`inspectWithService`, `checkHealth`, `compareReports`).
- `src/components/clinic-app.tsx`: added menarche year input form, audit logging, PCOS basis badge, and cycle-interval guideline indicators.
- `src/components/volume-lab.tsx`: added "Second check · imaging service" cross-check card comparing browser (`dicom-parser`) vs service (`pydicom`) series analysis.
- `tests/verify/run.html`: browser-based test verification runner.

## Update 2026-10-31 (Clinical report ingestion, De-identification, Structured evidence linking & Preprocessing)

Run in this workspace: `tsc --noEmit` clean; `vite build` ok; `npm run test:app` 189 pass, 0 fail.

New:
- `src/lib/reports/zip.ts`: zero-dependency DOCX container / ZIP central directory parser using platform `DecompressionStream`.
- `src/lib/reports/text.ts`: plain-text extraction from TXT, DOCX, and PDF content streams with printable character verification.
- `src/lib/reports/deidentify.ts`: rule-based de-identification scrubbing patient names, MRNs, phone numbers, emails, and Indian Aadhaar-like IDs while keeping clinical dates and measurements.
- `src/lib/reports/extract.ts`: rule-based structured extraction for exam dates, imaging modality, measurements, FIGO fibroid classification, and sentence-level findings with character-exact offsets.
- `migrations/0005_report_ingestion.sql`: database tables for uploaded reports and evidence link anchors (`quote_start`, `quote_end`, `content_sha256`).
- `src/lib/reports/store.ts` + `store.test.ts`: database operations for de-identified report ingestion and evidence quote anchoring with audit trail.
- `src/components/reports-view.tsx`: Reports screen for client-side text extraction, de-identification preview, clinician confirmation, and linking quotes to finding versions.
- `src/components/clinic-app.tsx`: integrated Reports tab and view.
- `src/lib/imaging/preprocess.ts` + `preprocess.test.ts`: pure functional volume preprocessing (percentile/z-score normalisation, Gaussian smoothing, median filter, trilinear resampling, ROI cropping, and noise/anisotropy indicators) preserving the input volume intact.


