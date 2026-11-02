/**
 * Database side of report ingestion, persistent original report storage,
 * report-to-imaging reconciliation, and clinician extraction review (Sprint 4 Task 2).
 */
import type { Sql } from "../db.ts";
import { deidentify } from "./deidentify.ts";
import {
  extractReport,
  longestMm,
  quoteMatches,
  EXTRACTOR_ID,
  type Extraction,
} from "./extract.ts";
import {
  MAX_REPORT_TEXT_CHARS,
  type ReportExtractionMethod,
  type ReportFileKind,
} from "./text.ts";
import type { PdfPageExtraction } from "./ocr.ts";
import { storeImagingArtifact } from "../imaging/storage.ts";
import {
  evaluateClinicianConsentForPatient,
  type ClinicianPermission,
} from "../clinic/collaboration.ts";

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
  /** Optional base64-encoded or binary original report file to persist in Sprint 3 storage */
  rawFileBase64?: string | null;
  rawBytesBase64?: string | null;
  rawFileBytes?: Uint8Array | Buffer | null;
  extractionMethod?: ReportExtractionMethod;
  pageCount?: number;
  pages?: PdfPageExtraction[];
  ocrUsed?: boolean;
};

export type IngestResult = {
  reportId: string;
  studyId: string;
  extractionId: string;
  reportObjectId: string | null;
  extraction: Extraction;
  redactionsAddedByServer: number;
  reconciliationDiscrepancies: ReportImagingDiscrepancy[];
};

export interface ReportImagingDiscrepancy {
  id: string;
  category: "reporting_inconsistency" | "report_vs_image";
  summary: string;
  detail: string;
  reportId: string;
  findingVersionId: string | null;
  reportedLongestMm: number | null;
  imagingLongestMm: number | null;
  reportedVolumeMm3: number | null;
  imagingVolumeMm3: number | null;
}

const MODALITIES = new Set(["MR", "US", "CT", "OT"]);

function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

async function resolvePatientAccessForReportAction(
  sql: Sql,
  userId: string,
  patientId: string,
  actionLabel: string,
  requiredPermission: ClinicianPermission,
): Promise<{ patientOwnerUserId: string }> {
  if (!userId || typeof userId !== "string" || !userId.trim()) {
    throw new Error("Unauthorized: Authentication is required.");
  }
  const uid = userId.trim();

  const patientRows = await sql<{ id: string; user_id: string }>`
    select id, user_id from patients where id = ${patientId}
  `;
  const patient = patientRows[0];
  if (!patient) {
    throw new Error("Record not found.");
  }

  const profileRows = await sql<{ role: string }>`
    select role from profiles where user_id = ${uid}
  `;

  if (profileRows.length === 0) {
    const anyProfiles = await sql<{ n: number }>`select 1 as n from profiles limit 1`;
    if (anyProfiles.length > 0 || patient.user_id !== uid) {
      throw new Error("Record not found: Unauthorized (user profile not found; access denied).");
    }
    return { patientOwnerUserId: patient.user_id };
  }

  const role = profileRows[0].role;

  // Check clinician verification
  let isVerifiedClinician = false;
  if (role === "clinician") {
    const verifRows = await sql<{ status: string; licence_no: string; registry: string }>`
      select status, licence_no, registry
      from clinician_verifications
      where user_id = ${uid}
      order by coalesce(decided_at, requested_at) desc, requested_at desc, id desc
      limit 1
    `.catch(() => []);
    const v = verifRows[0];
    isVerifiedClinician =
      Boolean(v) &&
      (v.status === "verified" || v.status === "approved") &&
      String(v.licence_no ?? "").trim().length > 0 &&
      String(v.registry ?? "").trim().length > 0;
  }

  if (patient.user_id !== uid) {
    // Cross-user access: requires verified clinician AND active consent with requiredPermission.
    // Administrators do NOT automatically receive unrestricted access to other users' medical records.
    if (!isVerifiedClinician) {
      throw new Error(
        `Unauthorized: ${actionLabel} on a shared patient record requires verified clinician status and active patient consent.`,
      );
    }
    const consentEval = await evaluateClinicianConsentForPatient(
      sql,
      uid,
      patientId,
      requiredPermission,
      actionLabel.toLowerCase().replace(/\s+/g, "_"),
    );
    if (!consentEval.allowed) {
      throw new Error(`Unauthorized: ${consentEval.reason}`);
    }
    return { patientOwnerUserId: patient.user_id };
  }

  // Direct owner of the synthetic/workspace record: require verified clinician or admin
  if (role !== "admin" && !isVerifiedClinician) {
    if (role !== "clinician") {
      throw new Error(`Unauthorized: ${actionLabel} is a clinician action.`);
    }
    throw new Error(
      `Unauthorized: Clinician verification is not approved. A role string alone does not authorize ${actionLabel.toLowerCase()}.`,
    );
  }

  return { patientOwnerUserId: patient.user_id };
}

