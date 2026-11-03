/**
 * Source-image retrieval for evidence navigation (Requirement 1.4).
 *
 * Resolves finding version -> study -> series -> stored DICOM instances (imaging_objects) and returns the
 * original bytes through the existing authorized, SHA-256-verified, audited storage path
 * (listImagingArtifacts / getImagingArtifact). No URL (signed or public) is handed to the browser.
 * When the series has no stored instances, the result says so instead of regenerating or guessing.
 */
import type { Sql } from "../db.ts";
import { getImagingArtifact, listImagingArtifacts, storeImagingArtifact } from "../imaging/storage.ts";
import { requirePatientRecordAccess } from "./server.backend.ts";

/** Browser-side cap: matches Volume Lab's own limits. */
const MAX_INSTANCES = 600;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

export type SourceSeriesResult = {
  available: boolean;
  reason: string | null;
  patientId: string;
  studyId: string | null;
  seriesId: string | null;
  sliceIndex: number | null;
  sopInstanceUid: string | null;
  frameNumber: number | null;
  centroidLps: number[] | null;
  coordinateFrame: string | null;
  /** Index of the anchored SOP instance among the returned files (ordered by instance number), when known. */
  anchorFileIndex: number | null;
  files: { name: string; sopInstanceUid: string | null; instanceNumber: number | null; sha256: string; base64: string }[];
  integrity: { verified: number; failed: number };
};

const unavailable = (base: Omit<SourceSeriesResult, "available" | "reason" | "files" | "anchorFileIndex" | "integrity">, reason: string): SourceSeriesResult => ({
  ...base,
  available: false,
  reason,
  files: [],
  anchorFileIndex: null,
  integrity: { verified: 0, failed: 0 },
});

function parseCentroid(v: unknown): number[] | null {
  if (v == null) return null;
  try {
    const a = typeof v === "string" ? JSON.parse(v) : v;
    return Array.isArray(a) && a.length === 3 && a.every((n) => Number.isFinite(Number(n))) ? a.map(Number) : null;
  } catch {
    return null;
  }
}

/**
 * Loads the original DICOM instances behind a finding version's image anchor (or an explicit series).
 * Requires the caller to hold view_imaging access to the patient; every object download is
 * integrity-checked and audited by the storage layer.
 */
