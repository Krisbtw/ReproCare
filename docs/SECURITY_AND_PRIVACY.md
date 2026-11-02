# ReproCare / AnatomyBridge — Security, Authorization, Audit Reliability & Privacy Architecture

**Last Updated:** 2026-11-02  
**Primary Modules:** `src/lib/auth/middleware.ts`, `src/lib/clinic/server.ts`, `src/lib/clinic/collaboration.ts`, `src/lib/imaging/storage.server.ts`, `src/lib/dicom/deidentify.ts`, `src/lib/reports/deidentify.ts`, `imaging-service/app/auth.py`, `imaging-service/app/dicom_deidentify.py`

---

## 1. Fail-Closed Authentication & Role-Based Access Control (RBAC)

1. **No Unauthenticated Access:** Every server function and imaging-service endpoint requires a verified caller identity (`requireAuthenticatedUser` in `src/lib/clinic/server.ts`, `verifyCallerIdentityAndProfile` in `src/lib/imaging/storage.server.ts`, and `X-Service-Key` HMAC constant-time comparison in `imaging-service/app/auth.py`).
2. **Fail-Closed Profile & Database Error Handling:**
   - If a caller's `user_id` has no row in `profiles`, has an unrecognized role, or if any database query throws an error during profile/consent lookup, `verifyCallerIdentityAndProfile()` and `checkPatientAndClinicianAccess()` immediately throw an `Unauthorized` error and **never** fall back to granting access.
3. **Clinician Verification Gate:**
   - A `role = 'clinician'` string in `profiles` is **never** sufficient on its own to grant clinician privileges.
   - `resolveUserAuthorization()` (`src/lib/clinic/server.ts`) and `verifyCallerIdentityAndProfile()` (`src/lib/imaging/storage.server.ts`) query the latest record in `clinician_verifications` and require `status IN ('verified', 'approved')` with non-empty `licence_no` and `registry`.
   - Unverified, pending, rejected, suspended, or revoked clinicians are downgraded to `canPerformClinicianActions: false` and blocked from all clinician-restricted operations.
   - `promoteUser` cannot bypass the administrator-controlled clinician verification workflow.
4. **Administrator Isolation:**
   - Administrators (`role = 'admin'`) can review and decide clinician verification requests (`decideClinicianVerification`) and run system-level storage maintenance/backups, but do **not** automatically receive unrestricted clinical read/write access to individual patients' private medical records without authorization.

---

## 2. Granular Patient–Clinician Consent & Immediate Revocation

Patients control access to their own medical records (`patients.is_self = true`) via `patient_clinician_consents` (`migrations/0012_sprint4_collaboration_and_report_intelligence.sql`):
- **Supported Granular Permissions (`ALL_CLINICIAN_PERMISSIONS`):**
  1. `view_demographics`
  2. `view_reports`
  3. `view_imaging`
  4. `view_findings`
  5. `view_longitudinal_history`
  6. `add_annotations`
  7. `review_ai_findings`
  8. `approve_or_reject_findings`
- **Real-Time Enforcement:** Every cross-user access checks `evaluateClinicianConsentForPatient()`. If a patient revokes consent (`status = 'revoked'`), if `expires_at` is in the past, or if the clinician's verification is suspended/revoked, access is denied immediately on the next request.
- **Anti-Escalation:** Users cannot grant consent to themselves (`patient_user_id !== clinician_user_id`), and clinicians cannot grant or widen consent on a patient's behalf.

---

## 3. Medical Imaging Storage Security & IDOR Prevention

`src/lib/imaging/storage.server.ts` enforces identical fail-closed authorization across all imaging artifact kinds (`dicom`, `volume`, `mask`, `mesh`, `report`):
- **Cross-Patient IDOR Validation:** Before storing, listing, or retrieving any artifact or historical finding evidence chain, the server verifies that `patientId`, `studyId`, `seriesId`, `findingId`, `findingVersionId`, and `sourceObjectId` all belong to the same authorized patient record. Mismatched or manipulated IDs immediately throw an `Unauthorized` error.
- **Path Traversal & Size Guards:** `validateSafeId()` rejects `..`, `/`, `\`, null bytes, and overlong IDs; resolved file paths are verified via `fullPath.startsWith(base)` and capped at `MAX_IMAGING_OBJECT_BYTES` (`64 MB`).
- **Sensitive Metadata Redaction:** `redactSensitiveMetadata()` strips keys matching passwords, tokens, API keys, connection strings, storage roots, and direct patient identifiers (`patient_name`, `patient_birth`, `patient_address`, `patient_phone`, `ssn`, `aadhaar`), and scrubs embedded `Bearer` tokens and `postgresql://` URIs.
- **No Public Image URLs:** `validateStorageBackendConfig()` prohibits public bucket URLs (`REPROCARE_ALLOW_PUBLIC_IMAGING_URLS`) and client-exposed `VITE_` storage secrets. All imaging bytes flow strictly through authenticated server functions.

