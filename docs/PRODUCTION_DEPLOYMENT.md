# ReproCare / AnatomyBridge — Production Deployment, Supabase PostgreSQL, Supabase Storage & Vercel Guide

**Last Updated:** 2026-11-02  
**Primary Files:** `src/lib/db.ts`, `src/lib/imaging/supabase-storage.server.ts`, `src/lib/imaging/storage.server.ts`, `scripts/migrate.mjs`, `scripts/setup-supabase-storage.mjs`, `scripts/migrate-storage-to-supabase.mjs`, `migrations/0001_auth.sql`–`0014_supabase_storage_integration.sql`, `imaging-service/app/storage_client.py`, `imaging-service/app/main.py`

---

## 1. Supabase PostgreSQL Database Integration (`src/lib/db.ts` & `scripts/migrate.mjs`)

### 1.1 Supabase Project Reference & Connection Modes
- **Supabase Project Reference:** `mfbqdesghtvalkywzsdb`
- **Supabase Project URL:** `https://mfbqdesghtvalkywzsdb.supabase.co`
- **Direct Connection Template (Port `5432` — for Migrations & Persistent IPv6 Backends):**
  `postgresql://postgres:[YOUR-PASSWORD]@db.mfbqdesghtvalkywzsdb.supabase.co:5432/postgres`
- **Shared Transaction Pooler (Port `6543` — Required for Vercel Serverless Runtime):**
  Obtain the exact region hostname from **Supabase Dashboard → Connect → Transaction pooler** (e.g. `postgresql://postgres.mfbqdesghtvalkywzsdb:[YOUR-PASSWORD]@aws-0-<region>.pooler.supabase.com:6543/postgres?pgbouncer=true`).

### 1.2 Runtime Connection Pooling & Safety Controls
1. **Transaction Pooler Detection (`resolveDatabaseConfig` in `src/lib/db.ts`):**
   - Automatically detects transaction-mode pooling when port is `6543`, `?pgbouncer=true` is present, or `SUPABASE_POOL_MODE=transaction`.
   - Strips `?pgbouncer=true` and `?connection_limit=...` before initializing `pg.Pool` so `node-postgres` parses the URI cleanly.
   - Disables named prepared statements (`preparedStatementsDisabled: true`, executing unnamed extended-protocol queries `{ text, values }`) so Supavisor transaction pooling never fails with `prepared statement already exists`.
   - Sizes the pool for serverless execution (`max: 3`, `idleTimeoutMillis: 10000`, `allowExitOnIdle: true`).
2. **Encrypted TLS Enforcement:**
   - Enforces SSL (`ssl: { rejectUnauthorized: false }` by default, or `rejectUnauthorized: true` when `DATABASE_SSL_REJECT_UNAUTHORIZED=true` / `sslmode=verify-full`) for all `*.supabase.co` and `*.pooler.supabase.com` connections.
3. **Fail-Closed Startup in Production:**
   - In production or Vercel runtimes (`NODE_ENV=production` or `VERCEL=1`), missing/empty `DATABASE_URL` or unreplaced `[YOUR-PASSWORD]` placeholders throw an immediate configuration error. Silent fallback to in-memory PGlite is disabled in production.
4. **Controlled Database Migrations (`npm run db:migrate` / `scripts/migrate.mjs`):**
   - Reads `DIRECT_DATABASE_URL` first (falling back to `DATABASE_URL`).
   - Uses session-level `pg_advisory_lock(72839401)` on direct/session connections and automatically falls back to transaction-scoped `pg_advisory_xact_lock(72839401)` inside each migration's `BEGIN ... COMMIT` block if run through a port `6543` transaction pooler.

---

## 2. Supabase Storage Integration (`src/lib/imaging/supabase-storage.server.ts`)

### 2.1 Private Medical Storage Buckets
All medical files are stored in three **strictly private (`public: false`)** Supabase Storage buckets while relational metadata and SHA-256 checksums remain in PostgreSQL (`imaging_objects`):

