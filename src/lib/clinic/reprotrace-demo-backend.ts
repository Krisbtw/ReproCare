/** Database side of the SYNTHETIC ReproTrace demonstration patient. */
import type { Sql } from "../db.ts";
import { registerVolumes, toMatrix4x4 } from "../imaging/registration.ts";
import {
  DEMO_EXAMS,
  DEMO_PATIENT_KEY,
  buildDemoVolume,
  demoGeometryJson,
  lesionCentroidLps,
  lesionSliceIndex,
  lesionSopInstanceUid,
} from "./reprotrace-demo.ts";
import {
  executeSaveVolumeRegistration,
  requirePatientRecordAccess,
  requireVerifiedClinicianOrAdmin,
} from "./server.backend.ts";
import { writeAuditEvent } from "../imaging/storage.ts";

const kid = (userId: string, key: string) => `${userId}:${key}`;

/**
 * Inserts the synthetic demo patient into the caller's workspace (idempotent). No correspondences are
 * seeded: the first ReproTrace result for this patient only exists after a live recompute.
 */
export async function executeSeedReproTraceDemo(sql: Sql, rawUserId: string) {
  const auth = await requireVerifiedClinicianOrAdmin(sql, rawUserId, "loading the synthetic ReproTrace demo");
  const userId = auth.userId;
  const patientId = kid(userId, DEMO_PATIENT_KEY);
  const existing = await sql<{ id: string }>`select id from patients where id = ${patientId}`;
  if (existing.length) {
    await sql`update profiles set active_patient_id = ${patientId} where user_id = ${userId}`;
    return { ok: true, patientId, created: false };
  }
  await sql`insert into patients (id, user_id, code, display_name, year_of_birth, pathway, synopsis, is_self, synthetic)
    values (${patientId}, ${userId}, ${"SYN-RT-01"}, ${"ReproTrace demo (synthetic)"}, ${1990}, ${"fibroids"},
      ${"SYNTHETIC demonstration patient: two generated MRI examinations of one anterior intramural fibroid. Not a real person."},
      ${false}, ${true})`;
  for (const ex of DEMO_EXAMS) {
    const studyId = kid(userId, ex.key);
    const seriesId = kid(userId, ex.seriesKey);
    await sql`insert into studies (id, user_id, patient_id, modality, study_date, description, accession, synthetic, source_note, study_instance_uid)
      values (${studyId}, ${userId}, ${patientId}, ${"MR"}, ${ex.date}, ${ex.description}, ${ex.accession}, ${true},
        ${"SYNTHETIC: generated DICOM series (series-writer). Pixels are regenerated deterministically on demand."},
        ${ex.spec.studyUid ?? null})`;
    await sql`insert into series (
        id, user_id, study_id, series_number, description, plane, slice_thickness_mm, pixel_spacing_mm, slice_count, quality,
        series_instance_uid, frame_of_reference_uid, geometry_json, origin_lps_json, direction_cosines_json
      ) values (
        ${seriesId}, ${userId}, ${studyId}, ${1}, ${ex.spec.description ?? "SYNTHETIC series"}, ${"sagittal"},
        ${ex.spec.sliceStepMm}, ${`${ex.spec.pixelSpacingMm[0]}\\${ex.spec.pixelSpacingMm[1]}`}, ${ex.spec.slices}, ${"adequate"},
        ${ex.spec.seriesUid ?? null}, ${ex.frameOfReferenceUid}, ${demoGeometryJson(ex)},
        ${JSON.stringify(ex.spec.originMm)}, ${JSON.stringify([1, 0, 0, 0, 1, 0, 0, 0, 1])}
      )`;
    const findingId = kid(userId, ex.findingKey);
    const versionId = kid(userId, ex.versionKey);
    const centroid = lesionCentroidLps(ex);
    const axes = ex.spec.lesionRadiiMm.map((r) => r * 2) as [number, number, number];
    const volume = Math.round((4 / 3) * Math.PI * ex.spec.lesionRadiiMm[0] * ex.spec.lesionRadiiMm[1] * ex.spec.lesionRadiiMm[2]);
    await sql`insert into findings (id, user_id, patient_id, code, structure, organ, pathway)
      values (${findingId}, ${userId}, ${patientId}, ${ex.code}, ${"fibroid"}, ${"uterus"}, ${"fibroids"})`;
    await sql`insert into finding_versions (
        id, user_id, finding_id, version_no, previous_version_id, study_id, observed_on, location_label, figo,
        centroid_mm, axes_mm, longest_mm, measurement_basis, frame, segmentation_source, model_id, quality, modality,
        report_longest_mm, change_reason, series_id, volume_mm3, volume_method
      ) values (
        ${versionId}, ${userId}, ${findingId}, 1, ${null}, ${studyId}, ${ex.date}, ${"FIGO 4 anterior intramural"}, ${"4"},
        ${JSON.stringify(centroid)}, ${JSON.stringify(axes)}, ${Math.max(...axes)},
        ${"known generator geometry of the synthetic DICOM ellipsoid (not a segmentation)"}, ${"dicom_lps"},
        ${"synthetic_phantom_ground_truth"}, ${null}, ${"adequate"}, ${"MR"}, ${null},
        ${"SYNTHETIC seed: ellipsoid parameters of the generated series, mapped to DICOM LPS through the series geometry."},
        ${seriesId}, ${volume}, ${"analytic_ellipsoid"}
      )`;
    await sql`insert into evidence_links (
        id, user_id, finding_version_id, kind, study_id, series_id, report_id, quote, slice_index, note,
        sop_instance_uid, coordinate_frame, centroid_lps_json, link_status, review_status, source_artifact_ref
      ) values (
        ${kid(userId, `${ex.versionKey}-img`)}, ${userId}, ${versionId}, ${"series_slice"}, ${studyId}, ${seriesId},
        ${null}, ${null}, ${lesionSliceIndex(ex)},
        ${"SYNTHETIC image anchor: slice through the generated lesion centre. Opening it regenerates the same DICOM bytes."},
        ${lesionSopInstanceUid(ex)}, ${"dicom_lps"}, ${JSON.stringify(centroid)}, ${"spatially_anchored"}, ${"needs_review"},
        ${`synthetic-series:${ex.key}`}
      )`;
  }
  await sql`update profiles set active_patient_id = ${patientId} where user_id = ${userId}`;
  await writeAuditEvent(sql, userId, "seed_reprotrace_demo", "patient", patientId,
    "Synthetic ReproTrace demo patient loaded. No correspondence was seeded; run Recompute to compute it.");
  return { ok: true, patientId, created: true };
}

