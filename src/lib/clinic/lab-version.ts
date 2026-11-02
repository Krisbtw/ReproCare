import type { Sql } from "../db.ts";
import { storeImagingArtifact } from "../imaging/storage.server.ts";
import { computeVoxelBoundaryUncertainty } from "../reprotrace/params.ts";
import { evaluateClinicianConsentForPatient } from "./collaboration.ts";

export type LabVersionInput = {
  findingId: string;
  axes: [number, number, number];
  longest: number;
  sliceIndex: number;
  reason: string;
  evidenceNote: string;
  studyId?: string | null;
  seriesId?: string | null;
  centroidMm?: [number, number, number] | null;
  frame?: string | null;
  observedOn?: string | null;
  provenanceHash?: string | null;
  segmentationSource?: string | null;
  modelId?: string | null;
  segmentationRunId?: string | null;
  weightsSha256?: string | null;
  volumeMm3?: number | null;
  uncertaintyMm3?: number | null;
  newStudy?: {
    patientId: string;
    modality?: string;
    studyDate?: string;
    description?: string;
    accession?: string;
    sourceNote?: string;
    studyInstanceUid?: string | null;
  };
  newSeries?: {
    seriesNumber?: number;
    description?: string;
    plane?: string;
    sliceCount?: number;
    pixelSpacingMm?: string;
    sliceThicknessMm?: number;
    seriesInstanceUid?: string | null;
    frameOfReferenceUid?: string | null;
    geometryJson?: string | null;
    volumeSha256?: string | null;
  };
  clinicianConfirmed?: boolean;
  seedPoint?: [number, number, number] | null;
  /** Optional persistent imaging artifacts to store and link to the finding version */
  sourceDicomFiles?: Array<{
    name?: string;
    fileName?: string;
    data?: Uint8Array | Buffer | string;
    dataBase64?: string;
    instanceNumber?: number;
    sopInstanceUid?: string;
    metadata?: Record<string, unknown>;
  }>;
  maskArtifact?: {
    filename?: string;
    fileName?: string;
    mimeType?: string;
    data?: Uint8Array | Buffer | string;
    dataBase64?: string;
    metadata?: Record<string, unknown>;
  } | null;
  meshArtifact?: {
    filename?: string;
    fileName?: string;
    mimeType?: string;
    data?: Uint8Array | Buffer | string;
    dataBase64?: string;
    metadata?: Record<string, unknown>;
  } | null;
};

const num = (v: unknown) => Number(v ?? 0);

function toBuffer(raw: Uint8Array | Buffer | string): Buffer {
  if (typeof raw === "string") {
    return Buffer.from(raw, "base64");
  }
  return Buffer.from(raw);
}

async function enforceVerifiedClinicianIfProfileExists(sql: Sql, userId: string): Promise<void> {
  if (!userId || typeof userId !== "string" || !userId.trim()) {
    throw new Error("Unauthorized: Authentication is required.");
  }
  const profileRows = await sql<{ role: string }>`select role from profiles where user_id = ${userId}`.catch(() => []);
  if (profileRows.length === 0) return;
  const role = profileRows[0].role;
  if (role === "admin") return;
  if (role !== "clinician") {
    throw new Error("Unauthorized: Recording a measurement is a clinician action.");
  }
  const verifRows = await sql<{ status: string; licence_no: string; registry: string }>`
    select status, licence_no, registry
    from clinician_verifications
    where user_id = ${userId}
    order by coalesce(decided_at, requested_at) desc, requested_at desc, id desc
    limit 1
  `.catch(() => []);
  const v = verifRows[0];
  const approved =
    Boolean(v) &&
    (v.status === "verified" || v.status === "approved") &&
    String(v.licence_no ?? "").trim().length > 0 &&
    String(v.registry ?? "").trim().length > 0;
  if (!approved) {
    throw new Error(
      `Unauthorized: Clinician verification is not approved (status: ${v?.status ?? "unverified"}). A role string alone does not authorize clinical operations.`,
    );
  }
}