| Bucket Name | Visibility | Size Ceiling | Allowed MIME Types | Stored Artifacts |
| :--- | :---: | :---: | :--- | :--- |
| **`reprocare-imaging`** | **Private** (`public: false`) | `512 MB` | `application/dicom`, `application/octet-stream`, `application/gzip`, `application/x-gzip`, `image/nii`, `application/nii` | Original DICOM slices, multi-frame DICOM studies, NIfTI volumes, MRI image data |
| **`reprocare-reports`** | **Private** (`public: false`) | `64 MB` | `application/pdf`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`, `text/plain`, `application/octet-stream` | Clinical PDF reports, DOCX reports, supporting medical documents |
| **`reprocare-derived`** | **Private** (`public: false`) | `256 MB` | `application/octet-stream`, `application/json`, `model/stl`, `model/obj`, `text/plain` | Segmentation masks, 3D STL/OBJ surface meshes, derived imaging volumes |

### 2.2 Provisioning Buckets & Storage Policies
1. **Automated CLI Provisioning:**
   ```bash
   SUPABASE_URL="https://mfbqdesghtvalkywzsdb.supabase.co" \
   SUPABASE_SERVICE_ROLE_KEY="<your-service-role-key>" \
   npm run storage:setup
   ```
2. **SQL Migration Provisioning (`migrations/0014_supabase_storage_integration.sql`):**
   - Running `npm run db:migrate` against Supabase PostgreSQL adds `storage_bucket`, `storage_provider`, `object_path`, `processing_status`, and `deidentification_status` to `imaging_objects` and idempotently upserts the three private buckets in `storage.buckets` with `public = false`.

---

## 3. Vercel Environment Variable Checklist

Configure the following environment variables in **Vercel Dashboard → Project Settings → Environment Variables** (never commit secrets to Git, and never prefix server secrets with `VITE_`):

| Variable | Scope | Prod | Preview | Dev | Where to Obtain / Value |
| :--- | :---: | :---: | :---: | :---: | :--- |
| `DATABASE_URL` | Server-only | **Required** | **Required** | Optional (PGlite fallback) | **Supabase Dashboard → Connect → Transaction pooler (Port 6543)**: `postgresql://postgres.mfbqdesghtvalkywzsdb:[PASSWORD]@aws-0-<region>.pooler.supabase.com:6543/postgres?pgbouncer=true` |
| `DIRECT_DATABASE_URL` | Server-only | Recommended | Recommended | Optional | **Supabase Dashboard → Connect → Direct connection (Port 5432)** (or Session pooler): `postgresql://postgres:[PASSWORD]@db.mfbqdesghtvalkywzsdb.supabase.co:5432/postgres` (used by `npm run db:migrate`) |
| `SUPABASE_URL` | Server-only | **Required** | **Required** | Optional | **Supabase Dashboard → Project Settings → API → Project URL**: `https://mfbqdesghtvalkywzsdb.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | **Server-only (Secret)** | **Required** | **Required** | Optional | **Supabase Dashboard → Project Settings → API → `service_role` secret key** (NEVER expose in `VITE_*` or client code) |
| `SUPABASE_ANON_KEY` | Server-only / Optional | Optional | Optional | Optional | **Supabase Dashboard → Project Settings → API → `anon` `public` key** |
| `REPROCARE_STORAGE_BACKEND` | Server-only | **Required** (`supabase`) | **Required** (`supabase`) | `local_durable` or `supabase` | Set to `supabase` in Production and Preview |
| `ANATOMYBRIDGE_SERVICE_URL` | Server-only | Auto-bound / URL | Auto-bound / URL | `http://localhost:8100` | Injected automatically by `vercel.json` service binding, or set to external FastAPI container URL |
| `ANATOMYBRIDGE_SERVICE_API_KEY` | **Server-only (Secret)** | **Required** | **Required** | Optional | Generate a 32+ byte random hex secret (`openssl rand -hex 32`) shared between `app` and `imaging-service` |
| `BETTER_AUTH_URL` | Server-only | **Required** | Optional | `http://localhost:8080` | Your production domain (e.g. `https://reprocare.vercel.app`) |
| `VITE_AUTH_ENABLED` | Build + Runtime | `true` | `true` | `true` | Enables Better Auth sign-in enforcement |
| `BOOTSTRAP_ADMIN_EMAILS` | Server-only | Optional | Optional | `admin@reprocare.org` | Comma-separated emails granted initial administrator role |
| `REPROCARE_LLM_MODE` | Server-only | `local_extractive` | `local_extractive` | `local_extractive` | Defaults to `local_extractive` (zero external network calls) |

