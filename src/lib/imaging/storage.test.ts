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
} from "../clinic/server.ts";

async function createTestStorageDb() {
  const storageDir = mkdtempSync(join(tmpdir(), "reprocare-imaging-test-"));
  process.env.REPROCARE_IMAGING_STORAGE_DIR = storageDir;

  const pg = new PGlite();
  await pg.exec(readFileSync(new URL("../../../migrations/0002_anatomybridge.sql", import.meta.url), "utf8"));
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
