# ReproCare Persistent Medical Imaging Storage & Retention Architecture

## 1. Storage Architecture Overview

ReproCare separates **binary medical imaging object storage** from **relational clinical and spatial metadata** in PostgreSQL:

1. **Relational Metadata Layer (PostgreSQL)**:
   - `studies`: Study-level metadata (`study_date`, `modality`, `description`, `accession`, `patient_id`).
   - `series`: Series-level acquisition geometry (`series_number`, `plane`, `slice_thickness_mm`, `pixel_spacing_mm`, `slice_count`, `quality`).
   - `imaging_objects`: Content-addressed, versioned catalog of persistent imaging artifacts (`dicom_instance`, `dicom_series`, `segmentation_mask`, `mesh_3d`, `registration_transform`), tracking:
     - `id`, `user_id`, `patient_id`, `study_id`, `series_id`, `finding_version_id`, `source_object_id` (provenance link from derived mask/mesh back to source scan).
     - `sop_instance_uid`, `instance_number`, `original_filename`, `mime_type`.
     - `sha256_hash` (64-hex cryptographic digest), `byte_size`, `version` (monotonic per series/kind), `storage_uri`.
     - `metadata_json` (extracted spatial geometry: rows, cols, pixelSpacingMm, sliceThicknessMm, imagePositionPatientMm, imageOrientationPatient, scrubbed tag audit).
     - `status` (`active`, `superseded`, `purged`, `corrupted`, `missing`), `created_at`, `updated_at`, `purged_at`.
   - `segmentation_runs`: Provenance of AI or manual segmentation runs (`model_name`, `model_version`, `seed_point_json`, `parameters_json`, `mask_object_id`, `mesh_object_id`, `voxel_count`, `volume_mm3`, `uncertainty_mm3`, `clinician_confirmed`).
   - `finding_versions` & `evidence_links`: Append-only clinical finding versions linked to `study_id`, `series_id`, `segmentation_run_id`, `imaging_object_id` (source scan), and `mask_object_id` (derived segmentation mask).

2. **Binary Object Storage Layer (`src/lib/imaging/storage.server.ts`)**:
   - **Local Development / Self-Hosted**: Configurable filesystem object store via `REPROCARE_IMAGING_STORAGE_DIR` or `IMAGING_STORAGE_PATH` (defaults to `.reprocare-storage/imaging`), partitioned hierarchically by `<patient_id>/<series_id>/v<version>_<sha256_prefix>_<object_id>.bin`.
   - **Production Deployment**: Supports private object storage or authorized DICOMweb/PACS URIs (`s3://...`, `dicomweb://...`) referenced by `storage_uri`, keeping all storage credentials and signing keys strictly server-side.
   - No public static file serving is exposed for `.reprocare-storage/`; every read or write passes through server-side authentication, RBAC verification, and patient-level access isolation.

---

## 2. Data Integrity, Versioning, and Provenance

- **Cryptographic Checksums**: Every uploaded DICOM instance, segmentation mask, or 3D mesh is hashed with SHA-256 (`sha256_hash`) upon ingestion and re-verified (`verifyImagingObjectIntegrity`) on retrieval.
- **No Silent Overwrites**: Binary writes use exclusive file creation (`flag: "wx"`) with unique versioned paths (`v${version}_${sha256.slice(0,12)}_${id}.bin`). Uploading a new version of a segmentation mask or series increments `version = max(version) + 1` while preserving all earlier versions and their links to historical `finding_versions`.
- **Duplicate Detection**: If an identical payload (`sha256_hash`) is uploaded for the same `(patient_id, series_id, kind)` and the underlying blob is verified intact on disk, `storeImagingArtifact` returns the existing record with `deduplicated: true` instead of writing duplicate bytes.
- **Corruption & Missing-File Detection**: `verifyImagingObjectIntegrity` and `getImagingArtifact` verify:
  1. File existence on storage media (`status = 'missing'` if absent).
  2. Exact byte length match against `byte_size`.
  3. Exact SHA-256 digest match against `sha256_hash` (`status = 'corrupted'` if mismatched).
  Any integrity failure is immediately recorded in `audit_events` and surfaced to the caller without returning corrupted bytes.

---

## 3. Access Control & DICOM Privacy Scrubbing

1. **Authorization & Patient Isolation**:
   - Uploading or mutating clinical imaging artifacts (`executeStoreImagingArtifact`, `executeSaveLabMeasurement`, `executePurgeImagingArtifact`) requires an authenticated user with **approved clinician verification** (`isClinicianVerified === true`) or **administrator** role (`requireVerifiedClinicianOrAdmin`).
   - Retrieving imaging artifacts or historical finding evidence (`executeGetImagingArtifact`, `executeGetHistoricalFindingImagingEvidence`) requires authenticated ownership/authorized access to the target patient record (`requirePatientRecordAccess`), preventing cross-patient data leakage.
2. **Automatic Server-Side DICOM PHI De-Identification**:
   - Before any NEMA PS3.10 DICOM file (`DICM` magic bytes at offset 128) is written to persistent storage, `validateAndScrubDicomBuffer()` parses the explicit-VR dataset, extracts non-identifying spatial geometry (`Rows`, `Columns`, `PixelSpacing`, `SliceThickness`, `ImagePositionPatient`, `ImageOrientationPatient`, `SOPInstanceUID`, `InstanceNumber`), and overwrites direct patient/institution identifier tags in-place (`PatientName`, `PatientID`, `PatientBirthDate`, `PatientAddress`, `PatientTelephoneNumbers`, `OtherPatientIDs`, `OtherPatientNames`, `InstitutionName`, `InstitutionAddress`, `ReferringPhysicianName`, `PerformingPhysicianName`, `OperatorsName`, `AccessionNumber`).
   - Patient identity is linked exclusively through ReproCare's internal access-controlled `patient_id` foreign key, never exposed in logs or filenames.

---

## 4. Retention and Deletion Policy

Medical imaging artifacts linked to clinical findings must support regulatory auditability and longitudinal reproducibility:

1. **Append-Only Clinical History**:
   - `finding_versions`, `reviews`, and `audit_events` are append-only in PostgreSQL (enforced by database triggers in `0003_append_only.sql`).
2. **Audited Retention Purge (`purgeImagingArtifact`)**:
   - When a binary imaging object is purged under a retention policy or patient erasure request, `purgeImagingArtifact()`:
     1. Verifies authorization (`requireVerifiedClinicianOrAdmin` and patient ownership).
     2. Removes the raw binary payload from disk/object storage.
     3. Updates the `imaging_objects` metadata row to `status = 'purged'` and sets `purged_at = now()`, retaining the non-identifying provenance tombstone (`id`, `sha256_hash`, `kind`, `version`, `purged_at`) so historical `finding_versions` can clearly report that their source binary was intentionally purged rather than unexpectedly lost.
     4. Appends an immutable record to `audit_events` (`action = 'purge_imaging_object'`) recording the actor, timestamp, object ID, kind, SHA-256 digest, and retention/deletion reason.
