/**
 * Sprint 4 Task 2G — Automated Clinical Report Intelligence, OCR, Source-Grounded LLM,
 * Reconciliation, and Clinician Review Tests:
 * 1. Native-text PDF extraction.
 * 2. Scanned PDF OCR extraction (page-selective OCR fallback without claiming unverified OCR accuracy).
 * 3. Multi-page hybrid PDF handling (native page + scanned OCR page) with page number preservation.
 * 4. DOCX and TXT extraction.
 * 5. Corrupted document handling and failed OCR page preservation (never silently dropping pages).
 * 6. Reports with missing information and extraction uncertainty/negation (never silently converting uncertain/negated to confirmed).
 * 7. Structured clinical information extraction (modality, exam date, anatomical region, uterine measurements,
 *    fibroid measurements with FIGO, ovarian cyst measurements, impressions, recommendations, author/institution)
 *    with 4-tier provenance (`explicitly_stated`, `parser_inferred`, `llm_generated`, `clinician_confirmed`).
 * 8. Source-grounded LLM interpretation, output schema validation, privacy gate enforcement, and unsupported question refusal (`insufficient_evidence`).
 * 9. Source-reference correctness (character offsets and page numbers match verbatim quotes).
 * 10. Report-to-study association, persistent original report storage (`imaging_objects`), and reconciliation against imaging-derived measurements (`reconcileReportWithImaging`) without auto-merging findings.
 * 11. Clinician review workflow (editing extracted fields, approving/rejecting proposed findings, and preserving append-only revision history).
 * 12. Unauthorized report access refusal.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import type { Sql } from "../db.ts";
import { extractReportText } from "./text.ts";
import { deidentify } from "./deidentify.ts";
import { extractReport, quoteMatches } from "./extract.ts";
import {
  buildPdf,
  buildMultiPagePdf,
  buildScannedPdf,
  buildDocx,
  SAMPLE_REPORT_LINES,
} from "./fixtures.ts";
import {
  interpretReportWithLlm,
  answerQuestionFromSourceReport,
  validateLlmInterpretationOutput,
} from "./llm-interpreter.ts";
import {
  ensure,
  executeRequestClinicianVerification,
  executeVerifyClinician,
  executeUploadReport,
  executeReviewAndEditReportExtraction,
  executeDecideExtractedFinding,
  executeGetOriginalReportDocument,
  executeGetReportRevisions,
  executeInterpretReportWithLlm,
  executeAnswerReportQuestion,
} from "../clinic/server.ts";

const MIGRATION_FILES = [
  "migrations/0002_anatomybridge.sql",
  "migrations/0003_append_only.sql",
  "migrations/0004_menarche_year.sql",
  "migrations/0005_report_ingestion.sql",
  "migrations/0007_fix_profile_default.sql",
  "migrations/0008_clinician_verification.sql",
  "migrations/0009_imaging_and_provenance.sql",
  "migrations/0010_sprint1_auth_and_registration.sql",
  "migrations/0011_sprint3_imaging_storage_and_reprotrace.sql",
  "migrations/0012_sprint4_collaboration_and_report_intelligence.sql",
];

function wrap(pg: PGlite): Sql {
  return async <T = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]> => {
    let text = strings[0] ?? "";
    for (let i = 0; i < values.length; i += 1) {
      text += `$${i + 1}${strings[i + 1] ?? ""}`;
    }
    const res = await pg.query<T>(text, values);
    return res.rows;
  };
}

async function setupDb(): Promise<{ pg: PGlite; sql: Sql }> {
  const pg = new PGlite();
  for (const file of MIGRATION_FILES) {
    await pg.exec(readFileSync(file, "utf8"));
  }
  return { pg, sql: wrap(pg) };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("Sprint 4 Task 2 — Clinical Report Intelligence, OCR, LLM Grounding & Clinician Review", () => {
  it("1. Native-text PDF, DOCX, and TXT extraction record accurate method and page metadata", async () => {
    const pdfBytes = await buildPdf(SAMPLE_REPORT_LINES, true);
    const pdfRes = await extractReportText("report.pdf", pdfBytes);
    assert.equal(pdfRes.usable, true);
    assert.equal(pdfRes.extractionMethod, "native_pdf_text");
    assert.equal(pdfRes.ocrUsed, false);
    assert.equal(pdfRes.ocrAccuracyClaimed, false);
    assert.equal(pdfRes.pageCount, 1);
    assert.match(pdfRes.text, /5\.6 x 4\.2 x 3\.3 cm/);

    const docxBytes = await buildDocx(SAMPLE_REPORT_LINES);
    const docxRes = await extractReportText("report.docx", docxBytes);
    assert.equal(docxRes.usable, true);
    assert.equal(docxRes.extractionMethod, "docx_xml");
    assert.match(docxRes.text, /FIGO 4/);

    const txtBytes = new TextEncoder().encode(SAMPLE_REPORT_LINES.join("\n"));
    const txtRes = await extractReportText("report.txt", txtBytes);
    assert.equal(txtRes.usable, true);
    assert.equal(txtRes.extractionMethod, "plain_text");
  });

  it("2. Scanned PDF OCR extracts text from rasterized image pages without claiming unvalidated OCR accuracy", async () => {
    const scannedLines = [
      "Department of Radiology - Pelvic MRI Report",
      "Study Date: 2026-03-14",
      "Modality: MRI Pelvis",
      "Uterus measures 88 x 54 x 46 mm.",
      "Posterior wall intramural fibroid (FIGO 4) measuring 44 x 38 x 35 mm.",
      "Left ovary simple cyst measuring 26 mm.",
      "Impression: Intramural uterine fibroid.",
      "Recommendation: Follow-up MRI in 6 months.",
    ];
    const scannedBytes = await buildScannedPdf([scannedLines], false);
    const res = await extractReportText("scanned-mri.pdf", scannedBytes);

    assert.equal(res.usable, true);
    assert.equal(res.ocrUsed, true);
    assert.equal(res.extractionMethod, "ocr_pdf");
    assert.equal(res.ocrAccuracyClaimed, false);
    assert.equal(res.pageCount, 1);
    assert.equal(res.pages.length, 1);
    assert.equal(res.pages[0].method, "ocr");
    assert.match(res.text, /44 x 38 x 35 mm/);
    assert.match(res.text, /FIGO 4/);
    assert.ok(res.warnings.some((w) => /OCR|scanned/i.test(w)));
  });

  it("3. Multi-page hybrid PDF preserves page numbers across native and scanned OCR pages and never silently drops failed pages", async () => {
    const hybridBytes = await buildMultiPagePdf([
      {
        mode: "native",
        lines: [
          "Page 1: Clinical History and Uterine Biometry",
          "Study date: 2026-03-18. Pelvic MRI.",
          "Uterus measures 91 x 55 x 48 mm.",
        ],
      },
      {
        mode: "scanned",
        lines: [
          "Page 2: Scanned Fibroid & Adnexal Addendum",
          "Anterior wall subserosal fibroid (FIGO 5) measuring 38 x 33 x 30 mm.",
          "Right ovary simple cyst measuring 24 mm.",
        ],
      },
    ]);

    const res = await extractReportText("hybrid-report.pdf", hybridBytes);
    assert.equal(res.usable, true);
    assert.equal(res.pageCount, 2);
    assert.equal(res.pages.length, 2);
    assert.equal(res.extractionMethod, "hybrid_pdf_text_and_ocr");
    assert.equal(res.pages[0].pageNumber, 1);
    assert.equal(res.pages[0].method, "native_pdf_text");
    assert.equal(res.pages[1].pageNumber, 2);
    assert.equal(res.pages[1].method, "ocr");

    const deid = deidentify(res.text);
    const ext = extractReport(deid.text, {
      rawTextForMetadata: res.text,
      extractionMethod: res.extractionMethod,
      pageCount: res.pageCount,
      pages: res.pages,
    });

    assert.equal(ext.uterineMeasurements.length, 1);
    assert.equal(ext.uterineMeasurements[0].pageNumber, 1);
    assert.equal(ext.fibroidMeasurements.length, 1);
    assert.equal(ext.fibroidMeasurements[0].pageNumber, 2);
    assert.equal(ext.ovarianCystMeasurements.length, 1);
    assert.equal(ext.ovarianCystMeasurements[0].pageNumber, 2);

    // Simulate a page where OCR fails -> page must still be preserved in `pages` with method: "failed"
    const failedPageRes = await extractReportText("failed-ocr.pdf", hybridBytes, {
      ocrRecognizer: () => ({
        text: "",
        confidence: 0,
        engine: "failing-ocr-stub",
        warnings: ["Simulated OCR engine timeout on page 2"],
      }),
    });
    assert.equal(failedPageRes.pageCount, 2);
    assert.equal(failedPageRes.pages.length, 2);
    assert.equal(failedPageRes.pages[0].method, "native_pdf_text");
    assert.equal(failedPageRes.pages[1].method, "failed");
    assert.ok(failedPageRes.warnings.some((w) => /Page 2.*failed/i.test(w)));
  });

  it("4. Corrupted documents, missing information, uncertainty, and negated findings are handled safely", async () => {
    // Corrupted PDF
    await assert.rejects(
      () => extractReportText("corrupt.pdf", new Uint8Array([0x00, 0x01, 0x02, 0x03])),
      /does not look like one|does not have a %PDF- header/i,
    );

    // Report with missing date/modality and uncertain + negated findings
    const uncertainReport = [
      "Pelvic imaging note.",
      "Questionable tiny 9 mm myometrial focus, cannot exclude small fibroid.",
      "No ovarian cyst or hydrosalpinx is seen.",
      "No free fluid in the cul-de-sac.",
    ].join(" ");

    const ext = extractReport(uncertainReport);
    assert.equal(ext.examDate, null);
    assert.equal(ext.modality, null);

    const fibroidFinding = ext.findings.find((f) => f.structure === "fibroid");
    assert.ok(fibroidFinding);
    assert.equal(fibroidFinding.uncertain, true);
    assert.equal(fibroidFinding.negated, false);
    assert.equal(fibroidFinding.provenance, "parser_inferred");

    const cystFinding = ext.findings.find((f) => f.structure === "ovarian cyst" || f.structure === "ovarian_cyst" || f.structure === "cyst");
    assert.ok(cystFinding);
    assert.equal(cystFinding.negated, true);
    // Negated or uncertain findings must never be promoted to confirmed fibroid/cyst measurement lists
    assert.equal(ext.ovarianCystMeasurements.length, 0);
  });

  it("5. Source-grounded LLM interpreter validates structured output, enforces privacy gates, cites exact offsets, and refuses unsupported questions", async () => {
    const deid = deidentify(SAMPLE_REPORT_LINES.join("\n"));
    const ext = extractReport(deid.text, {
      rawTextForMetadata: SAMPLE_REPORT_LINES.join("\n"),
    });

    // Local source-grounded interpretation succeeds with exact citations
    const interp = await interpretReportWithLlm({
      reportId: "rep-test-1",
      deidentifiedText: deid.text,
      structuredExtraction: ext,
    });
    assert.equal(interp.status, "completed");
    assert.equal(interp.clinicianReviewed, false);
    assert.ok(interp.claims.length >= 2);
    for (const claim of interp.claims) {
      assert.equal(
        quoteMatches(
          deid.text,
          claim.citation.startOffset,
          claim.citation.endOffset,
          claim.citation.verbatimQuote,
        ),
        true,
        `Claim quote '${claim.citation.verbatimQuote}' must match exact character offsets in report body`,
      );
    }

    // Privacy gate blocks external provider if unredacted PHI is present or privacy gate is disabled
    const blockedByPrivacy = await interpretReportWithLlm({
      reportId: "rep-test-2",
      deidentifiedText: "Patient Name: Kavya Sharma. Phone: +91 9876543210.",
      structuredExtraction: ext,
      configOverrides: {
        provider: "openai_compatible",
        endpointUrl: "https://example.invalid/v1/chat/completions",
        apiKey: "test-key",
        privacyGateAllowExternalDeidentified: true,
      },
    });
    assert.equal(blockedByPrivacy.status, "blocked_by_privacy_gate");

    // Schema validator rejects autonomous treatment recommendations or unverified quotes
    const badValidation = validateLlmInterpretationOutput(
      {
        generatedExplanationSummary: "You should start Leuprolide 3.75mg immediately and schedule a myomectomy.",
        uncertaintyFlags: [],
        claims: [
          {
            statement: "Fibroid seen",
            category: "finding",
            uncertain: false,
            negated: false,
            provenance: "llm_generated",
            citation: {
              reportId: "rep-test-1",
              pageNumber: 1,
              startOffset: 0,
              endOffset: 10,
              verbatimQuote: "NON_EXISTENT_QUOTE",
            },
          },
        ],
      },
      deid.text,
      "rep-test-1",
    );
    assert.equal(badValidation.valid, false);
    assert.ok(badValidation.errors.some((e) => /autonomous|treatment/i.test(e)));
    assert.ok(badValidation.errors.some((e) => /does not match/i.test(e)));

    // Supported question vs unsupported question refusal
    const supportedQa = answerQuestionFromSourceReport({
      reportId: "rep-test-1",
      deidentifiedText: deid.text,
      structuredExtraction: ext,
      question: "What are the fibroid measurements and FIGO classification?",
    });
    assert.equal(supportedQa.status, "answered");
    assert.ok(supportedQa.citations.length > 0);

    const unsupportedQa = answerQuestionFromSourceReport({
      reportId: "rep-test-1",
      deidentifiedText: deid.text,
      structuredExtraction: ext,
      question: "What is the patient's serum AMH level and genetic BRCA status?",
    });
    assert.equal(unsupportedQa.status, "insufficient_evidence");
    assert.match(unsupportedQa.answer, /Insufficient evidence in the source report/i);
  });

  it("6. End-to-end report ingestion persists original file, reconciles report vs imaging measurements without auto-merging, and supports clinician review & finding approval", async () => {
    const { pg, sql } = await setupDb();
    try {
      await ensure(sql, "admin-u");
      await sql`update profiles set role = 'admin' where user_id = ${"admin-u"}`;
      await ensure(sql, "clin-u");
      const req = await executeRequestClinicianVerification(sql, "clin-u", {
        licenceNo: "MCI-778899",
        registry: "NMC",
        evidenceNote: "Radiology Specialist",
      });
      await executeVerifyClinician(sql, "admin-u", {
        verificationId: req.verificationId,
        decision: "verified",
        reason: "Approved",
      });

      const patientId = "clin-u:meera";
      // Kavya's latest study s2 has F1 fibroid with longest_mm = 42 mm.
      // Upload a report on study s2 reporting a 52 x 44 x 40 mm fibroid (10 mm discrepancy vs 42 mm imaging measurement!)
      const reportLines = [
        "Pelvic MRI Report",
        "Study date: 2025-11-08",
        "Posterior uterine wall intramural fibroid (FIGO 4) measuring 52 x 44 x 40 mm.",
        "Impression: Enlarging posterior wall intramural fibroid.",
        "Recommendation: Gynaecology follow-up in 6 months.",
      ];
      const pdfBytes = await buildPdf(reportLines, true);
      const parsed = await extractReportText("followup-s2.pdf", pdfBytes);
      const deid = deidentify(parsed.text);

      const uploadRes = await executeUploadReport(sql, "clin-u", {
        patientId,
        studyId: "clin-u:meera-mr1",
        newStudy: null,
        fileName: "followup-s2.pdf",
        fileKind: "pdf",
        sha256: sha256(pdfBytes),
        text: deid.text,
        warnings: parsed.warnings,
        rawBytesBase64: Buffer.from(pdfBytes).toString("base64"),
        extractionMethod: parsed.extractionMethod,
        pageCount: parsed.pageCount,
        pages: parsed.pages,
        ocrUsed: parsed.ocrUsed,
      });

      assert.equal(uploadRes.ok, true);
      assert.ok(uploadRes.reportObjectId, "Original report binary must be persisted in imaging_objects");
      assert.ok(
        uploadRes.reconciliationDiscrepancies.length >= 1,
        "10 mm difference between report (52 mm) and imaging (42 mm) must be flagged for clinician review",
      );
      assert.equal(
        uploadRes.reconciliationDiscrepancies[0].category,
        "reporting_inconsistency",
      );

      // Retrieve original persisted report document and verify SHA-256 integrity
      const origDoc = await executeGetOriginalReportDocument(
        sql,
        "clin-u",
        uploadRes.reportId,
      );
      assert.equal(origDoc.integrity.valid, true);
      assert.equal(origDoc.record.sha256, sha256(pdfBytes));

      // Unauthorized user cannot retrieve the original report document or revisions
      await ensure(sql, "other-patient");
      await assert.rejects(
        () => executeGetOriginalReportDocument(sql, "other-patient", uploadRes.reportId),
        /Unauthorized/,
      );
      await assert.rejects(
        () => executeInterpretReportWithLlm(sql, "other-patient", { reportId: uploadRes.reportId }),
        /Unauthorized/,
      );

      // Clinician reviews and edits the report extraction
      const reviewRes = await executeReviewAndEditReportExtraction(sql, "clin-u", {
        reportId: uploadRes.reportId,
        ocrReviewed: true,
        editedModality: "MR",
        editedExamDate: "2025-11-08",
        reviewStatus: "reviewed",
        reason: "Confirmed modality and date against original PDF header.",
      });
      assert.equal(reviewRes.ok, true);
      assert.equal(reviewRes.revisionNo, 2);
      assert.equal(reviewRes.updatedExtraction.modalityProvenance, "clinician_confirmed");

      // Clinician approves the extracted fibroid finding (creates a new finding record without auto-merging existing findings)
      const findingsBefore = await sql<{ c: number }>`
        select count(*)::int as c from findings where patient_id = ${patientId}
      `;
      const decideRes = await executeDecideExtractedFinding(sql, "clin-u", {
        reportId: uploadRes.reportId,
        findingIndex: 0,
        decision: "approved",
        note: "Approved posterior wall fibroid finding from report.",
        createFindingRecord: true,
      });
      assert.equal(decideRes.ok, true);
      assert.equal(decideRes.decision, "approved");
      assert.ok(decideRes.linkedFindingId);
      assert.ok(decideRes.linkedVersionId);
      assert.equal(
        decideRes.updatedExtraction.findings[0].provenance,
        "clinician_confirmed",
      );

      const findingsAfter = await sql<{ c: number }>`
        select count(*)::int as c from findings where patient_id = ${patientId}
      `;
      assert.equal(
        Number(findingsAfter[0].c),
        Number(findingsBefore[0].c) + 1,
        "Approving a report finding without targetFindingId creates a distinct finding rather than silently merging",
      );

      // Revision history contains initial extract, field review, and finding approval
      const revHistory = await executeGetReportRevisions(
        sql,
        "clin-u",
        uploadRes.reportId,
      );
      assert.ok(revHistory.revisions.length >= 3);
      assert.equal(revHistory.findingReviews.length, 1);

      // Source-grounded LLM interpretation and Q&A work end-to-end on the stored report
      const llmRes = await executeInterpretReportWithLlm(sql, "clin-u", {
        reportId: uploadRes.reportId,
      });
      assert.equal(llmRes.status, "completed");

      const qaRes = await executeAnswerReportQuestion(sql, "clin-u", {
        reportId: uploadRes.reportId,
        question: "What follow-up recommendation is stated in the report?",
      });
      assert.equal(qaRes.status, "answered");
      assert.match(qaRes.answer, /follow-up in 6 months/i);
    } finally {
      await pg.close();
    }
  });
});

import { spawnSync } from "node:child_process";
import { recognizeImageWithTesseract } from "./ocr.ts";

import { test } from "node:test";
test("Workstream 6A: Real /usr/bin/tesseract OCR engine extracts text from a rendered PNG medical report image and reports handwritingSupported: false", () => {
  // Render a clean black-on-white PNG image containing medical report text using Python Pillow
  const pyPng = spawnSync(
    "python3",
    [
      "-c",
      "import io, base64; from PIL import Image, ImageDraw; " +
      "im = Image.new('L', (640, 120), color=255); " +
      "dr = ImageDraw.Draw(im); " +
      "dr.text((20, 40), 'PELVIC MRI REPORT FIGO 4 FIBROID 32 MM', fill=0); " +
      "buf = io.BytesIO(); im.save(buf, format='PNG'); " +
      "print(base64.b64encode(buf.getvalue()).decode())",
    ],
    { encoding: "utf8" },
  );
  assert.equal(pyPng.status, 0);
  const pngBytes = new Uint8Array(Buffer.from(pyPng.stdout.trim(), "base64"));

  const tessResult = recognizeImageWithTesseract(pngBytes);
  assert.equal(tessResult.recognized, true);
  assert.equal(tessResult.engine, "tesseract_cli");
  assert.equal(tessResult.handwritingSupported, false);
  assert.match(tessResult.text, /PELVIC|MRI|REPORT|FIBROID/i);
});