export function validateIngest(input: IngestInput): IngestInput {
  if (!input.patientId) throw new Error("Choose a record.");
  if (!["txt", "docx", "pdf"].includes(input.fileKind))
    throw new Error("Only TXT, DOCX and PDF reports are accepted.");
  if (!/^[0-9a-f]{64}$/.test(input.sha256))
    throw new Error("File fingerprint is missing or malformed.");
  const text = String(input.text ?? "").trim();
  if (text.length < 20) throw new Error("The report text is too short to store.");
  if (text.length > MAX_REPORT_TEXT_CHARS)
    throw new Error(`The report text is longer than ${MAX_REPORT_TEXT_CHARS} characters.`);
  if ((input.studyId ? 1 : 0) + (input.newStudy ? 1 : 0) !== 1)
    throw new Error("Attach the report to one existing study, or describe a new one.");
  if (input.newStudy) {
    if (!MODALITIES.has(input.newStudy.modality))
      throw new Error("Modality must be MR, US, CT or OT.");
    if (!isIsoDate(input.newStudy.date))
      throw new Error("Study date must be a real date (YYYY-MM-DD).");
  }
  return {
    ...input,
    fileName: String(input.fileName).replace(/[^\w .\-()]/g, "_").slice(0, 160),
    text,
    warnings: (input.warnings ?? []).slice(0, 12).map((w) => String(w).slice(0, 240)),
    newStudy: input.newStudy
      ? {
          ...input.newStudy,
          description: String(
            input.newStudy.description || "Study created from an uploaded report",
          ).slice(0, 160),
        }
      : null,
  };
}

/**
 * Compare extracted report measurements against imaging-derived finding_versions on the patient/study
 * and flag discrepancies for clinician review without ever automatically merging findings.
 */
