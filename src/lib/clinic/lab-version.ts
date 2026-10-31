import type { Sql } from "../db.ts";

export type LabVersionInput = { findingId: string; axes: [number, number, number]; longest: number; sliceIndex: number; reason: string; evidenceNote: string };

const num = (v: unknown) => Number(v ?? 0);

/** Appends version N+1 for a finding from a Volume lab measurement. Never updates or deletes an earlier row. */
export async function insertLabVersion(sql: Sql, userId: string, data: LabVersionInput): Promise<string> {
  const found = await sql<Record<string, unknown>>`select * from finding_versions
    where finding_id = ${data.findingId} and user_id = ${userId} order by version_no desc limit 1`;
  const current = found[0];
  if (!current) throw new Error("Finding not found.");
  const id = crypto.randomUUID();
  await sql`insert into finding_versions (
    id, user_id, finding_id, version_no, previous_version_id, study_id, observed_on, location_label, figo,
    centroid_mm, axes_mm, longest_mm, measurement_basis, frame, segmentation_source, model_id, quality, modality,
    report_longest_mm, change_reason
  ) values (
    ${id}, ${userId}, ${data.findingId}, ${num(current.version_no) + 1}, ${current.id as string},
    ${current.study_id as string}, ${current.observed_on as string}, ${current.location_label as string}, ${current.figo as string | null},
    ${null}, ${JSON.stringify(data.axes)}, ${data.longest}, ${"principal-axis extents of a seeded mask (not a caliper plane)"},
    ${"unavailable"}, ${"classical_region_growing"}, ${null}, ${"unknown"}, ${current.modality as string},
    ${null}, ${"Volume lab: " + data.reason}
  )`;
  await sql`insert into evidence_links (id, user_id, finding_version_id, kind, study_id, series_id, report_id, quote, slice_index, note)
    values (${crypto.randomUUID()}, ${userId}, ${id}, ${"lab_segmentation"}, ${null}, ${null}, ${null}, ${null}, ${data.sliceIndex}, ${data.evidenceNote})`;
  return id;
}
