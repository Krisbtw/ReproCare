/**
 * Clinician decisions on extracted report observations (ReproTrace Requirement 1).
 * Never merges findings, never invents coordinates, never auto-selects a candidate.
 */
import type { Sql } from "../db.ts";
import { extractReport, quoteMatches, type Extraction } from "./extract.ts";
import {
  assessReportObservation,
  observationFromExtraction,
  type CandidateAssessment,
  type CandidateVersion,
} from "./candidates.ts";
import { resolvePatientAccessForReportAction } from "./store.ts";

export type ObservationDecision = "link_existing" | "create_provisional" | "leave_unlinked";
export type LinkStatus = "report_only" | "anatomically_linked" | "spatially_anchored";

export type ResolveObservationInput = {
  reportId: string;
  observationIndex: number;
  decision: ObservationDecision;
  targetVersionId?: string | null;
  note: string;
};

/** Latest version of each same-patient finding, as scoring candidates. */
export async function loadCandidateVersions(
  sql: Sql,
  ownerUserId: string,
  patientId: string,
): Promise<CandidateVersion[]> {
  const rows = await sql<{
    id: string;
    finding_id: string;
    version_no: number;
    study_id: string;
    location_label: string;
    figo: string | null;
    longest_mm: number | null;
    axes_mm: string | null;
    modality: string | null;
    observed_on: string;
    code: string;
    structure: string;
    organ: string;
  }>`
    select fv.id, fv.finding_id, fv.version_no, fv.study_id, fv.location_label, fv.figo, fv.longest_mm,
           fv.axes_mm, fv.modality, fv.observed_on::text as observed_on, f.code, f.structure, f.organ
    from finding_versions fv join findings f on f.id = fv.finding_id
    where f.patient_id = ${patientId} and f.user_id = ${ownerUserId}
    order by fv.version_no desc
  `;
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (!latest.has(r.finding_id)) latest.set(r.finding_id, r);
  return [...latest.values()].map((v) => ({
    versionId: v.id,
    findingId: v.finding_id,
    findingCode: v.code,
    patientId,
    structure: v.structure,
    organ: v.organ,
    locationLabel: v.location_label,
    figo: v.figo,
    studyId: v.study_id,
    studyDate: v.observed_on,
    modality: v.modality,
    versionNo: Number(v.version_no),
    longestMm: v.longest_mm != null ? Number(v.longest_mm) : null,
    axesMm: v.axes_mm ? (JSON.parse(v.axes_mm) as [number, number, number]) : null,
    volumeMm3: null,
  }));
}

