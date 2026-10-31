import type { Sql } from "../db.ts";

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
  newStudy?: {
    patientId: string;
    modality?: string;
    studyDate?: string;
    description?: string;
    accession?: string;
    sourceNote?: string;
  };
  newSeries?: {
    seriesNumber?: number;
    description?: string;
    plane?: string;
    sliceCount?: number;
    pixelSpacingMm?: string;
    sliceThicknessMm?: number;
  };
};

const num = (v: unknown) => Number(v ?? 0);

/** Appends version N+1 for a finding from a Volume lab measurement. Never updates or deletes an earlier row. */
export async function insertLabVersion(sql: Sql, userId: string, data: LabVersionInput): Promise<string> {
  const found = await sql<Record<string, unknown>>`select * from finding_versions
    where finding_id = ${data.findingId} and user_id = ${userId} order by version_no desc limit 1`;
  const current = found[0];
  if (!current) throw new Error("Finding not found.");

  let targetStudyId = current.study_id as string;
  let targetSeriesId = data.seriesId ?? null;
  let targetObservedOn = current.observed_on as string;

  if (data.newStudy) {
    const patientCheck = await sql`select id from patients where id = ${data.newStudy.patientId} and user_id = ${userId}`;
    if (!patientCheck.length) throw new Error("Patient not found for new study.");
    targetStudyId = crypto.randomUUID();
    targetObservedOn = data.newStudy.studyDate ?? new Date().toISOString().slice(0, 10);
    await sql`insert into studies (id, user_id, patient_id, modality, study_date, description, accession, synthetic, source_note)
      values (
        ${targetStudyId},
        ${userId},
        ${data.newStudy.patientId},
        ${data.newStudy.modality ?? "MR"},
        ${targetObservedOn},
        ${data.newStudy.description ?? "Uploaded DICOM study"},
        ${data.newStudy.accession ?? "ACC-" + Date.now().toString().slice(-6)},
        false,
        ${data.newStudy.sourceNote ?? "Uploaded in Volume Lab"}
      )`;
    if (data.newSeries) {
      targetSeriesId = crypto.randomUUID();
      await sql`insert into series (id, user_id, study_id, series_number, description, plane, slice_count, pixel_spacing_mm, slice_thickness_mm)
        values (
          ${targetSeriesId},
          ${userId},
          ${targetStudyId},
          ${data.newSeries.seriesNumber ?? 1},
          ${data.newSeries.description ?? "DICOM Series"},
          ${data.newSeries.plane ?? null},
          ${data.newSeries.sliceCount ?? null},
          ${data.newSeries.pixelSpacingMm ?? null},
          ${data.newSeries.sliceThicknessMm ?? null}
        )`;
    }
  } else if (data.studyId) {
    const studyCheck = await sql<{ id: string; study_date: string }>`select id, study_date from studies where id = ${data.studyId} and user_id = ${userId}`;
    if (studyCheck.length > 0) {
      targetStudyId = studyCheck[0].id;
      targetObservedOn = data.observedOn ?? studyCheck[0].study_date;
    }
  }

  const id = crypto.randomUUID();
  const centroidJson = data.centroidMm ? JSON.stringify(data.centroidMm) : null;
  const frameVal = data.frame ?? (data.centroidMm ? "dicom_lps" : "unavailable");

  await sql`insert into finding_versions (
    id, user_id, finding_id, version_no, previous_version_id, study_id, observed_on, location_label, figo,
    centroid_mm, axes_mm, longest_mm, measurement_basis, frame, segmentation_source, model_id, quality, modality,
    report_longest_mm, change_reason
  ) values (
    ${id}, ${userId}, ${data.findingId}, ${num(current.version_no) + 1}, ${current.id as string},
    ${targetStudyId}, ${targetObservedOn}, ${current.location_label as string}, ${current.figo as string | null},
    ${centroidJson}, ${JSON.stringify(data.axes)}, ${data.longest}, ${"principal-axis extents of a seeded mask (not a caliper plane)"},
    ${frameVal}, ${"classical_region_growing"}, ${null}, ${"adequate"}, ${current.modality as string},
    ${null}, ${"Volume lab: " + data.reason}
  )`;
  await sql`insert into evidence_links (id, user_id, finding_version_id, kind, study_id, series_id, report_id, quote, slice_index, note)
    values (${crypto.randomUUID()}, ${userId}, ${id}, ${"lab_segmentation"}, ${targetStudyId}, ${targetSeriesId}, ${null}, ${null}, ${data.sliceIndex}, ${data.evidenceNote})`;
  return id;
}