export async function reconcileReportWithImaging(
  sql: Sql,
  ownerUserId: string,
  patientId: string,
  studyId: string,
  reportId: string,
  extraction: Extraction,
): Promise<ReportImagingDiscrepancy[]> {
  const findings = await sql<{ id: string; code: string; structure: string; organ: string }>`
    select id, code, structure, organ from findings where patient_id = ${patientId} and user_id = ${ownerUserId}
  `.catch(() => []);
  if (findings.length === 0) return [];

  const findingIds = new Set(findings.map((f) => f.id));
  const allVersions = await sql<{
    id: string;
    finding_id: string;
    version_no: number;
    study_id: string;
    location_label: string;
    figo: string | null;
    longest_mm: number | null;
    axes_mm: string | null;
    volume_mm3?: number | null;
  }>`
    select id, finding_id, version_no, study_id, location_label, figo, longest_mm, axes_mm
    from finding_versions
    where user_id = ${ownerUserId}
    order by version_no desc
  `.catch(() => []);

  const studyVersions = allVersions.filter(
    (v) => findingIds.has(v.finding_id) && v.study_id === studyId,
  );
  const candidateVersions =
    studyVersions.length > 0
      ? studyVersions
      : allVersions.filter((v) => findingIds.has(v.finding_id));

  // Keep latest version per finding
  const latestByFinding = new Map<string, (typeof candidateVersions)[number]>();
  for (const v of candidateVersions) {
    if (!latestByFinding.has(v.finding_id)) {
      latestByFinding.set(v.finding_id, v);
    }
  }
  const activeVersions = [...latestByFinding.values()];

  const discrepancies: ReportImagingDiscrepancy[] = [];
  const fibroidMeas = extraction.fibroidMeasurements ?? [];

  for (const fm of fibroidMeas) {
    if (fm.negated) continue;
    // Match candidate imaging version by FIGO or location substring
    const matchingVersion = activeVersions.find((v) => {
      const f = findings.find((x) => x.id === v.finding_id);
      if (f && f.structure !== "fibroid") return false;
      if (fm.figo && v.figo && fm.figo === v.figo) return true;
      if (
        fm.location &&
        v.location_label &&
        (v.location_label.toLowerCase().includes(fm.location.toLowerCase()) ||
          fm.location.toLowerCase().includes(v.location_label.toLowerCase()))
      ) {
        return true;
      }
      return activeVersions.length === 1;
    });

    if (!matchingVersion) {
      const disc: ReportImagingDiscrepancy = {
        id: crypto.randomUUID(),
        category: "report_vs_image",
        summary: `Report describes fibroid (${fm.text}${fm.figo ? `, FIGO ${fm.figo}` : ""}) with no linked imaging segmentation on study`,
        detail: `Clinical report states "${fm.text}" (${fm.location ?? "uterus"}), but no corresponding segmented finding version was matched on study ${studyId}. Review and segment or link manually; findings are never auto-merged.`,
        reportId,
        findingVersionId: null,
        reportedLongestMm: fm.longestMm,
        imagingLongestMm: null,
        reportedVolumeMm3: fm.volumeMm3,
        imagingVolumeMm3: null,
      };
      discrepancies.push(disc);
      continue;
    }

    const imgLongest =
      matchingVersion.longest_mm != null ? Number(matchingVersion.longest_mm) : null;
    if (fm.longestMm != null && imgLongest != null) {
      const diffMm = Math.abs(fm.longestMm - imgLongest);
      if (diffMm > 3.0) {
        const disc: ReportImagingDiscrepancy = {
          id: crypto.randomUUID(),
          category: "reporting_inconsistency",
          summary: `Report states ${fm.longestMm.toFixed(0)} mm; imaging measurement states ${imgLongest.toFixed(0)} mm`,
          detail: `Reported fibroid longest dimension (${fm.longestMm.toFixed(1)} mm from "${fm.text}") differs from imaging measurement (${imgLongest.toFixed(1)} mm on ${matchingVersion.location_label}) by ${diffMm.toFixed(1)} mm (>3 mm threshold). Flagged for clinician review without overwriting either value.`,
          reportId,
          findingVersionId: matchingVersion.id,
          reportedLongestMm: fm.longestMm,
          imagingLongestMm: imgLongest,
          reportedVolumeMm3: fm.volumeMm3,
          imagingVolumeMm3: null,
        };
        discrepancies.push(disc);
      }
    }
  }

  for (const d of discrepancies) {
    try {
      await sql`
        insert into discrepancies (
          id, user_id, patient_id, category, attribution_category, summary, detail,
          left_ref, right_ref, engine_version, active
        ) values (
          ${d.id}, ${ownerUserId}, ${patientId}, ${d.category}, 'insufficient_evidence',
          ${d.summary}, ${d.detail}, ${d.reportId}, ${d.findingVersionId ?? d.reportId},
          'reprotrace-report-reconcile-1', true
        )
      `;
    } catch {
      await sql`
        insert into discrepancies (
          id, user_id, patient_id, category, summary, detail, left_ref, right_ref, engine_version, active
        ) values (
          ${d.id}, ${ownerUserId}, ${patientId}, ${d.category},
          ${d.summary}, ${d.detail}, ${d.reportId}, ${d.findingVersionId ?? d.reportId},
          'reprotrace-report-reconcile-1', true
        )
      `.catch(() => null);
    }
  }

  return discrepancies;
}

