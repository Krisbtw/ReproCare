# ReproCare / AnatomyBridge — ReproTrace Longitudinal Intelligence & Validation Report

**Last Updated:** 2026-11-02  
**Primary Modules:** `src/lib/imaging/registration.ts`, `src/lib/reprotrace/engine.ts`, `src/lib/reprotrace/matching.ts`, `src/lib/reprotrace/trends.ts`, `src/lib/reprotrace/params.ts`, `imaging-service/app/trends.py`, `src/lib/reprotrace/longitudinal-intelligence.test.ts`

---

## 1. Rigid 3D Registration & Coordinate Transformation Validation

* **Canonical Representation (`src/lib/imaging/registration.ts`):**
  * Uses a 4×4 homogeneous rigid transformation matrix $\mathbf{T}_{\text{moving}\to\text{fixed}} \in SE(3)$ operating in physical DICOM LPS millimetres ($\text{mm}$).
  * `validateTransformMatrix()` enforces:
    1. Finite numeric entries across all 16 elements.
    2. Proper rotation matrix orthogonality: $\|\mathbf{R}^T\mathbf{R} - \mathbf{I}\|_\infty \le 10^{-3}$.
    3. Proper right-handed orientation without reflection: $|\det(\mathbf{R}) - 1| \le 10^{-3}$.
    4. Exact homogeneous bottom row `[0, 0, 0, 1]`.
* **Registration Quality Gating (`src/lib/reprotrace/engine.ts`):**
  * Evaluates study/series reference matching (`fixedStudyId`, `movingStudyId`, `fixedSeriesId`, `movingSeriesId`), Normalized Cross-Correlation (`NCC >= 0.70` for verified, `>= 0.50` for provisional), and residual alignment error (`residualMm <= 15.0 mm`).
  * When registration is missing across different studies, failed (`status === 'failed'`), or below quality thresholds, ReproTrace blocks automatic spatial matching and returns `uncertain_correspondence` (`provisional: true`).

---

## 2. Finding Correspondence Outcomes

`matchFindings()` (`src/lib/reprotrace/matching.ts`) and `matchChronology()` (`src/lib/reprotrace/engine.ts`) evaluate registered 3D Euclidean distance, combined voxel + registration uncertainty $\sigma_{\text{comb}} = \sqrt{\sigma_1^2 + \sigma_2^2 + \sigma_{\text{reg}}^2}$, 3D principal-axis shape similarity (`computeShapeSimilarity`), and anatomical site/laterality compatibility (`evaluateAnatomicalCompatibility`) to produce six explicit outcomes:

| Outcome | Trigger Condition | Clinical Review Requirement |
| :--- | :--- | :--- |
| `confirmed_match` | Authorized clinician explicitly accepts the correspondence (`clinicianDecision === 'accept'`). | Clinician-confirmed (`provisional: false`). |
| `probable_match` / `probable_match_review_required` | Compatible anatomy, valid registration, and spatial distance within adaptive high-confidence tolerance ($\le \max(12\text{ mm}, 2\sigma_{\text{comb}})$), including growing or shrinking lesions at the same site. | Requires clinician sign-off (`provisional: true` unless stable and verified). |
| `possible_match_requiring_review` | Moderate spatial separation ($\le \max(18\text{ mm}, 3\sigma_{\text{comb}})$) or partial shape change. | Flagged for clinician review (`provisional: true`). |
| `new_finding_candidate` / `possible_new_finding` | Finding in follow-up study separated by $> 40\text{ mm}$ from all prior lesions in registered patient space, or clinician rejected prior pairing. | Candidate new lesion (`provisional: true`). |
| `possible_resolved_finding` | Prior finding has no corresponding candidate in a registered follow-up scan covering the same anatomical region. | **Never** automatically declared resolved; labeled `possible_resolved_finding` pending clinician inspection of the follow-up slices. |
| `uncertain_correspondence` | Registration missing/failed, contradictory anatomical labels (e.g., left vs right, uterus vs ovary), or ambiguous multi-lesion clustering. | Requires manual clinician adjudication. |

---

## 3. Longitudinal Physical Measurements & Chronological Validation