export async function resolveReportObservation(
  sql: Sql,
  callerUserId: string,
  input: ResolveObservationInput,
): Promise<{
  id: string;
  decision: ObservationDecision;
  assessment: CandidateAssessment;
  findingId: string | null;
  findingVersionId: string | null;
  evidenceLinkId: string | null;
  linkStatus: LinkStatus | null;
}> {
  const note = String(input.note ?? "").trim().slice(0, 600);
  if (note.length < 4) throw new Error("A review note (at least 4 characters) is required.");
  if (!["link_existing", "create_provisional", "leave_unlinked"].includes(input.decision)) {
    throw new Error("Unknown decision.");
  }

  const rRows = await sql<{
    id: string;
    body: string;
    study_id: string;
    patient_id: string;
    report_date: string;
    modality: string;
  }>`
    select r.id, r.body, r.study_id, s.patient_id, r.report_date::text as report_date, s.modality
    from reports r join studies s on s.id = r.study_id where r.id = ${input.reportId}
  `;
  const report = rRows[0];
  if (!report) throw new Error("Report not found.");
  const { patientOwnerUserId } = await resolvePatientAccessForReportAction(
    sql,
    callerUserId,
    report.patient_id,
    "Linking report evidence",
    "add_annotations",
  );

  const extRows = await sql<{ id: string; extraction: string }>`
    select id, extraction from report_extractions where report_id = ${input.reportId} order by created_at desc limit 1
  `.catch(() => []);
  const extraction: Extraction = extRows[0]
    ? (JSON.parse(extRows[0].extraction) as Extraction)
    : extractReport(report.body);
  const extractionId = extRows[0]?.id ?? null;
  const obs = observationFromExtraction(extraction, input.observationIndex);
  if (!obs) throw new Error("That extracted observation does not exist.");
  if (!quoteMatches(report.body, obs.sentence.start, obs.sentence.end, obs.sentence.text)) {
    throw new Error("The source sentence does not match the stored report text. Nothing was linked.");
  }

  const candidates = await loadCandidateVersions(sql, patientOwnerUserId, report.patient_id);
  const assessment = assessReportObservation(obs, candidates, {
    patientId: report.patient_id,
    reportStudyId: report.study_id,
    reportDate: report.report_date,
  });

  let findingId: string | null = null;
  let findingVersionId: string | null = null;
  let evidenceLinkId: string | null = null;
  let linkStatus: LinkStatus | null = null;

  if (input.decision === "link_existing") {
    if (obs.negated) throw new Error("The report negates this finding; it cannot be linked as evidence.");
    const chosen = assessment.candidates.find((c) => c.versionId === input.targetVersionId);
    if (!chosen) throw new Error("Choose one of this record's candidate findings.");
    if (!chosen.compatible) {
      throw new Error(`Not linked: ${chosen.conflicts.join("; ")}. Create a provisional finding instead.`);
    }
    findingVersionId = chosen.versionId;
    findingId = chosen.findingId;
  } else if (input.decision === "create_provisional") {
    if (obs.negated) throw new Error("The report negates this finding; no provisional finding is created.");
    const f = extraction.findings[input.observationIndex];
    findingId = crypto.randomUUID();
    const countRows = await sql<{ c: number }>`
      select count(*)::int as c from findings where patient_id = ${report.patient_id}
    `;
    const code = `R${Number(countRows[0]?.c ?? 0) + 1}`;
    await sql`insert into findings (id, user_id, patient_id, code, structure, organ, pathway)
      values (${findingId}, ${patientOwnerUserId}, ${report.patient_id}, ${code}, ${f.structure}, ${f.organ}, ${f.pathway})`;
    const lengths = obs.measurements.filter((m) => m.dimension === "length").flatMap((m) => m.valuesNormalised);
    const axes =
      obs.measurements.find((m) => m.dimension === "length" && m.valuesNormalised.length === 3)?.valuesNormalised ??
      null;
    const longest = lengths.length ? Math.max(...lengths) : null;
    findingVersionId = crypto.randomUUID();
    await sql`insert into finding_versions (
        id, user_id, finding_id, version_no, previous_version_id, study_id, observed_on, location_label, figo,
        centroid_mm, axes_mm, longest_mm, measurement_basis, frame, segmentation_source, model_id, quality, modality,
        report_longest_mm, change_reason
      ) values (
        ${findingVersionId}, ${patientOwnerUserId}, ${findingId}, 1, ${null}, ${report.study_id},
        ${extraction.examDate ?? report.report_date.slice(0, 10)},
        ${obs.location ?? (obs.laterality ? `${obs.laterality} ${obs.organ}` : obs.organ)}, ${obs.figo},
        ${null}, ${axes ? JSON.stringify(axes) : null}, ${longest},
        ${"report-stated measurement (provisional, no imaging anchor)"}, ${"unavailable"},
        ${"report_extracted_provisional"}, ${null}, ${"unknown"}, ${extraction.modality ?? report.modality},
        ${longest}, ${`Provisional finding created by clinician from report ${input.reportId}: ${note}`}
      )`;
  }

  if (findingVersionId) {
    const anchorRows = await sql<{ centroid_mm: string | null; frame: string; series_id: string | null }>`
      select centroid_mm, frame, series_id from finding_versions where id = ${findingVersionId}
    `.catch(() => []);
    const a = anchorRows[0];
    linkStatus =
      a && a.centroid_mm && (a.frame === "dicom_lps" || a.frame === "image_registered") && a.series_id
        ? "spatially_anchored"
        : input.decision === "create_provisional"
          ? "report_only"
          : "anatomically_linked";
    evidenceLinkId = crypto.randomUUID();
    const linkNote = `Clinician ${input.decision === "link_existing" ? "confirmed match" : "created provisional finding"}: ${note}`;
    try {
      await sql`insert into evidence_links (
          id, user_id, finding_version_id, kind, study_id, series_id, report_id, quote, slice_index, note,
          quote_start, quote_end, extraction_id, observation_index, page_number, extraction_provenance,
          link_status, review_status, reviewed_by, reviewed_at, coordinate_frame
        ) values (
          ${evidenceLinkId}, ${patientOwnerUserId}, ${findingVersionId}, ${"report_quote"}, ${report.study_id}, ${null},
          ${report.id}, ${obs.sentence.text}, ${null}, ${linkNote}, ${obs.sentence.start}, ${obs.sentence.end},
          ${extractionId}, ${input.observationIndex}, ${obs.pageNumber}, ${obs.provenance},
          ${linkStatus}, ${"clinician_verified"}, ${callerUserId}, now(), ${a?.frame ?? null}
        )`;
    } catch {
      await sql`insert into evidence_links (
          id, user_id, finding_version_id, kind, study_id, series_id, report_id, quote, slice_index, note, quote_start, quote_end
        ) values (
          ${evidenceLinkId}, ${patientOwnerUserId}, ${findingVersionId}, ${"report_quote"}, ${report.study_id}, ${null},
          ${report.id}, ${obs.sentence.text}, ${null}, ${linkNote}, ${obs.sentence.start}, ${obs.sentence.end}
        )`;
    }
  }

  const id = crypto.randomUUID();
  const decisionDb =
    input.decision === "link_existing"
      ? "linked_existing"
      : input.decision === "create_provisional"
        ? "created_provisional"
        : "left_unlinked";
  await sql`insert into report_observation_links (
      id, user_id, patient_id, report_id, extraction_id, observation_index, decision, candidate_state, candidates_json,
      finding_id, finding_version_id, evidence_link_id, quote, quote_start, quote_end, page_number, reviewer_user_id, note
    ) values (
      ${id}, ${patientOwnerUserId}, ${report.patient_id}, ${report.id}, ${extractionId}, ${input.observationIndex},
      ${decisionDb}, ${assessment.state}, ${JSON.stringify(assessment.candidates)},
      ${findingId}, ${findingVersionId}, ${evidenceLinkId}, ${obs.sentence.text}, ${obs.sentence.start},
      ${obs.sentence.end}, ${obs.pageNumber}, ${callerUserId}, ${note}
    )`.catch(() => null);

  await sql`insert into audit_events (id, user_id, action, entity_type, entity_id, detail)
    values (${crypto.randomUUID()}, ${callerUserId}, ${`report_observation_${decisionDb}`}, 'report', ${report.id},
      ${`Observation #${input.observationIndex} (${obs.structure}) ${decisionDb}; candidate state ${assessment.state}. No findings merged.`})`.catch(
    () => null,
  );

  return { id, decision: input.decision, assessment, findingId, findingVersionId, evidenceLinkId, linkStatus };
}