export async function ingestReport(
  sql: Sql,
  userId: string,
  raw: IngestInput,
): Promise<IngestResult> {
  if (!userId || typeof userId !== "string" || !userId.trim()) {
    throw new Error("Unauthorized: Authentication is required.");
  }
  const input = validateIngest(raw);
  const { patientOwnerUserId } = await resolvePatientAccessForReportAction(
    sql,
    userId,
    input.patientId,
    "Report upload",
    "add_annotations",
  );

  // Server-side de-identification pass. Already-removed tags are left as they are.
  const deid = deidentify(input.text);
  const ocrUsed = Boolean(input.ocrUsed);
  const extraction = extractReport(deid.text, { ocrUsed });

  let studyId = input.studyId;
  if (studyId) {
    const s = await sql<{ id: string }>`
      select id from studies where id = ${studyId} and user_id = ${patientOwnerUserId} and patient_id = ${input.patientId}
    `;
    if (!s.length) throw new Error("That study is not part of this record.");
  } else {
    const ns = input.newStudy!;
    studyId = crypto.randomUUID();
    await sql`
      insert into studies (id, user_id, patient_id, modality, study_date, description, accession, synthetic, source_note)
      values (
        ${studyId}, ${patientOwnerUserId}, ${input.patientId}, ${ns.modality}, ${ns.date}, ${ns.description},
        ${"uploaded-report"}, ${false},
        ${"Study entry created from an uploaded report. No images are attached to it."}
      )
    `;
  }

  // Persist original uploaded report document using Sprint 3 storage architecture if binary/base64 bytes are supplied
  let reportObjectId: string | null = null;
  const rawBytes =
    input.rawFileBytes ??
    ((input.rawFileBase64 || input.rawBytesBase64) ? Buffer.from((input.rawFileBase64 || input.rawBytesBase64)!, "base64") : null);
  if (rawBytes && rawBytes.byteLength > 0) {
    const mimeType =
      input.fileKind === "pdf"
        ? "application/pdf"
        : input.fileKind === "docx"
          ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          : "text/plain";
    try {
      const storedObj = await storeImagingArtifact(sql, {
        userId,
        patientId: input.patientId,
        studyId,
        kind: "report",
        filename: input.fileName,
        mimeType,
        data: rawBytes,
        metadata: {
          fileKind: input.fileKind,
          extractionMethod:
            input.extractionMethod ??
            (input.fileKind === "pdf"
              ? ocrUsed
                ? "ocr_pdf"
                : "native_pdf_text"
              : input.fileKind === "docx"
                ? "docx_xml"
                : "plain_text"),
          pageCount: input.pageCount ?? 1,
          ocrUsed,
          uploadedByUserId: userId,
        },
      });
      reportObjectId = storedObj.id;
    } catch {
      // In unit tests without imaging_objects table, continue gracefully
      reportObjectId = null;
    }
  }

  const extractionMethod: ReportExtractionMethod =
    input.extractionMethod ??
    (input.fileKind === "pdf"
      ? ocrUsed
        ? "ocr_pdf"
        : "native_pdf_text"
      : input.fileKind === "docx"
        ? "docx_xml"
        : "plain_text");
  const pageCount = input.pageCount ?? 1;
  const pagesJson = JSON.stringify(input.pages ?? []);

  const date =
    extraction.examDate ?? input.newStudy?.date ?? new Date().toISOString().slice(0, 10);
  const reportId = crypto.randomUUID();

  try {
    await sql`
      insert into reports (
        id, user_id, patient_id, study_id, report_date, author_role, body,
        synthetic, source_kind, report_object_id, version_no, extraction_method,
        page_count, ocr_used, review_status
      ) values (
        ${reportId}, ${patientOwnerUserId}, ${input.patientId}, ${studyId}, ${date},
        ${extraction.reportAuthorOrInstitution?.roleOrDepartment ?? "uploaded report (author not stored)"},
        ${deid.text}, ${false}, ${"uploaded"}, ${reportObjectId}, 1,
        ${extractionMethod}, ${pageCount}, ${ocrUsed}, 'unreviewed'
      )
    `;
  } catch {
    await sql`
      insert into reports (id, user_id, study_id, report_date, author_role, body, synthetic, source_kind)
      values (
        ${reportId}, ${patientOwnerUserId}, ${studyId}, ${date},
        ${"uploaded report (author not stored)"}, ${deid.text}, ${false}, ${"uploaded"}
      )
    `;
  }

  const extractionId = crypto.randomUUID();
  const kinds = [...new Set(deid.redactions.map((r) => r.kind))];
  try {
    await sql`
      insert into report_extractions (
        id, user_id, report_id, file_name, file_kind, content_sha256, deid_method,
        redaction_count, redaction_kinds, extractor, extraction, warnings,
        report_object_id, extraction_method, page_count, pages_json, ocr_used,
        ocr_reviewed, review_status, version_no
      ) values (
        ${extractionId}, ${patientOwnerUserId}, ${reportId}, ${input.fileName}, ${input.fileKind},
        ${input.sha256}, ${deid.method}, ${deid.redactions.length},
        ${JSON.stringify(kinds)}, ${EXTRACTOR_ID}, ${JSON.stringify(extraction)},
        ${JSON.stringify(input.warnings)}, ${reportObjectId}, ${extractionMethod},
        ${pageCount}, ${pagesJson}, ${ocrUsed}, ${false}, 'unreviewed', 1
      )
    `;
  } catch {
    await sql`
      insert into report_extractions (
        id, user_id, report_id, file_name, file_kind, content_sha256, deid_method,
        redaction_count, redaction_kinds, extractor, extraction, warnings
      ) values (
        ${extractionId}, ${patientOwnerUserId}, ${reportId}, ${input.fileName}, ${input.fileKind},
        ${input.sha256}, ${deid.method}, ${deid.redactions.length},
        ${JSON.stringify(kinds)}, ${EXTRACTOR_ID}, ${JSON.stringify(extraction)},
        ${JSON.stringify(input.warnings)}
      )
    `;
  }

  // Record initial extraction revision (version 1)
  await sql`
    insert into report_extraction_revisions (
      id, report_id, extraction_id, revision_no, editor_user_id, action,
      previous_extraction_json, updated_extraction_json, reason
    ) values (
      ${crypto.randomUUID()}, ${reportId}, ${extractionId}, 1, ${userId}, 'initial_extract',
      ${null}, ${JSON.stringify(extraction)}, ${`Initial ${extractionMethod} extraction`}
    )
  `.catch(() => null);

  // Reconcile extracted report measurements against imaging-derived findings on this study/patient
  const reconciliationDiscrepancies = await reconcileReportWithImaging(
    sql,
    patientOwnerUserId,
    input.patientId,
    studyId,
    reportId,
    extraction,
  );

  return {
    reportId,
    studyId,
    extractionId,
    reportObjectId,
    extraction,
    redactionsAddedByServer: deid.redactions.length,
    reconciliationDiscrepancies,
  };
}

