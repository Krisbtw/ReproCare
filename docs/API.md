# API reference (TanStack Start server functions)

AnatomyBridge has no separate REST service. The server surface is the set of `createServerFn` functions in `src/lib/clinic/server.ts`. Each is called from the client through the framework RPC, every one runs `authMiddleware` first, and every query is scoped by the verified `context.userId` (never a client-sent id). There is no OpenAPI file because these are not hand-routed HTTP endpoints; a FastAPI service would produce one automatically (see Next steps in `DEVELOPMENT_CHECKLIST.md`).

Errors are thrown as `Error(message)`; the client sees the message. "Patient lens" means the account's `profiles.role` is `patient`.

| Function | Method | Input | Returns | Rules enforced in code |
|---|---|---|---|---|
| `getWorkspace` | GET | none | whole workspace for this user (patients, studies, series, reports, findings, versions, evidence, symptoms, cycles, labs, correspondences, discrepancies, reviews, audit, uploads, models) | seeds synthetic data on first call |
| `setRole` | POST | `role: "patient" \| "clinician" \| "admin"` | `{ ok }` | anything else throws. This switches a *lens* on the signed-in account; it is not enforced RBAC (see limitations) |
| `setActivePatient` | POST | patient id | `{ ok }` | record must belong to the user |
| `addSymptom` | POST | `{ patientId, region, intensity 0–10, cycleDay\|null, description, recordedOn }` | `{ ok }` | region must be listed; description required, trimmed to 500; patient lens only on own record; stored with `source = patient_reported` |
| `addCycle` | POST | `{ patientId, startDate, lengthDays, flow, note }` | `{ ok }` | length 1-120 days; note trimmed to 400, flow to 40; record must belong to the user; writes an audit event |
| `addLab` | POST | `{ patientId, observedOn, analyte, valueText, unit, referenceText }` | `{ ok }` | analyte and value required; stored with the note "Entered in the workspace. Not interpreted."; no flag or diagnosis is derived |
| `addReview` | POST | `{ targetType: finding_version\|correspondence\|discrepancy, targetId, status: verified\|rejected\|needs_more_information, note }` | `{ ok }` | clinician/admin lens only; inserts a row, never edits a target |
| `correctVersion` | POST | `{ versionId, axes: [mm,mm,mm], reason }` | `{ ok, id }` | axes finite, 0–300 mm; reason ≥ 8 chars; inserts version N+1 with `previous_version_id`, copies one evidence link forward; old version untouched; clinician lens only |
| `saveLabMeasurement` | POST | `{ findingId, axes: [mm,mm,mm], longest, sliceIndex, reason, evidenceNote }` | `{ ok, id }` | three positive axes <= 300 mm; longest 0-300 mm; integer slice index 0-5000; reason >= 8 chars; clinician/admin lens only; inserts version N+1 with `previous_version_id`; centroid null, frame `unavailable`, source `classical_region_growing`; no pixels, mask, mesh or patient identifiers stored |
| `decideCorrespondence` | POST | `{ correspondenceId, decision: accept\|reject\|defer, note }` | `{ ok }` | inserts a decision row; findings are never merged |
| `saveDicomMeta` | POST | `{ patientId\|null, fileName, transferSyntax, metadata, warnings }` | `{ ok }` | ≤ 40 metadata keys, truncated values; patient name/ID never sent (reader withholds them); `identifiers_withheld = true` |
| `exportRecord` | POST | patient id | `{ warning, patient, studies, findings, versions }` | JSON export, labelled synthetic; writes an audit event |
| `resetWorkspace` | POST | none | `{ ok }` | re-seeds this user's synthetic data |

Validators for `addCycle`, `addLab` and `saveLabMeasurement` were read from `src/lib/clinic/server.ts` on 2026-10-31.

No OpenAPI file exists and none was invented. Server-function URLs are framework-internal and not a stable public contract. A real OpenAPI spec would come from the FastAPI imaging service proposed in `DEVELOPMENT_CHECKLIST.md`.

## Client-side modules (no network)

| Module | Purpose |
|---|---|
| `src/lib/reprotrace/engine.ts` | correspondence proposals, discrepancy classes, restrained explanations |
| `src/lib/dicom/codec.ts` | DICOM header reader (needs `dicom-parser`), synthetic single-slice writer |
| `src/lib/dicom/pixels.ts` | 8/16-bit pixel decode with rescale |
| `src/lib/imaging/series.ts` | series geometry validation and volume stacking |
| `src/lib/imaging/segment.ts` | classical seeded segmentation (not a learned model) |
| `src/lib/imaging/isosurface.ts`, `mesh.ts` | surface extraction, mesh quality, smoothing, STL/OBJ export |
| `src/lib/imaging/metrics.ts` | Dice, Jaccard, volume difference, HD95, mask measurements |

## Imaging service (Python)

Real OpenAPI 3.1 file: `imaging-service/openapi.json` (generated from the FastAPI app). Routes: `GET /health`, `GET /models`, `POST /series/inspect`, `POST /metrics/score`, `POST /segment/{model_id}` (503 `model_not_connected` unless operator weights are configured). No authentication; trusted network only. The web app's own server functions above remain framework-internal and have no OpenAPI file.
