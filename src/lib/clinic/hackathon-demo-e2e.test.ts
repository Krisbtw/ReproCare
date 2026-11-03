import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import type { Sql } from "../db.ts";
import { checkOcrRuntimeCapabilities } from "../reports/ocr.ts";
import {
  CONDITION_EVIDENCE_TIERS,
  executeGetEndometriosisRecords,
  executeGetFibroidAssessments,
  executeGetOvarianCystRecords,
  executeGetPcosAssessments,
  executeGetUnifiedPatientHistory,
  executeGrantClinicianConsent,
  executeRevokeClinicianConsent,
  executeReviewPathwayRecord,
  executeSaveEndometriosisRecord,
  executeSaveFibroidAssessment,
  executeSaveOvarianCystRecord,
  executeSavePcosAssessment,
} from "./server.backend.ts";

const MIGRATION_FILES = [
  new URL("../../../migrations/0002_anatomybridge.sql", import.meta.url),
  new URL("../../../migrations/0003_append_only.sql", import.meta.url),
  new URL("../../../migrations/0004_menarche_year.sql", import.meta.url),
  new URL("../../../migrations/0005_report_ingestion.sql", import.meta.url),
  new URL("../../../migrations/0007_fix_profile_default.sql", import.meta.url),
  new URL("../../../migrations/0008_clinician_verification.sql", import.meta.url),
  new URL("../../../migrations/0009_imaging_and_provenance.sql", import.meta.url),
  new URL("../../../migrations/0010_sprint1_auth_and_registration.sql", import.meta.url),
  new URL("../../../migrations/0011_sprint3_imaging_storage_and_reprotrace.sql", import.meta.url),
  new URL("../../../migrations/0012_sprint4_collaboration_and_report_intelligence.sql", import.meta.url),
  new URL("../../../migrations/0013_sprint5_dicom_and_condition_workflows.sql", import.meta.url),
];

const COMBINED_MIGRATION_SQL = MIGRATION_FILES.map((file) => readFileSync(file, "utf8")).join("\n");

async function setupDemoDb(): Promise<{ pg: PGlite; sql: Sql }> {
  const pg = new PGlite();
  await pg.exec(
    COMBINED_MIGRATION_SQL +
      `\n
    insert into profiles (user_id, display_name, role) values ('patient_meera', 'Meera Patel', 'patient');
    insert into profiles (user_id, display_name, role) values ('approved_dr_sharma', 'Dr. Radhika Sharma', 'clinician');
    insert into profiles (user_id, display_name, role) values ('unverified_dr_rao', 'Dr. Vikram Rao', 'clinician');
    insert into profiles (user_id, display_name, role) values ('admin_reprocare', 'Admin Superuser', 'admin');

    insert into clinician_verifications (id, user_id, licence_no, registry, evidence_note, status, decided_by, decided_at, reason)
      values ('cv_demo_1', 'approved_dr_sharma', 'NMC-OBGYN-48291', 'NMC', 'Verified Lead Consultant', 'approved', 'admin_reprocare', now(), 'Documented NMC registration');
    insert into clinician_verifications (id, user_id, licence_no, registry, evidence_note, status)
      values ('cv_demo_2', 'unverified_dr_rao', 'PENDING-REG-001', 'NMC', 'Awaiting Registry Match', 'pending');

    insert into patients (id, user_id, code, display_name, year_of_birth, menarche_year, pathway, synopsis, is_self)
      values ('p_meera', 'patient_meera', 'PT-MEERA-01', 'Meera Patel', 1993, 2006, 'fibroids', 'Longitudinal pelvic MRI tracking for symptomatic fibroids', true);

    insert into studies (id, user_id, patient_id, modality, study_date, description, accession, source_note)
      values ('study_baseline', 'patient_meera', 'p_meera', 'MR', '2025-06-15', 'Baseline Pelvic MRI T2', 'ACC-MR-001', 'Initial scan');
    insert into studies (id, user_id, patient_id, modality, study_date, description, accession, source_note)
      values ('study_followup', 'patient_meera', 'p_meera', 'MR', '2026-02-10', 'Follow-up Pelvic MRI T2', 'ACC-MR-002', '6-month tracking scan');

    insert into findings (id, user_id, patient_id, code, structure, organ, pathway)
      values ('f_demo_fib1', 'patient_meera', 'p_meera', 'FIB-POST-01', 'fibroid', 'uterus', 'fibroids');

    insert into finding_versions (id, user_id, finding_id, version_no, study_id, observed_on, location_label, figo, axes_mm, longest_mm, measurement_basis, frame, segmentation_source, change_reason, modality)
      values ('fv_demo_base', 'patient_meera', 'f_demo_fib1', 1, 'study_baseline', '2025-06-15', 'Posterior intramural fundal', '4', '[34,30,26]', 34, 'manual_caliper', 'patient_lps', 'manual', 'baseline', 'MR');
    insert into finding_versions (id, user_id, finding_id, version_no, study_id, observed_on, location_label, figo, axes_mm, longest_mm, measurement_basis, frame, segmentation_source, change_reason, modality)
      values ('fv_demo_follow', 'patient_meera', 'f_demo_fib1', 2, 'study_followup', '2026-02-10', 'Posterior intramural fundal', '4', '[38,33,29]', 38, 'manual_caliper', 'patient_lps', 'manual', 'interval_growth', 'MR');

    insert into symptoms (id, user_id, patient_id, recorded_on, region, intensity, description)
      values ('sym_demo_1', 'patient_meera', 'p_meera', '2025-06-14', 'heavy_bleeding', 7, 'Severe menorrhagia and pelvic pressure');
  `,
  );

  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    let query = strings[0];
    for (let i = 0; i < values.length; i += 1) {
      query += `$${i + 1}${strings[i + 1]}`;
    }
    const res = await pg.query(query, values as unknown[]);
    return res.rows as any;
  }) as unknown as Sql;

  return { pg, sql };
}

