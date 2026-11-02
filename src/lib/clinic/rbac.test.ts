import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import type { Sql } from "../db.ts";
import { insertLabVersion } from "./lab-version.ts";
import { executeExplainPlain } from "./plain.ts";
import { requireClinicianOrAdmin as requireProxyClinicianOrAdmin } from "../../routes/api/-imaging-proxy.ts";
import { updateMenarcheYear } from "./menarche.ts";
import { ingestReport, linkReportQuote } from "../reports/store.ts";
import {
  storeImagingArtifact,
  getImagingArtifact,
  listImagingArtifacts,
} from "../imaging/storage.server.ts";
import {
  resolveUserAuthorization,
  requireAuthenticatedUser,
  requireVerifiedClinicianOrAdmin,
  requireAdmin,
  requirePatientRecordAccess,
  executeGetWorkspace,
  executeSetRole,
  executePromoteUser,
  executeRequestClinicianVerification,
  executeVerifyClinician,
  executeSetActivePatient,
  executeAddSymptom,
  executeAddCycle,
  executeAddLab,
  executeSetMenarcheYear,
  executeCorrectVersion,
  executeSaveLabMeasurement,
  executeAddReview,
  executeDecideCorrespondence,
  executeSaveDicomMeta,
  executeSaveVolumeRegistration,
  executeUploadReport,
  executeLinkReportEvidence,
  executeExportRecord,
  executeSaveEndometriosisRecord,
  executeGetEndometriosisRecords,
  executeSaveOvarianCystRecord,
  executeGetOvarianCystRecords,
  executeSavePcosAssessment,
  executeGetPcosAssessments,
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
];

const COMBINED_MIGRATION_SQL = MIGRATION_FILES.map((file) => readFileSync(file, "utf8")).join("\n");

