# AnatomyBridge project document

Research and clinical-communication prototype. Synthetic data only. Not a diagnostic system. Not approved by any regulator.

## 1. Abstract

AnatomyBridge is a web workspace for women's reproductive health records. It keeps each imaging finding as a versioned object tied to its report quote, slice, measurement and processing record. A rules engine, ReproTrace, proposes whether findings in two exams may be the same, labels why two measurements differ, and never merges anything automatically. A browser Volume lab reads a DICOM series, checks geometry, grows a mask from a clinician's seed, builds a 3D mesh and records the result as a new finding version. No trained segmentation model is connected. No real patient scan has been run. All demonstration patients are synthetic.

## 2. Problem statement

Imaging reports, measurements, symptoms, cycles and labs sit in separate places. When a later scan arrives, it is hard to see which finding is which, whether a size difference comes from a different method, and who corrected what. Patient-facing explanations risk adding claims the source does not make.

## 3. Research gap (stated narrowly)

Report-to-image linking, serial finding tracking and edit logs already appear in earlier products and patents (see `RESEARCH_REPORT.md` sections 1 and 3). The open question is whether a conservative record layer for reproductive findings helps reviewers: uncertain matches stay unmerged, modality differences are not called progression, corrections are new versions. This has **not** been tested with users or real longitudinal data.

## 4. Objectives

1. Keep every finding version append-only, with its evidence.
2. Propose correspondences with explicit uncertainty and no auto-merge.
3. Label discrepancy types without calling any of them progression.
4. Run a real DICOM-to-mesh pipeline in the browser with honest quality checks.
5. Keep patient-reported and clinician-documented information visibly apart.
6. Report what is verified and what is not.

## 5. Functional requirements and state

| Requirement | State |
|---|---|
| Sign-in, patient/clinician/admin lens | Lens only; no true RBAC |
| Patient profile, symptoms, cycles, labs | Works on synthetic records; not browser-tested by the author |
| DICOM header read, series checks, pixel decode | Tested on synthetic series; uncompressed only |
| Segmentation | Classical seeded region growing; no learned model |
| 3D mesh, STL/OBJ export, mesh quality | Tested on a synthetic ellipsoid |
| Finding versions, reviews, audit events | Application-level append-only; no DB trigger yet |
| Correspondence, discrepancy rules | Rule engine, unit-tested on synthetic cases |
| Lab measurement to finding version | Server function and PGlite test; UI not clicked in a browser |
| Report extraction | Pattern highlighting of stored text only; no PDF/DOCX parsing |
| LLM plain-language rewrite | Optional; shows stored excerpt when no model is configured |
| Trained model adapters | Listed as not connected |

## 6. Non-functional requirements

Privacy: patient name and ID are not stored; pixels stay in the browser. Traceability: every write adds an audit event. Honesty: no invented scores; unknown values are null. Not yet met: encryption at rest, consent enforcement beyond a table, DB-level immutability, accessibility audit, load testing.

## 7. Architecture

Single TanStack Start app (React 19, TypeScript, Vite, Tailwind, Three.js). Server functions run on Node, behind an auth middleware, and query Postgres (PGlite locally, Postgres via `DATABASE_URL`). Imaging code under `src/lib/imaging` and `src/lib/dicom` runs in the browser. There is **no** Python/FastAPI service, though the master prompt asked for one; a separate service is needed before any nnU-Net or MONAI model can run. Database tables are in `docs/ER_DIAGRAM.md`.

Data flow, Volume lab: files in browser -> `dicom-parser` -> series checks -> volume stack -> seed -> region growing -> mask metrics -> isosurface -> mesh checks -> export or one server call that stores only extents, seed slice, note and a processing-record hash.

## 8. Methods

- ReproTrace rules `reprotrace-rules-1`: correspondence needs a common registered frame for any "likely same"; image quality caps the category; a size gap is "measurable difference" only when modality and basis match and relative change exceeds 15%; ultrasound vs MRI is "method difference"; non-visualisation of a finding under 20 mm stays in review. The 15% and 20 mm thresholds are design choices, **not** clinical standards.
- Segmentation: seeded region growing with a leakage guard. Not learned.
- Surface: marching tetrahedra, Taubin smoothing.
- Metrics: Dice, Jaccard, volume difference, HD95, mean surface distance, computed only against a reference mask; null otherwise.

## 9. Validation status

Run on synthetic phantoms only. The earlier session's headless run on a synthetic ellipsoid (radii 20/16/28 mm): mask 37.56 mL vs analytic 37.53 mL, watertight mesh. This shows the code is consistent with a geometric shape. It says nothing about clinical accuracy.

## 10. Limitations

No real MRI run. No trained model. No longitudinal real data. No reader study. No true RBAC. Compressed DICOM unsupported. Lab coordinates not registered to stored studies. Patent claims not read. Regulatory sources secondary. UI not driven in a browser. 14 platform scaffold tests fail (template-state checks; 11 of 14 read, not fixed). The PCOS adolescent note uses an app-chosen age line (under 20 by year of birth), not the guideline's time-since-first-period rule.

## 11. Future scope (in order of value)

1. Run UMD cases through the Volume lab and compute Dice/HD95 against UMD labels with the existing metric code.
2. Separate Python service for nnU-Net/MONAI inference with weights whose licence is checked; model cards in the app.
3. Registration so lab findings get real coordinates; then re-test correspondence.
4. DB triggers and revoked update/delete for append-only tables; real RBAC.
5. Store first-period date so the PCOS adolescent rule can follow the guideline instead of an age line.
6. Reader study of the discrepancy labels with clinicians and ethics approval.
7. Patent attorney review before any novelty claim.
