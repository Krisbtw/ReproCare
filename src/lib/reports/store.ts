/**
 * Database side of report ingestion and report-to-finding evidence links. Takes an injected Sql so it can be
 * tested on embedded Postgres (PGlite) without the server runtime.
 */
import type { Sql } from "../db.ts";
import { deidentify } from "./deidentify.ts";
import { extractReport, quoteMatches, EXTRACTOR_ID, type Extraction } from "./extract.ts";
import { MAX_REPORT_TEXT_CHARS, type ReportFileKind } from "./text.ts";

export type IngestInput = {
  patientId: string;
  /** Attach to an existing study, or create one from `newStudy`. Exactly one must be given. */
  studyId: string | null;
  newStudy: { modality: string; date: string; description: string } | null;
  fileName: string;
  fileKind: ReportFileKind;
  sha256: string;
  /** De-identified text the person confirmed in the browser. De-identified again here. */
  text: string;
  warnings: string[];
};

export type IngestResult = { reportId: string; studyId: string; extractionId: string; extraction: Extraction; redactionsAddedByServer: number };

const MODALITIES = new Set(["MR", "US", "CT", "OT"]);

function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function validateIngest(input: IngestInput): IngestInput {
  if (!input.patientId) throw new Error("Choose a record.");
  if (!["txt", "docx", "pdf"].includes(input.fileKind)) throw new Error("Only TXT, DOCX and PDF reports are accepted.");
  if (!/^[0-9a-f]{64}$/.test(input.sha256)) throw new Error("File fingerprint is missing or malformed.");
  const text = String(input.text ?? "").trim();
  if (text.length < 20) throw new Error("The report text is too short to store.");
  if (text.length > MAX_REPORT_TEXT_CHARS) throw new Error(`The report text is longer than ${MAX_REPORT_TEXT_CHARS} characters.`);
  if ((input.studyId ? 1 : 0) + (input.newStudy ? 1 : 0) !== 1) throw new Error("Attach the report to one existing study, or describe a new one.");
  if (input.newStudy) {
    if (!MODALITIES.has(input.newStudy.modality)) throw new Error("Modality must be MR, US, CT or OT.");
    if (!isIsoDate(input.newStudy.date)) throw new Error("Study date must be a real date (YYYY-MM-DD).");
  }
  return {
    ...input,
    fileName: String(input.fileName).replace(/[^\w .\-()]/g, "_").slice(0, 160),
    text,
    warnings: (input.warnings ?? []).slice(0, 12).map((w) => String(w).slice(0, 240)),
    newStudy: input.newStudy ? { ...input.newStudy, description: String(input.newStudy.description || "Study created from an uploaded report").slice(0, 160) } : null,
  };
}

export async function ingestReport(sql: Sql, userId: string, raw: IngestInput): Promise<IngestResult> {
  const input = validateIngest(raw);
  const owned = await sql<{ id: string }>`select id from patients where id = ${input.patientId} and user_id = ${userId}`;
  if (!owned.length) throw new Error("Record not found.");

  // Server-side de-identification pass. Already-removed tags are left as they are.
  const deid = deidentify(input.text);
  const extraction = extractReport(deid.text);

  let studyId = input.studyId;
  if (studyId) {
    const s = await sql<{ id: string }>`select id from studies where id = ${studyId} and user_id = ${userId} and patient_id = ${input.patientId}`;
    if (!s.length) throw new Error("That study is not part of this record.");
  } else {
    const ns = input.newStudy!;
    studyId = crypto.randomUUID();
    await sql`insert into studies (id, user_id, patient_id, modality, study_date, description, accession, synthetic, source_note)
      values (${studyId}, ${userId}, ${input.patientId}, ${ns.modality}, ${ns.date}, ${ns.description}, ${"uploaded-report"}, ${false},
        ${"Study entry created from an uploaded report. No images are attached to it."})`;
  }
  const date = extraction.examDate ?? input.newStudy?.date ?? new Date().toISOString().slice(0, 10);
  const reportId = crypto.randomUUID();
  await sql`insert into reports (id, user_id, study_id, report_date, author_role, body, synthetic, source_kind)
    values (${reportId}, ${userId}, ${studyId}, ${date}, ${"uploaded report (author not stored)"}, ${deid.text}, ${false}, ${"uploaded"})`;
  const extractionId = crypto.randomUUID();
  const kinds = [...new Set(deid.redactions.map((r) => r.kind))];
  await sql`insert into report_extractions (id, user_id, report_id, file_name, file_kind, content_sha256, deid_method, redaction_count, redaction_kinds, extractor, extraction, warnings)
    values (${extractionId}, ${userId}, ${reportId}, ${input.fileName}, ${input.fileKind}, ${input.sha256}, ${deid.method}, ${deid.redactions.length},
      ${JSON.stringify(kinds)}, ${EXTRACTOR_ID}, ${JSON.stringify(extraction)}, ${JSON.stringify(input.warnings)})`;
  return { reportId, studyId, extractionId, extraction, redactionsAddedByServer: deid.redactions.length };
}

export type QuoteLinkInput = { findingVersionId: string; reportId: string; start: number; end: number; quote: string; note: string };

/**
 * Appends a report quote as evidence on one finding version. The quote must reproduce exactly from the stored
 * report body at the given offsets, and the report must belong to the same patient as the finding.
 * It never edits the version itself.
 */
export async function linkReportQuote(sql: Sql, userId: string, input: QuoteLinkInput): Promise<string> {
  const note = String(input.note ?? "").trim().slice(0, 400);
  const v = await sql<{ id: string; patient_id: string }>`
    select fv.id, f.patient_id from finding_versions fv join findings f on f.id = fv.finding_id
    where fv.id = ${input.findingVersionId} and fv.user_id = ${userId}`;
  if (!v[0]) throw new Error("Finding version not found.");
  const r = await sql<{ id: string; body: string; study_id: string; patient_id: string }>`
    select r.id, r.body, r.study_id, s.patient_id from reports r join studies s on s.id = r.study_id
    where r.id = ${input.reportId} and r.user_id = ${userId}`;
  if (!r[0]) throw new Error("Report not found.");
  if (r[0].patient_id !== v[0].patient_id) throw new Error("The report and the finding belong to different records. Not linked.");
  if (!quoteMatches(r[0].body, input.start, input.end, input.quote)) {
    throw new Error("The quote does not match the stored report text at those positions. Nothing was linked.");
  }
  const id = crypto.randomUUID();
  await sql`insert into evidence_links (id, user_id, finding_version_id, kind, study_id, series_id, report_id, quote, slice_index, note, quote_start, quote_end)
    values (${id}, ${userId}, ${input.findingVersionId}, ${"report_quote"}, ${r[0].study_id}, ${null}, ${r[0].id}, ${input.quote}, ${null},
      ${note || "Quote linked by a clinician from an uploaded report. Offsets verified against the stored text."}, ${input.start}, ${input.end})`;
  return id;
}