/**
 * Runs the existing moment-based rigid registration (registerVolumes) on the two regenerated synthetic
 * volumes, converts the image-space transform to DICOM LPS (both demo series use identity orientation),
 * and stores it through the normal registration path. The quality metrics are the algorithm's own.
 */
export async function executeRegisterReproTraceDemo(sql: Sql, rawUserId: string, patientId: string) {
  const auth = await requireVerifiedClinicianOrAdmin(sql, rawUserId, "registering the synthetic demo series");
  await requirePatientRecordAccess(sql, auth.userId, patientId, "registering demo series", "add_annotations");
  const [ex1, ex2] = DEMO_EXAMS;
  const owner = patientId.slice(0, patientId.length - DEMO_PATIENT_KEY.length - 1);
  if (patientId !== kid(owner, DEMO_PATIENT_KEY)) throw new Error("Automatic registration is only wired for the synthetic demo patient.");
  const fixed = buildDemoVolume(ex1);
  const moving = buildDemoVolume(ex2);
  const result = registerVolumes(fixed, moving);
  const t = result.transform;
  const o1 = ex1.spec.originMm;
  const o2 = ex2.spec.originMm;
  const lpsMatrix = toMatrix4x4({
    translationMm: [0, 0, 0],
    rotation: t.rotation,
    centerOfRotationMm: [t.centerOfRotationMm![0] + o1[0], t.centerOfRotationMm![1] + o1[1], t.centerOfRotationMm![2] + o1[2]],
    movingCentroidMm: [t.movingCentroidMm![0] + o2[0], t.movingCentroidMm![1] + o2[1], t.movingCentroidMm![2] + o2[2]],
  });
  const saved = await executeSaveVolumeRegistration(sql, auth.userId, {
    patientId,
    fixedSeriesId: kid(owner, ex1.seriesKey),
    movingSeriesId: kid(owner, ex2.seriesKey),
    method: "ncc_moments_3d",
    matrix: lpsMatrix,
    nccScore: Number.isFinite(result.ncc) ? result.ncc : 0,
    residualMm: Number.isFinite(result.residualMm) ? result.residualMm : 999,
    status: result.status,
  });
  return { ...saved, ncc: result.ncc, residualMm: result.residualMm, notes: result.notes };
}