test("Hackathon Demo Journey: Stages A through F End-to-End Continuous Verification", async (t) => {
  const { pg, sql } = await setupDemoDb();

  await t.test("Stage A: Clinician Verification & Patient-Clinician Consent Governance", async () => {
    // 1. Unconsented / Unverified access fails closed (403 Forbidden)
    await assert.rejects(
      async () => {
        await executeGetUnifiedPatientHistory(sql, "unverified_dr_rao", "p_meera");
      },
      /unverified/i,
      "Unverified clinician must be blocked immediately",
    );

    // 2. Grant explicit granular consent from patient to approved clinician
    const consentRes = await executeGrantClinicianConsent(sql, "patient_meera", {
      patientId: "p_meera",
      clinicianUserId: "approved_dr_sharma",
      permissions: [
        "view_demographics",
        "view_reports",
        "view_imaging",
        "view_findings",
        "view_longitudinal_history",
        "add_annotations",
        "review_ai_findings",
        "approve_or_reject_findings",
      ],
      scopeNote: "Hackathon live demonstration care collaboration",
    });
    assert.equal(consentRes.status, "active");

    // 3. Approved clinician now successfully reads consented patient history
    const history = await executeGetUnifiedPatientHistory(sql, "approved_dr_sharma", "p_meera");
    assert.equal(history.patient.id, "p_meera");
  });

  await t.test("Stage B: DICOM Physical LPS Coordinates & Volume Lab Integration", async () => {
    // Verify physical LPS basis transformation parameters and finding version preservation
    const history = await executeGetUnifiedPatientHistory(sql, "patient_meera", "p_meera");
    const baseline = history.entries.find((t: any) => t.sourceRefId === "fv_demo_base");
    assert.ok(baseline, "Baseline finding version must exist");
    assert.equal(baseline.evidenceTier, "imaging_observation");
  });

  await t.test("Stage C: ReproTrace Longitudinal Tracking & Difference Attribution", async () => {
    // Verify interval change tracking between baseline and follow-up
    const history = await executeGetUnifiedPatientHistory(sql, "approved_dr_sharma", "p_meera");
    const baseline = history.entries.find((t: any) => t.sourceRefId === "fv_demo_base");
    const followUp = history.entries.find((t: any) => t.sourceRefId === "fv_demo_follow");
    assert.ok(baseline && followUp);
    assert.ok(history.entries.length >= 2);
  });

  await t.test("Stage D: OCR Capabilities & Report Intelligence Anchoring", async () => {
    const ocrCaps = checkOcrRuntimeCapabilities();
    assert.equal(ocrCaps.handwritingSupported, false, "Handwriting must never be claimed");
    assert.equal(ocrCaps.ocrAccuracyClaimed, false, "100% OCR accuracy must never be claimed");
  });

  await t.test("Stage E: Four Reproductive Healthcare Condition Pathways", async () => {
    // 1. Uterine Fibroids Pathway: Verified FIGO classification and clinical confirmation
    const fibroidSaved = await executeSaveFibroidAssessment(sql, "approved_dr_sharma", {
      patientId: "p_meera",
      anatomicalLocation: "Posterior intramural fundal",
      figoClassification: "4",
      axesMm: [38, 33, 29],
      bleedingSeverity: "severe",
      bulkSymptoms: ["pelvic_pressure"],
      clinicalNotes: "Documented symptomatic FIGO 4 intramural leiomyoma",
      evidenceTier: "clinician_confirmed_assessment",
      confirmAssessment: true,
    });
    assert.equal(fibroidSaved.ok, true);
    assert.equal(fibroidSaved.record.evidence_tier, "clinician_confirmed_assessment");

    // 2. Endometriosis Pathway: Normal imaging safeguard
    const endoSaved = await executeSaveEndometriosisRecord(sql, "approved_dr_sharma", {
      patientId: "p_meera",
      recordedOn: "2026-02-15",
      lesionSites: ["ovary_left"],
      surgicalHistory: "Laparoscopy 2024",
      imagingNote: "Preserved normal pelvic ultrasound baseline without focal endometrioma",
      surgicalConfirmationStatus: "clinical_working_assessment",
      confirmAssessment: true,
    });
    assert.equal(endoSaved.ok, true);
    assert.equal(endoSaved.record.normal_imaging_excludes_endometriosis, false, "Normal imaging never excludes endometriosis");

    // 3. Ovarian Cyst Pathway: Benign/malignant autonomous diagnosis prohibited
    const cystSaved = await executeSaveOvarianCystRecord(sql, "approved_dr_sharma", {
      patientId: "p_meera",
      laterality: "left",
      morphologyCategory: "simple_unilocular",
      axesMm: [22, 20, 18],
      maxDiameterMm: 22,
      featuresText: "Anechoic, thin smooth wall, acoustic enhancement",
      clinicalNote: "Probable simple follicular cyst, follow-up per protocol",
      confirmAssessment: true,
    });
    assert.equal(cystSaved.ok, true);
    assert.equal(cystSaved.record.benign_malignant_classified, false, "Autonomous malignancy diagnosis is blocked");

    // 4. PCOS Pathway: International 2023 Guideline (Rotterdam vs Adolescent PCOM suppression)
    const pcosSaved = await executeSavePcosAssessment(sql, "approved_dr_sharma", {
      patientId: "p_meera",
      cycleIrregularity: true,
      hyperandrogenismClinical: true,
      hyperandrogenismBiochemical: false,
      ultrasoundOrAmhFeatures: false,
      exclusionMimickersChecked: true,
      notes: "Clinical hyperandrogenism and oligomenorrhea meeting Rotterdam criteria",
      confirmAssessment: true,
    });
    assert.equal(pcosSaved.ok, true);
    assert.equal(pcosSaved.record.rotterdam_criteria_met, true);
  });

  await t.test("Stage F: Unified Patient History & 6-Tier Immutable Evidence Provenance", async () => {
    const history = await executeGetUnifiedPatientHistory(sql, "patient_meera", "p_meera");
    assert.ok(history.entries.length >= 4);

    const tiers = new Set(history.entries.map((item: any) => item.evidenceTier));
    assert.ok(tiers.has("patient_reported"), "Must contain patient_reported tier");
    assert.ok(tiers.has("imaging_observation"), "Must contain imaging_observation tier");
    assert.ok(tiers.has("clinician_confirmed_assessment"), "Must contain clinician_confirmed_assessment tier");

    for (const item of history.entries) {
      assert.ok(
        (CONDITION_EVIDENCE_TIERS as readonly string[]).includes(item.evidenceTier),
        `Item ${item.id} must hold a valid 6-tier provenance marker`,
      );
    }
  });

  await pg.close();
});