async function makeDb(): Promise<{ pg: PGlite; sql: Sql }> {
  const pg = new PGlite();
  await pg.exec(COMBINED_MIGRATION_SQL + `\n
    insert into profiles (user_id, display_name, role) values ('patient_user', 'Patient Self', 'patient');
    insert into profiles (user_id, display_name, role) values ('unverified_clinician', 'Dr Unverified', 'clinician');
    insert into profiles (user_id, display_name, role) values ('pending_clinician', 'Dr Pending', 'clinician');
    insert into profiles (user_id, display_name, role) values ('approved_clinician', 'Dr Approved', 'clinician');
    insert into profiles (user_id, display_name, role) values ('rejected_clinician', 'Dr Rejected', 'clinician');
    insert into profiles (user_id, display_name, role) values ('suspended_clinician', 'Dr Suspended', 'clinician');
    insert into profiles (user_id, display_name, role) values ('revoked_clinician', 'Dr Revoked', 'clinician');
    insert into profiles (user_id, display_name, role) values ('admin_user', 'Administrator', 'admin');

    insert into clinician_verifications (id, user_id, licence_no, registry, evidence_note, status)
      values ('v_pending', 'pending_clinician', 'LIC-PEND', 'GMC', 'Pending check', 'pending');
    insert into clinician_verifications (id, user_id, licence_no, registry, evidence_note, status, decided_by, decided_at, reason)
      values ('v_approved', 'approved_clinician', 'LIC-APP', 'GMC', 'Verified OB/GYN', 'approved', 'admin_user', now(), 'Approved');
    insert into clinician_verifications (id, user_id, licence_no, registry, evidence_note, status, decided_by, decided_at, reason)
      values ('v_rejected', 'rejected_clinician', 'LIC-REJ', 'GMC', 'Invalid number', 'rejected', 'admin_user', now(), 'Registry mismatch');
    insert into clinician_verifications (id, user_id, licence_no, registry, evidence_note, status, decided_by, decided_at, reason)
      values ('v_suspended', 'suspended_clinician', 'LIC-SUSP', 'GMC', 'Audit hold', 'suspended', 'admin_user', now(), 'Suspended pending audit');
    insert into clinician_verifications (id, user_id, licence_no, registry, evidence_note, status, decided_by, decided_at, reason)
      values ('v_revoked', 'revoked_clinician', 'LIC-REV', 'GMC', 'Expired', 'revoked', 'admin_user', now(), 'Expired licence');

    insert into patients (id, user_id, code, display_name, year_of_birth, pathway, synopsis, is_self)
      values ('p_clin', 'approved_clinician', 'P01', 'Meera Patel', 1989, 'fibroids', 'Demo record', false);
    insert into patients (id, user_id, code, display_name, year_of_birth, pathway, synopsis, is_self)
      values ('p_pat_self', 'patient_user', 'P02', 'Self Patient', 1992, 'fibroids', 'Self record', true);
    insert into patients (id, user_id, code, display_name, year_of_birth, pathway, synopsis, is_self)
      values ('p_pat_other', 'patient_user', 'P03', 'Other Patient', 1985, 'fibroids', 'Other record', false);

    insert into studies (id, user_id, patient_id, modality, study_date, description, accession, source_note)
      values ('s_clin', 'approved_clinician', 'p_clin', 'MR', '2026-01-01', 'Initial MRI', 'ACC-01', 'Synthetic');
    insert into series (id, user_id, study_id, series_number, description, plane, slice_thickness_mm, pixel_spacing_mm, slice_count)
      values ('ser_clin_1', 'approved_clinician', 's_clin', 1, 'T2 Sagittal', 'sagittal', 3.0, '0.7\\0.7', 32);
    insert into series (id, user_id, study_id, series_number, description, plane, slice_thickness_mm, pixel_spacing_mm, slice_count)
      values ('ser_clin_2', 'approved_clinician', 's_clin', 2, 'T2 Axial', 'axial', 3.0, '0.7\\0.7', 32);
    insert into findings (id, user_id, patient_id, code, structure, organ, pathway)
      values ('f_clin', 'approved_clinician', 'p_clin', 'F1', 'fibroid', 'uterus', 'fibroids');
    insert into finding_versions (id, user_id, finding_id, version_no, study_id, observed_on, location_label, figo, axes_mm, longest_mm, measurement_basis, frame, segmentation_source, change_reason, modality)
      values ('v_clin', 'approved_clinician', 'f_clin', 1, 's_clin', '2026-01-01', 'FIGO 4', '4', '[30,20,15]', 30, 'seeded', 'schematic', 'demo', 'initial', 'MR');
    insert into correspondences (id, user_id, patient_id, from_version_id, to_version_id, category, score, rationale, provisional, engine_version)
      values ('c_clin', 'approved_clinician', 'p_clin', 'v_clin', 'v_clin', 'uncertain', 0.5, 'Seeded', true, 'reprotrace-rules-0.2');
  `);

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

test("RBAC 1: Unauthenticated users are rejected across all protected operations", async () => {
  const { sql } = await makeDb();

  assert.throws(
    () => requireAuthenticatedUser(null),
    /Unauthorized: Authentication is required/,
  );
  assert.throws(
    () => requireAuthenticatedUser("   "),
    /Unauthorized: Authentication is required/,
  );
  await assert.rejects(
    () => requireVerifiedClinicianOrAdmin(sql, null as unknown as string),
    /Unauthorized: Authentication is required/,
  );
  await assert.rejects(
    () => requireAdmin(sql, undefined as unknown as string),
    /Unauthorized: Authentication is required/,
  );
});

test("RBAC 2: Role string alone is never sufficient to establish clinician verification", async () => {
  const { sql, pg } = await makeDb();

  // unverified_clinician has role='clinician' in profiles, but NO record in clinician_verifications
  const unverifiedAuth = await resolveUserAuthorization(sql, "unverified_clinician");
  assert.equal(unverifiedAuth.role, "clinician");
  assert.equal(unverifiedAuth.verificationStatus, "unverified");
  assert.equal(unverifiedAuth.isVerifiedClinician, false);
  assert.equal(unverifiedAuth.effectiveRole, "patient");

  await assert.rejects(
    () => requireVerifiedClinicianOrAdmin(sql, "unverified_clinician"),
    /status: unverified/,
  );

  // Even direct DB-level helpers reject unverified_clinician
  await pg.exec(`
    insert into patients (id, user_id, code, display_name, year_of_birth, pathway, synopsis, is_self)
      values ('p_unver', 'unverified_clinician', 'PU', 'Unverified Pat', 1990, 'fibroids', 'Test', false);
    insert into studies (id, user_id, patient_id, modality, study_date, description, accession, source_note)
      values ('s_unver', 'unverified_clinician', 'p_unver', 'MR', '2026-01-01', 'MRI', 'ACC-U', 'Seed');
    insert into findings (id, user_id, patient_id, code, structure, organ, pathway)
      values ('f_unver', 'unverified_clinician', 'p_unver', 'FU1', 'fibroid', 'uterus', 'fibroids');
    insert into finding_versions (id, user_id, finding_id, version_no, study_id, observed_on, location_label, figo, axes_mm, longest_mm, measurement_basis, frame, segmentation_source, change_reason, modality)
      values ('v_unver', 'unverified_clinician', 'f_unver', 1, 's_unver', '2026-01-01', 'FIGO 4', '4', '[20,15,10]', 20, 'seeded', 'schematic', 'demo', 'initial', 'MR');
  `);

  await assert.rejects(
    () =>
      insertLabVersion(sql, "unverified_clinician", {
        findingId: "f_unver",
        axes: [25, 20, 15],
        longest: 25,
        sliceIndex: 4,
        reason: "Attempted measurement without verification",
        evidenceNote: "note",
      }),
    /Clinician verification is not approved/,
  );

  await assert.rejects(
    () =>
      ingestReport(sql, "unverified_clinician", {
        patientId: "p_unver",
        studyId: null,
        newStudy: { modality: "MR", date: "2026-02-01", description: "Pelvic MRI" },
        fileName: "report.txt",
        fileKind: "txt",
        sha256: "a".repeat(64),
        text: "Uterus measures 80 x 50 x 40 mm with a 30 mm intramural fibroid.",
        warnings: [],
      }),
    /Clinician verification is not approved/,
  );
});

test("RBAC 3: Verification statuses (pending, approved, verified, rejected, suspended, revoked) are strictly enforced", async () => {
  const { sql } = await makeDb();

  // Pending clinician -> rejected
  await assert.rejects(
    () => requireVerifiedClinicianOrAdmin(sql, "pending_clinician"),
    /status: pending/,
  );

  // Rejected clinician -> rejected
  await assert.rejects(
    () => requireVerifiedClinicianOrAdmin(sql, "rejected_clinician"),
    /status: rejected/,
  );

  // Suspended clinician -> rejected
  await assert.rejects(
    () => requireVerifiedClinicianOrAdmin(sql, "suspended_clinician"),
    /status: suspended/,
  );

  // Revoked clinician -> rejected
  await assert.rejects(
    () => requireVerifiedClinicianOrAdmin(sql, "revoked_clinician"),
    /status: revoked/,
  );

  // Approved clinician -> allowed
  const approvedAuth = await requireVerifiedClinicianOrAdmin(sql, "approved_clinician");
  assert.equal(approvedAuth.isVerifiedClinician, true);

  // Verified status -> allowed
  await sql`update clinician_verifications set status = 'verified' where id = 'v_approved'`;
  const verifiedAuth = await requireVerifiedClinicianOrAdmin(sql, "approved_clinician");
  assert.equal(verifiedAuth.isVerifiedClinician, true);

  // Administrator -> allowed
  const adminAuth = await requireVerifiedClinicianOrAdmin(sql, "admin_user");
  assert.equal(adminAuth.isAdmin, true);
});

test("RBAC 4: promoteUser cannot bypass the clinician verification workflow", async () => {
  const { sql } = await makeDb();

  // Patient or clinician cannot call promoteUser
  await assert.rejects(
    () =>
      executePromoteUser(sql, "patient_user", {
        targetUserId: "patient_user",
        newRole: "clinician",
      }),
    /Only administrators/,
  );
  await assert.rejects(
    () =>
      executePromoteUser(sql, "approved_clinician", {
        targetUserId: "patient_user",
        newRole: "clinician",
      }),
    /Only administrators/,
  );

  // Even an administrator CANNOT promote an unverified, pending, rejected, suspended, or revoked user to 'clinician' via promoteUser!
  for (const target of [
    "patient_user",
    "unverified_clinician",
    "pending_clinician",
    "rejected_clinician",
    "suspended_clinician",
    "revoked_clinician",
  ]) {
    await assert.rejects(
      () =>
        executePromoteUser(sql, "admin_user", {
          targetUserId: target,
          newRole: "clinician",
        }),
      /Verification workflow required/,
    );
  }

  // Once the user submits verification and admin approves it via executeVerifyClinician, promoteUser to clinician succeeds
  const reqRes = await executeRequestClinicianVerification(sql, "patient_user", {
    licenceNo: "GMC-998877",
    registry: "GMC",
    evidenceNote: "Board certified",
  });
  await executeVerifyClinician(sql, "admin_user", {
    verificationId: reqRes.verificationId,
    decision: "approved",
    reason: "Confirmed in GMC register",
  });

  // Admin can demote to patient and then re-promote to clinician because approved verification exists
  await executePromoteUser(sql, "admin_user", {
    targetUserId: "patient_user",
    newRole: "patient",
  });
  const promoted = await executePromoteUser(sql, "admin_user", {
    targetUserId: "patient_user",
    newRole: "clinician",
  });
  assert.equal(promoted.newRole, "clinician");

  // Reset patient_user back to patient for subsequent tests
  await executeVerifyClinician(sql, "admin_user", {
    verificationId: reqRes.verificationId,
    decision: "revoked",
    reason: "Test cleanup",
  });
});

test("RBAC 5: Only administrators can approve, reject, suspend, or revoke clinician verification, and audit records are created", async () => {
  const { sql } = await makeDb();

  // Non-admins cannot call executeVerifyClinician for any decision
  for (const caller of ["patient_user", "unverified_clinician", "pending_clinician", "approved_clinician", "revoked_clinician"]) {
    for (const decision of ["approved", "verified", "rejected", "suspended", "revoked"] as const) {
      await assert.rejects(
        () =>
          executeVerifyClinician(sql, caller, {
            verificationId: "v_pending",
            decision,
            reason: "Attempted unauthorized verification decision",
          }),
        /Only administrators/,
      );
    }
  }

  // Admin approves pending_clinician -> status='approved', role='clinician', audit recorded
  const approveRes = await executeVerifyClinician(sql, "admin_user", {
    verificationId: "v_pending",
    decision: "approved",
    reason: "Licence verified with GMC",
  });
  assert.equal(approveRes.decision, "approved");
  assert.equal(approveRes.newRole, "clinician");
  const afterApprove = await requireVerifiedClinicianOrAdmin(sql, "pending_clinician");
  assert.equal(afterApprove.isVerifiedClinician, true);

  // Admin suspends pending_clinician -> immediately loses access, role='patient', audit recorded
  const suspendRes = await executeVerifyClinician(sql, "admin_user", {
    verificationId: "v_pending",
    decision: "suspended",
    reason: "Temporary credential suspension",
  });
  assert.equal(suspendRes.decision, "suspended");
  assert.equal(suspendRes.newRole, "patient");
  await assert.rejects(
    () => requireVerifiedClinicianOrAdmin(sql, "pending_clinician"),
    /status: suspended/,
  );

  // Admin reinstates with 'verified' -> regains access
  await executeVerifyClinician(sql, "admin_user", {
    verificationId: "v_pending",
    decision: "verified",
    reason: "Suspension lifted",
  });
  const afterReinstate = await requireVerifiedClinicianOrAdmin(sql, "pending_clinician");
  assert.equal(afterReinstate.isVerifiedClinician, true);

  // Admin rejects -> loses access immediately
  await executeVerifyClinician(sql, "admin_user", {
    verificationId: "v_pending",
    decision: "rejected",
    reason: "Rejected on secondary review",
  });
  await assert.rejects(
    () => requireVerifiedClinicianOrAdmin(sql, "pending_clinician"),
    /status: rejected/,
  );

  // Admin revokes -> loses access immediately
  await executeVerifyClinician(sql, "admin_user", {
    verificationId: "v_pending",
    decision: "revoked",
    reason: "Credentials revoked",
  });
  await assert.rejects(
    () => requireVerifiedClinicianOrAdmin(sql, "pending_clinician"),
    /status: revoked/,
  );

  // Verify audit trail captured every verification transition
  const audits = await sql<{ action: string; detail: string }>`
    select action, detail from audit_events
    where entity_id = 'v_pending'
    order by at asc
  `;
  const actions = audits.map((a) => a.action);
  assert.ok(actions.includes("verify_clinician"));
  assert.ok(actions.includes("suspend_clinician"));
  assert.ok(actions.includes("reject_clinician"));
  assert.ok(actions.includes("revoke_clinician"));
  assert.equal(audits.length, 5);
});

test("RBAC 6: Revoked clinicians immediately lose privileged access even if profiles.role is tampered with", async () => {
  const { sql } = await makeDb();

  // Initially approved_clinician can perform clinician operations
  const editRes = await executeCorrectVersion(sql, "approved_clinician", {
    versionId: "v_clin",
    axes: [32, 22, 16],
    reason: "Verified clinician measurement update",
  });
  assert.ok(editRes.id);

  // Admin revokes approved_clinician
  await executeVerifyClinician(sql, "admin_user", {
    verificationId: "v_approved",
    decision: "revoked",
    reason: "Revoked immediately",
  });

  // Even if profiles.role were somehow still 'clinician', all clinician operations immediately fail
  await sql`update profiles set role = 'clinician' where user_id = 'approved_clinician'`;

  await assert.rejects(
    () =>
      executeCorrectVersion(sql, "approved_clinician", {
        versionId: "v_clin",
        axes: [34, 24, 18],
        reason: "Post-revocation attempt",
      }),
    /status: revoked/,
  );

  await assert.rejects(
    () =>
      executeSaveLabMeasurement(sql, "approved_clinician", {
        findingId: "f_clin",
        axes: [34, 24, 18],
        longest: 34,
        sliceIndex: 5,
        reason: "Post-revocation lab measurement",
        evidenceNote: "Evidence",
      }),
    /status: revoked/,
  );

  await assert.rejects(
    () =>
      executeAddReview(sql, "approved_clinician", {
        targetType: "finding_version",
        targetId: "v_clin",
        status: "verified",
        note: "Post-revocation review",
      }),
    /status: revoked/,
  );

  await assert.rejects(
    () =>
      executeDecideCorrespondence(sql, "approved_clinician", {
        correspondenceId: "c_clin",
        decision: "accept",
        note: "Post-revocation decision",
      }),
    /status: revoked/,
  );

  // Restore approved_clinician for subsequent tests
  await executeVerifyClinician(sql, "admin_user", {
    verificationId: "v_approved",
    decision: "approved",
    reason: "Restored for subsequent tests",
  });
});

test("RBAC 7: Direct API bypass attempts on all clinician-restricted endpoints are blocked for patient, unverified, pending, rejected, suspended, and revoked accounts", async () => {
  const { sql } = await makeDb();

  const unauthorizedUsers = [
    "patient_user",
    "unverified_clinician",
    "pending_clinician",
    "rejected_clinician",
    "suspended_clinician",
    "revoked_clinician",
  ];

  for (const uid of unauthorizedUsers) {
    // Role escalation attempt via setRole
    await assert.rejects(
      () => executeSetRole(sql, uid, "clinician"),
      /Unauthorized/,
    );
    await assert.rejects(
      () => executeSetRole(sql, uid, "admin"),
      /Unauthorized/,
    );

    // Direct API calls to clinician endpoints
    await assert.rejects(
      () =>
        executeCorrectVersion(sql, uid, {
          versionId: "v_clin",
          axes: [30, 20, 15],
          reason: "Bypass attempt",
        }),
      /Unauthorized/,
    );

    await assert.rejects(
      () =>
        executeSaveLabMeasurement(sql, uid, {
          findingId: "f_clin",
          axes: [30, 20, 15],
          longest: 30,
          sliceIndex: 1,
          reason: "Bypass attempt",
          evidenceNote: "Bypass",
        }),
      /Unauthorized/,
    );

    await assert.rejects(
      () =>
        executeAddReview(sql, uid, {
          targetType: "finding_version",
          targetId: "v_clin",
          status: "verified",
          note: "Bypass attempt",
        }),
      /Unauthorized/,
    );

    await assert.rejects(
      () =>
        executeDecideCorrespondence(sql, uid, {
          correspondenceId: "c_clin",
          decision: "accept",
          note: "Bypass attempt",
        }),
      /Unauthorized/,
    );

    await assert.rejects(
      () =>
        executeSaveVolumeRegistration(sql, uid, {
          patientId: "p_clin",
          fixedSeriesId: "ser_clin_1",
          movingSeriesId: "ser_clin_2",
          matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
          nccScore: 0.9,
          residualMm: 1.2,
          status: "verified",
        }),
      /Unauthorized/,
    );

    await assert.rejects(
      () =>
        executeUploadReport(sql, uid, {
          patientId: "p_clin",
          studyId: "s_clin",
          newStudy: null,
          fileName: "bypass.txt",
          fileKind: "txt",
          sha256: "b".repeat(64),
          text: "Bypass report text over twenty chars.",
          warnings: [],
        }),
      /Unauthorized/,
    );

    await assert.rejects(
      () =>
        executeSaveEndometriosisRecord(sql, uid, {
          patientId: "p_clin",
          lesionSites: ["Uterosacral"],
          surgicalHistory: "None",
          stagingRASRM: "Stage I",
          imagingNote: "Note",
        }),
      /Unauthorized/,
    );

    await assert.rejects(
      () =>
        executeSaveOvarianCystRecord(sql, uid, {
          patientId: "p_clin",
          laterality: "left",
          maxDiameterMm: 25,
          featuresText: "Simple",
          clinicalNote: "Note",
        }),
      /Unauthorized/,
    );

    await assert.rejects(
      () =>
        executeSavePcosAssessment(sql, uid, {
          patientId: "p_clin",
          cycleIrregularity: true,
          hyperandrogenismClinical: true,
          hyperandrogenismBiochemical: false,
          ultrasoundOrAmhFeatures: false,
          notes: "Note",
        }),
      /Unauthorized/,
    );
  }
});

test("RBAC 8: Patients cannot access or modify another patient's records on the backend or database", async () => {
  const { sql, pg } = await makeDb();

  // Add findings and clinical records on both p_pat_self and p_pat_other under patient_user
  await pg.exec(`
    insert into findings (id, user_id, patient_id, code, structure, organ, pathway)
      values ('f_self', 'patient_user', 'p_pat_self', 'FS1', 'fibroid', 'uterus', 'fibroids');
    insert into findings (id, user_id, patient_id, code, structure, organ, pathway)
      values ('f_other', 'patient_user', 'p_pat_other', 'FO1', 'fibroid', 'uterus', 'fibroids');
    insert into symptoms (id, user_id, patient_id, recorded_on, region, intensity, description, source)
      values ('sym_self', 'patient_user', 'p_pat_self', '2026-01-01', 'Deep pelvis', 4, 'Self symptom', 'patient_reported');
    insert into symptoms (id, user_id, patient_id, recorded_on, region, intensity, description, source)
      values ('sym_other', 'patient_user', 'p_pat_other', '2026-01-01', 'Deep pelvis', 8, 'Other patient confidential symptom', 'patient_reported');
  `);

  // 1. executeGetWorkspace for patient_user must ONLY return p_pat_self and its records, never p_pat_other
  const ws = await executeGetWorkspace(sql, "patient_user");
  assert.equal(ws.patients.length, 1);
  assert.equal(ws.patients[0].id, "p_pat_self");
  assert.equal(ws.findings.length, 1);
  assert.equal(ws.findings[0].id, "f_self");
  assert.equal(ws.symptoms.length, 1);
  assert.equal(ws.symptoms[0].id, "sym_self");
  assert.ok(((ws.verifications ?? []) as any[]).every((v) => v.user_id === "patient_user"));

  // 2. Patient can modify their own record (p_pat_self)
  await executeSetActivePatient(sql, "patient_user", "p_pat_self");
  await executeAddSymptom(sql, "patient_user", {
    patientId: "p_pat_self",
    region: "Low back",
    intensity: 3,
    cycleDay: 5,
    description: "Mild ache",
    recordedOn: "2026-02-01",
  });
  await executeAddCycle(sql, "patient_user", {
    patientId: "p_pat_self",
    startDate: "2026-02-01",
    lengthDays: 29,
    flow: "moderate",
    note: "Regular",
  });
  await executeAddLab(sql, "patient_user", {
    patientId: "p_pat_self",
    observedOn: "2026-02-01",
    analyte: "Hb",
    valueText: "12.5",
    unit: "g/dL",
    referenceText: "12-16",
  });
  await executeSetMenarcheYear(sql, "patient_user", {
    patientId: "p_pat_self",
    menarcheYear: 2005,
    reason: "Self-reported menarche year",
  });
  const selfExport = await executeExportRecord(sql, "patient_user", "p_pat_self");
  assert.equal((selfExport.patient as { id: string }).id, "p_pat_self");

  // 3. Patient CANNOT access or modify p_pat_other (non-self record in same workspace) or p_clin (other user's record)
  for (const forbiddenPid of ["p_pat_other", "p_clin"]) {
    await assert.rejects(
      () => requirePatientRecordAccess(sql, "patient_user", forbiddenPid, "read"),
      /Unauthorized|Record not found/,
    );
    await assert.rejects(
      () => executeSetActivePatient(sql, "patient_user", forbiddenPid),
      /Unauthorized|Record not found/,
    );
    await assert.rejects(
      () =>
        executeAddSymptom(sql, "patient_user", {
          patientId: forbiddenPid,
          region: "Low back",
          intensity: 5,
          cycleDay: null,
          description: "Unauthorized write",
          recordedOn: "2026-02-01",
        }),
      /Unauthorized|Record not found/,
    );
    await assert.rejects(
      () =>
        executeAddCycle(sql, "patient_user", {
          patientId: forbiddenPid,
          startDate: "2026-02-01",
          lengthDays: 28,
          flow: "heavy",
          note: "Unauthorized write",
        }),
      /Unauthorized|Record not found/,
    );
    await assert.rejects(
      () =>
        executeAddLab(sql, "patient_user", {
          patientId: forbiddenPid,
          observedOn: "2026-02-01",
          analyte: "FSH",
          valueText: "6.1",
          unit: "IU/L",
          referenceText: "3-10",
        }),
      /Unauthorized|Record not found/,
    );
    await assert.rejects(
      () =>
        executeSetMenarcheYear(sql, "patient_user", {
          patientId: forbiddenPid,
          menarcheYear: 2000,
          reason: "Unauthorized menarche update",
        }),
      /Unauthorized|Record not found/,
    );
    await assert.rejects(
      () =>
        updateMenarcheYear(sql, "patient_user", {
          patientId: forbiddenPid,
          menarcheYear: 2000,
          reason: "Direct DB helper bypass attempt",
        }),
      /Unauthorized|Record not found/,
    );
    await assert.rejects(
      () => executeExportRecord(sql, "patient_user", forbiddenPid),
      /Unauthorized|Record not found/,
    );
    await assert.rejects(
      () =>
        executeSaveDicomMeta(sql, "patient_user", {
          patientId: forbiddenPid,
          fileName: "scan.dcm",
          transferSyntax: "1.2.840.10008.1.2.1",
          metadata: { Modality: "MR" },
          warnings: [],
        }),
      /Unauthorized|Record not found/,
    );
    await assert.rejects(
      () => executeGetEndometriosisRecords(sql, "patient_user", forbiddenPid),
      /Unauthorized|Record not found/,
    );
    await assert.rejects(
      () => executeGetOvarianCystRecords(sql, "patient_user", forbiddenPid),
      /Unauthorized|Record not found/,
    );
    await assert.rejects(
      () => executeGetPcosAssessments(sql, "patient_user", forbiddenPid),
      /Unauthorized|Record not found/,
    );
  }
});

test("RBAC 9: Imaging storage and report store enforce clinician verification and patient isolation", async () => {
  const { sql } = await makeDb();

  // Patient or unverified clinician cannot store imaging artifacts
  await assert.rejects(
    () =>
      storeImagingArtifact(sql, {
        userId: "patient_user",
        patientId: "p_pat_self",
        kind: "mask",
        mimeType: "application/octet-stream",
        filename: "mask.bin",
        data: new Uint8Array([1, 2, 3, 4]),
      }),
    /Unauthorized/,
  );

  await sql`
    insert into patients (id, user_id, code, display_name, year_of_birth, pathway, synopsis, is_self)
      values ('p_unver_img', 'unverified_clinician', 'PUI', 'Unverified Img Pat', 1990, 'fibroids', 'Test', false)
  `;
  await assert.rejects(
    () =>
      storeImagingArtifact(sql, {
        userId: "unverified_clinician",
        patientId: "p_unver_img",
        kind: "mask",
        mimeType: "application/octet-stream",
        filename: "mask.bin",
        data: new Uint8Array([1, 2, 3, 4]),
      }),
    /Unauthorized/,
  );

  // Approved clinician can store and retrieve imaging artifact on their patient
  const stored = await storeImagingArtifact(sql, {
    userId: "approved_clinician",
    patientId: "p_clin",
    studyId: "s_clin",
    seriesId: "ser_clin_1",
    kind: "mask",
    mimeType: "application/octet-stream",
    filename: "mask.bin",
    data: new Uint8Array([10, 20, 30, 40]),
  });
  assert.ok(stored.id);

  const fetched = await getImagingArtifact(sql, "approved_clinician", stored.id);
  assert.ok(fetched);
  assert.ok(fetched?.data);
  assert.equal(fetched?.data?.byteLength, 4);

  // Patient cannot list or fetch clinician's artifact or non-self patient artifacts
  await assert.rejects(
    () => listImagingArtifacts(sql, "patient_user", "p_pat_other"),
    /Unauthorized/,
  );

  // Approved clinician can ingest and link report
  const bodyText = "Pelvic MRI reveals a FIGO 4 intramural fibroid measuring 30 mm in the anterior wall.";
  const rep = await ingestReport(sql, "approved_clinician", {
    patientId: "p_clin",
    studyId: "s_clin",
    newStudy: null,
    fileName: "mri-report.txt",
    fileKind: "txt",
    sha256: "c".repeat(64),
    text: bodyText,
    warnings: [],
  });
  assert.ok(rep.reportId);

  const quote = "FIGO 4 intramural fibroid measuring 30 mm";
  const start = bodyText.indexOf(quote);
  const linkId = await linkReportQuote(sql, "approved_clinician", {
    reportId: rep.reportId,
    findingVersionId: "v_clin",
    start,
    end: start + quote.length,
    quote,
    note: "Verified quote link",
  });
  assert.ok(linkId);
});

test("RBAC 10: Imaging proxy and plain-language endpoints enforce identical clinician verification rules", async () => {
  const { sql } = await makeDb();

  // Unauthenticated
  await assert.rejects(
    () => requireProxyClinicianOrAdmin("" as string, sql),
    /Unauthorized/,
  );

  // Patient, unverified, pending, rejected, suspended, and revoked accounts are blocked on both imaging proxy and explainPlain
  for (const uid of [
    "patient_user",
    "unverified_clinician",
    "pending_clinician",
    "rejected_clinician",
    "suspended_clinician",
    "revoked_clinician",
  ]) {
    await assert.rejects(
      () => requireProxyClinicianOrAdmin(uid, sql),
      /Unauthorized/,
    );
    await assert.rejects(
      () =>
        executeExplainPlain(sql, uid, {
          structure: "fibroid",
          location: "FIGO 4",
          quote: "",
          measurement: "30 mm",
          basis: "three-axis",
          verified: true,
        }),
      /Unauthorized/,
    );
  }

  // Approved clinician and administrator are permitted
  assert.equal(await requireProxyClinicianOrAdmin("approved_clinician", sql), "clinician");
  assert.equal(await requireProxyClinicianOrAdmin("admin_user", sql), "admin");

  const plainRes = await executeExplainPlain(sql, "approved_clinician", {
    structure: "fibroid",
    location: "FIGO 4",
    quote: "",
    measurement: "30 mm",
    basis: "three-axis",
    verified: true,
  });
  assert.equal(plainRes.available, true);
});
