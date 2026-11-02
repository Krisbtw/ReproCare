import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import type { Sql } from "../db.ts";
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
} from "./server.ts";

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

async function makeDb(): Promise<{ pg: PGlite; sql: Sql }> {
  const pg = new PGlite();
  await pg.exec(
    COMBINED_MIGRATION_SQL +
      `\n
    insert into profiles (user_id, display_name, role) values ('patient_adult', 'Anya Sharma', 'patient');
    insert into profiles (user_id, display_name, role) values ('patient_adolescent', 'Riya Verma', 'patient');
    insert into profiles (user_id, display_name, role) values ('approved_clinician', 'Dr. Kavita Mehta', 'clinician');
    insert into profiles (user_id, display_name, role) values ('unconsented_clinician', 'Dr. Vikram Rao', 'clinician');
    insert into profiles (user_id, display_name, role) values ('unverified_clinician', 'Dr. Pending', 'clinician');
    insert into profiles (user_id, display_name, role) values ('admin_user', 'System Admin', 'admin');

    insert into clinician_verifications (id, user_id, licence_no, registry, evidence_note, status, decided_by, decided_at, reason)
      values ('v_app_1', 'approved_clinician', 'LIC-APP-1', 'NMC', 'Verified OB/GYN', 'approved', 'admin_user', now(), 'Approved');
    insert into clinician_verifications (id, user_id, licence_no, registry, evidence_note, status, decided_by, decided_at, reason)
      values ('v_app_2', 'unconsented_clinician', 'LIC-APP-2', 'NMC', 'Verified RE', 'approved', 'admin_user', now(), 'Approved');
    insert into clinician_verifications (id, user_id, licence_no, registry, evidence_note, status)
      values ('v_pend_1', 'unverified_clinician', 'LIC-PEND-1', 'NMC', 'Pending check', 'pending');

    insert into patients (id, user_id, code, display_name, year_of_birth, menarche_year, pathway, synopsis, is_self)
      values ('p_adult', 'patient_adult', 'PT-ADULT', 'Anya Sharma', 1992, 2005, 'fibroids', 'Adult reproductive health record', true);
    insert into patients (id, user_id, code, display_name, year_of_birth, menarche_year, pathway, synopsis, is_self)
      values ('p_adolescent', 'patient_adolescent', 'PT-ADOL', 'Riya Verma', 2010, 2022, 'pcos', 'Adolescent reproductive health record', true);

    insert into studies (id, user_id, patient_id, modality, study_date, description, accession, source_note)
      values ('study_1', 'patient_adult', 'p_adult', 'MR', '2026-01-10', 'Pelvic MRI T2', 'ACC-101', 'Baseline MRI');
    insert into findings (id, user_id, patient_id, code, structure, organ, pathway)
      values ('f_fib_1', 'patient_adult', 'p_adult', 'F1', 'fibroid', 'uterus', 'fibroids');
    insert into finding_versions (id, user_id, finding_id, version_no, study_id, observed_on, location_label, figo, axes_mm, longest_mm, measurement_basis, frame, segmentation_source, change_reason, modality)
      values ('fv_fib_1', 'patient_adult', 'f_fib_1', 1, 'study_1', '2026-01-10', 'Posterior corporal wall', '4', '[32,28,25]', 32, 'manual_caliper', 'patient_lps', 'manual', 'baseline', 'MR');

    insert into symptoms (id, user_id, patient_id, recorded_on, region, intensity, description)
      values ('sym_1', 'patient_adult', 'p_adult', '2026-02-01', 'heavy_bleeding', 8, 'Heavy menstrual bleeding for 6 days');
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

  // Grant active patient consent to approved_clinician for both patients
  await executeGrantClinicianConsent(sql, "patient_adult", {
    patientId: "p_adult",
    clinicianUserId: "approved_clinician",
    permissions: ["view_demographics", "view_reports", "view_imaging", "view_findings", "view_longitudinal_history", "add_annotations", "review_ai_findings", "approve_or_reject_findings"],
    scopeNote: "Clinical care and multi-pathway review",
  });
  await executeGrantClinicianConsent(sql, "patient_adolescent", {
    patientId: "p_adolescent",
    clinicianUserId: "approved_clinician",
    permissions: ["view_demographics", "view_reports", "view_imaging", "view_findings", "view_longitudinal_history", "add_annotations", "review_ai_findings", "approve_or_reject_findings"],
    scopeNote: "Adolescent endocrine evaluation",
  });

  return { pg, sql };
}

test("Sprint 5 Task 2A (Uterine Fibroids): records fibroid assessment as unreviewed, computes volume & longitudinal delta, rejects invented FIGO codes, and requires clinician review for confirmation", async () => {
  const { sql } = await makeDb();

  // 1. Reject invented FIGO classification
  await assert.rejects(
    () =>
      executeSaveFibroidAssessment(sql, "approved_clinician", {
        patientId: "p_adult",
        anatomicalLocation: "Posterior uterine wall",
        figoClassification: "FIGO-99-INVENTED",
        axesMm: [40, 36, 32],
      }),
    /Invalid or unsupported FIGO leiomyoma classification/,
  );

  // 2. Record AI-segmented fibroid assessment linked to finding f_fib_1 (prior longest_mm = 32 mm)
  const saved = await executeSaveFibroidAssessment(sql, "approved_clinician", {
    patientId: "p_adult",
    findingId: "f_fib_1",
    studyId: "study_1",
    anatomicalLocation: "Intramural posterior corporal wall",
    figoClassification: "4",
    axesMm: [38, 34, 30],
    segmentationSource: "ai_3d_unet_v1",
    associatedSymptoms: ["Heavy menstrual bleeding", "Pelvic pressure"],
  });

  assert.equal(saved.ok, true);
  assert.equal(saved.record.figo_classification, "4");
  assert.equal(saved.record.longest_mm, 38);
  assert.ok((saved.record.volume_mm3 ?? 0) > 19000);
  // Automatically classifies AI segmentation output as ai_experimental and unreviewed
  assert.equal(saved.record.evidence_tier, "ai_experimental");
  assert.equal(saved.record.review_status, "unreviewed");
  assert.equal(saved.record.clinically_confirmed, false);
  assert.match(saved.record.longitudinal_comparison_note ?? "", /delta \+6\.0 mm/);

  // 3. Clinician reviews and confirms assessment -> upgrades to clinician_confirmed_assessment
  const reviewed = await executeReviewPathwayRecord(sql, "approved_clinician", {
    patientId: "p_adult",
    pathway: "fibroids",
    recordId: saved.id,
    decision: "clinician_confirmed_assessment",
    note: "Confirmed FIGO 4 intramural fibroid on sagittal and axial T2 MRI.",
  });
  assert.equal(reviewed.ok, true);
  assert.equal(reviewed.reviewStatus, "clinician_confirmed_assessment");
  assert.equal(reviewed.evidenceTier, "clinician_confirmed_assessment");

  const list = await executeGetFibroidAssessments(sql, "approved_clinician", "p_adult");
  assert.equal(list.length, 1);
  assert.equal(list[0].clinically_confirmed, true);
});

test("Sprint 5 Task 2B (Endometriosis): enforces that normal imaging never excludes endometriosis and symptoms alone do not localize lesions", async () => {
  const { sql } = await makeDb();

  // 1. Reject claim that normal imaging rules out endometriosis
  await assert.rejects(
    () =>
      executeSaveEndometriosisRecord(sql, "approved_clinician", {
        patientId: "p_adult",
        lesionSites: [],
        surgicalHistory: "None",
        imagingNote: "Normal MRI rules out endometriosis.",
      }),
    /A normal ultrasound or MRI examination must NEVER be treated as excluding endometriosis/,
  );

  // 2. Reject claim that symptom locations localize lesions
  await assert.rejects(
    () =>
      executeSaveEndometriosisRecord(sql, "approved_clinician", {
        patientId: "p_adult",
        lesionSites: [],
        surgicalHistory: "None",
        imagingNote: "Pain localizes lesion to left uterosacral ligament.",
      }),
    /Patient symptom locations must not be used to infer anatomical endometriosis lesion locations/,
  );

  // 3. Valid endometriosis record with normal imaging preserves normal_imaging_excludes_endometriosis = false
  const saved = await executeSaveEndometriosisRecord(sql, "approved_clinician", {
    patientId: "p_adult",
    studyId: "study_1",
    lesionSites: [],
    imagingStatus: "normal_or_no_visible_lesion",
    surgicalHistory: "No prior laparoscopy",
    surgicalConfirmationStatus: "not_performed",
    imagingNote: "No deep infiltrating lesion visible on routine pelvic MRI; superficial peritoneal disease cannot be excluded by imaging.",
    symptomHistory: ["Severe cyclic dysmenorrhea (8/10)", "Deep dyspareunia"],
    menstrualHistoryNote: "28-day regular cycles, 6 days flow",
  });

  assert.equal(saved.ok, true);
  assert.equal(saved.record.imaging_status, "normal_or_no_visible_lesion");
  assert.equal(saved.record.normal_imaging_excludes_endometriosis, false);
  assert.equal(saved.record.symptom_infers_lesion_location, false);
  assert.equal(saved.record.review_status, "unreviewed");
});

test("Sprint 5 Task 2C (Ovarian Cysts): records laterality, measurements, longitudinal comparison, uncertainty flags, and blocks unvalidated benign/malignant claims or invented risk scores", async () => {
  const { sql } = await makeDb();

  // 1. Reject unvalidated benign/malignant claims
  await assert.rejects(
    () =>
      executeSaveOvarianCystRecord(sql, "approved_clinician", {
        patientId: "p_adult",
        laterality: "left",
        maxDiameterMm: 35,
        featuresText: "Thin-walled unilocular cyst",
        clinicalNote: "Classified as definitely benign by automated check.",
      }),
    /Do not classify ovarian cysts as definitively benign or malignant/,
  );

  // 2. Reject invented risk scores
  await assert.rejects(
    () =>
      executeSaveOvarianCystRecord(sql, "approved_clinician", {
        patientId: "p_adult",
        laterality: "right",
        maxDiameterMm: 42,
        featuresText: "Multilocular cyst with risk of malignancy: 12%",
        clinicalNote: "Follow up.",
      }),
    /Do not classify ovarian cysts as definitively benign or malignant or invent unvalidated malignancy risk scores/,
  );

  // 3. Record baseline left ovarian cyst (34 mm) and follow-up left ovarian cyst (41 mm) with indeterminate morphology
  await executeSaveOvarianCystRecord(sql, "approved_clinician", {
    patientId: "p_adult",
    laterality: "left",
    anatomicalLocation: "Left ovary posterior cortex",
    maxDiameterMm: 34,
    morphologyCategory: "simple_unilocular",
    featuresText: "Anechoic fluid, smooth thin wall, no solid components",
    followUpMonths: 3,
    clinicalNote: "Baseline simple adnexal cyst.",
  });

  const followUp = await executeSaveOvarianCystRecord(sql, "approved_clinician", {
    patientId: "p_adult",
    laterality: "left",
    anatomicalLocation: "Left ovary posterior cortex",
    maxDiameterMm: 41,
    axesMm: [41, 36, 33],
    morphologyCategory: "indeterminate_incomplete",
    featuresText: "Internal echoes with suboptimal acoustic window",
    associatedSymptoms: ["Intermittent left iliac fossa dull ache"],
    followUpMonths: 2,
    clinicalNote: "Recommend dedicated repeat transvaginal ultrasound.",
  });

  assert.equal(followUp.ok, true);
  assert.equal(followUp.record.laterality, "left");
  assert.equal(followUp.record.uncertainty_flag, true);
  assert.equal(followUp.record.benign_malignant_classified, false);
  assert.equal(followUp.record.historical_comparison?.previousMaxDiameterMm, 34);
  assert.equal(followUp.record.historical_comparison?.diameterDeltaMm, 7);
});

test("Sprint 5 Task 2D (PCOS): separates adult vs adolescent (<8y post-menarche) cohorts, blocks adult Rotterdam/PCOM criteria in adolescents, and never diagnoses PCOS from ovarian appearance alone", async () => {
  const { sql } = await makeDb();

  // 1. Adult patient: ovarian appearance (PCOM) alone without ovulatory dysfunction or hyperandrogenism -> rotterdamCriteriaMet MUST be false
  const adultPcomOnly = await executeSavePcosAssessment(sql, "approved_clinician", {
    patientId: "p_adult",
    cycleIrregularity: false,
    hyperandrogenismClinical: false,
    hyperandrogenismBiochemical: false,
    ultrasoundOrAmhFeatures: true,
    exclusionMimickersChecked: true,
    notes: "Incidental PCOM appearance on pelvic scan; eumenorrheic and normoandrogenic.",
    referenceYear: 2026,
  });
  assert.equal(adultPcomOnly.assessmentCohort, "adult");
  assert.equal(adultPcomOnly.rotterdamCriteriaMet, false);
  assert.equal(adultPcomOnly.record.diagnosis_from_ovarian_appearance_alone_blocked, true);

  // 2. Adult patient meeting 2-of-3 criteria -> rotterdamCriteriaMet is true, still unreviewed until clinician confirmation
  const adultFull = await executeSavePcosAssessment(sql, "approved_clinician", {
    patientId: "p_adult",
    cycleIrregularity: true,
    hyperandrogenismClinical: true,
    hyperandrogenismBiochemical: true,
    ultrasoundOrAmhFeatures: true,
    exclusionMimickersChecked: true,
    hormoneLabs: {
      totalTestosteroneNgDl: 68,
      freeTestosteronePgMl: 6.1,
      lhIuL: 11.8,
      fshIuL: 5.4,
      amhNgMl: 5.9,
      tshMiuL: 1.8,
      prolactinNgMl: 12.0,
      seventeenOhProgesteroneNgDl: 45,
    },
    metabolicContext: {
      bmiKgM2: 26.2,
      fastingGlucoseMgDl: 92,
      hba1cPct: 5.4,
    },
    notes: "Oligo-anovulation and hyperandrogenism with secondary causes excluded.",
    referenceYear: 2026,
  });
  assert.equal(adultFull.assessmentCohort, "adult");
  assert.equal(adultFull.adultCriteriaAllowed, true);
  assert.equal(adultFull.rotterdamCriteriaMet, true);
  assert.equal(adultFull.record.review_status, "unreviewed");

  // 3. Adolescent patient (YOB 2010, menarche 2022 -> 4 years post-menarche in 2026):
  // Adult Rotterdam criteria and ultrasound PCOM criterion must NOT be applied!
  const adolescent = await executeSavePcosAssessment(sql, "approved_clinician", {
    patientId: "p_adolescent",
    cycleIrregularity: true,
    hyperandrogenismClinical: false,
    hyperandrogenismBiochemical: false,
    ultrasoundOrAmhFeatures: true,
    exclusionMimickersChecked: true,
    notes: "Adolescent 4 years post-menarche; multifollicular ovaries cannot be used as adult PCOM criterion.",
    referenceYear: 2026,
  });
  assert.equal(adolescent.assessmentCohort, "adolescent_or_within_8y_menarche");
  assert.equal(adolescent.adultCriteriaAllowed, false);
  assert.equal(adolescent.rotterdamCriteriaMet, false);
  assert.equal(adolescent.record.gynecological_age_years, 4);

  // Attempting to sign off an adolescent PCOS record as a confirmed adult PCOS diagnosis is blocked
  await assert.rejects(
    () =>
      executeReviewPathwayRecord(sql, "approved_clinician", {
        patientId: "p_adolescent",
        pathway: "pcos",
        recordId: adolescent.id,
        decision: "clinician_confirmed_assessment",
        note: "Confirming adult PCOS diagnosis.",
      }),
    /Adult diagnostic PCOS confirmation cannot be signed off for an adolescent/,
  );
});

test("Sprint 5 Task 2E, 2F & 2H: Unified Patient History preserves all 6 evidence provenance tiers without merging conditions and enforces strict RBAC & consent", async () => {
  const { sql } = await makeDb();

  assert.deepEqual(CONDITION_EVIDENCE_TIERS, [
    "patient_reported",
    "imaging_observation",
    "report_extracted",
    "ai_experimental",
    "clinician_reviewed",
    "clinician_confirmed_assessment",
  ]);

  // Add observations across all 4 workflows
  const fib = await executeSaveFibroidAssessment(sql, "approved_clinician", {
    patientId: "p_adult",
    findingId: "f_fib_1",
    studyId: "study_1",
    anatomicalLocation: "Anterior wall",
    figoClassification: "3",
    axesMm: [26, 24, 22],
    segmentationSource: "ai_3d_unet",
  });
  const cyst = await executeSaveOvarianCystRecord(sql, "approved_clinician", {
    patientId: "p_adult",
    laterality: "right",
    maxDiameterMm: 29,
    morphologyCategory: "simple_unilocular",
    featuresText: "Simple unilocular cyst",
    clinicalNote: "Routine observation.",
  });
  await executeReviewPathwayRecord(sql, "approved_clinician", {
    patientId: "p_adult",
    pathway: "ovarian_cyst",
    recordId: cyst.id,
    decision: "clinician_confirmed_assessment",
    note: "Confirmed simple right ovarian cyst.",
  });
  await executeSaveEndometriosisRecord(sql, "approved_clinician", {
    patientId: "p_adult",
    lesionSites: [],
    surgicalHistory: "None",
    imagingNote: "Normal pelvic ultrasound; does not exclude superficial endometriosis.",
  });
  await executeSavePcosAssessment(sql, "approved_clinician", {
    patientId: "p_adult",
    cycleIrregularity: true,
    hyperandrogenismClinical: true,
    hyperandrogenismBiochemical: false,
    ultrasoundOrAmhFeatures: false,
    exclusionMimickersChecked: true,
    notes: "Adult endocrine check.",
  });

  const history = await executeGetUnifiedPatientHistory(sql, "approved_clinician", "p_adult");
  assert.equal(history.patient.id, "p_adult");
  assert.ok(history.entries.length >= 5);

  const tiersPresent = new Set(history.entries.map((e) => e.evidenceTier));
  assert.ok(tiersPresent.has("patient_reported"));
  assert.ok(tiersPresent.has("ai_experimental"));
  assert.ok(tiersPresent.has("clinician_reviewed"));
  assert.ok(tiersPresent.has("clinician_confirmed_assessment"));

  // Distinct conditions remain separate in condition arrays and timeline entries
  assert.equal(history.fibroidAssessments.length, 1);
  assert.equal(history.endometriosisRecords.length, 1);
  assert.equal(history.ovarianCystRecords.length, 1);
  assert.equal(history.pcosAssessments.length, 1);
  assert.equal(
    history.endometriosisRecords[0].normal_imaging_excludes_endometriosis,
    false,
  );
  assert.ok(fib.id !== cyst.id);

  // Unauthorized access checks: unconsented clinician, unverified clinician, and admin (without clinical consent) must be rejected
  await assert.rejects(
    () => executeGetUnifiedPatientHistory(sql, "unconsented_clinician", "p_adult"),
    /Unauthorized|Forbidden/,
  );
  await assert.rejects(
    () => executeGetUnifiedPatientHistory(sql, "unverified_clinician", "p_adult"),
    /Unauthorized|Forbidden/,
  );
  await assert.rejects(
    () => executeGetUnifiedPatientHistory(sql, "admin_user", "p_adult"),
    /Unauthorized|Forbidden/,
  );

  // Patient revokes consent -> approved_clinician immediately loses access
  await executeRevokeClinicianConsent(sql, "patient_adult", {
    patientId: "p_adult",
    clinicianUserId: "approved_clinician",
    reason: "Completed consultation",
  });
  await assert.rejects(
    () => executeGetUnifiedPatientHistory(sql, "approved_clinician", "p_adult"),
    /Unauthorized|Forbidden/,
  );
});