export type QuoteLinkInput = {
  findingVersionId: string;
  reportId: string;
  start: number;
  end: number;
  quote: string;
  note: string;
};

/**
 * Appends a report quote as evidence on one finding version. The quote must reproduce exactly from the stored
 * report body at the given offsets, and the report must belong to the same patient as the finding.
 * It never edits the version itself.
 */
export async function linkReportQuote(
  sql: Sql,
  userId: string,
  input: QuoteLinkInput,
): Promise<string> {
  if (!userId || typeof userId !== "string" || !userId.trim()) {
    throw new Error("Unauthorized: Authentication is required.");
  }
  const note = String(input.note ?? "").trim().slice(0, 400);
  const v = await sql<{ id: string; patient_id: string; user_id: string }>`
    select fv.id, f.patient_id, fv.user_id
    from finding_versions fv
    join findings f on f.id = fv.finding_id
    where fv.id = ${input.findingVersionId}
  `;
  if (!v[0]) throw new Error("Finding version not found.");

  await resolvePatientAccessForReportAction(
    sql,
    userId,
    v[0].patient_id,
    "Linking evidence",
    "add_annotations",
  );

  const r = await sql<{ id: string; body: string; study_id: string; patient_id: string }>`
    select r.id, r.body, r.study_id, s.patient_id
    from reports r
    join studies s on s.id = r.study_id
    where r.id = ${input.reportId}
  `;
  if (!r[0]) throw new Error("Report not found.");
  if (r[0].patient_id !== v[0].patient_id)
    throw new Error("The report and the finding belong to different records. Not linked.");

  if (!quoteMatches(r[0].body, input.start, input.end, input.quote)) {
    throw new Error(
      "The quote does not match the stored report text at those positions. Nothing was linked.",
    );
  }
  const id = crypto.randomUUID();
  await sql`
    insert into evidence_links (
      id, user_id, finding_version_id, kind, study_id, series_id, report_id,
      quote, slice_index, note, quote_start, quote_end
    ) values (
      ${id}, ${v[0].user_id}, ${input.findingVersionId}, ${"report_quote"},
      ${r[0].study_id}, ${null}, ${r[0].id}, ${input.quote}, ${null},
      ${note || "Quote linked by a clinician from an uploaded report. Offsets verified against the stored text."},
      ${input.start}, ${input.end}
    )
  `;
  return id;
}

/**
 * Clinician review and editing of extracted report fields or OCR text (Task 2F).
 * Preserves the previous extraction JSON in `report_extraction_revisions` and marks
 * edited fields with `provenance: "clinician_confirmed"`.
 */
