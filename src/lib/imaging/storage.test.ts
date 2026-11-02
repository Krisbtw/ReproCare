import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import dicomParser from "dicom-parser";
import type { Sql } from "../db.ts";
import { buildSyntheticMrDicom } from "../dicom/codec.ts";
import { buildSyntheticSeries } from "../dicom/series-writer.ts";
import {
  storeImagingArtifact,
  getImagingArtifact,
  listImagingArtifacts,
  verifyImagingObjectIntegrity,
  purgeImagingArtifact,
  getHistoricalFindingImagingEvidence,
  validateAndScrubDicomBuffer,
  checkPatientAndClinicianAccess,
  redactSensitiveMetadata,
} from "./storage.server.ts";
import {
  executeStoreImagingArtifact,
  executeGetImagingArtifact,
  executeListImagingArtifacts,
  executeVerifyImagingObjectIntegrity,
  executePurgeImagingArtifact,
  executeGetHistoricalFindingImagingEvidence,
  executeSaveLabMeasurement,
  executeAddReview,
} from "../clinic/server.backend.ts";

async function createTestStorageDb() {
  const storageDir = mkdtempSync(join(tmpdir(), "reprocare-imaging-test-"));
  process.env.REPROCARE_IMAGING_STORAGE_DIR = storageDir;

  const pg = new PGlite();
  await pg.exec(readFileSync(new URL("../../../migrations/0002_anatomybridge.sql", import.meta.url), "utf8"));
  await pg.exec(readFileSync(new URL("../../../migrations/0005_report_ingestion.sql", import.meta.url), "utf8"));
  await pg.exec(readFileSync(new URL("../../../migrations/0008_clinician_verification.sql", import.meta.url), "utf8"));
  await pg.exec(
    readFileSync(
      new URL("../../../migrations/0009_imaging_and_provenance.sql", import.meta.url),
      "utf8",
    ),
  );
  await pg.exec(
    readFileSync(
      new URL(
        "../../../migrations/0010_sprint1_auth_and_registration.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  await pg.exec(
    readFileSync(
      new URL(
        "../../../migrations/0011_sprint3_imaging_storage_and_reprotrace.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  await pg.exec(
    readFileSync(
      new URL(
        "../../../migrations/0012_sprint4_collaboration_and_report_intelligence.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );

  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.reduce(
      (acc, s, i) => acc + s + (i < values.length ? `$${i + 1}` : ""),
      "",
    );
    return (await pg.query(text, values as unknown[])).rows;
  }) as unknown as Sql;

  await pg.exec(`
    insert into profiles (user_id, display_name, role) values
      ('clin_verified', 'Dr Verified', 'clinician'),
      ('clin_unverified', 'Dr Unverified', 'clinician'),
      ('clin_revoked', 'Dr Revoked', 'clinician'),
      ('patient_a', 'Patient A', 'patient'),
      ('patient_b', 'Patient B', 'patient');

    insert into clinician_verifications (id, user_id, licence_no, registry, status) values
      ('cv_ok', 'clin_verified', 'LIC-001', 'NMC', 'verified'),
      ('cv_pend', 'clin_unverified', 'LIC-002', 'NMC', 'pending'),
      ('cv_rev', 'clin_revoked', 'LIC-003', 'NMC', 'revoked');

    insert into patients (id, user_id, code, display_name, year_of_birth, pathway, synopsis, is_self) values
      ('pat_clin_1', 'clin_verified', 'P-01', 'Synthetic Patient 1', 1990, 'fibroids', 'Baseline', false),
      ('pat_a', 'patient_a', 'P-A', 'Self Patient A', 1992, 'fibroids', 'Self A', true),
      ('pat_b', 'patient_b', 'P-B', 'Self Patient B', 1994, 'fibroids', 'Self B', true);

    insert into studies (id, user_id, patient_id, modality, study_date, description, accession, source_note) values
      ('study_1', 'clin_verified', 'pat_clin_1', 'MR', '2025-02-10', 'Pelvic MRI T2', 'ACC-101', 'Seed');

    insert into series (id, user_id, study_id, series_number, description, plane, slice_thickness_mm, pixel_spacing_mm, slice_count, quality) values
      ('series_1', 'clin_verified', 'study_1', 1, 'Sagittal T2 FSE', 'Sagittal', 4.0, '0.8\\\\0.8', 16, 'adequate');

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
    cleanup: () => rmSync(storageDir, { recursive: true, force: true }),
  };
}

test("DICOM upload, PHI tag scrubbing, SHA-256 verification, and persistent retrieval across simulated restarts", async () => {
  const ctx = await createTestStorageDb();
  try {
    const rawDicom = buildSyntheticMrDicom();
    // Verify raw synthetic DICOM contains PatientName (0010,0010) before scrubbing
    const rawDataset = dicomParser.parseDicom(rawDicom);
    assert.ok(rawDataset.string("x00100010"), "Synthetic DICOM starts with a PatientName tag");

    const stored = await executeStoreImagingArtifact(ctx.sql, "clin_verified", {
      patientId: "pat_clin_1",
      studyId: "study_1",
      seriesId: "series_1",
      sopInstanceUid: "1.2.826.0.1.3680043.8.498.1001",
      instanceNumber: 1,
      kind: "dicom_instance",
      fileName: "slice_001.dcm",
      mimeType: "application/dicom",
      dataBase64: Buffer.from(rawDicom).toString("base64"),
      metadata: { customTag: "pelvic_t2" },
    });

    assert.ok(stored.id);
    assert.equal(stored.version, 1);
    assert.equal(stored.deduplicated, false);
    assert.equal(stored.sha256Hash.length, 64);

    // Simulate application restart by reading from database and disk via fresh call
    const retrieved = await executeGetImagingArtifact(
      ctx.sql,
      "clin_verified",
      stored.id,
      true,
    );
    assert.equal(retrieved.integrity.valid, true);
    assert.equal(retrieved.integrity.status, "ok");
    assert.equal(retrieved.record.study_id, "study_1");
    assert.equal(retrieved.record.series_id, "series_1");
    assert.equal(retrieved.record.sop_instance_uid, "1.2.826.0.1.3680043.8.498.1001");
    assert.equal(retrieved.record.instance_number, 1);
    assert.ok(retrieved.dataBase64);

    // Verify stored binary DICOM has direct PHI tags scrubbed while remaining valid DICOM Part-10
    const persistedBytes = Buffer.from(retrieved.dataBase64!, "base64");
    const persistedDataset = dicomParser.parseDicom(new Uint8Array(persistedBytes));
    assert.equal(
      persistedDataset.string("x00100010") ?? "",
      "",
      "PatientName (0010,0010) must be scrubbed from stored binary DICOM",
    );
    assert.equal(persistedDataset.string("x00080060"), "MR", "Modality tag is preserved");
    assert.equal(persistedDataset.uint16("x00280010"), 32, "Rows geometry tag is preserved");
  } finally {
    ctx.cleanup();
  }
});

test("Duplicate detection vs monotonic file versioning without silent overwrites", async () => {
  const ctx = await createTestStorageDb();
  try {
    const maskV1 = Buffer.from(JSON.stringify({ dims: [32, 32, 16], voxels: [1, 2, 3] }), "utf8");
    const maskV2 = Buffer.from(
      JSON.stringify({ dims: [32, 32, 16], voxels: [1, 2, 3, 4, 5] }),
      "utf8",
    );

    const first = await executeStoreImagingArtifact(ctx.sql, "clin_verified", {
      patientId: "pat_clin_1",
      studyId: "study_1",
      seriesId: "series_1",
      kind: "segmentation_mask",
      fileName: "mask.json",
      dataBase64: maskV1.toString("base64"),
    });
    assert.equal(first.version, 1);
    assert.equal(first.deduplicated, false);

    // Re-uploading the exact same bytes for the same series & kind is deduplicated
    const dup = await executeStoreImagingArtifact(ctx.sql, "clin_verified", {
      patientId: "pat_clin_1",
      studyId: "study_1",
      seriesId: "series_1",
      kind: "segmentation_mask",
      fileName: "mask.json",
      dataBase64: maskV1.toString("base64"),
    });
    assert.equal(dup.id, first.id);
    assert.equal(dup.version, 1);
    assert.equal(dup.deduplicated, true);

    // Uploading modified mask creates version 2 at a distinct URI while preserving version 1 intact
    const second = await executeStoreImagingArtifact(ctx.sql, "clin_verified", {
      patientId: "pat_clin_1",
      studyId: "study_1",
      seriesId: "series_1",
      kind: "segmentation_mask",
      fileName: "mask_v2.json",
      dataBase64: maskV2.toString("base64"),
    });
    assert.notEqual(second.id, first.id);
    assert.equal(second.version, 2);
    assert.notEqual(second.storageUri, first.storageUri);

    // Both v1 and v2 remain retrievable and pass SHA-256 verification
    const getV1 = await executeGetImagingArtifact(ctx.sql, "clin_verified", first.id, true);
    const getV2 = await executeGetImagingArtifact(ctx.sql, "clin_verified", second.id, true);
    assert.equal(Buffer.from(getV1.dataBase64!, "base64").toString("utf8"), maskV1.toString("utf8"));
    assert.equal(Buffer.from(getV2.dataBase64!, "base64").toString("utf8"), maskV2.toString("utf8"));
  } finally {
    ctx.cleanup();
  }
});

test("Invalid file rejection, missing storage object detection, corruption detection, and audited retention purge", async () => {
  const ctx = await createTestStorageDb();
  try {
    // 1. Invalid non-DICOM bytes must be rejected when kind is dicom_instance
    await assert.rejects(
      () =>
        executeStoreImagingArtifact(ctx.sql, "clin_verified", {
          patientId: "pat_clin_1",
          studyId: "study_1",
          seriesId: "series_1",
          kind: "dicom_instance",
          fileName: "fake.dcm",
          dataBase64: Buffer.from("not a valid dicom file at all").toString("base64"),
        }),
      /Invalid DICOM file/,
    );

    // 2. Store a valid segmentation mask, then corrupt it on disk and verify checksum detection
    const maskData = Buffer.from(JSON.stringify({ mask: [10, 20, 30] }), "utf8");
    const maskObj = await executeStoreImagingArtifact(ctx.sql, "clin_verified", {
      patientId: "pat_clin_1",
      studyId: "study_1",
      seriesId: "series_1",
      kind: "segmentation_mask",
      fileName: "check.json",
      dataBase64: maskData.toString("base64"),
    });

    // Tamper with the file on disk
    writeFileSync(maskObj.storageUri, Buffer.from(JSON.stringify({ mask: [99, 99, 99] }), "utf8"));
    const corruptedCheck = await executeVerifyImagingObjectIntegrity(
      ctx.sql,
      "clin_verified",
      maskObj.id,
    );
    assert.equal(corruptedCheck.valid, false);
    assert.equal(corruptedCheck.status, "corrupted");

    await assert.rejects(
      () => executeGetImagingArtifact(ctx.sql, "clin_verified", maskObj.id, true),
      /integrity verification failed/i,
    );

    // 3. Delete underlying file manually and verify missing object detection
    unlinkSync(maskObj.storageUri);
    const missingCheck = await executeVerifyImagingObjectIntegrity(
      ctx.sql,
      "clin_verified",
      maskObj.id,
    );
    assert.equal(missingCheck.valid, false);
    assert.equal(missingCheck.status, "missing");

    // 4. Store another artifact and test auditable retention purge
    const meshObj = await executeStoreImagingArtifact(ctx.sql, "clin_verified", {
      patientId: "pat_clin_1",
      studyId: "study_1",
      seriesId: "series_1",
      kind: "mesh_3d",
      fileName: "fibroid.stl",
      dataBase64: Buffer.from("solid fibroid\nendsolid fibroid").toString("base64"),
    });

    const purgeRes = await executePurgeImagingArtifact(ctx.sql, "clin_verified", {
      objectId: meshObj.id,
      reason: "Patient retention schedule expiry test",
    });
    assert.equal(purgeRes.purged, true);

    const afterPurge = await executeVerifyImagingObjectIntegrity(
      ctx.sql,
      "clin_verified",
      meshObj.id,
    );
    assert.equal(afterPurge.status, "purged");

    const auditRows = await ctx.sql<{ action: string; detail: string }>`
      select action, detail from audit_events where entity_id = ${meshObj.id} order by at desc
    `;
    assert.ok(auditRows.some((a) => a.action === "purge_imaging_object"));
  } finally {
    ctx.cleanup();
  }
});

test("Access control and patient-level isolation on imaging storage and retrieval", async () => {
  const ctx = await createTestStorageDb();
  try {
    const dicomBytes = buildSyntheticMrDicom();
    const b64 = Buffer.from(dicomBytes).toString("base64");

    // 1. Unauthenticated caller is rejected
    await assert.rejects(
      () =>
        executeStoreImagingArtifact(ctx.sql, "", {
          patientId: "pat_clin_1",
          kind: "dicom_instance",
          dataBase64: b64,
        }),
      /Unauthorized/i,
    );

    // 2. Unverified/pending and revoked clinicians are rejected
    await assert.rejects(
      () =>
        executeStoreImagingArtifact(ctx.sql, "clin_unverified", {
          patientId: "pat_clin_1",
          kind: "dicom_instance",
          dataBase64: b64,
        }),
      /Unauthorized|verification/i,
    );
    await assert.rejects(
      () =>
        executeStoreImagingArtifact(ctx.sql, "clin_revoked", {
          patientId: "pat_clin_1",
          kind: "dicom_instance",
          dataBase64: b64,
        }),
      /Unauthorized|verification/i,
    );

    // 3. Patient cannot upload clinician imaging artifacts or access another patient's imaging
    await assert.rejects(
      () =>
        executeStoreImagingArtifact(ctx.sql, "patient_a", {
          patientId: "pat_a",
          kind: "dicom_instance",
          dataBase64: b64,
        }),
      /Unauthorized/i,
    );

    // 4. Verified clinician stores artifact for pat_clin_1; patient_a and patient_b cannot retrieve it
    const stored = await executeStoreImagingArtifact(ctx.sql, "clin_verified", {
      patientId: "pat_clin_1",
      studyId: "study_1",
      seriesId: "series_1",
      kind: "dicom_instance",
      dataBase64: b64,
    });

    await assert.rejects(
      () => executeGetImagingArtifact(ctx.sql, "patient_a", stored.id, true),
      /not found or access denied/i,
    );
    await assert.rejects(
      () => executeListImagingArtifacts(ctx.sql, "patient_a", { patientId: "pat_clin_1" }),
      /not found|Unauthorized/i,
    );
  } finally {
    ctx.cleanup();
  }
});

test("Historical finding retrieval links finding_versions to source DICOM slices, segmentation runs, masks, meshes, and clinician reviews", async () => {
  const ctx = await createTestStorageDb();
  try {
    const seriesFiles = buildSyntheticSeries({
      cols: 24,
      rows: 24,
      slices: 6,
      pixelSpacingMm: [0.8, 0.8],
      sliceStepMm: 4.0,
      lesionRadiiMm: [6, 6, 8],
    });

    const maskPayload = Buffer.from(
      JSON.stringify({
        dims: [24, 24, 6],
        spacingMm: [0.8, 0.8, 4.0],
        voxelCount: 420,
        volumeMm3: 1075.2,
      }),
      "utf8",
    );
    const meshPayload = Buffer.from("solid lesion\nendsolid lesion", "utf8");

    const saved = await executeSaveLabMeasurement(ctx.sql, "clin_verified", {
      findingId: "find_1",
      axes: [24, 20, 18],
      longest: 24,
      sliceIndex: 3,
      reason: "AI segmentation confirmed in Volume Lab",
      evidenceNote: "UMD 3D U-Net segmentation confirmed by clinician",
      studyId: "study_1",
      seriesId: "series_1",
      centroidMm: [12.4, -18.2, 44.0],
      frame: "dicom_lps",
      modelId: "umd_monai_fibroid",
      segmentationSource: "umd_monai_fibroid",
      volumeMm3: 4523.9,
      uncertaintyMm3: 210.5,
      clinicianConfirmed: true,
      seedPoint: [12, 12, 3],
      sourceDicomFiles: seriesFiles.slice(0, 3).map((f, idx) => ({
        fileName: f.name,
        instanceNumber: idx + 1,
        dataBase64: Buffer.from(f.bytes).toString("base64"),
      })),
      maskArtifact: {
        fileName: "find_1_mask.json",
        mimeType: "application/json",
        dataBase64: maskPayload.toString("base64"),
        metadata: { dims: [24, 24, 6], spacingMm: [0.8, 0.8, 4.0] },
      },
      meshArtifact: {
        fileName: "find_1_mesh.stl",
        mimeType: "model/stl",
        dataBase64: meshPayload.toString("base64"),
      },
    });

    assert.ok(saved.id);

    // Attach a clinician review to the new finding version
    await executeAddReview(ctx.sql, "clin_verified", {
      targetType: "finding_version",
      targetId: saved.id,
      status: "verified",
      note: "Verified segmentation boundaries on sagittal T2 series.",
    });

    // Retrieve complete historical finding imaging evidence
    const evidence = await executeGetHistoricalFindingImagingEvidence(
      ctx.sql,
      "clin_verified",
      saved.id,
    );

    assert.equal(evidence.findingVersion.id, saved.id);
    assert.equal(evidence.finding.id, "find_1");
    assert.equal(evidence.study?.id, "study_1");
    assert.equal(evidence.series?.id, "series_1");
    assert.ok(evidence.segmentationRun, "Segmentation run metadata is linked and retrieved");
    assert.equal(evidence.segmentationRun?.model_name, "umd_monai_fibroid");
    assert.equal(evidence.sourceDicomObjects.length, 3, "All 3 source DICOM instances are linked");
    assert.equal(evidence.maskObjects.length, 1, "Segmentation mask artifact is linked");
    assert.equal(evidence.meshObjects.length, 1, "3D mesh artifact is linked");
    assert.equal(evidence.clinicianReviews.length, 1, "Clinician review is linked");
    assert.equal(evidence.integritySummary.allObjectsValid, true);
    assert.equal(evidence.integritySummary.corruptedCount, 0);
    assert.equal(evidence.integritySummary.missingCount, 0);

    // Verify the linked segmentation mask bytes can be retrieved and match SHA-256
    const maskObj = await executeGetImagingArtifact(
      ctx.sql,
      "clin_verified",
      evidence.maskObjects[0].id,
      true,
    );
    assert.equal(maskObj.integrity.valid, true);
    assert.equal(
      Buffer.from(maskObj.dataBase64!, "base64").toString("utf8"),
      maskPayload.toString("utf8"),
    );
  } finally {
    ctx.cleanup();
  }
});

test("Security Task 1: Fail-closed authorization across all 12 required scenarios (missing profile, DB error, consent lifecycle, manipulated IDs, and metadata redaction)", async () => {
  const ctx = await createTestStorageDb();
  try {
    await ctx.pg.exec(`
      insert into profiles (user_id, display_name, role) values
        ('admin_user', 'Admin User', 'admin'),
        ('clin_no_consent', 'Dr No Consent', 'clinician');
      insert into clinician_verifications (id, user_id, licence_no, registry, status) values
        ('cv_noconsent', 'clin_no_consent', 'LIC-999', 'NMC', 'approved');
      insert into studies (id, user_id, patient_id, modality, study_date, description, accession, source_note) values
        ('study_pat_a', 'patient_a', 'pat_a', 'MR', '2026-01-15', 'Pelvic MRI A', 'ACC-A', 'Seed A'),
        ('study_pat_b', 'patient_b', 'pat_b', 'MR', '2026-01-16', 'Pelvic MRI B', 'ACC-B', 'Seed B');
      insert into series (id, user_id, study_id, series_number, description, plane, slice_thickness_mm, pixel_spacing_mm, slice_count, quality) values
        ('series_pat_a', 'patient_a', 'study_pat_a', 1, 'Sagittal T2 A', 'Sagittal', 3.0, '1.0\\\\1.0', 8, 'adequate'),
        ('series_pat_b', 'patient_b', 'study_pat_b', 1, 'Sagittal T2 B', 'Sagittal', 3.0, '1.0\\\\1.0', 8, 'adequate');
      insert into findings (id, user_id, patient_id, code, structure, organ, pathway) values
        ('find_pat_a', 'patient_a', 'pat_a', 'FA1', 'fibroid', 'uterus', 'fibroids'),
        ('find_pat_b', 'patient_b', 'pat_b', 'FB1', 'fibroid', 'uterus', 'fibroids');
      insert into finding_versions (
        id, user_id, finding_id, version_no, study_id, series_id, observed_on, location_label, figo,
        centroid_mm, axes_mm, longest_mm, measurement_basis, frame, segmentation_source, quality, modality, change_reason
      ) values
        ('fv_pat_a', 'patient_a', 'find_pat_a', 1, 'study_pat_a', 'series_pat_a', '2026-01-15', 'FIGO 3', '3', '[0,0,0]', '[20,20,20]', 20, 'caliper', 'dicom_lps', 'manual', 'adequate', 'MR', 'baseline'),
        ('fv_pat_b', 'patient_b', 'find_pat_b', 1, 'study_pat_b', 'series_pat_b', '2026-01-16', 'FIGO 4', '4', '[0,0,0]', '[25,25,25]', 25, 'caliper', 'dicom_lps', 'manual', 'adequate', 'MR', 'baseline');
    `);

    const dicomBytes = buildSyntheticMrDicom();
    const maskBytes = Buffer.from(JSON.stringify({ dims: [16, 16, 4], mask: [1, 1] }), "utf8");
    const meshBytes = Buffer.from("solid m\nendsolid m", "utf8");

    // Scenario 9: Missing profile MUST fail closed (never return early or grant access)
    await assert.rejects(
      () => checkPatientAndClinicianAccess(ctx.sql, "ghost_missing_profile", "pat_a", false),
      /User profile not found; access denied/,
    );
    await assert.rejects(
      () =>
        storeImagingArtifact(ctx.sql, {
          userId: "ghost_missing_profile",
          patientId: "pat_a",
          kind: "dicom",
          data: dicomBytes,
        }),
      /User profile not found; access denied/,
    );
    await assert.rejects(
      () => listImagingArtifacts(ctx.sql, "ghost_missing_profile", "pat_a"),
      /User profile not found; access denied/,
    );

    // Scenario 10: Database query failure MUST fail closed (never catch and bypass)
    const failingSql = (async () => {
      throw new Error("Simulated database connection failure: postgres://secret:pass@db.internal:5432/prod");
    }) as unknown as Sql;

    await assert.rejects(
      async () => {
        try {
          await checkPatientAndClinicianAccess(failingSql, "clin_verified", "pat_a", false);
        } catch (err: any) {
          assert.ok(
            !String(err.message).includes("secret:pass"),
            "Database error must not leak connection credentials",
          );
          throw err;
        }
      },
      /Database query failed.*failing closed/,
    );

    // Scenario 3: Approved clinician with active consent (view_imaging + add_annotations) can upload & retrieve DICOM, mask, and mesh for pat_a
    await ctx.pg.exec(`
      insert into patient_clinician_consents (
        id, patient_id, patient_user_id, clinician_user_id, status, permissions_json, scope_note, expires_at
      ) values (
        'consent_a_active', 'pat_a', 'patient_a', 'clin_verified', 'active',
        '["view_demographics","view_imaging","add_annotations","review_ai_findings"]',
        'Imaging review consent',
        '2099-12-31T23:59:59Z'
      );
    `);

    const storedDicomA = await storeImagingArtifact(ctx.sql, {
      userId: "clin_verified",
      patientId: "pat_a",
      studyId: "study_pat_a",
      seriesId: "series_pat_a",
      findingVersionId: "fv_pat_a",
      kind: "dicom",
      data: dicomBytes,
      metadata: {
        sequence: "T2_SAG",
        apiKey: "sk-should-be-stripped",
        password: "secret-password",
        storageRoot: "/internal/server/path",
        patientName: "Anya Secret Name",
      },
    });
    const storedMaskA = await storeImagingArtifact(ctx.sql, {
      userId: "clin_verified",
      patientId: "pat_a",
      studyId: "study_pat_a",
      seriesId: "series_pat_a",
      findingVersionId: "fv_pat_a",
      sourceObjectId: storedDicomA.id,
      kind: "mask",
      data: maskBytes,
    });
    const storedMeshA = await storeImagingArtifact(ctx.sql, {
      userId: "clin_verified",
      patientId: "pat_a",
      studyId: "study_pat_a",
      seriesId: "series_pat_a",
      findingVersionId: "fv_pat_a",
      sourceObjectId: storedMaskA.id,
      kind: "mesh",
      data: meshBytes,
    });

    // Requirement 12: Verify sensitive metadata keys were stripped before persistence
    const parsedMeta = JSON.parse(storedDicomA.metadataJson);
    assert.equal(parsedMeta.sequence, "T2_SAG");
    assert.equal(parsedMeta.apiKey, undefined);
    assert.equal(parsedMeta.password, undefined);
    assert.equal(parsedMeta.storageRoot, undefined);
    assert.equal(parsedMeta.patientName, undefined);

    // Consented clinician can retrieve all 3 artifact types
    const clinGetDicom = await getImagingArtifact(ctx.sql, "clin_verified", storedDicomA.id, true);
    const clinGetMask = await getImagingArtifact(ctx.sql, "clin_verified", storedMaskA.id, true);
    const clinGetMesh = await getImagingArtifact(ctx.sql, "clin_verified", storedMeshA.id, true);
    assert.equal(clinGetDicom.integrity.valid, true);
    assert.equal(clinGetMask.integrity.valid, true);
    assert.equal(clinGetMesh.integrity.valid, true);

    // Scenario 1: Valid patient accessing their own imaging (DICOM, mask, mesh, list, integrity, historical evidence)
    const patGetDicom = await getImagingArtifact(ctx.sql, "patient_a", storedDicomA.id, true);
    const patGetMask = await getImagingArtifact(ctx.sql, "patient_a", storedMaskA.id, true);
    const patGetMesh = await getImagingArtifact(ctx.sql, "patient_a", storedMeshA.id, true);
    assert.equal(patGetDicom.record.id, storedDicomA.id);
    assert.equal(patGetMask.record.id, storedMaskA.id);
    assert.equal(patGetMesh.record.id, storedMeshA.id);
    const patList = await listImagingArtifacts(ctx.sql, "patient_a", "pat_a");
    assert.equal(patList.length, 3);
    const patEvidence = await getHistoricalFindingImagingEvidence(ctx.sql, "patient_a", "fv_pat_a");
    assert.equal(patEvidence.patientId, "pat_a");

    // Scenario 2: Patient accessing another patient's imaging MUST be denied across all operations
    await assert.rejects(
      () => getImagingArtifact(ctx.sql, "patient_b", storedDicomA.id, true),
      /Unauthorized/,
    );
    await assert.rejects(
      () => getImagingArtifact(ctx.sql, "patient_b", storedMaskA.id, true),
      /Unauthorized/,
    );
    await assert.rejects(
      () => verifyImagingObjectIntegrity(ctx.sql, "patient_b", storedDicomA.id),
      /Unauthorized/,
    );
    await assert.rejects(
      () => listImagingArtifacts(ctx.sql, "patient_b", "pat_a"),
      /Unauthorized/,
    );
    await assert.rejects(
      () => getHistoricalFindingImagingEvidence(ctx.sql, "patient_b", "fv_pat_a"),
      /Unauthorized/,
    );

    // Scenario 4: Approved clinician without consent MUST be denied on upload and retrieval
    await assert.rejects(
      () => getImagingArtifact(ctx.sql, "clin_no_consent", storedDicomA.id, true),
      /Unauthorized.*no active patient consent/i,
    );
    await assert.rejects(
      () =>
        storeImagingArtifact(ctx.sql, {
          userId: "clin_no_consent",
          patientId: "pat_a",
          kind: "mask",
          data: maskBytes,
        }),
      /Unauthorized.*no active patient consent/i,
    );

    // Consent Scope Enforcement: Consent granting ONLY view_reports (without view_imaging) must be denied for imaging
    await ctx.pg.exec(`
      update patient_clinician_consents
      set permissions_json = '["view_demographics","view_reports"]'
      where id = 'consent_a_active'
    `);
    await assert.rejects(
      () => getImagingArtifact(ctx.sql, "clin_verified", storedDicomA.id, true),
      /does not grant 'view_imaging' permission/,
    );

    // Consent granting view_imaging ONLY (without add_annotations / review_ai_findings) allows read but denies upload/purge
    await ctx.pg.exec(`
      update patient_clinician_consents
      set permissions_json = '["view_demographics","view_imaging"]'
      where id = 'consent_a_active'
    `);
    const readOnlyOk = await getImagingArtifact(ctx.sql, "clin_verified", storedDicomA.id, false);
    assert.equal(readOnlyOk.record.id, storedDicomA.id);
    await assert.rejects(
      () =>
        storeImagingArtifact(ctx.sql, {
          userId: "clin_verified",
          patientId: "pat_a",
          kind: "mask",
          data: maskBytes,
        }),
      /does not grant 'add_annotations' or 'review_ai_findings'/,
    );
    await assert.rejects(
      () => purgeImagingArtifact(ctx.sql, "clin_verified", storedMeshA.id, "Unauthorized purge attempt"),
      /does not grant 'add_annotations' or 'review_ai_findings'/,
    );

    // Restore full permissions for subsequent tests
    await ctx.pg.exec(`
      update patient_clinician_consents
      set permissions_json = '["view_demographics","view_imaging","add_annotations","review_ai_findings"]'
      where id = 'consent_a_active'
    `);

    // Scenario 5: Expired consent MUST immediately block access
    await ctx.pg.exec(`
      update patient_clinician_consents
      set expires_at = '2020-01-01T00:00:00Z'
      where id = 'consent_a_active'
    `);
    await assert.rejects(
      () => getImagingArtifact(ctx.sql, "clin_verified", storedDicomA.id, true),
      /Unauthorized.*no active patient consent/i,
    );
    await assert.rejects(
      () =>
        storeImagingArtifact(ctx.sql, {
          userId: "clin_verified",
          patientId: "pat_a",
          kind: "mask",
          data: maskBytes,
        }),
      /Unauthorized.*no active patient consent/i,
    );

    // Scenario 6: Revoked consent MUST immediately block access
    await ctx.pg.exec(`
      update patient_clinician_consents
      set expires_at = '2099-12-31T23:59:59Z', status = 'revoked', revoked_at = now()
      where id = 'consent_a_active'
    `);
    await assert.rejects(
      () => getImagingArtifact(ctx.sql, "clin_verified", storedDicomA.id, true),
      /Unauthorized.*no active patient consent/i,
    );

    // Re-activate consent to test Scenario 7, 8, and 11
    await ctx.pg.exec(`
      update patient_clinician_consents
      set status = 'active', revoked_at = null
      where id = 'consent_a_active'
    `);

    // Scenario 7 & 8: Unverified clinician and Revoked clinician are immediately blocked even if consent row exists
    await assert.rejects(
      () => getImagingArtifact(ctx.sql, "clin_unverified", storedDicomA.id, true),
      /Clinician verification is not approved/,
    );
    await assert.rejects(
      () => getImagingArtifact(ctx.sql, "clin_revoked", storedDicomA.id, true),
      /Clinician verification is not approved/,
    );

    // Scenario 11: Invalid or manipulated cross-patient IDs MUST be rejected
    await assert.rejects(
      () => getImagingArtifact(ctx.sql, "clin_verified", "../etc/passwd", true),
      /Invalid or manipulated objectId/,
    );
    await assert.rejects(
      () =>
        storeImagingArtifact(ctx.sql, {
          userId: "clin_verified",
          patientId: "pat_a",
          studyId: "study_pat_b",
          kind: "mask",
          data: maskBytes,
        }),
      /Invalid or cross-patient studyId/,
    );
    await assert.rejects(
      () =>
        storeImagingArtifact(ctx.sql, {
          userId: "clin_verified",
          patientId: "pat_a",
          seriesId: "series_pat_b",
          kind: "mask",
          data: maskBytes,
        }),
      /Invalid or cross-patient seriesId/,
    );
    await assert.rejects(
      () =>
        storeImagingArtifact(ctx.sql, {
          userId: "clin_verified",
          patientId: "pat_a",
          findingVersionId: "fv_pat_b",
          kind: "mask",
          data: maskBytes,
        }),
      /Invalid or cross-patient findingVersionId/,
    );
    await assert.rejects(
      () =>
        getHistoricalFindingImagingEvidence(ctx.sql, "clin_verified", {
          findingId: "find_pat_a",
          findingVersionId: "fv_pat_b",
        }),
      /Manipulated or mismatched findingId and findingVersionId/,
    );

    // Scenario 12: Unauthorized upload/purge by patient and unauthorized cross-user access by admin
    await assert.rejects(
      () =>
        storeImagingArtifact(ctx.sql, {
          userId: "patient_a",
          patientId: "pat_a",
          kind: "mask",
          data: maskBytes,
        }),
      /requires verified clinician credentials/,
    );
    await assert.rejects(
      () => purgeImagingArtifact(ctx.sql, "patient_a", storedMaskA.id, "Patient trying to purge"),
      /requires verified clinician credentials/,
    );
    await assert.rejects(
      () => getImagingArtifact(ctx.sql, "admin_user", storedDicomA.id, true),
      /Unauthorized/,
    );
  } finally {
    ctx.cleanup();
  }
});

import { exportDeidentifiedDicomArtifact } from "./storage.server.ts";

test("Sprint 6 Task 2E & 2F: exportDeidentifiedDicomArtifact enforces authorization, manual review gate for burned-in risk, original file immutability, and audit logging", async () => {
  const ctx = await createTestStorageDb();
  try {
    const dicomBytes = buildSyntheticMrDicom({
      rows: 16,
      cols: 16,
      imagePosition: "-10\\-20\\30",
      imageOrientation: "1\\0\\0\\0\\1\\0",
      pixelSpacing: "1.0\\1.0",
      sliceThickness: "3.0",
    });
    const stored = await storeImagingArtifact(ctx.sql, {
      userId: "clin_verified",
      patientId: "pat_clin_1",
      studyId: "study_1",
      seriesId: "series_1",
      kind: "dicom",
      data: dicomBytes,
    });

    // 1. Unauthorized user is rejected fail-closed
    await assert.rejects(
      () => exportDeidentifiedDicomArtifact(ctx.sql, "clin_unverified", stored.id),
      /Unauthorized/,
    );

    // 2. Because BurnedInAnnotation (0028,0301) is not explicitly 'NO', manualReviewRequired is true;
    // exporting without clinicianReviewedBurnedInPixels: true is blocked and audited
    await assert.rejects(
      () => exportDeidentifiedDicomArtifact(ctx.sql, "clin_verified", stored.id),
      /Manual pixel review required before export/,
    );

    // 3. Exporting with clinicianReviewedBurnedInPixels: true succeeds, preserves the original file on disk, and returns de-identified bytes
    const exported = await exportDeidentifiedDicomArtifact(ctx.sql, "clin_verified", stored.id, {
      uidSalt: "storage-export-salt",
      dateShiftDays: -90,
      patientIdReplacement: "ANON-PAT-01",
      clinicianReviewedBurnedInPixels: true,
    });
    assert.equal(exported.sourceObjectId, stored.id);
    assert.equal(exported.originalPreserved, true);
    assert.equal(exported.claimCompleteAnonymisation, false);
    assert.equal(exported.clinicianReviewedBurnedInPixels, true);
    assert.ok(exported.derivedBase64.length > 100);

    // Verify original stored object on disk still passes SHA-256 integrity verification
    const integrityAfter = await verifyImagingObjectIntegrity(ctx.sql, "clin_verified", stored.id);
    assert.equal(integrityAfter.valid, true);
    assert.equal(integrityAfter.actualSha256, stored.sha256);
  } finally {
    ctx.cleanup();
  }
});

import {
  writeAuditEvent,
  flushPendingAuditOutbox,
  readDurableAuditOutbox,
  createImagingStorageBackup,
  restoreImagingStorageBackup,
  reconcileImagingStorageConsistency,
  validateStorageBackendConfig,
} from "./storage.server.ts";

test("Workstream 1 & 4: Atomic purge rollback on DB failure, durable audit outbox replay, backup creation, actual backup restoration, and storage consistency monitor", async () => {
  const ctx = await createTestStorageDb();
  try {
    // 1. Validate server-side storage backend configuration rejects public URLs or browser-exposed secrets
    const validLocalCfg = validateStorageBackendConfig({
      REPROCARE_STORAGE_BACKEND: "local_durable",
      REPROCARE_IMAGING_STORAGE_DIR: process.env.REPROCARE_IMAGING_STORAGE_DIR,
    });
    assert.equal(validLocalCfg.backend, "local_durable");
    assert.equal(validLocalCfg.credentialsServerSideOnly, true);
    assert.equal(validLocalCfg.publicUrlsDisabled, true);

    assert.throws(
      () =>
        validateStorageBackendConfig({
          REPROCARE_ALLOW_PUBLIC_IMAGING_URLS: "true",
        }),
      /Security violation: storage credentials and medical-image URLs must remain strictly server-side/,
    );

    // 2. Store a valid DICOM artifact
    const dicomBytes = buildSyntheticMrDicom({
      rows: 16,
      cols: 16,
      imagePosition: "5\\10\\15",
      imageOrientation: "1\\0\\0\\0\\1\\0",
      pixelSpacing: "1.2\\1.2",
      sliceThickness: "3.0",
    });
    const stored = await storeImagingArtifact(ctx.sql, {
      userId: "clin_verified",
      patientId: "pat_clin_1",
      studyId: "study_1",
      seriesId: "series_1",
      kind: "dicom",
      data: dicomBytes,
    });

    // 3. Test Atomic Two-Phase Purge Rollback: if the DB UPDATE to 'purged' fails,
    // the binary file on disk MUST be restored and NEVER left deleted with status='active'!
    const failingUpdateSql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const q = strings.join(" ").toLowerCase();
      if (q.includes("update imaging_objects") && q.includes("purged")) {
        throw new Error("Simulated database crash during purge status update");
      }
      return ctx.sql(strings, ...values);
    }) as unknown as Sql;

    await assert.rejects(
      () =>
        purgeImagingArtifact(
          failingUpdateSql,
          "clin_verified",
          stored.id,
          "Attempted purge during DB failure",
        ),
      /Atomic purge aborted/,
    );

    // Verify that after the aborted purge, the binary file on disk was rolled back intact and passes SHA-256 verification!
    const integrityAfterFailedPurge = await verifyImagingObjectIntegrity(
      ctx.sql,
      "clin_verified",
      stored.id,
    );
    assert.equal(integrityAfterFailedPurge.valid, true);
    assert.equal(integrityAfterFailedPurge.exists, true);
    assert.equal(integrityAfterFailedPurge.actualSha256, stored.sha256);

    // 4. Test Durable Audit Outbox & Replay when audit_events DB insert fails transiently
    const failingAuditSql = (async () => {
      throw new Error("Simulated audit_events table lock/unavailable");
    }) as unknown as Sql;

    const queuedEntry = await writeAuditEvent(
      failingAuditSql,
      "clin_verified",
      "critical_consent_check",
      "patient_consent",
      "consent_99",
      "Verified consent during transient DB audit outage",
    );
    assert.equal(queuedEntry.dbPersisted, false);
    const outboxBefore = await readDurableAuditOutbox();
    assert.ok(outboxBefore.some((e) => e.id === queuedEntry.id));

    // Replay pending outbox into the working DB
    const flushed = await flushPendingAuditOutbox(ctx.sql);
    assert.ok(flushed.replayedCount >= 1);
    assert.equal(flushed.remainingCount, 0);

    const dbAuditRows = await ctx.sql<{ id: string; action: string }>`
      select id, action from audit_events where id = ${queuedEntry.id}
    `;
    assert.equal(dbAuditRows.length, 1);
    assert.equal(dbAuditRows[0].action, "critical_consent_check");

    // 5. Test Backup Creation & Actual Backup Restoration
    const backup = await createImagingStorageBackup(ctx.sql, "clin_verified", {
      patientId: "pat_clin_1",
    });
    assert.equal(backup.manifest.objectCount, 1);
    assert.equal(backup.manifest.objects[0].id, stored.id);
    assert.equal(backup.manifest.objects[0].sha256, stored.sha256);

    // Simulate catastrophic loss of the active binary file on disk
    const baseDir = process.env.REPROCARE_IMAGING_STORAGE_DIR!;
    const activeFilePath = stored.storagePath;
    unlinkSync(activeFilePath);

    const consistencyMissing = await reconcileImagingStorageConsistency(ctx.sql, "clin_verified", {
      patientId: "pat_clin_1",
      repairStatuses: true,
    });
    assert.equal(consistencyMissing.consistent, false);
    assert.ok(consistencyMissing.missingBlobObjectIds.includes(stored.id));

    // Perform ACTUAL restoration from the verified backup bundle
    const restored = await restoreImagingStorageBackup(
      ctx.sql,
      "clin_verified",
      backup.backupDir,
    );
    assert.equal(restored.restoredCount, 1);
    assert.equal(restored.verifiedCount, 1);
    assert.ok(restored.restoredObjectIds.includes(stored.id));

    // Verify the restored binary file is retrievable and passes SHA-256 integrity
    const retrievedAfterRestore = await getImagingArtifact(
      ctx.sql,
      "clin_verified",
      stored.id,
      true,
    );
    assert.equal(retrievedAfterRestore.integrity.valid, true);
    assert.equal(retrievedAfterRestore.record.sha256, stored.sha256);
    assert.ok(retrievedAfterRestore.data && retrievedAfterRestore.data.byteLength === stored.bytes);

    const consistencyHealthy = await reconcileImagingStorageConsistency(ctx.sql, "clin_verified", {
      patientId: "pat_clin_1",
    });
    assert.equal(consistencyHealthy.consistent, true);
    assert.equal(consistencyHealthy.healthyActiveCount, 1);

    rmSync(backup.backupDir, { recursive: true, force: true });
  } finally {
    ctx.cleanup();
  }
});