---

## 4. Python `imaging-service/` Runtime & Vercel Compatibility Assessment

| Verification Dimension | Measured / Verified Finding | Vercel Serverless Impact & Resolution |
| :--- | :--- | :--- |
| **1. FastAPI Entrypoint & Startup** | `imaging-service/app/main.py` exports `app = FastAPI(...)`; Docker CMD runs `uvicorn app.main:app --host 0.0.0.0 --port 8100`. | Compatible with both Vercel's `fastapi` builder and container runtimes. |
| **2–3. Python Packages (`torch`, `SimpleITK`, `scipy`, `numpy`, `pydicom`)** | Measured sizes: `numpy` (66.4 MB), `scipy` (139.8 MB), `Pillow` (13.4 MB), plus `SimpleITK` (~185 MB) and CPU `torch` (~480 MB) = **~890 MB uncompressed**. | **Exceeds standard Vercel Python Serverless Function 250 MB uncompressed bundle limit.** Requires either Vercel Container Runtime or external container hosting for full 3D U-Net inference. |
| **4. Native DICOM Decoding Codecs** | `pydicom` + `Pillow` + `pylibjpeg` (`pylibjpeg-libjpeg`, `pylibjpeg-openjpeg`) decode Explicit/Implicit VR LE/BE, RLE, JPEG, and JPEG 2000. | Pure-Python + `Pillow` codecs run anywhere; `pylibjpeg` C++ wheels require Linux x86_64/arm64 container or manylinux runtime. |
| **5. Tesseract OCR Binary (`/usr/bin/tesseract`)** | Installed in root `Dockerfile` (`apt-get install tesseract-ocr tesseract-ocr-eng poppler-utils`). | Absent in standard Vercel Node.js serverless base image; `src/lib/reports/ocr.ts` gracefully degrades (`ocr_unavailable_manual_review_required`) unless run in a container runtime. |
| **6–9. Payload Size (4.5 MB Limit), Memory & Timeout** | 3D MRI series (15–200 MB) exceed Vercel's 4.5 MB HTTP body limit; 3D U-Net inference uses ~1.5 GB RAM and 8–35s CPU time. | **Resolved for payloads:** `authorizeDirectImagingUpload` (Signed URL / TUS Resumable Upload) + `POST /storage/inspect` and `POST /storage/segment/{model_id}` fetch DICOMs directly from `reprocare-imaging` in Supabase Storage, bypassing the 4.5 MB body limit. |
| **10–13. Supabase Storage, Auth, CORS & Health** | `imaging-service/app/storage_client.py` connects to `reprocare-imaging` and `reprocare-derived` with `SUPABASE_SERVICE_ROLE_KEY`; `/health` reports `supabase_storage` status; `verify_service_auth` enforces constant-time `hmac.compare_digest`. | Verified by `115 / 115` passing Python tests (`test_supabase_storage.py`, `test_api.py`, `test_security_comprehensive.py`). |

### Recommended Production Hosting for `imaging-service/` if Standard Vercel Serverless Bundle Limit Applies
If deploying on a standard Vercel plan where the 250 MB Python serverless bundle limit prevents bundling PyTorch + SimpleITK inside a serverless function:
1. Deploy `imaging-service/` as a Docker container using `imaging-service/Dockerfile` on **Render** (Docker Web Service, ≥2 GB RAM), **Railway**, **Fly.io**, **Google Cloud Run** (`--memory=4Gi --cpu=2`), or **AWS ECS Fargate**.
2. Set `ANATOMYBRIDGE_SERVICE_API_KEY`, `SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY` on that container service.
3. Set `ANATOMYBRIDGE_SERVICE_URL` in Vercel Project Environment Variables to the deployed `imaging-service` HTTPS URL.