export async function reviewAndEditReportExtraction(
  sql: Sql,
  callerUserId: string,
  input: {
    reportId: string;
    ocrReviewed?: boolean;
    editedModality?: string | null;
    editedExamDate?: string | null;
    editedFindings?: Array<{
      index: number;
      structure?: string;
      anatomicalLocation?: string | null;
      laterality?: "left" | "right" | "bilateral" | null;
      figo?: string | null;
      negated?: boolean;
      uncertain?: boolean;
    }>;
    reviewStatus: "reviewed" | "corrected" | "rejected";
    reason: string;
  },
): Promise<{
  ok: true;
  reportId: string;
  extractionId: string;
  revisionNo: number;
  updatedExtraction: Extraction;
}> {
  const reason = String(input.reason ?? "").trim();
  if (reason.length < 4) {
    throw new Error("A review or correction reason (at least 4 characters) is required.");
  }

  const rRows = await sql<{
    id: string;
    user_id: string;
    study_id: string;
    patient_id: string;
  }>`
    select r.id, r.user_id, r.study_id, s.patient_id
    from reports r
    join studies s on s.id = r.study_id
    where r.id = ${input.reportId}
  `;
  const report = rRows[0];
  if (!report) {
    throw new Error("Report not found.");
  }

  await resolvePatientAccessForReportAction(
    sql,
    callerUserId,
    report.patient_id,
    "Reviewing or editing report extraction",
    "approve_or_reject_findings",
  );

  const extRows = await sql<{
    id: string;
    extraction: string;
    version_no?: number;
  }>`
    select id, extraction, version_no
    from report_extractions
    where report_id = ${input.reportId}
    order by created_at desc
    limit 1
  `;
  const extRow = extRows[0];
  if (!extRow) {
    throw new Error("Report extraction record not found.");
  }

  const prevExtraction = JSON.parse(extRow.extraction) as Extraction;
  const updated: Extraction = structuredClone(prevExtraction);

  if (input.editedModality !== undefined) {
    updated.modality = input.editedModality;
    updated.modalityProvenance = "clinician_confirmed";
  }
  if (input.editedExamDate !== undefined) {
    updated.examDate = input.editedExamDate;
    updated.examDateProvenance = "clinician_confirmed";
  }

  if (input.editedFindings && input.editedFindings.length > 0) {
    for (const edit of input.editedFindings) {
      const target = updated.findings[edit.index];
      if (!target) continue;
      if (edit.structure !== undefined) target.structure = edit.structure;
      if (edit.anatomicalLocation !== undefined)
        target.anatomicalLocation = edit.anatomicalLocation;
      if (edit.laterality !== undefined) target.laterality = edit.laterality;
      if (edit.figo !== undefined) target.figo = edit.figo;
      if (edit.negated !== undefined) target.negated = edit.negated;
      if (edit.uncertain !== undefined) target.uncertain = edit.uncertain;
      target.provenance = "clinician_confirmed";
      target.reviewStatus = "edited";
      target.reviewedBy = callerUserId;
      target.reviewedAt = new Date().toISOString();
      target.reviewNote = reason;
    }
  }

  updated.reviewStatus = input.reviewStatus;
  updated.notes = [
    ...updated.notes,
    `Clinician review (${input.reviewStatus}) by ${callerUserId}: ${reason}`,
  ];

  const revCountRows = await sql<{ max_rev: number }>`
    select coalesce(max(revision_no), 0)::int as max_rev
    from report_extraction_revisions
    where report_id = ${input.reportId}
  `.catch(() => [{ max_rev: 1 }]);
  const nextRev = Number(revCountRows[0]?.max_rev ?? 1) + 1;

  await sql`
    update report_extractions
    set extraction = ${JSON.stringify(updated)},
        ocr_reviewed = coalesce(${input.ocrReviewed ?? null}, ocr_reviewed),
        review_status = ${input.reviewStatus},
        reviewed_by = ${callerUserId},
        reviewed_at = now(),
        version_no = ${nextRev}
    where id = ${extRow.id}
  `.catch(async () => {
    await sql`
      update report_extractions
      set extraction = ${JSON.stringify(updated)}
      where id = ${extRow.id}
    `;
  });

  await sql`
    update reports
    set review_status = ${input.reviewStatus},
        reviewed_by = ${callerUserId},
        reviewed_at = now()
    where id = ${input.reportId}
  `.catch(() => null);

  await sql`
    insert into report_extraction_revisions (
      id, report_id, extraction_id, revision_no, editor_user_id, action,
      previous_extraction_json, updated_extraction_json, reason
    ) values (
      ${crypto.randomUUID()},
      ${input.reportId},
      ${extRow.id},
      ${nextRev},
      ${callerUserId},
      ${input.ocrReviewed ? "ocr_review" : "edit_fields"},
      ${extRow.extraction},
      ${JSON.stringify(updated)},
      ${reason}
    )
  `.catch(() => null);

  await sql`
    insert into audit_events (id, user_id, action, entity_type, entity_id, detail)
    values (
      ${crypto.randomUUID()},
      ${callerUserId},
      'review_report_extraction',
      'report',
      ${input.reportId},
      ${`Revision v${nextRev} (${input.reviewStatus}): ${reason}`}
    )
  `.catch(() => null);

  return {
    ok: true,
    reportId: input.reportId,
    extractionId: extRow.id,
    revisionNo: nextRev,
    updatedExtraction: updated,
  };
}

/**
 * Clinician approval or rejection of a specific proposed finding extracted from a report (Task 2F).
 * - Never auto-merges with existing findings unless `targetFindingId` is explicitly specified.
 * - When `decision === "approved"`, updates the finding's provenance to `"clinician_confirmed"`
 *   and (when `createOrUpdateFindingVersion` is true) records a new `finding` + `finding_version`
 *   and links the verbatim report quote in `evidence_links`.
 */
