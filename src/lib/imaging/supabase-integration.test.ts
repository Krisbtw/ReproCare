import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import {
  checkDatabaseHealth,
  isProductionDatabaseRuntime,
  redactDatabaseUrl,
  resolveDatabaseConfig,
  sanitizeDatabaseError,
  type Sql,
} from "../db.ts";
import {
  resolveMigrationConnectionConfig,
  redactMigrationUrl,
} from "../../../scripts/migrate.mjs";
import {
  provisionSupabaseBuckets,
} from "../../../scripts/setup-supabase-storage.mjs";
import { buildSyntheticMrDicom } from "../dicom/codec.ts";
import { buildSyntheticSeries } from "../dicom/series-writer.ts";
import {
  SUPABASE_STORAGE_BUCKETS,
  SupabaseStorageProvider,
  authorizeDirectImagingUpload,
  completeDirectImagingUpload,
  executeTusResumableUpload,
  generateAuthorizedSignedDownloadUrl,
  getHistoricalFindingImagingEvidence,
  getImagingArtifact,
  listImagingArtifacts,
  migrateLocalImagingToSupabase,
  purgeImagingArtifact,
  resolveBucketForArtifactKind,
  resolveSupabaseStorageConfig,
  setCustomStorageFetchForTests,
  storeImagingArtifact,
  validateStorageBackendConfig,
  verifySignedUrlAccess,
} from "./storage.server.ts";
import {
  executeGrantClinicianConsent,
  executeRevokeClinicianConsent,
  executeSaveLabMeasurement,
} from "../clinic/server.backend.ts";

/**
 * In-memory simulation of Supabase Storage REST API + TUS 1.0.0 Resumable Upload server
 * for deterministic, full-protocol testing of `SupabaseStorageProvider` without external credentials.
 */
