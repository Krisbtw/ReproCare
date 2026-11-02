/**
 * Sprint 4 Task 1E — Automated Security, Consent Lifecycle, and Granular Permission Tests:
 * 1. Unauthenticated access rejection across all collaboration and consent endpoints.
 * 2. Patient accessing own records vs attempting to access another patient's records.
 * 3. Approved clinician with active consent accessing shared patient records.
 * 4. Approved clinician WITHOUT active consent attempting to access another patient's records.
 * 5. Revoked clinician and suspended clinician immediately losing access even when active consent exists.
 * 6. Expired consent and revoked consent immediately blocking clinician access while preserving append-only audit logs.
 * 7. Granular permission enforcement (`view_demographics`, `view_reports`, `view_imaging`, `view_findings`,
 *    `view_longitudinal_history`, `add_annotations`, `review_ai_findings`, `approve_or_reject_findings`)
 *    and blocking unauthorized permission escalation.
 * 8. Administrators can manage clinician verification and account status, but do NOT automatically receive
 *    unrestricted access to other users' medical records.
 * 9. Preventing users from granting access to themselves (`patient_user_id !== clinician_user_id`) or granting
 *    access on records they do not own.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import type { Sql } from "../db.ts";
import {
  ensure,
  executeGetWorkspace,
  executeRequestClinicianVerification,
  executeVerifyClinician,
  executeGrantClinicianConsent,
  executeRevokeClinicianConsent,
  executeListPatientConsents,
  executeListClinicianConsents,
  executeListApprovedClinicians,
  executeGetConsentAccessHistory,
  executeAddSymptom,
  executeAddReview,
  executeCorrectVersion,
  executeExportRecord,
  executeUploadReport,
  requirePatientRecordAccess,
  DEFAULT_CLINICIAN_PERMISSIONS,
  ALL_CLINICIAN_PERMISSIONS,
} from "./server.ts";

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
  const fn = async <T = Record<string, unknown>>(
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
  (fn as unknown as Sql).query = async <T = Record<string, unknown>>(
    text: string,
    params: unknown[] = [],
  ) => {
    const res = await pg.query<T>(text, params);
    return res.rows;
  };
  return fn as unknown as Sql;
}

async function setupDb(): Promise<{ pg: PGlite; sql: Sql }> {
  const pg = new PGlite();
  for (const file of MIGRATION_FILES) {
    await pg.exec(readFileSync(file, "utf8"));
  }
  return { pg, sql: wrap(pg) };
}

async function createApprovedClinician(
  sql: Sql,
  adminUserId: string,
  clinicianUserId: string,
  licenceNo = "MCI-998877",
  registry = "National Medical Commission (NMC)",
): Promise<string> {
  await ensure(sql, adminUserId);
  await sql`update profiles set role = 'admin', display_name = 'System Admin' where user_id = ${adminUserId}`;
  await ensure(sql, clinicianUserId);
  await sql`update profiles set display_name = ${"Dr. " + clinicianUserId} where user_id = ${clinicianUserId}`;
  const req = await executeRequestClinicianVerification(sql, clinicianUserId, {
    licenceNo,
    registry,
    evidenceNote: "Obstetrics & Gynaecology Consultant",
  });
  await executeVerifyClinician(sql, adminUserId, {
    verificationId: req.verificationId,
    decision: "verified",
    reason: "Verified against NMC medical register",
  });
  return req.verificationId;
}

describe("Sprint 4 Task 1 — Secure Patient-Clinician Collaboration & Granular Consent", () => {
  it("1. Unauthenticated requests are rejected across all consent and collaboration operations", async () => {
    const { pg, sql } = await setupDb();
    try {
      await assert.rejects(
        () =>
          executeGrantClinicianConsent(sql, "", {
            patientId: "p1",
            clinicianUserId: "c1",
          }),
        /Unauthorized: Authentication is required/,
      );
      await assert.rejects(
        () => executeRevokeClinicianConsent(sql, "   ", { consentId: "c1" }),
        /Unauthorized: Authentication is required/,
      );
      await assert.rejects(
        () => executeListPatientConsents(sql, "", "p1"),
        /Unauthorized: Authentication is required/,
      );
      await assert.rejects(
        () => executeListClinicianConsents(sql, ""),
        /Unauthorized: Authentication is required/,
      );
      await assert.rejects(
        () => executeListApprovedClinicians(sql, ""),
        /Unauthorized: Authentication is required/,
      );
      await assert.rejects(
        () => executeGetConsentAccessHistory(sql, "", "p1"),
        /Unauthorized: Authentication is required/,
      );
    } finally {
      await pg.close();
    }
  });

  it("2. Patient can access own record, cannot access another patient's record, and cannot grant access to themselves", async () => {
    const { pg, sql } = await setupDb();
    try {
      await ensure(sql, "patient-alice");
      await ensure(sql, "patient-bob");

      const aliceSelfId = "patient-alice:kavya";
      const bobSelfId = "patient-bob:kavya";

      // Alice can access her own record
      const selfAccess = await requirePatientRecordAccess(
        sql,
        "patient-alice",
        aliceSelfId,
        "view own record",
      );
      assert.equal(selfAccess.patient.id, aliceSelfId);

      // Alice cannot access Bob's record
      await assert.rejects(
        () =>
          requirePatientRecordAccess(
            sql,
            "patient-alice",
            bobSelfId,
            "view another patient record",
          ),
        /Unauthorized: Patients cannot access another patient's medical records/,
      );

      // Alice cannot grant access to herself
      await assert.rejects(
        () =>
          executeGrantClinicianConsent(sql, "patient-alice", {
            patientId: aliceSelfId,
            clinicianUserId: "patient-alice",
          }),
        /Unauthorized: Users cannot grant medical record access to themselves/,
      );

      // Bob cannot grant access on Alice's record
      await createApprovedClinician(sql, "admin-1", "clin-1");
      await assert.rejects(
        () =>
          executeGrantClinicianConsent(sql, "patient-bob", {
            patientId: aliceSelfId,
            clinicianUserId: "clin-1",
          }),
        /Unauthorized: Only the patient who owns this medical record can grant clinician access/,
      );
    } finally {
      await pg.close();
    }
  });

  it("3. Approved clinician WITHOUT active consent is blocked; approved clinician WITH active consent is allowed", async () => {
    const { pg, sql } = await setupDb();
    try {
      await ensure(sql, "patient-owner");
      const patientId = "patient-owner:kavya";
      await createApprovedClinician(sql, "admin-1", "clin-approved");
      await createApprovedClinician(sql, "admin-1", "clin-unassigned", "MCI-222333");

      // Approved clinician without consent is denied cross-user access
      await assert.rejects(
        () =>
          requirePatientRecordAccess(
            sql,
            "clin-approved",
            patientId,
            "view unconsented patient",
          ),
        /Unauthorized: No patient consent exists authorizing this clinician/,
      );

      // Approved clinician directory lists both approved clinicians
      const directory = await executeListApprovedClinicians(sql, "patient-owner");
      assert.ok(directory.some((d) => d.user_id === "clin-approved"));
      assert.ok(directory.some((d) => d.user_id === "clin-unassigned"));

      // Patient grants default read-oriented consent to clin-approved
      const consent = await executeGrantClinicianConsent(sql, "patient-owner", {
        patientId,
        clinicianUserId: "clin-approved",
        scopeNote: "Fibroid specialist consultation",
      });
      assert.equal(consent.status, "active");
      assert.deepEqual(consent.permissions, [...DEFAULT_CLINICIAN_PERMISSIONS]);

      // Now clin-approved can access the patient record and see it in their workspace
      const access = await requirePatientRecordAccess(
        sql,
        "clin-approved",
        patientId,
        "view consented patient",
        "view_demographics",
      );
      assert.equal(access.patient.id, patientId);
      assert.equal(access.consent?.id, consent.id);

      const clinWorkspace = await executeGetWorkspace(sql, "clin-approved");
      assert.ok(clinWorkspace.patients.some((p) => p.id === patientId));

      // clin-unassigned still has no consent and is blocked
      await assert.rejects(
        () =>
          requirePatientRecordAccess(
            sql,
            "clin-unassigned",
            patientId,
            "view unconsented patient",
          ),
        /Unauthorized: No patient consent exists authorizing this clinician/,
      );
    } finally {
      await pg.close();
    }
  });

  it("4. Unverified, pending, rejected, suspended, and revoked clinicians cannot be granted consent or access shared records", async () => {
    const { pg, sql } = await setupDb();
    try {
      await ensure(sql, "patient-owner");
      const patientId = "patient-owner:kavya";

      // Unverified user
      await ensure(sql, "clin-unverified");
      await assert.rejects(
        () =>
          executeGrantClinicianConsent(sql, "patient-owner", {
            patientId,
            clinicianUserId: "clin-unverified",
          }),
        /clinician verification is not approved/,
      );

      // Pending clinician
      await ensure(sql, "clin-pending");
      await executeRequestClinicianVerification(sql, "clin-pending", {
        licenceNo: "MCI-PEND-1",
        registry: "NMC",
        evidenceNote: "Pending review",
      });
      await assert.rejects(
        () =>
          executeGrantClinicianConsent(sql, "patient-owner", {
            patientId,
            clinicianUserId: "clin-pending",
          }),
        /clinician verification is not approved/,
      );

      // Approved clinician who is later suspended and then revoked
      const verifId = await createApprovedClinician(sql, "admin-1", "clin-lifecycle");
      await executeGrantClinicianConsent(sql, "patient-owner", {
        patientId,
        clinicianUserId: "clin-lifecycle",
        permissions: [...ALL_CLINICIAN_PERMISSIONS],
      });

      // Works while verified
      const okAccess = await requirePatientRecordAccess(
        sql,
        "clin-lifecycle",
        patientId,
        "check active access",
      );
      assert.equal(okAccess.patient.id, patientId);

      // Admin suspends clinician -> immediately loses access to consented patient record
      await executeVerifyClinician(sql, "admin-1", {
        verificationId: verifId,
        decision: "suspended",
        reason: "Temporary credential suspension",
      });
      await assert.rejects(
        () =>
          requirePatientRecordAccess(
            sql,
            "clin-lifecycle",
            patientId,
            "access while suspended",
          ),
        /Unauthorized: Clinician verification is not approved \(status: suspended\)/,
      );

      // Admin revokes clinician -> remains blocked even if profiles.role is tampered with
      await executeVerifyClinician(sql, "admin-1", {
        verificationId: verifId,
        decision: "revoked",
        reason: "Credential revoked",
      });
      await sql`update profiles set role = 'clinician' where user_id = ${"clin-lifecycle"}`;
      await assert.rejects(
        () =>
          requirePatientRecordAccess(
            sql,
            "clin-lifecycle",
            patientId,
            "access while revoked",
          ),
        /Unauthorized: Clinician verification is not approved \(status: revoked\)/,
      );
    } finally {
      await pg.close();
    }
  });

  it("5. Administrators manage clinician verification and account status, but do NOT automatically receive unrestricted access to other users' medical records", async () => {
    const { pg, sql } = await setupDb();
    try {
      await ensure(sql, "patient-private");
      const patientId = "patient-private:kavya";

      await ensure(sql, "admin-only");
      await sql`update profiles set role = 'admin' where user_id = ${"admin-only"}`;

      // Admin cannot read, export, or modify another user's medical record
      await assert.rejects(
        () =>
          requirePatientRecordAccess(
            sql,
            "admin-only",
            patientId,
            "admin attempting to read patient record",
          ),
        /Administrators manage clinician verification and account status, and do not automatically receive unrestricted access/,
      );

      await assert.rejects(
        () => executeExportRecord(sql, "admin-only", patientId),
        /Administrators manage clinician verification and account status, and do not automatically receive unrestricted access/,
      );
    } finally {
      await pg.close();
    }
  });

  it("6. Granular permission enforcement blocks unauthorized write/approval operations when only read permissions are granted", async () => {
    const { pg, sql } = await setupDb();
    try {
      await ensure(sql, "patient-granular");
      const patientId = "patient-granular:kavya";
      await createApprovedClinician(sql, "admin-1", "clin-readonly");

      // Grant only view_demographics and view_reports (no findings write, no review_ai_findings, no approve_or_reject_findings)
      await executeGrantClinicianConsent(sql, "patient-granular", {
        patientId,
        clinicianUserId: "clin-readonly",
        permissions: ["view_demographics", "view_reports"],
      });

      // Allowed: view_demographics and view_reports
      await requirePatientRecordAccess(
        sql,
        "clin-readonly",
        patientId,
        "view report",
        "view_reports",
      );

      // Denied: view_imaging
      await assert.rejects(
        () =>
          requirePatientRecordAccess(
            sql,
            "clin-readonly",
            patientId,
            "view imaging",
            "view_imaging",
          ),
        /Consent does not include the required 'view_imaging' permission/,
      );

      // Denied: add_annotations (e.g., adding symptom or uploading report on patient's record)
      await assert.rejects(
        () =>
          executeAddSymptom(sql, "clin-readonly", {
            patientId,
            region: "Deep pelvis",
            intensity: 4,
            cycleDay: 12,
            description: "Attempted annotation without permission",
            recordedOn: "2026-03-01",
          }),
        /Consent does not include the required 'add_annotations' permission/,
      );

      // Denied: approve_or_reject_findings (e.g., editing a finding version)
      const versionRows = await sql<{ id: string }>`
        select fv.id
        from finding_versions fv
        join findings f on f.id = fv.finding_id
        where f.patient_id = ${patientId}
        limit 1
      `;
      await assert.rejects(
        () =>
          executeCorrectVersion(sql, "clin-readonly", {
            versionId: versionRows[0].id,
            axes: [35, 30, 28],
            reason: "Attempted edit without approve_or_reject_findings permission",
          }),
        /Consent does not include the required 'approve_or_reject_findings' permission/,
      );

      // Denied: review_ai_findings
      await assert.rejects(
        () =>
          executeAddReview(sql, "clin-readonly", {
            targetType: "finding_version",
            targetId: versionRows[0].id,
            status: "verified",
            note: "Attempted review without review_ai_findings permission",
          }),
        /Consent does not include the required 'review_ai_findings' permission/,
      );

      // Now patient updates consent to grant review_ai_findings and approve_or_reject_findings
      await executeGrantClinicianConsent(sql, "patient-granular", {
        patientId,
        clinicianUserId: "clin-readonly",
        permissions: [
          "view_demographics",
          "view_findings",
          "review_ai_findings",
          "approve_or_reject_findings",
        ],
      });

      const revRes = await executeAddReview(sql, "clin-readonly", {
        targetType: "finding_version",
        targetId: versionRows[0].id,
        status: "verified",
        note: "Authorized review after consent upgrade",
      });
      assert.equal(revRes.ok, true);

      const editRes = await executeCorrectVersion(sql, "clin-readonly", {
        versionId: versionRows[0].id,
        axes: [35, 30, 28],
        reason: "Authorized measurement update after consent upgrade",
      });
      assert.equal(editRes.ok, true);
    } finally {
      await pg.close();
    }
  });

  it("7. Consent revocation and consent expiration immediately block access while preserving full append-only audit history", async () => {
    const { pg, sql } = await setupDb();
    try {
      await ensure(sql, "patient-lifecycle");
      const patientId = "patient-lifecycle:kavya";
      await createApprovedClinician(sql, "admin-1", "clin-temp");

      const consent = await executeGrantClinicianConsent(sql, "patient-lifecycle", {
        patientId,
        clinicianUserId: "clin-temp",
        permissions: [...DEFAULT_CLINICIAN_PERMISSIONS],
      });

      // Clinician accesses record once (logged in consent_access_logs)
      await requirePatientRecordAccess(
        sql,
        "clin-temp",
        patientId,
        "initial consultation",
        "view_demographics",
      );

      // Patient revokes consent immediately
      const revokeRes = await executeRevokeClinicianConsent(sql, "patient-lifecycle", {
        consentId: consent.id,
        reason: "Consultation completed",
      });
      assert.equal(revokeRes.status, "revoked");

      // Immediate access refusal after revocation
      await assert.rejects(
        () =>
          requirePatientRecordAccess(
            sql,
            "clin-temp",
            patientId,
            "post-revocation access attempt",
          ),
        /Patient consent for this record has been revoked/,
      );

      // Test expired consent lifecycle
      const futureIso = new Date(Date.now() + 60_000).toISOString();
      const expiringConsent = await executeGrantClinicianConsent(sql, "patient-lifecycle", {
        patientId,
        clinicianUserId: "clin-temp",
        expiresAt: futureIso,
      });
      // Backdate expires_at to the past to simulate expiry
      await sql`
        update patient_clinician_consents
        set expires_at = '2020-01-01T00:00:00.000Z'
        where id = ${expiringConsent.id}
      `;

      await assert.rejects(
        () =>
          requirePatientRecordAccess(
            sql,
            "clin-temp",
            patientId,
            "post-expiration access attempt",
          ),
        /Patient consent for this record has expired/,
      );

      // Verify historical consent rows and access audit history were NEVER deleted
      const allConsents = await executeListPatientConsents(
        sql,
        "patient-lifecycle",
        patientId,
      );
      assert.equal(allConsents.length, 2);
      assert.ok(allConsents.some((c) => c.status === "revoked"));
      assert.ok(allConsents.some((c) => c.status === "expired"));

      const history = await executeGetConsentAccessHistory(
        sql,
        "patient-lifecycle",
        patientId,
      );
      assert.ok(history.length >= 4);
      assert.ok(history.some((h) => h.action === "grant_consent"));
      assert.ok(history.some((h) => h.action === "revoke_consent"));
    } finally {
      await pg.close();
    }
  });
});