/** Appends version N+1 for a finding from a Volume lab measurement and persists linked source imaging/masks. */
export async function insertLabVersion(sql: Sql, userId: string, data: LabVersionInput): Promise<string> {
  if (!userId || typeof userId !== "string" || !userId.trim()) {
    throw new Error("Unauthorized: Authentication is required.");
  }
  await enforceVerifiedClinicianIfProfileExists(sql, userId);

  const findingRows = await sql<{ id: string; user_id: string; patient_id: string }>`
    select id, user_id, patient_id from findings where id = ${data.findingId} limit 1
  `;
  const findingMeta = findingRows[0];
  if (!findingMeta) throw new Error("Finding not found.");

  const recordOwnerUserId = findingMeta.user_id;
  const patientId = findingMeta.patient_id ?? data.newStudy?.patientId ?? "";

  if (recordOwnerUserId !== userId) {
    const consentEval = await evaluateClinicianConsentForPatient(
      sql,
      userId,
      patientId,
      "add_annotations",
      "save_lab_measurement",
    );
    if (!consentEval.allowed) {
      throw new Error(`Finding not found or unauthorized: ${consentEval.reason}`);
    }
  }

  const found = await sql<Record<string, unknown>>`select * from finding_versions
    where finding_id = ${data.findingId} and user_id = ${recordOwnerUserId} order by version_no desc limit 1`;
  const current = found[0];
  if (!current) throw new Error("Finding not found.");

  let targetStudyId = current.study_id as string;
  let targetSeriesId = data.seriesId ?? null;
  let targetObservedOn = current.observed_on as string;

  if (data.newStudy) {
    const patientCheck = await sql`select id from patients where id = ${data.newStudy.patientId} and user_id = ${recordOwnerUserId}`;
    if (!patientCheck.length) throw new Error("Patient not found for new study.");
    targetStudyId = crypto.randomUUID();
    targetObservedOn = data.newStudy.studyDate ?? new Date().toISOString().slice(0, 10);
    try {
      await sql`insert into studies (
        id, user_id, patient_id, modality, study_date, description, accession, synthetic, source_note, study_instance_uid
      ) values (
        ${targetStudyId},
        ${recordOwnerUserId},
        ${data.newStudy.patientId},
        ${data.newStudy.modality ?? "MR"},
        ${targetObservedOn},
        ${data.newStudy.description ?? "Uploaded DICOM study"},
        ${data.newStudy.accession ?? "ACC-" + Date.now().toString().slice(-6)},
        false,
        ${data.newStudy.sourceNote ?? "Uploaded in Volume Lab"},
        ${data.newStudy.studyInstanceUid ?? null}
      )`;
    } catch {
      await sql`insert into studies (id, user_id, patient_id, modality, study_date, description, accession, synthetic, source_note)
        values (
          ${targetStudyId},
          ${recordOwnerUserId},
          ${data.newStudy.patientId},
          ${data.newStudy.modality ?? "MR"},
          ${targetObservedOn},
          ${data.newStudy.description ?? "Uploaded DICOM study"},
          ${data.newStudy.accession ?? "ACC-" + Date.now().toString().slice(-6)},
          false,
          ${data.newStudy.sourceNote ?? "Uploaded in Volume Lab"}
        )`;
    }
    if (data.newSeries) {
      targetSeriesId = crypto.randomUUID();
      try {
        await sql`insert into series (
          id, user_id, study_id, series_number, description, plane, slice_count, pixel_spacing_mm, slice_thickness_mm,
          series_instance_uid, frame_of_reference_uid, geometry_json, volume_sha256
        ) values (
          ${targetSeriesId},
          ${recordOwnerUserId},
          ${targetStudyId},
          ${data.newSeries.seriesNumber ?? 1},
          ${data.newSeries.description ?? "DICOM Series"},
          ${data.newSeries.plane ?? null},
          ${data.newSeries.sliceCount ?? null},
          ${data.newSeries.pixelSpacingMm ?? null},
          ${data.newSeries.sliceThicknessMm ?? null},
          ${data.newSeries.seriesInstanceUid ?? null},
          ${data.newSeries.frameOfReferenceUid ?? null},
          ${data.newSeries.geometryJson ?? null},
          ${data.newSeries.volumeSha256 ?? null}
        )`;
      } catch {
        await sql`insert into series (id, user_id, study_id, series_number, description, plane, slice_count, pixel_spacing_mm, slice_thickness_mm)
          values (
            ${targetSeriesId},
            ${recordOwnerUserId},
            ${targetStudyId},
            ${data.newSeries.seriesNumber ?? 1},
            ${data.newSeries.description ?? "DICOM Series"},
            ${data.newSeries.plane ?? null},
            ${data.newSeries.sliceCount ?? null},
            ${data.newSeries.pixelSpacingMm ?? null},
            ${data.newSeries.sliceThicknessMm ?? null}
          )`;
      }
    }
  } else if (data.studyId) {
    const studyCheck = await sql<{ id: string; study_date: string }>`select id, study_date from studies where id = ${data.studyId} and user_id = ${recordOwnerUserId}`;
    if (!studyCheck.length) {
      throw new Error(`Invalid studyId: Study ${data.studyId} does not exist or does not belong to user.`);
    }
    targetStudyId = studyCheck[0].id;
    targetObservedOn = data.observedOn ?? studyCheck[0].study_date;
  }

  if (targetSeriesId) {
    const seriesCheck = await sql<{ id: string }>`select id from series where id = ${targetSeriesId} and user_id = ${recordOwnerUserId}`;
    if (!seriesCheck.length) {
      throw new Error(`Invalid seriesId: Series ${targetSeriesId} does not exist or does not belong to user.`);
    }
  }

  const versionId = crypto.randomUUID();
  const centroidJson = data.centroidMm ? JSON.stringify(data.centroidMm) : null;
  const frameVal = data.frame ?? (data.centroidMm ? "dicom_lps" : "unavailable");

  // Compute physical volume and boundary uncertainty if not explicitly provided
  const computedVolMm3 =
    data.volumeMm3 != null && Number.isFinite(data.volumeMm3)
      ? Number(data.volumeMm3)
      : Math.round((4 / 3) * Math.PI * (data.axes[0] / 2) * (data.axes[1] / 2) * (data.axes[2] / 2));

  let spacingTriple: [number, number, number] = [1.0, 1.0, 3.0];
  if (data.newSeries?.pixelSpacingMm) {
    const parts = data.newSeries.pixelSpacingMm.split("\\").map(Number);
    const sz = data.newSeries.sliceThicknessMm ?? 3.0;
    if (parts.length === 2 && parts.every((v) => Number.isFinite(v) && v > 0) && Number.isFinite(sz) && sz > 0) {
      spacingTriple = [parts[1], parts[0], sz];
    }
  }
  const computedUncertaintyMm3 =
    data.uncertaintyMm3 != null && Number.isFinite(data.uncertaintyMm3)
      ? Number(data.uncertaintyMm3)
      : Math.round(computeVoxelBoundaryUncertainty(computedVolMm3, spacingTriple));

  let primaryDicomObjectId: string | null = null;
  let storedMaskObjectId: string | null = null;
  let segmentationRunId: string | null = data.segmentationRunId ?? null;

  // 1. Persist source DICOM files if supplied
  if (patientId && data.sourceDicomFiles && data.sourceDicomFiles.length > 0) {
    for (let i = 0; i < data.sourceDicomFiles.length; i++) {
      const f = data.sourceDicomFiles[i];
      const payload = f.data ?? f.dataBase64;
      if (!payload) continue;
      const stored = await storeImagingArtifact(sql, {
        userId: recordOwnerUserId,
        patientId,
        studyId: targetStudyId,
        seriesId: targetSeriesId,
        kind: "dicom",
        filename: f.name || f.fileName || `slice-${String(i).padStart(4, "0")}.dcm`,
        instanceNumber: f.instanceNumber ?? i + 1,
        sopInstanceUid: f.sopInstanceUid ?? null,
        data: toBuffer(payload),
        metadata: f.metadata,
      });
      if (!primaryDicomObjectId) {
        primaryDicomObjectId = stored.id;
      }
    }
  }

  // 2. Persist segmentation mask artifact if supplied
  const maskPayload = data.maskArtifact?.data ?? data.maskArtifact?.dataBase64;
  if (patientId && data.maskArtifact && maskPayload) {
    const maskStored = await storeImagingArtifact(sql, {
      userId: recordOwnerUserId,
      patientId,
      studyId: targetStudyId,
      seriesId: targetSeriesId,
      sourceObjectId: primaryDicomObjectId,
      kind: "mask",
      filename: data.maskArtifact.filename || data.maskArtifact.fileName || "segmentation-mask.bin",
      mimeType: data.maskArtifact.mimeType,
      data: toBuffer(maskPayload),
      metadata: data.maskArtifact.metadata ?? {
        axesMm: data.axes,
        volumeMm3: computedVolMm3,
        segmentationSource: data.segmentationSource ?? "classical_region_growing",
        modelId: data.modelId ?? null,
      },
    });
    storedMaskObjectId = maskStored.id;

    if (!segmentationRunId) {
      segmentationRunId = crypto.randomUUID();
      await sql`
        insert into segmentation_runs (
          id, user_id, series_id, model_id, weights_sha256, params_json,
          mask_object_id, label_counts, volume_mm3, status
        ) values (
          ${segmentationRunId},
          ${recordOwnerUserId},
          ${targetSeriesId},
          ${data.modelId ?? data.segmentationSource ?? "classical_region_growing"},
          ${data.weightsSha256 ?? null},
          ${JSON.stringify({ sliceIndex: data.sliceIndex, provenanceHash: data.provenanceHash ?? null, seedPoint: data.seedPoint ?? null, clinicianConfirmed: data.clinicianConfirmed ?? false })},
          ${storedMaskObjectId},
          ${JSON.stringify(data.maskArtifact.metadata?.labelCounts ?? {})},
          ${computedVolMm3},
          'completed'
        )
      `.catch(() => null);
    }
  }

  // 3. Persist 3D surface mesh artifact if supplied
  const meshPayload = data.meshArtifact?.data ?? data.meshArtifact?.dataBase64;
  if (patientId && data.meshArtifact && meshPayload) {
    await storeImagingArtifact(sql, {
      userId: recordOwnerUserId,
      patientId,
      studyId: targetStudyId,
      seriesId: targetSeriesId,
      sourceObjectId: storedMaskObjectId ?? primaryDicomObjectId,
      kind: "mesh",
      filename: data.meshArtifact.filename || data.meshArtifact.fileName || "surface-mesh.stl",
      mimeType: data.meshArtifact.mimeType,
      data: toBuffer(meshPayload),
      metadata: data.meshArtifact.metadata ?? {},
    });
  }

  await sql`insert into finding_versions (
    id, user_id, finding_id, version_no, previous_version_id, study_id, observed_on, location_label, figo,
    centroid_mm, axes_mm, longest_mm, measurement_basis, frame, segmentation_source, model_id, quality, modality,
    report_longest_mm, change_reason, series_id, volume_mm3, volume_method, segmentation_run_id, uncertainty_mm3
  ) values (
    ${versionId}, ${recordOwnerUserId}, ${data.findingId}, ${num(current.version_no) + 1}, ${current.id as string},
    ${targetStudyId}, ${targetObservedOn}, ${current.location_label as string}, ${current.figo as string | null},
    ${centroidJson}, ${JSON.stringify(data.axes)}, ${data.longest}, ${"principal-axis extents of a seeded mask (not a caliper plane)"},
    ${frameVal}, ${data.segmentationSource ?? "classical_region_growing"}, ${data.modelId ?? null}, ${"adequate"}, ${current.modality as string},
    ${null}, ${"Volume lab: " + data.reason}, ${targetSeriesId}, ${computedVolMm3},
    ${data.segmentationSource ? "voxel_counting" : "ellipsoid_formula"}, ${segmentationRunId}, ${computedUncertaintyMm3}
  )`;

  // Link finding_version_id back onto the newly stored objects if migration 0011 is active
  if (primaryDicomObjectId || storedMaskObjectId) {
    await sql`
      update imaging_objects
      set finding_version_id = ${versionId}
      where user_id = ${recordOwnerUserId}
        and id in (${primaryDicomObjectId ?? ""}, ${storedMaskObjectId ?? ""})
    `.catch(() => null);
  }

  try {
    await sql`insert into evidence_links (
      id, user_id, finding_version_id, kind, study_id, series_id, report_id, quote, slice_index, note,
      imaging_object_id, mask_object_id
    ) values (
      ${crypto.randomUUID()}, ${recordOwnerUserId}, ${versionId}, ${"lab_segmentation"},
      ${targetStudyId}, ${targetSeriesId}, ${null}, ${null}, ${data.sliceIndex}, ${data.evidenceNote},
      ${primaryDicomObjectId}, ${storedMaskObjectId}
    )`;
  } catch {
    await sql`insert into evidence_links (id, user_id, finding_version_id, kind, study_id, series_id, report_id, quote, slice_index, note)
      values (${crypto.randomUUID()}, ${recordOwnerUserId}, ${versionId}, ${"lab_segmentation"}, ${targetStudyId}, ${targetSeriesId}, ${null}, ${null}, ${data.sliceIndex}, ${data.evidenceNote})`;
  }

  return versionId;
}
