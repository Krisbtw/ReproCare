# ReproCare Persistent Medical Imaging Storage & Retention Architecture (Supabase Storage + PostgreSQL)

## 1. Storage Architecture Overview

ReproCare separates **binary medical imaging and document storage** (in private Supabase Storage buckets) from **relational clinical and spatial metadata** (in Supabase PostgreSQL):

1. **Relational Metadata Layer (Supabase PostgreSQL)**:
   - `studies`: Study-level metadata (`study_date`, `modality`, `description`, `accession`, `patient_id`).
   - `series`: Series-level acquisition geometry (`series_number`, `plane`, `slice_thickness_mm`, `pixel_spacing_mm`, `slice_count`, `quality`).
   - `imaging_objects`: Content-addressed, versioned catalog of persistent imaging and report artifacts (`dicom`, `volume`, `report`, `mask`, `mesh`), tracking:
     - `id`, `user_id`, `patient_id`, `study_id`, `series_id`, `finding_version_id`, `source_object_id` (provenance link from derived mask/mesh back to source scan).
     - `storage_bucket` (`reprocare-imaging`, `reprocare-reports`, `reprocare-derived`), `storage_provider` (`supabase` or `local_durable`), `object_path`, `storage_uri`.
     - `sop_instance_uid`, `instance_number`, `original_filename`, `mime_type`.
     - `sha256` (64-hex cryptographic digest), `bytes`, `version` (monotonic per series/kind).
     - `processing_status` (`pending_upload`, `completed`), `deidentification_status` (`dicom_ps315_scrubbed`, `deidentified`, `verified_synthetic`).
     - `metadata_json` (extracted spatial geometry: rows, cols, pixelSpacingMm, sliceThicknessMm, imagePositionPatient, imageOrientationPatient, scrubbed tag audit).
     - `status` (`pending_upload`, `active`, `archived`, `purged`, `corrupted`, `missing`), `created_at`, `updated_at`, `purged_at`.
   - `segmentation_runs`: Provenance of AI or manual segmentation runs (`model_id`, `weights_sha256`, `params_json`, `mask_object_id`, `label_counts`, `volume_mm3`, `status`).
   - `finding_versions` & `evidence_links`: Append-only clinical finding versions linked to `study_id`, `series_id`, `segmentation_run_id`, `imaging_object_id` (source scan), and `mask_object_id` (derived segmentation mask).

2. **Private Supabase Storage Buckets (`src/lib/imaging/supabase-storage.server.ts` & `src/lib/imaging/storage.server.ts`)**:
   All medical storage buckets are strictly **private (`public: false`)** with enforced MIME-type allowlists and file-size ceilings:
   - **`reprocare-imaging`** (`512 MB` max per object): Original DICOM files (`application/dicom`), DICOM studies, NIfTI volumes (`.nii`, `.nii.gz`), and MRI image data.
   - **`reprocare-reports`** (`64 MB` max per object): Clinical PDF reports (`application/pdf`), DOCX reports, and supporting medical documents.
   - **`reprocare-derived`** (`256 MB` max per object): Segmentation masks, 3D STL/OBJ meshes (`model/stl`, `model/obj`), derived imaging volumes, and processing outputs.
   - **Provisioning**: Run `npm run storage:setup` (`node scripts/setup-supabase-storage.mjs`) or apply `migrations/0014_supabase_storage_integration.sql` (`npm run db:migrate`) to create and enforce `public = false` across all three buckets.

---

## 2. Large Imaging Uploads, TUS Resumable Protocol & Short-Lived Signed URLs

1. **Direct-to-Storage Uploads (`authorizeDirectImagingUpload` + `completeDirectImagingUpload`)**:
   - Medical imaging studies (multi-slice DICOM series and 3D NIfTI volumes) can exceed Vercel's 4.5 MB serverless request payload limit.
   - Instead of routing large binaries through a normal serverless request body, `authorizeDirectImagingUpload()` first verifies caller RBAC, clinician verification, patient ownership, and active non-revoked consent (`checkPatientAndClinicianAccess`), validates cross-patient `studyId`/`seriesId`/`findingVersionId`, validates the file size and MIME type against the target bucket specification, and generates a server-controlled `objectPath`.
   - For files ≤ 6 MB (or when `uploadMode: "signed_url"` is requested), it issues a short-lived **Signed Upload URL** (`POST /storage/v1/object/upload/sign/{bucket}/{path}`).
   - For large imaging files (`> 6 MB` or `uploadMode: "tus_resumable"`), it creates a **TUS 1.0.0 Resumable Upload session** (`https://<project_ref>.storage.supabase.co/storage/v1/upload/resumable`) with 6 MB chunking (`executeTusResumableUpload`) and automatic `HEAD` offset resumption on unstable connections.
   - Once uploaded, `completeDirectImagingUpload()` downloads/verifies the stored object, checks its exact byte length and SHA-256 digest against the declared checksum (deleting and marking `corrupted` on mismatch), and activates the record (`status = 'active'`).
2. **Short-Lived Signed Download URLs (`generateAuthorizedSignedDownloadUrl`)**:
   - All buckets remain private; permanent public URLs are never generated.
   - `generateAuthorizedSignedDownloadUrl()` enforces `checkPatientAndClinicianAccess()` (verifying patient ownership or active, non-expired, non-revoked clinician consent granting `'view_imaging'`), rejects manipulated `patientId`/`studyId` parameters, and issues a short-lived signed URL (default `120` seconds, clamped to `15..900` seconds) recorded in `audit_events`.
3. **Direct Python `imaging-service` Storage Processing (`/storage/inspect` & `/storage/segment/{model_id}`)**:
   - `imaging-service/app/storage_client.py` allows the Python FastAPI service to download DICOM slices directly from `reprocare-imaging` by object reference, verify SHA-256 checksums in memory, and optionally write derived segmentation masks directly to `reprocare-derived`.

---

## 3. Local-to-Supabase Storage Migration (`scripts/migrate-storage-to-supabase.mjs`)

To migrate existing local development/demo files from `.data/imaging` to Supabase Storage without data loss:
```bash
DATABASE_URL="postgresql://..." \
SUPABASE_URL="https://mfbqdesghtvalkywzsdb.supabase.co" \
SUPABASE_SERVICE_ROLE_KEY="<service-role-key>" \
npm run storage:migrate -- --dry-run
```
Remove `--dry-run` to execute the migration. The migration tool:
1. Enumerates active `imaging_objects` rows and validates patient/study links.
2. Verifies local file SHA-256 checksums before upload.
3. Uploads to `reprocare-imaging`, `reprocare-reports`, or `reprocare-derived`.
4. Downloads and re-verifies the remote SHA-256 checksum before updating `storage_provider = 'supabase'` and `storage_bucket` in PostgreSQL.
5. Never deletes original local files (`localFilesDeleted: false`) until verified.