export async function decideExtractedFinding(
  sql: Sql,
  callerUserId: string,
  input: {
    reportId: string;
    findingIndex: number;
    decision: "approved" | "rejected" | "edited";
    note: string;
    createFindingRecord?: boolean;
    targetFindingId?: string | null;
    correctedStructure?: string | null;
    correctedLocation?: string | null;
    correctedFigo?: string | null;
    correctedAxesMm?: [number, number, number] | null;
  },
): Promise<{
  ok: true;
  reviewId: string;
  decision: "approved" | "rejected" | "edited";
  linkedFindingId: string | null;
  linkedVersionId: string | null;
  updatedExtraction: Extraction;
}> {
  const note = String(input.note ?? "").trim();
  if (note.length < 4) {
    throw new Error("A clinical review note (at least 4 characters) is required.");
  }

  const rRows = await sql<{
    id: string;
    user_id: string;
    study_id: string;
    report_date: string;
    body: string;
    patient_id: string;
    modality: string;
  }>`
    select r.id, r.user_id, r.study_id, r.report_date::text as report_date, r.body, s.patient_id, s.modality
    from reports r
    join studies s on s.id = r.study_id
    where r.id = ${input.reportId}
  `;
  const report = rRows[0];
  if (!report) {
    throw new Error("Report not found.");
  }

  const { patientOwnerUserId } = await resolvePatientAccessForReportAction(
    sql,
    callerUserId,
    report.patient_id,
    "Approving or rejecting extracted report finding",
    "approve_or_reject_findings",
  );

  const extRows = await sql<{ id: string; extraction: string }>`
    select id, extraction
    from report_extractions
    where report_id = ${input.reportId}
    order by created_at desc
    limit 1
  `;
  const extRow = extRows[0];
  if (!extRow) {
    throw new Error("Report extraction record not found.");
  }

  const prevExtraction = JSON.parse(extRow.extraction) as Extraction;
  const updated: Extraction = structuredClone(prevExtraction);
  const ef = updated.findings[input.findingIndex];
  if (!ef) {
    throw new Error(`Extracted finding at index ${input.findingIndex} does not exist.`);
  }

  if (input.correctedStructure) ef.structure = input.correctedStructure;
  if (input.correctedLocation !== undefined) ef.anatomicalLocation = input.correctedLocation;
  if (input.correctedFigo !== undefined) ef.figo = input.correctedFigo;

  ef.reviewStatus = input.decision;
  ef.provenance =
    input.decision === "approved" || input.decision === "edited"
      ? "clinician_confirmed"
      : ef.provenance;
  ef.reviewedBy = callerUserId;
  ef.reviewedAt = new Date().toISOString();
  ef.reviewNote = note;

  let linkedFindingId: string | null = input.targetFindingId ?? null;
  let linkedVersionId: string | null = null;

  if (
    (input.decision === "approved" || input.decision === "edited") &&
    input.createFindingRecord !== false
  ) {
    // Determine measurement dimensions from the finding's linked measurement or correctedAxesMm
    const measIdx = ef.measurementIndexes?.[0];
    const meas = measIdx !== undefined ? updated.measurements[measIdx] : undefined;
    const axes: [number, number, number] | null =
      input.correctedAxesMm ??
      (meas && meas.dimension === "length" && meas.normalised.length === 3
        ? [meas.normalised[0], meas.normalised[1], meas.normalised[2]]
        : null);
    const longestVal =
      axes != null
        ? Math.max(...axes)
        : meas
          ? longestMm(meas)
          : null;

    if (!linkedFindingId) {
      linkedFindingId = crypto.randomUUID();
      const countRows = await sql<{ c: number }>`
        select count(*)::int as c from findings where patient_id = ${report.patient_id}
      `;
      const code = `R${Number(countRows[0]?.c ?? 0) + 1}`;
      await sql`
        insert into findings (id, user_id, patient_id, code, structure, organ, pathway)
        values (
          ${linkedFindingId},
          ${patientOwnerUserId},
          ${report.patient_id},
          ${code},
          ${ef.structure},
          ${ef.organ},
          ${ef.pathway}
        )
      `;
    }

    const vRows = await sql<{ max_v: number; last_id: string | null }>`
      select coalesce(max(version_no), 0)::int as max_v,
             (select id from finding_versions where finding_id = ${linkedFindingId} order by version_no desc limit 1) as last_id
      from finding_versions
      where finding_id = ${linkedFindingId}
    `;
    const nextVersionNo = Number(vRows[0]?.max_v ?? 0) + 1;
    const prevVersionId = vRows[0]?.last_id ?? null;

    linkedVersionId = crypto.randomUUID();
    const locationLabel =
      input.correctedLocation ??
      ef.anatomicalLocation ??
      (ef.laterality ? `${ef.laterality} ${ef.organ}` : ef.organ);

    await sql`
      insert into finding_versions (
        id, user_id, finding_id, version_no, previous_version_id, study_id, observed_on,
        location_label, figo, centroid_mm, axes_mm, longest_mm, measurement_basis,
        frame, segmentation_source, model_id, quality, modality, report_longest_mm, change_reason
      ) values (
        ${linkedVersionId},
        ${patientOwnerUserId},
        ${linkedFindingId},
        ${nextVersionNo},
        ${prevVersionId},
        ${report.study_id},
        ${updated.examDate ?? report.report_date.slice(0, 10)},
        ${locationLabel},
        ${ef.figo},
        ${null},
        ${axes ? JSON.stringify(axes) : null},
        ${longestVal},
        ${"report-stated measurement confirmed by clinician"},
        ${"unavailable"},
        ${"clinician_confirmed_report"},
        ${null},
        ${"adequate"},
        ${updated.modality ?? report.modality ?? "MR"},
        ${longestVal},
        ${`Clinician confirmed from report ${input.reportId}: ${note}`}
      )
    `;

    // Link exact sentence quote in evidence_links if quoteMatches holds
    if (
      ef.sentence &&
      quoteMatches(report.body, ef.sentence.start, ef.sentence.end, ef.sentence.text)
    ) {
      await sql`
        insert into evidence_links (
          id, user_id, finding_version_id, kind, study_id, series_id, report_id,
          quote, slice_index, note, quote_start, quote_end
        ) values (
          ${crypto.randomUUID()},
          ${patientOwnerUserId},
          ${linkedVersionId},
          ${"report_quote"},
          ${report.study_id},
          ${null},
          ${report.id},
          ${ef.sentence.text},
          ${null},
          ${`Clinician approved extracted finding: ${note}`},
          ${ef.sentence.start},
          ${ef.sentence.end}
        )
      `;
    }
  }

  const reviewId = crypto.randomUUID();
  await sql`
    insert into report_finding_reviews (
      id, report_id, extraction_id, patient_id, finding_index, decision,
      reviewer_user_id, linked_finding_id, linked_version_id,
      corrected_structure, corrected_location, corrected_figo,
      corrected_axes_mm, corrected_longest_mm, note
    ) values (
      ${reviewId},
      ${input.reportId},
      ${extRow.id},
      ${report.patient_id},
      ${input.findingIndex},
      ${input.decision},
      ${callerUserId},
      ${linkedFindingId},
      ${linkedVersionId},
      ${input.correctedStructure ?? null},
      ${input.correctedLocation ?? null},
      ${input.correctedFigo ?? null},
      ${input.correctedAxesMm ? JSON.stringify(input.correctedAxesMm) : null},
      ${input.correctedAxesMm ? Math.max(...input.correctedAxesMm) : null},
      ${note}
    )
  `.catch(() => null);

  const revCountRows = await sql<{ max_rev: number }>`
    select coalesce(max(revision_no), 0)::int as max_rev
    from report_extraction_revisions
    where report_id = ${input.reportId}
  `.catch(() => [{ max_rev: 1 }]);
  const nextRev = Number(revCountRows[0]?.max_rev ?? 1) + 1;

  await sql`
    update report_extractions
    set extraction = ${JSON.stringify(updated)},
        review_status = 'reviewed',
        reviewed_by = ${callerUserId},
        reviewed_at = now(),
        version_no = ${nextRev}
    where id = ${extRow.id}
  `.catch(async () => {
    await sql`
      update report_extractions
      set extraction = ${JSON.stringify(updated)}
      where id = ${extRow.id}
    `;
  });

  await sql`
    insert into report_extraction_revisions (
      id, report_id, extraction_id, revision_no, editor_user_id, action,
      previous_extraction_json, updated_extraction_json, reason
    ) values (
      ${crypto.randomUUID()},
      ${input.reportId},
      ${extRow.id},
      ${nextRev},
      ${callerUserId},
      ${input.decision === "rejected" ? "reject_finding" : "approve_finding"},
      ${extRow.extraction},
      ${JSON.stringify(updated)},
      ${note}
    )
  `.catch(() => null);

  await sql`
    insert into audit_events (id, user_id, action, entity_type, entity_id, detail)
    values (
      ${crypto.randomUUID()},
      ${callerUserId},
      ${`report_finding_${input.decision}`},
      'report',
      ${input.reportId},
      ${`Finding #${input.findingIndex} (${ef.structure}) ${input.decision}: ${note}`}
    )
  `.catch(() => null);

  return {
    ok: true,
    reviewId,
    decision: input.decision,
    linkedFindingId,
    linkedVersionId,
    updatedExtraction: updated,
  };
}
