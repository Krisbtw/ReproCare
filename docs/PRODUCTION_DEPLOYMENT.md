# ReproCare / AnatomyBridge — Production Deployment, Persistent Storage, Backup & Recovery Guide

**Last Updated:** 2026-11-02  
**Primary Files:** `docker-compose.yml`, `docker-compose.prod.yml`, `Dockerfile`, `imaging-service/Dockerfile`, `src/lib/imaging/storage.server.ts`, `migrations/0001_auth.sql`–`0012_sprint4_collaboration_and_report_intelligence.sql`

---

## 1. Architecture & Container Topology

ReproCare runs as three core services (plus optional loopback-bound Prometheus/Grafana monitoring in `docker-compose.prod.yml`):
1. **`web` (Node.js / TanStack Start Full-Stack Server, Port `8080`):** Serves the React frontend, executes authenticated server functions (`src/lib/clinic/server.ts`), enforces RBAC and consent, manages persistent imaging storage (`src/lib/imaging/storage.server.ts`), and proxies authenticated requests to `imaging`.
2. **`imaging` (Python FastAPI Medical Imaging & AI Service, Internal Port `8100`):** Performs DICOM series inspection, 3D volume reconstruction, `SimpleUnet3D` inference, physical fibroid morphometry, and evaluation. Protected by constant-time `X-Service-Key` verification (`ANATOMYBRIDGE_SERVICE_API_KEY`) and never exposed publicly in production.
3. **`db` (PostgreSQL 15.8 Alpine, Internal Port `5432`):** Stores relational records (`profiles`, `clinician_verifications`, `patients`, `patient_clinician_consents`, `studies`, `series`, `imaging_objects`, `segmentation_runs`, `findings`, `finding_versions`, `registrations`, `reports`, `audit_events`, and condition pathway tables).

---

## 2. Dedicated Persistent Volumes (PostgreSQL + Medical Imaging + Backups + Checkpoints)

A PostgreSQL volume (`postgres_data`) persists relational metadata only and **never** persists binary DICOM, NIfTI, mask, mesh, or PDF files. Both `docker-compose.yml` and `docker-compose.prod.yml` configure four separate named Docker volumes:

| Docker Volume Name | Container Mount Path | Purpose |
| :--- | :--- | :--- |
| `postgres_data` | `/var/lib/postgresql/data` (`db`) | Relational database tables, append-only `finding_versions`, and `audit_events`. |
| `imaging_storage_data` | `/var/lib/reprocare/imaging` (`web` rw, `imaging` ro) | Content-addressed binary DICOM slices, 3D volumes, masks, STL/OBJ meshes, reports, and the durable audit outbox (`.audit/audit-outbox.jsonl`). |
| `imaging_backup_data` | `/var/lib/reprocare/backups` (`web` rw) | Timestamped, SHA-256 manifested backup bundles created by `createImagingStorageBackup()`. |
| `model_checkpoints_data` | `/var/lib/reprocare/models` (`imaging` rw) | Versioned `SimpleUnet3D` `.pt` checkpoints, `.meta.json` provenance files, and `checkpoint_registry.json`. |

---

## 3. Production Environment Variables & Secrets Management

All secrets must be injected server-side via environment variables or a secret manager (never prefixed with `VITE_` and never committed to Git):

| Variable | Required in Prod? | Description |
| :--- | :---: | :--- |
| `DATABASE_URL` | **Yes** | PostgreSQL connection string (`postgresql://user:pass@db:5432/reprocare_db`). |
| `ANATOMYBRIDGE_SERVICE_URL` | **Yes** | Internal URL of the Python imaging service (`http://imaging:8100`). |
| `ANATOMYBRIDGE_SERVICE_API_KEY` | **Yes** | High-entropy shared secret (≥32 chars) verified via `hmac.compare_digest` between `web` and `imaging`. |
| `REPROCARE_IMAGING_STORAGE_DIR` | **Yes** | Server-side directory for binary imaging artifacts (`/var/lib/reprocare/imaging`). |
| `REPROCARE_IMAGING_BACKUP_DIR` | **Yes** | Server-side directory for imaging backups (`/var/lib/reprocare/backups`). |
| `REPROCARE_STORAGE_BACKEND` | Optional | `local_durable` (default) or `s3_compatible` (requires server-side `REPROCARE_S3_BUCKET`, `REPROCARE_S3_ACCESS_KEY_ID`, `REPROCARE_S3_SECRET_ACCESS_KEY`). Public bucket URLs are strictly prohibited. |
| `ANATOMYBRIDGE_UMD_WEIGHTS` | Optional | Path to a verified `SimpleUnet3D` checkpoint (`/var/lib/reprocare/models/umd_unet3d.pt`). When unset, `/models` honestly reports `connected: false`. |
| `REPROCARE_LLM_MODE` | Optional | `local_extractive` (default, zero outbound network calls), `disabled`, or `external_authorized` (requires `REPROCARE_LLM_EXTERNAL_PRIVACY_APPROVED=true` and `REPROCARE_LLM_API_KEY`). |

---

## 4. Database Migrations

Apply all SQL migrations in numerical order (`0001` through `0012`) cleanly and reversibly:

```bash
for f in migrations/00*.sql; do
  echo "Applying $f..."
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
done
```

---

## 5. Backup, Actual Restoration & Consistency Reconciliation Procedures

1. **Create Verified Storage Backup (`createImagingStorageBackup`):**
   - Verifies the SHA-256 checksum of every active binary object on disk, copies each blob into `<backupDir>/blobs/`, snapshots `.audit/audit-outbox.jsonl`, and writes a signed `<backupDir>/manifest.json` with a top-level `manifestSha256`.
2. **Execute Actual Backup Restoration (`restoreImagingStorageBackup`):**
   - Verifies `manifest.json` integrity (`manifestSha256`) and each backup blob's SHA-256 hash before copying blobs back to their target `storageUri` paths, re-verifies every restored file on disk, reconciles the `imaging_objects` database rows (`status = 'active'`), replays any pending audit outbox entries (`flushPendingAuditOutbox`), and records a `restore_imaging_backup` audit event.
3. **Storage Consistency Monitoring (`reconcileImagingStorageConsistency`):**
   - Scans all `imaging_objects` rows against physical storage to detect `missingBlobObjectIds`, `corruptedBlobObjectIds`, and `purgedWithLingeringFileObjectIds`, optionally repairing database status flags (`repairStatuses: true`).

---

## 6. Running & Testing the Complete Application

### 6.1 Run All Automated Tests

```bash
# 1. Run all 23 TypeScript test suites (RBAC, Consent, Storage, Backup/Restore, DICOM/NIfTI, ReproTrace, OCR, LLM, Pathways)
npm test

# 2. Run all 13 Python imaging-service test suites (API, Auth, CORS, 3D U-Net Gradients, Training, Evaluation, DICOM Codecs, Trends)
cd imaging-service
ANATOMYBRIDGE_DEV_NO_AUTH=1 pytest
```

### 6.2 Start the Full Stack Locally

```bash
docker compose up --build -d
# Web UI: http://localhost:8080
# Imaging Service Health (loopback): http://127.0.0.1:8100/health
```