* **Anisotropic Physical Geometry (`src/lib/reprotrace/trends.ts`, `imaging-service/app/trends.py`):**
  * Physical volume is computed strictly as $V_{\text{mm}^3} = N_{\text{voxels}} \cdot \Delta x \cdot \Delta y \cdot \Delta z$ ($1\text{ mL} = 1\text{ cm}^3 = 1000\text{ mm}^3$).
  * Physical 3D centroid is computed in DICOM LPS millimetres via the 4×4 patient-space affine matrix.
  * Surface partial-volume boundary uncertainty (`computeVoxelBoundaryUncertainty`) models a $0.5$-voxel boundary shell around the equivalent sphere surface area.
* **Strict Chronological Validation (`validateAndOrderChronology`):**
  * Sorts observations strictly by parsed UTC examination date (`date`), never by upload order or array index.
  * Flags and excludes missing dates (`missing_date`), unparseable dates (`invalid_date`), non-finite/negative volumes (`invalid_measurement_value`), duplicate study IDs (`duplicate_study_id`), and same-day duplicate scans (`duplicate_examination_date`).
  * Refuses to extrapolate monthly growth rates when elapsed time between valid examinations is $< 14\text{ days}$ (`minElapsedDaysForGrowthRate`).

---

## 4. Seven-Category Longitudinal Difference Classification

`attributeLongitudinalChange()` (`src/lib/reprotrace/trends.ts`) and `evaluateLongitudinalChange()` (`src/lib/reprotrace/params.ts`) classify apparent volumetric changes across seven distinct categories:

1. **Biological Anatomical Change (`genuine_anatomical_change` / `biological_anatomical_change`):** Volume delta $|\Delta V| > \sqrt{\sigma_1^2 + \sigma_2^2}$ and $\ge 8\%$ under consistent modality, scanner, voxel spacing, segmentation method, and verified registration over a $\ge 2\text{-day}$ interval.
2. **Acquisition Protocol / Spacing Difference (`protocol_or_spacing_difference` / `acquisition_difference`):** Modality mismatch (e.g., `MR` vs `US`) or slice thickness / voxel volume ratio difference exceeding tolerance (`maxSliceThicknessGapMm = 2.0 mm`, `spacingDifferenceRatioThreshold = 0.35`).
3. **Scanner / Field-Strength Difference (`scanner_difference`):** Different MRI scanner model/manufacturer or magnetic field strength mismatch ($\ge 0.25\text{ T}$, e.g., $1.5\text{ T}$ vs $3.0\text{ T}$).
4. **Segmentation Method Difference (`segmentation_method_difference` / `segmentation_difference`):** Different measurement basis (e.g., `manual_caliper` vs `ai_3d_unet` vs `ellipsoid_report`).
5. **Registration Error or Uncertainty (`registration_error_or_uncertainty` / `registration_error`):** Degraded registration quality (`NCC < 0.50` or `residualMm > 15.0 mm`).
6. **Measurement Uncertainty (`within_measurement_uncertainty` / `measurement_uncertainty`):** $|\Delta V| \le \sqrt{\sigma_1^2 + \sigma_2^2}$ or $< 8\%$.
7. **Insufficient Evidence (`insufficient_evidence`):** Missing physical volume, missing dates, or sub-48-hour interval.

---

## 5. Validation Status & Clinical Limitations

* **Automated Synthetic Verification:** Verified in `src/lib/reprotrace/longitudinal-intelligence.test.ts`, `src/lib/reprotrace/matching.test.ts`, `src/lib/reprotrace/trends.test.ts`, `src/lib/imaging/registration.test.ts`, and `imaging-service/tests/test_trends.py` using known 3D rigid rotations/translations, anisotropic spacings, out-of-order dates, growing/shrinking lesions, and cross-scanner/protocol scenarios.
* **Clinical Validation Disclaimer:** All ReproTrace thresholds (`DEFAULT_REPROTRACE_THRESHOLDS`) carry `isClinicallyValidated: false`. Synthetic registration tests verify mathematical and software correctness only; prospective clinical validation on longitudinal multi-timepoint patient MRI cohorts under IEC-approved protocols is required before clinical use.