function createMockSupabaseStorageServer() {
  const buckets = new Map<
    string,
    { id: string; name: string; public: boolean; file_size_limit?: number; allowed_mime_types?: string[] }
  >();
  const objects = new Map<string, { data: Buffer; mimeType: string; updatedAt: string }>();
  const tusSessions = new Map<
    string,
    { bucket: string; objectPath: string; totalBytes: number; mimeType: string; chunks: Buffer[]; offset: number }
  >();
  const requestLog: Array<{ method: string; url: string; hasAuth: boolean }> = [];

  const mockFetch: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const u = new URL(rawUrl);
    const method = (init?.method || "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const authHeader = headers.get("authorization") || "";
    const apiKey = headers.get("apikey") || "";
    const hasAuth = authHeader.startsWith("Bearer ") && apiKey.length > 0;
    requestLog.push({ method, url: rawUrl, hasAuth });

    if (!hasAuth && !u.pathname.includes("/upload/resumable/")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    }

    // 1. Bucket management: GET /storage/v1/bucket, POST /storage/v1/bucket, PUT /storage/v1/bucket/:id
    if (u.pathname === "/storage/v1/bucket" && method === "GET") {
      return new Response(JSON.stringify([...buckets.values()]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (u.pathname === "/storage/v1/bucket" && method === "POST") {
      const body = JSON.parse(String(init?.body || "{}"));
      buckets.set(body.id, {
        id: body.id,
        name: body.name || body.id,
        public: Boolean(body.public),
        file_size_limit: body.file_size_limit,
        allowed_mime_types: body.allowed_mime_types,
      });
      return new Response(JSON.stringify({ name: body.id }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (u.pathname.startsWith("/storage/v1/bucket/") && method === "PUT") {
      const id = decodeURIComponent(u.pathname.slice("/storage/v1/bucket/".length));
      const body = JSON.parse(String(init?.body || "{}"));
      buckets.set(id, {
        id,
        name: body.name || id,
        public: Boolean(body.public),
        file_size_limit: body.file_size_limit,
        allowed_mime_types: body.allowed_mime_types,
      });
      return new Response(JSON.stringify({ message: "Successfully updated" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    // 2. TUS Resumable Upload creation: POST /storage/v1/upload/resumable
    if (u.pathname === "/storage/v1/upload/resumable" && method === "POST") {
      const totalBytes = Number(headers.get("upload-length") || 0);
      const rawMeta = headers.get("upload-metadata") || "";
      const metaMap: Record<string, string> = {};
      for (const pair of rawMeta.split(",")) {
        const [k, v] = pair.trim().split(/\s+/);
        if (k && v) metaMap[k] = Buffer.from(v, "base64").toString("utf8");
      }
      const sessionId = `tus_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      tusSessions.set(sessionId, {
        bucket: metaMap.bucketName || "reprocare-imaging",
        objectPath: metaMap.objectName || "unknown.bin",
        totalBytes,
        mimeType: metaMap.contentType || "application/octet-stream",
        chunks: [],
        offset: 0,
      });
      return new Response(null, {
        status: 201,
        headers: {
          Location: `${u.origin}/storage/v1/upload/resumable/${sessionId}`,
          "Tus-Resumable": "1.0.0",
        },
      });
    }

    // 3. TUS Resumable Upload HEAD / PATCH: /storage/v1/upload/resumable/:sessionId
    if (u.pathname.startsWith("/storage/v1/upload/resumable/")) {
      const sessionId = u.pathname.slice("/storage/v1/upload/resumable/".length);
      const sess = tusSessions.get(sessionId);
      if (!sess) return new Response("Not found", { status: 404 });

      if (method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: {
            "Upload-Offset": String(sess.offset),
            "Upload-Length": String(sess.totalBytes),
            "Tus-Resumable": "1.0.0",
          },
        });
      }
      if (method === "PATCH") {
        const reqOffset = Number(headers.get("upload-offset") || 0);
        if (reqOffset !== sess.offset) {
          return new Response("Conflict offset", { status: 409 });
        }
        const rawBody = init?.body as Uint8Array;
        const buf = Buffer.from(rawBody);
        sess.chunks.push(buf);
        sess.offset += buf.byteLength;
        if (sess.offset >= sess.totalBytes) {
          const full = Buffer.concat(sess.chunks);
          objects.set(`${sess.bucket}:${sess.objectPath}`, {
            data: full,
            mimeType: sess.mimeType,
            updatedAt: new Date().toISOString(),
          });
        }
        return new Response(null, {
          status: 204,
          headers: {
            "Upload-Offset": String(sess.offset),
            "Tus-Resumable": "1.0.0",
          },
        });
      }
    }

    // 4. Signed Upload URL: POST /storage/v1/object/upload/sign/:bucket/*
    if (u.pathname.startsWith("/storage/v1/object/upload/sign/") && method === "POST") {
      const rest = u.pathname.slice("/storage/v1/object/upload/sign/".length);
      const slashIdx = rest.indexOf("/");
      const bucket = rest.slice(0, slashIdx);
      const objectPath = rest.slice(slashIdx + 1).split("/").map(decodeURIComponent).join("/");
      const token = `upload_tok_${Math.random().toString(36).slice(2, 10)}`;
      return new Response(
        JSON.stringify({
          url: `/object/upload/sign/${bucket}/${objectPath}?token=${token}`,
          token,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    // 5. Signed Download URL: POST /storage/v1/object/sign/:bucket/*
    if (u.pathname.startsWith("/storage/v1/object/sign/") && method === "POST") {
      const rest = u.pathname.slice("/storage/v1/object/sign/".length);
      const slashIdx = rest.indexOf("/");
      const bucket = rest.slice(0, slashIdx);
      const objectPath = rest.slice(slashIdx + 1).split("/").map(decodeURIComponent).join("/");
      const token = `dl_tok_${Math.random().toString(36).slice(2, 10)}`;
      return new Response(
        JSON.stringify({
          signedURL: `/object/sign/${bucket}/${objectPath}?token=${token}`,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    // 6. Object metadata info: GET /storage/v1/object/info/:bucket/*
    if (u.pathname.startsWith("/storage/v1/object/info/") && method === "GET") {
      const rest = u.pathname.slice("/storage/v1/object/info/".length);
      const slashIdx = rest.indexOf("/");
      const bucket = rest.slice(0, slashIdx);
      const objectPath = rest.slice(slashIdx + 1).split("/").map(decodeURIComponent).join("/");
      const entry = objects.get(`${bucket}:${objectPath}`);
      if (!entry) return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
      return new Response(
        JSON.stringify({
          size: entry.data.byteLength,
          content_type: entry.mimeType,
          etag: createHash("sha256").update(entry.data).digest("hex").slice(0, 16),
          updated_at: entry.updatedAt,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    // 7. Object Upload / Download / Delete: /storage/v1/object/:bucket/*
    if (u.pathname.startsWith("/storage/v1/object/")) {
      const rest = u.pathname.slice("/storage/v1/object/".length);
      if (method === "DELETE") {
        const bucket = decodeURIComponent(rest.replace(/\/+$/, ""));
        const body = JSON.parse(String(init?.body || "{}"));
        const prefixes: string[] = body.prefixes || [];
        for (const p of prefixes) {
          objects.delete(`${bucket}:${p}`);
        }
        return new Response(JSON.stringify({ message: "Deleted" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      const slashIdx = rest.indexOf("/");
      const bucket = rest.slice(0, slashIdx);
      const objectPath = rest.slice(slashIdx + 1).split("/").map(decodeURIComponent).join("/");
      const key = `${bucket}:${objectPath}`;

      if (method === "POST" || method === "PUT") {
        const upsert = headers.get("x-upsert") === "true";
        if (!upsert && objects.has(key)) {
          return new Response(JSON.stringify({ error: "Duplicate" }), { status: 409 });
        }
        const rawBody = init?.body as Uint8Array;
        const buf = Buffer.from(rawBody);
        const mimeType = headers.get("content-type") || "application/octet-stream";
        objects.set(key, {
          data: buf,
          mimeType,
          updatedAt: new Date().toISOString(),
        });
        const etag = createHash("sha256").update(buf).digest("hex").slice(0, 16);
        return new Response(JSON.stringify({ Key: `${bucket}/${objectPath}`, Id: key }), {
          status: 200,
          headers: { "content-type": "application/json", etag },
        });
      }

      if (method === "GET") {
        const entry = objects.get(key);
        if (!entry) {
          return new Response(JSON.stringify({ error: "Object not found" }), { status: 404 });
        }
        return new Response(new Uint8Array(entry.data), {
          status: 200,
          headers: {
            "content-type": entry.mimeType,
            "content-length": String(entry.data.byteLength),
          },
        });
      }
    }

    return new Response("Unhandled mock route", { status: 404 });
  };

  return { buckets, objects, tusSessions, requestLog, mockFetch };
}

async function createSupabaseTestDb() {
  const storageDir = mkdtempSync(join(tmpdir(), "reprocare-supa-test-"));
  process.env.REPROCARE_IMAGING_STORAGE_DIR = storageDir;

  const pg = new PGlite();
  for (const mig of [
    "0001_auth.sql",
    "0002_anatomybridge.sql",
    "0003_append_only.sql",
    "0004_menarche_year.sql",
    "0005_report_ingestion.sql",
    "0006_performance_indices.sql",
    "0007_fix_profile_default.sql",
    "0008_clinician_verification.sql",
    "0009_imaging_and_provenance.sql",
    "0010_sprint1_auth_and_registration.sql",
    "0011_sprint3_imaging_storage_and_reprotrace.sql",
    "0012_sprint4_collaboration_and_report_intelligence.sql",
    "0013_sprint5_dicom_and_condition_workflows.sql",
    "0014_supabase_storage_integration.sql",
  ]) {
    await pg.exec(readFileSync(new URL(`../../../migrations/${mig}`, import.meta.url), "utf8"));
  }

  await pg.exec(
    "create table if not exists _migrations (name text primary key, applied_at timestamptz not null default now())",
  );
  await pg.exec("insert into _migrations (name) values ('0014_supabase_storage_integration.sql')");

  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.reduce(
      (acc, s, i) => acc + s + (i < values.length ? `$${i + 1}` : ""),
      "",
    );
    return (await pg.query(text, values as unknown[])).rows;
  }) as unknown as Sql;
  sql.query = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => {
    return (await pg.query(text, params)).rows as T[];
  };

  await pg.exec(`
    insert into profiles (user_id, display_name, role) values
      ('clin_verified', 'Dr Verified', 'clinician'),
      ('clin_unverified', 'Dr Unverified', 'clinician'),
      ('clin_revoked', 'Dr Revoked', 'clinician'),
      ('patient_a', 'Patient A', 'patient'),
      ('patient_b', 'Patient B', 'patient'),
      ('admin_1', 'Admin One', 'admin');

    insert into clinician_verifications (id, user_id, licence_no, registry, status) values
      ('cv_ok', 'clin_verified', 'LIC-001', 'NMC', 'verified'),
      ('cv_pend', 'clin_unverified', 'LIC-002', 'NMC', 'pending'),
      ('cv_rev', 'clin_revoked', 'LIC-003', 'NMC', 'revoked');

    insert into patients (id, user_id, code, display_name, year_of_birth, pathway, synopsis, is_self) values
      ('pat_clin_1', 'clin_verified', 'P-01', 'Synthetic Patient 1', 1990, 'fibroids', 'Baseline', false),
      ('pat_a', 'patient_a', 'P-A', 'Self Patient A', 1992, 'fibroids', 'Self A', true),
      ('pat_b', 'patient_b', 'P-B', 'Self Patient B', 1994, 'fibroids', 'Self B', true);

    insert into studies (id, user_id, patient_id, modality, study_date, description, accession, source_note) values
      ('study_1', 'clin_verified', 'pat_clin_1', 'MR', '2025-02-10', 'Pelvic MRI T2', 'ACC-101', 'Seed'),
      ('study_a', 'patient_a', 'pat_a', 'MR', '2025-02-12', 'Pelvic MRI Patient A', 'ACC-201', 'Seed');

    insert into series (id, user_id, study_id, series_number, description, plane, slice_thickness_mm, pixel_spacing_mm, slice_count, quality) values
      ('series_1', 'clin_verified', 'study_1', 1, 'Sagittal T2 FSE', 'Sagittal', 4.0, '0.8\\\\0.8', 16, 'adequate'),
      ('series_a', 'patient_a', 'study_a', 1, 'Axial T2', 'Axial', 4.0, '1.0\\\\1.0', 12, 'adequate');

    insert into findings (id, user_id, patient_id, code, structure, organ, pathway) values
      ('find_1', 'clin_verified', 'pat_clin_1', 'F1', 'fibroid', 'uterus', 'fibroids');

    insert into finding_versions (
      id, user_id, finding_id, version_no, study_id, series_id, observed_on, location_label, figo,
      centroid_mm, axes_mm, longest_mm, measurement_basis, frame, segmentation_source, quality, modality, change_reason
    ) values (
      'fv_base', 'clin_verified', 'find_1', 1, 'study_1', 'series_1', '2025-02-10', 'FIGO 4 anterior intramural', '4',
      '[10, 20, 30]', '[42, 36, 32]', 42, 'three-axis', 'dicom_lps', 'clinician_edit', 'adequate', 'MR', 'Initial baseline'
    );
  `);

  return {
    pg,
    sql,
    storageDir,
    cleanup() {
      rmSync(storageDir, { recursive: true, force: true });
    },
  };
}

test("Phase B — Supabase PostgreSQL Connection & Pooler Configuration Tests", async () => {
  const directCfg = resolveDatabaseConfig({
    DATABASE_URL:
      "postgresql://postgres:real_strong_db_pass_123@db.mfbqdesghtvalkywzsdb.supabase.co:5432/postgres",
    NODE_ENV: "production",
    VERCEL: "1",
  });
  assert.ok(directCfg);
  assert.equal(directCfg.isSupabase, true);
  assert.equal(directCfg.supabaseProjectRef, "mfbqdesghtvalkywzsdb");
  assert.equal(directCfg.poolMode, "direct");
  assert.deepEqual(directCfg.ssl, { rejectUnauthorized: false });
  assert.equal(
    directCfg.redactedUrl,
    "postgresql://postgres:***@db.mfbqdesghtvalkywzsdb.supabase.co:5432/postgres",
  );
  assert.ok(
    directCfg.warnings.some((w) => w.includes("Transaction Pooler")),
    "Should warn when direct port 5432 is used on Vercel serverless runtime",
  );

  const poolerCfg = resolveDatabaseConfig({
    DATABASE_URL:
      "postgresql://postgres.mfbqdesghtvalkywzsdb:real_strong_db_pass_123@aws-0-ap-south-1.pooler.supabase.com:6543/postgres?pgbouncer=true",
    NODE_ENV: "production",
    VERCEL: "1",
  });
  assert.ok(poolerCfg);
  assert.equal(poolerCfg.isSupabase, true);
  assert.equal(poolerCfg.supabaseProjectRef, "mfbqdesghtvalkywzsdb");
  assert.equal(poolerCfg.poolMode, "transaction");
  assert.equal(poolerCfg.preparedStatementsDisabled, true);
  assert.equal(poolerCfg.maxConnections, 3);
  assert.equal(poolerCfg.allowExitOnIdle, true);
  assert.deepEqual(poolerCfg.ssl, { rejectUnauthorized: false });
  assert.ok(!poolerCfg.connectionString.includes("pgbouncer="));
  assert.equal(poolerCfg.warnings.length, 0);

  assert.throws(
    () =>
      resolveDatabaseConfig({
        DATABASE_URL:
          "postgresql://postgres:[YOUR-PASSWORD]@db.mfbqdesghtvalkywzsdb.supabase.co:5432/postgres",
      }),
    /unreplaced password placeholder/i,
  );
  assert.throws(
    () =>
      resolveMigrationConnectionConfig({
        DATABASE_URL:
          "postgresql://postgres:[YOUR-PASSWORD]@db.mfbqdesghtvalkywzsdb.supabase.co:5432/postgres",
      }),
    /unreplaced password placeholder/i,
  );

  assert.equal(isProductionDatabaseRuntime({ NODE_ENV: "production" }), true);
  assert.equal(isProductionDatabaseRuntime({ VERCEL: "1" }), true);
  assert.equal(isProductionDatabaseRuntime({ NODE_ENV: "development" }), false);
  assert.throws(
    () => resolveDatabaseConfig({ NODE_ENV: "production", DATABASE_URL: "" }),
    /DATABASE_URL is required in production/i,
  );
  assert.throws(
    () => resolveDatabaseConfig({ VERCEL: "1", DATABASE_URL: "   " }),
    /DATABASE_URL is required in production/i,
  );

  const rawErr = new Error(
    "Connection failed to postgresql://postgres.mfbqdesghtvalkywzsdb:SuperSecretPass99@aws-0-ap-south-1.pooler.supabase.com:6543/postgres",
  );
  const safeErr = sanitizeDatabaseError(rawErr);
  assert.ok(!safeErr.message.includes("SuperSecretPass99"));
  assert.ok(safeErr.message.includes("***"));
  assert.ok(!redactDatabaseUrl(rawErr.message).includes("SuperSecretPass99"));
  assert.ok(!redactMigrationUrl(rawErr.message).includes("SuperSecretPass99"));

  const ctx = await createSupabaseTestDb();
  try {
    const health = await checkDatabaseHealth(ctx.sql, {
      DATABASE_URL:
        "postgresql://postgres.mfbqdesghtvalkywzsdb:real_pass@aws-0-ap-south-1.pooler.supabase.com:6543/postgres?pgbouncer=true",
    });
    assert.equal(health.ok, true);
    assert.equal(health.backend, "supabase_postgres");
    assert.equal(health.poolMode, "transaction");
    assert.equal(health.sslEnabled, true);
    assert.equal(health.supabaseProjectRef, "mfbqdesghtvalkywzsdb");
    assert.ok(health.appliedMigrationsCount >= 1);
  } finally {
    ctx.cleanup();
  }
});

test("Phase C & D — Private Supabase Storage Buckets, Upload/Download (DICOM, NIfTI, PDF, Mask, Mesh), Signed URLs, TUS Resumable Upload, and Security Controls", async () => {
  const ctx = await createSupabaseTestDb();
  const mockServer = createMockSupabaseStorageServer();

  const prevUrl = process.env.SUPABASE_URL;
  const prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const prevBackend = process.env.REPROCARE_STORAGE_BACKEND;

  process.env.SUPABASE_URL = "https://mfbqdesghtvalkywzsdb.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test_service_role_key_do_not_expose_999";
  process.env.REPROCARE_STORAGE_BACKEND = "supabase";
  setCustomStorageFetchForTests(mockServer.mockFetch);

  try {
    const provisioned = await provisionSupabaseBuckets(process.env, mockServer.mockFetch);
    assert.deepEqual(provisioned.verifiedPrivate, [
      "reprocare-imaging",
      "reprocare-reports",
      "reprocare-derived",
    ]);
    for (const b of mockServer.buckets.values()) {
      assert.equal(b.public, false, `Bucket ${b.id} must be strictly private`);
    }

    assert.equal(resolveBucketForArtifactKind("dicom"), SUPABASE_STORAGE_BUCKETS.imaging);
    assert.equal(resolveBucketForArtifactKind("nifti_volume"), SUPABASE_STORAGE_BUCKETS.imaging);
    assert.equal(resolveBucketForArtifactKind("volume"), SUPABASE_STORAGE_BUCKETS.imaging);
    assert.equal(
      resolveBucketForArtifactKind("volume", { isDerived: true }),
      SUPABASE_STORAGE_BUCKETS.derived,
    );
    assert.equal(resolveBucketForArtifactKind("report"), SUPABASE_STORAGE_BUCKETS.reports);
    assert.equal(resolveBucketForArtifactKind("mask"), SUPABASE_STORAGE_BUCKETS.derived);
    assert.equal(resolveBucketForArtifactKind("mesh"), SUPABASE_STORAGE_BUCKETS.derived);

    const dicomBytes = buildSyntheticMrDicom({
      rows: 16,
      cols: 16,
      instanceNumber: 1,
      patientName: "Confidential^Patient",
      patientId: "MRN-SECRET-99",
    });
    const storedDicom = await storeImagingArtifact(ctx.sql, {
      userId: "clin_verified",
      patientId: "pat_clin_1",
      studyId: "study_1",
      seriesId: "series_1",
      kind: "dicom",
      filename: "slice_001.dcm",
      mimeType: "application/dicom",
      data: dicomBytes,
    });
    assert.equal(storedDicom.storageProvider, "supabase");
    assert.equal(storedDicom.storageBucket, "reprocare-imaging");
    assert.equal(storedDicom.deidentificationStatus, "dicom_ps315_scrubbed");

    const retrievedDicom = await getImagingArtifact(ctx.sql, "clin_verified", storedDicom.id, true);
    assert.ok(retrievedDicom.data);
    assert.equal(retrievedDicom.integrity.valid, true);
    assert.equal(retrievedDicom.integrity.storageBucket, "reprocare-imaging");
    assert.ok(
      !retrievedDicom.data.toString("utf8").includes("Confidential^Patient"),
      "PHI PatientName must be scrubbed before uploading to Supabase Storage",
    );

    const syntheticNifti = Buffer.alloc(512, 0x42);
    syntheticNifti.writeInt32LE(348, 0);
    const storedNifti = await storeImagingArtifact(ctx.sql, {
      userId: "clin_verified",
      patientId: "pat_clin_1",
      studyId: "study_1",
      seriesId: "series_1",
      kind: "nifti_volume",
      filename: "t2_pelvis.nii",
      mimeType: "application/octet-stream",
      data: syntheticNifti,
    });
    assert.equal(storedNifti.storageBucket, "reprocare-imaging");
    const retrievedNifti = await getImagingArtifact(ctx.sql, "clin_verified", storedNifti.id, true);
    assert.equal(retrievedNifti.data?.byteLength, 512);

    const syntheticPdf = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n", "utf8");
    const storedPdf = await storeImagingArtifact(ctx.sql, {
      userId: "clin_verified",
      patientId: "pat_clin_1",
      studyId: "study_1",
      kind: "report",
      filename: "pelvic_mri_report.pdf",
      mimeType: "application/pdf",
      data: syntheticPdf,
    });
    assert.equal(storedPdf.storageBucket, "reprocare-reports");
    const retrievedPdf = await getImagingArtifact(ctx.sql, "clin_verified", storedPdf.id, true);
    assert.equal(retrievedPdf.data?.toString("utf8"), syntheticPdf.toString("utf8"));

    const maskBytes = Buffer.from(JSON.stringify({ dims: [16, 16, 4], rle: [10, 24] }), "utf8");
    const storedMask = await storeImagingArtifact(ctx.sql, {
      userId: "clin_verified",
      patientId: "pat_clin_1",
      studyId: "study_1",
      seriesId: "series_1",
      findingVersionId: "fv_base",
      sourceObjectId: storedDicom.id,
      kind: "mask",
      filename: "fibroid_mask.bin",
      mimeType: "application/octet-stream",
      data: maskBytes,
    });
    assert.equal(storedMask.storageBucket, "reprocare-derived");

    const signedDl = await generateAuthorizedSignedDownloadUrl(ctx.sql, {
      userId: "clin_verified",
      objectId: storedDicom.id,
      expiresInSeconds: 60,
    });
    assert.equal(signedDl.bucket, "reprocare-imaging");
    assert.equal(signedDl.expiresInSeconds, 60);
    assert.ok(!signedDl.signedUrl.includes(process.env.SUPABASE_SERVICE_ROLE_KEY!));

    const validNow = verifySignedUrlAccess(signedDl.signedUrl, {
      nowMs: Date.now(),
      expectedBucket: "reprocare-imaging",
      expectedObjectPath: storedDicom.objectPath,
      secret: process.env.SUPABASE_SERVICE_ROLE_KEY,
    });
    assert.equal(validNow.valid, true);
    assert.equal(validNow.expired, false);

    const expiredLater = verifySignedUrlAccess(signedDl.signedUrl, {
      nowMs: Date.now() + 120_000,
      expectedBucket: "reprocare-imaging",
    });
    assert.equal(expiredLater.valid, false);
    assert.equal(expiredLater.expired, true);

    const directPayload = Buffer.from("Direct DICOM/NIfTI binary payload", "utf8");
    const directSha = createHash("sha256").update(directPayload).digest("hex");
    const authSignedUp = await authorizeDirectImagingUpload(ctx.sql, {
      userId: "clin_verified",
      patientId: "pat_clin_1",
      studyId: "study_1",
      seriesId: "series_1",
      kind: "volume",
      filename: "direct_vol.nii",
      mimeType: "application/octet-stream",
      bytes: directPayload.byteLength,
      sha256: directSha,
      uploadMode: "signed_url",
    });
    assert.equal(authSignedUp.uploadMode, "signed_url");
    assert.ok(authSignedUp.signedUpload?.signedUrl);

    const supaCfg = resolveSupabaseStorageConfig()!;
    const supaProvider = new SupabaseStorageProvider(supaCfg, mockServer.mockFetch);
    await supaProvider.uploadObject({
      bucket: authSignedUp.bucket,
      objectPath: authSignedUp.objectPath,
      data: directPayload,
      mimeType: "application/octet-stream",
      upsert: true,
    });

    const completedSignedUp = await completeDirectImagingUpload(ctx.sql, {
      userId: "clin_verified",
      objectId: authSignedUp.objectId,
    });
    assert.equal(completedSignedUp.status, "active");
    assert.equal(completedSignedUp.processingStatus, "completed");

    const largePayload = Buffer.alloc(256 * 1024, 0x5a);
    const largeSha = createHash("sha256").update(largePayload).digest("hex");
    const authTus = await authorizeDirectImagingUpload(ctx.sql, {
      userId: "clin_verified",
      patientId: "pat_clin_1",
      studyId: "study_1",
      seriesId: "series_1",
      kind: "nifti_volume",
      filename: "large_study.nii.gz",
      mimeType: "application/gzip",
      bytes: largePayload.byteLength,
      sha256: largeSha,
      uploadMode: "tus_resumable",
    });
    assert.equal(authTus.uploadMode, "tus_resumable");
    assert.ok(authTus.tusSession);
    assert.match(authTus.tusSession.uploadUrl, /mfbqdesghtvalkywzsdb\.storage\.supabase\.co/);

    const tusResult = await executeTusResumableUpload({
      session: authTus.tusSession,
      data: largePayload,
      chunkSizeBytes: 64 * 1024,
      fetchImpl: mockServer.mockFetch,
    });
    assert.equal(tusResult.uploadedBytes, largePayload.byteLength);
    assert.equal(tusResult.chunksSent, 4);

    const completedTus = await completeDirectImagingUpload(ctx.sql, {
      userId: "clin_verified",
      objectId: authTus.objectId,
    });
    assert.equal(completedTus.status, "active");
    assert.equal(completedTus.sha256, largeSha);

    await assert.rejects(
      () =>
        generateAuthorizedSignedDownloadUrl(ctx.sql, {
          userId: "nonexistent_user",
          objectId: storedDicom.id,
        }),
      /Unauthorized/i,
    );
    await assert.rejects(
      () =>
        authorizeDirectImagingUpload(ctx.sql, {
          userId: "nonexistent_user",
          patientId: "pat_clin_1",
          kind: "dicom",
          filename: "unauth.dcm",
          mimeType: "application/dicom",
          bytes: 1024,
          sha256: directSha,
        }),
      /Unauthorized/i,
    );

    await assert.rejects(
      () => getImagingArtifact(ctx.sql, "patient_a", storedDicom.id, true),
      /Unauthorized/i,
    );
    await assert.rejects(
      () =>
        generateAuthorizedSignedDownloadUrl(ctx.sql, {
          userId: "patient_a",
          objectId: storedDicom.id,
        }),
      /Unauthorized/i,
    );

    await assert.rejects(
      () =>
        generateAuthorizedSignedDownloadUrl(ctx.sql, {
          userId: "clin_verified",
          objectId: storedDicom.id,
          patientId: "pat_a",
        }),
      /Manipulated patientId/i,
    );

    await executeGrantClinicianConsent(ctx.sql, "patient_a", {
      patientId: "pat_a",
      clinicianUserId: "clin_verified",
      permissions: ["view_imaging", "add_annotations"],
      scopeNote: "Review pelvic MRI",
    });

    const patADicom = await storeImagingArtifact(ctx.sql, {
      userId: "clin_verified",
      patientId: "pat_a",
      studyId: "study_a",
      seriesId: "series_a",
      kind: "dicom",
      filename: "pat_a_slice.dcm",
      mimeType: "application/dicom",
      data: dicomBytes,
    });
    const signedBeforeRevoke = await generateAuthorizedSignedDownloadUrl(ctx.sql, {
      userId: "clin_verified",
      objectId: patADicom.id,
    });
    assert.ok(signedBeforeRevoke.signedUrl);

    await executeRevokeClinicianConsent(ctx.sql, "patient_a", {
      patientId: "pat_a",
      clinicianUserId: "clin_verified",
      reason: "Consultation completed",
    });
    await assert.rejects(
      () => getImagingArtifact(ctx.sql, "clin_verified", patADicom.id, true),
      /no active patient consent/i,
    );
    await assert.rejects(
      () =>
        generateAuthorizedSignedDownloadUrl(ctx.sql, {
          userId: "clin_verified",
          objectId: patADicom.id,
        }),
      /no active patient consent/i,
    );

    assert.throws(
      () =>
        validateStorageBackendConfig({
          ...process.env,
          VITE_SUPABASE_SERVICE_ROLE_KEY: "leaked_secret",
        }),
      /Security violation/i,
    );

    const purgeRes = await purgeImagingArtifact(
      ctx.sql,
      "clin_verified",
      storedPdf.id,
      "Duplicate report purged under retention policy",
    );
    assert.equal(purgeRes.status, "purged");
    await assert.rejects(
      () =>
        generateAuthorizedSignedDownloadUrl(ctx.sql, {
          userId: "clin_verified",
          objectId: storedPdf.id,
        }),
      /purged/i,
    );
  } finally {
    setCustomStorageFetchForTests(null);
    if (prevUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = prevUrl;
    if (prevKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = prevKey;
    if (prevBackend === undefined) delete process.env.REPROCARE_STORAGE_BACKEND;
    else process.env.REPROCARE_STORAGE_BACKEND = prevBackend;
    ctx.cleanup();
  }
});

test("Phase E & G — Local-to-Supabase Storage Migration and Full 11-Step Synthetic Patient-to-ReproTrace Integration Flow", async () => {
  const ctx = await createSupabaseTestDb();
  const mockServer = createMockSupabaseStorageServer();

  const prevUrl = process.env.SUPABASE_URL;
  const prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const prevBackend = process.env.REPROCARE_STORAGE_BACKEND;

  try {
    process.env.REPROCARE_STORAGE_BACKEND = "local_durable";
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    const localDicom = buildSyntheticMrDicom({
      rows: 16,
      cols: 16,
      instanceNumber: 1,
    });
    const localStored = await storeImagingArtifact(ctx.sql, {
      userId: "clin_verified",
      patientId: "pat_clin_1",
      studyId: "study_1",
      seriesId: "series_1",
      kind: "dicom",
      filename: "legacy_local.dcm",
      mimeType: "application/dicom",
      data: localDicom,
    });
    assert.equal(localStored.storageProvider, "local_durable");
    assert.equal(existsSync(localStored.storagePath), true);

    process.env.SUPABASE_URL = "https://mfbqdesghtvalkywzsdb.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test_service_role_key_do_not_expose_999";
    process.env.REPROCARE_STORAGE_BACKEND = "supabase";
    setCustomStorageFetchForTests(mockServer.mockFetch);

    const supaCfg = resolveSupabaseStorageConfig()!;
    const supaProvider = new SupabaseStorageProvider(supaCfg, mockServer.mockFetch);

    const migrationSummary = await migrateLocalImagingToSupabase({
      sql: ctx.sql,
      localBaseDir: ctx.storageDir,
      supabaseProvider: supaProvider,
      actorUserId: "admin_1",
      dryRun: false,
    });
    assert.equal(migrationSummary.migratedCount, 1);
    assert.equal(migrationSummary.failedCount, 0);
    assert.equal(migrationSummary.localFilesDeleted, false);
    assert.equal(
      existsSync(localStored.storagePath),
      true,
      "Original local file must not be deleted automatically during migration",
    );

    const rerunSummary = await migrateLocalImagingToSupabase({
      sql: ctx.sql,
      localBaseDir: ctx.storageDir,
      supabaseProvider: supaProvider,
      actorUserId: "admin_1",
      dryRun: false,
    });
    assert.equal(rerunSummary.alreadyMigratedCount, 1);
    assert.equal(rerunSummary.failedCount, 0);

    // Full 11-Step Synthetic Patient-to-Imaging-to-ReproTrace Integration Flow
    const e2ePatientId = "pat_e2e_supa";
    const e2eStudyId = "study_e2e_supa";
    const e2eSeriesId = "series_e2e_supa";
    const e2eFindingId = "find_e2e_supa";

    await ctx.pg.exec(`
      insert into patients (id, user_id, code, display_name, year_of_birth, pathway, synopsis, is_self) values
        ('${e2ePatientId}', 'clin_verified', 'P-SUPA-E2E', 'Synthetic Supabase E2E Patient', 1991, 'fibroids', 'Longitudinal uterine fibroid follow-up', false);

      insert into studies (id, user_id, patient_id, modality, study_date, description, accession, source_note) values
        ('${e2eStudyId}', 'clin_verified', '${e2ePatientId}', 'MR', '2025-05-01', 'Pelvic MRI T2 Sagittal', 'ACC-SUPA-01', 'Synthetic E2E DICOM Series');

      insert into series (id, user_id, study_id, series_number, description, plane, slice_thickness_mm, pixel_spacing_mm, slice_count, quality) values
        ('${e2eSeriesId}', 'clin_verified', '${e2eStudyId}', 1, 'Sagittal T2 Cube', 'Sagittal', 4.0, '1.2\\\\1.2', 8, 'adequate');

      insert into findings (id, user_id, patient_id, code, structure, organ, pathway) values
        ('${e2eFindingId}', 'clin_verified', '${e2ePatientId}', 'F-E2E-1', 'fibroid', 'uterus', 'fibroids');

      insert into finding_versions (
        id, user_id, finding_id, version_no, study_id, series_id, observed_on, location_label, figo,
        centroid_mm, axes_mm, longest_mm, measurement_basis, frame, segmentation_source, quality, modality, change_reason
      ) values (
        'fv_e2e_1', 'clin_verified', '${e2eFindingId}', 1, '${e2eStudyId}', '${e2eSeriesId}', '2025-05-01', 'FIGO 3 intramural', '3',
        '[12, 15, 18]', '[22, 20, 18]', 22, 'three-axis', 'dicom_lps', 'clinician_edit', 'adequate', 'MR', 'Initial baseline'
      );
    `);

    const syntheticSlices = buildSyntheticSeries({
      cols: 32,
      rows: 32,
      slices: 8,
      pixelSpacingMm: [1.2, 1.2],
      sliceStepMm: 4.0,
      lesionRadiiMm: [8, 8, 8],
      noise: 5,
      description: "SYNTHETIC E2E MRI",
    });

    const storedSliceRecords: any[] = [];
    for (let i = 0; i < syntheticSlices.length; i++) {
      const rec = await storeImagingArtifact(ctx.sql, {
        userId: "clin_verified",
        patientId: e2ePatientId,
        studyId: e2eStudyId,
        seriesId: e2eSeriesId,
        instanceNumber: i + 1,
        kind: "dicom",
        filename: syntheticSlices[i].name,
        mimeType: "application/dicom",
        data: syntheticSlices[i].bytes,
      });
      assert.equal(rec.storageBucket, "reprocare-imaging");
      assert.equal(rec.storageProvider, "supabase");
      storedSliceRecords.push(rec);
    }

    const listedObjects = await listImagingArtifacts(ctx.sql, "clin_verified", {
      patientId: e2ePatientId,
      studyId: e2eStudyId,
      seriesId: e2eSeriesId,
    });
    assert.equal(listedObjects.length, 8);
    const loadedFirstSlice = await getImagingArtifact(
      ctx.sql,
      "clin_verified",
      storedSliceRecords[0].id,
      true,
    );
    assert.equal(loadedFirstSlice.integrity.valid, true);

    const labSaved = await executeSaveLabMeasurement(ctx.sql, "clin_verified", {
      findingId: e2eFindingId,
      studyId: e2eStudyId,
      seriesId: e2eSeriesId,
      axes: [24, 22, 20],
      longest: 24,
      sliceIndex: 4,
      reason: "Follow-up volumetric segmentation on Supabase Storage",
      evidenceNote: "Segmented 3D volume from 8-slice sagittal T2 series",
      centroidMm: [12, 15, 18],
      frame: "dicom_lps",
      segmentationSource: "region_grow",
      volumeMm3: 5540,
      uncertaintyMm3: 420,
      maskArtifact: {
        fileName: "e2e_mask.rle.json",
        mimeType: "application/json",
        dataBase64: Buffer.from(
          JSON.stringify({ dims: [32, 32, 8], voxelCount: 960, volumeMm3: 5540 }),
          "utf8",
        ).toString("base64"),
      },
    });
    assert.equal(labSaved.ok, true);
    assert.ok(labSaved.id);

    const evidence = await getHistoricalFindingImagingEvidence(ctx.sql, "clin_verified", {
      findingVersionId: labSaved.id,
      includeBinaryPayloads: true,
    });
    assert.equal(evidence.integritySummary.allObjectsValid, true);
    assert.equal(evidence.sourceDicomObjects.length, 8);
    assert.equal(evidence.maskObjects.length, 1);
    assert.equal(evidence.maskObjects[0].record.storageBucket, "reprocare-derived");

    await assert.rejects(
      () => getImagingArtifact(ctx.sql, "patient_a", storedSliceRecords[0].id, true),
      /Unauthorized/i,
    );

    const postRestartSlice = await getImagingArtifact(
      ctx.sql,
      "clin_verified",
      storedSliceRecords[0].id,
      true,
    );
    assert.equal(postRestartSlice.integrity.valid, true);
    assert.equal(postRestartSlice.record.sha256, storedSliceRecords[0].sha256);
  } finally {
    setCustomStorageFetchForTests(null);
    if (prevUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = prevUrl;
    if (prevKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = prevKey;
    if (prevBackend === undefined) delete process.env.REPROCARE_STORAGE_BACKEND;
    else process.env.REPROCARE_STORAGE_BACKEND = prevBackend;
    ctx.cleanup();
  }
});