export async function executeLoadSourceSeries(
  sql: Sql,
  userId: string,
  input: { patientId: string; findingVersionId?: string | null; seriesId?: string | null },
): Promise<SourceSeriesResult> {
  const access = await requirePatientRecordAccess(sql, userId, input.patientId, "opening source imaging", "view_imaging");
  const actor = (access as { userId?: string }).userId ?? userId;

  let studyId: string | null = null;
  let seriesId: string | null = input.seriesId ?? null;
  let sliceIndex: number | null = null;
  let sopInstanceUid: string | null = null;
  let frameNumber: number | null = null;
  let centroidLps: number[] | null = null;
  let coordinateFrame: string | null = null;

  if (input.findingVersionId) {
    const v = (await sql<Record<string, unknown>>`
      select fv.id, fv.study_id, fv.series_id, fv.centroid_mm, fv.frame, f.patient_id
      from finding_versions fv join findings f on f.id = fv.finding_id where fv.id = ${input.findingVersionId}`)[0];
    if (!v || String(v.patient_id) !== input.patientId) throw new Error("Finding version not found for this patient.");
    studyId = (v.study_id as string) ?? null;
    seriesId = seriesId ?? ((v.series_id as string) ?? null);
    coordinateFrame = (v.frame as string) ?? null;
    if (coordinateFrame === "dicom_lps") centroidLps = parseCentroid(v.centroid_mm);
    let anchors: Record<string, unknown>[] = [];
    try {
      anchors = await sql<Record<string, unknown>>`
        select study_id, series_id, slice_index, sop_instance_uid, frame_number, coordinate_frame, centroid_lps_json
        from evidence_links where finding_version_id = ${input.findingVersionId} and series_id is not null
        order by created_at desc`;
    } catch {
      anchors = await sql<Record<string, unknown>>`
        select study_id, series_id, slice_index from evidence_links
        where finding_version_id = ${input.findingVersionId} and series_id is not null`;
    }
    const a = anchors.find((r) => !input.seriesId || r.series_id === input.seriesId) ?? null;
    if (a) {
      seriesId = seriesId ?? (a.series_id as string);
      studyId = (a.study_id as string) ?? studyId;
      sliceIndex = a.slice_index == null ? null : Number(a.slice_index);
      sopInstanceUid = (a.sop_instance_uid as string) ?? null;
      frameNumber = a.frame_number == null ? null : Number(a.frame_number);
      if (a.coordinate_frame) coordinateFrame = String(a.coordinate_frame);
      centroidLps = parseCentroid(a.centroid_lps_json) ?? centroidLps;
    }
  }

  const base = { patientId: input.patientId, studyId, seriesId, sliceIndex, sopInstanceUid, frameNumber, centroidLps, coordinateFrame };
  if (!seriesId) return unavailable(base, "No source series is recorded for this finding, so there is no original image to open.");

  const series = (await sql<{ study_id: string; patient_id: string }>`
    select s.study_id, st.patient_id from series s join studies st on st.id = s.study_id where s.id = ${seriesId}`)[0];
  if (!series || String(series.patient_id) !== input.patientId) throw new Error("Series not found for this patient.");
  base.studyId = base.studyId ?? series.study_id;

  const objects = (await listImagingArtifacts(sql, actor, { patientId: input.patientId, seriesId, kind: "dicom", includePurged: false }))
    .filter((o) => o.status !== "corrupted" && o.status !== "missing");
  if (objects.length === 0) {
    return unavailable(base, "No original DICOM instances are stored for this series (pixels were never uploaded to imaging storage).");
  }
  // Latest version per SOP instance, ordered by instance number.
  const bySop = new Map<string, (typeof objects)[number]>();
  for (const o of objects) {
    const key = o.sopInstanceUid ?? o.id;
    const prev = bySop.get(key);
    if (!prev || o.version > prev.version) bySop.set(key, o);
  }
  const chosen = [...bySop.values()].sort((a, b) => (a.instanceNumber ?? 0) - (b.instanceNumber ?? 0));
  if (chosen.length > MAX_INSTANCES) return unavailable(base, `Series has ${chosen.length} stored instances; more than the viewer loads at once (${MAX_INSTANCES}).`);
  const total = chosen.reduce((n, o) => n + o.bytes, 0);
  if (total > MAX_TOTAL_BYTES) return unavailable(base, `Series is ${(total / 1e6).toFixed(0)} MB; more than the viewer holds in the browser.`);

  const files: SourceSeriesResult["files"] = [];
  let failed = 0;
  for (const o of chosen) {
    try {
      const got = await getImagingArtifact(sql, actor, o.id, true);
      if (!got.data) throw new Error("no data");
      files.push({
        name: o.originalFilename || `${o.id}.dcm`,
        sopInstanceUid: o.sopInstanceUid,
        instanceNumber: o.instanceNumber,
        sha256: got.integrity.actualSha256 ?? o.sha256,
        base64: Buffer.from(got.data).toString("base64"),
      });
    } catch {
      failed += 1;
    }
  }
  if (files.length === 0) return { ...unavailable(base, "Stored instances failed integrity verification or are missing from storage."), integrity: { verified: 0, failed } };
  const anchorFileIndex = sopInstanceUid ? files.findIndex((f) => f.sopInstanceUid === sopInstanceUid) : -1;
  return {
    ...base,
    available: true,
    reason: failed ? `${failed} instance(s) failed integrity verification and were not loaded.` : null,
    files,
    anchorFileIndex: anchorFileIndex >= 0 ? anchorFileIndex : null,
    integrity: { verified: files.length, failed },
  };
}

/** Stores generated synthetic DICOM instances as ordinary imaging objects (same path as uploads). */
export async function storeSeriesInstances(
  sql: Sql,
  userId: string,
  input: { patientId: string; studyId: string; seriesId: string; files: { name: string; bytes: Uint8Array }[]; sopUid: (i: number) => string; note: string },
): Promise<{ stored: number; error: string | null }> {
  let stored = 0;
  try {
    for (let i = 0; i < input.files.length; i += 1) {
      const f = input.files[i];
      await storeImagingArtifact(sql, {
        userId,
        patientId: input.patientId,
        studyId: input.studyId,
        seriesId: input.seriesId,
        sopInstanceUid: input.sopUid(i),
        instanceNumber: i + 1,
        kind: "dicom",
        fileName: f.name,
        mimeType: "application/dicom",
        data: f.bytes,
        metadata: { synthetic: true, note: input.note },
        deduplicateIfIdentical: true,
      });
      stored += 1;
    }
    return { stored, error: null };
  } catch (e) {
    return { stored, error: e instanceof Error ? e.message : String(e) };
  }
}