---

## 4. Durable Audit Outbox & Two-Phase Atomic Purge

1. **Durable Audit Outbox (`writeAuditEvent`, `flushPendingAuditOutbox`, `readDurableAuditOutbox`):**
   - Every security, consent, clinician-verification, de-identification, backup, and imaging storage event is written to PostgreSQL `audit_events` AND appended with a SHA-256 integrity hash (`entrySha256`) to `<storageBase>/.audit/audit-outbox.jsonl`.
   - If the database `audit_events` insert fails transiently, the event is persisted to `<storageBase>/.audit/pending-outbox.jsonl` so critical audit records never silently disappear. Calling `flushPendingAuditOutbox(sql)` replays queued events into `audit_events` idempotently (`ON CONFLICT (id) DO NOTHING`).
2. **Two-Phase Atomic Purge (`purgeImagingArtifact`):**
   - When purging a binary artifact under retention or erasure policy, `purgeImagingArtifact()` first stages the file on disk (`rename(fullPath, stagedPath)`), then updates `imaging_objects` (`SET status = 'purged', purged_at = now() RETURNING id`).
   - If the database update fails or updates zero rows, the staged file is immediately rolled back (`rename(stagedPath, fullPath)`) and the operation aborts—preventing any state where a binary file is deleted on disk while its database status remains `'active'`.

---

## 5. De-Identification Safeguards & Honest Privacy Limitations

1. **DICOM PS3.15 Basic Application Level Confidentiality Profile (`src/lib/dicom/deidentify.ts`, `imaging-service/app/dicom_deidentify.py`):**
   - Scrubs standard PHI tags across Groups `0008`, `0010`, `0018`, `0020`, `0032`, `0038`, and `0040`, zeroes the 128-byte Part-10 preamble, removes all odd-group private tags (`group % 2 === 1`), and recursively scrubs nested sequence (`SQ`) items.
   - Remaps `StudyInstanceUID`, `SeriesInstanceUID`, `SOPInstanceUID`, `FrameOfReferenceUID`, and `ReferencedSOPInstanceUID` deterministically using salted HMAC-SHA256 into valid `2.25.<decimal>` UIDs, and shifts dates by a deterministic offset while preserving spatial geometry (`ImagePositionPatient`, `ImageOrientationPatient`, `PixelSpacing`, `SliceThickness`, `PatientPosition`).
   - **Burned-In Pixel Detection & Manual Review Gate:** Inspects header tags (`BurnedInAnnotation 0028,0301`, `RecognizableVisualFeatures 0028,0302`, ultrasound/secondary capture modalities) and scans top/bottom pixel borders for high-contrast glyph overlays. `claimCompleteAnonymisation` is always `false`, and `exportDeidentifiedDicomArtifact()` blocks unreviewed export when `manualReviewRequired` is true unless `clinicianReviewedBurnedInPixels: true` is provided.
2. **NIfTI-1 Metadata & Extension Scrubbing (`deidentifyNiftiBytes`, `deidentify_nifti_bytes`):**
   - Scrubs `db_name`, `descrip`, `aux_file`, and `intent_name` and removes embedded NIfTI-1 header extension blocks (`extension[0] != 0`) while preserving `qform`/`sform` 3D patient-space affine matrices and voxel intensities.
3. **External LLM Privacy Gate (`src/lib/reports/llm-interpreter.ts`):**
   - External LLM calls are disabled by default (`local_extractive` mode). Even if `external_authorized` mode is configured, `interpretReportWithLlm()` blocks outbound transmission (`status: "blocked_by_privacy_gate"`) unless `REPROCARE_LLM_EXTERNAL_PRIVACY_APPROVED=true`, server-side API credentials are set, and `deidentify()` confirms zero residual patient identifiers.
