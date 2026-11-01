import { createServerFn } from "@tanstack/react-start";
import { getSql, type Sql } from "../db.ts";
import { authMiddleware } from "../auth/middleware.ts";
import {
  ENGINE_VERSION,
  matchChronology,
  sameMethodChange,
  MIN_REGISTRATION_NCC_VERIFIED,
  MIN_REGISTRATION_NCC_UNVERIFIED,
  MAX_REGISTRATION_RESIDUAL_MM,
  type Snap,
  type Measure,
  type RegistrationLookupEntry,
  type ClinicianCorrespondenceDecision,
} from "../reprotrace/engine.ts";
import { validateTransformMatrix, type RegistrationTransformInput } from "../imaging/registration.ts";
import {
  storeImagingArtifact,
  getImagingArtifact,
  listImagingArtifacts,
  verifyImagingObjectIntegrity,
  purgeImagingArtifact,
  getHistoricalFindingImagingEvidence,
  type ImagingArtifactKind,
} from "../imaging/storage.server.ts";
import { insertLabVersion, type LabVersionInput } from "./lab-version.ts";
import { applyMenarcheYear } from "./menarche.ts";
import { ingestReport, linkReportQuote, type IngestInput, type QuoteLinkInput } from "../reports/store.ts";
import type {
  ExportPayload,
  VersionRow,
  Workspace,
  ClinicianVerificationRow,
  ClinicianVerificationStatus,
  RegistrationRow,
  EndometriosisRecordItem,
  OvarianCystRecordItem,
  PcosAssessmentItem,
} from "./types.ts";
import {
  CYCLES,
  FINDINGS,
  LABS,
  MODELS,
  PATIENTS,
  REPORTS,
  SERIES,
  STUDIES,
  SYMPTOMS,
  discrepanciesFor,
  proposalsFor,
} from "./story.ts";

export type ClinicianVerificationDecision =
  | "verified"
  | "approved"
  | "rejected"
  | "suspended"
  | "revoked";

export type UserAuthorization = {
  userId: string;
  role: "patient" | "clinician" | "admin";
  storedRole: "patient" | "clinician" | "admin";
  effectiveRole: "patient" | "clinician" | "admin";
  verificationStatus: "unverified" | ClinicianVerificationStatus;
  verificationId: string | null;
  isClinicianVerified: boolean;
  isVerifiedClinician: boolean;
  isAdmin: boolean;
  canPerformClinicianActions: boolean;
};

const VALID_ROLES = new Set(["patient", "clinician", "admin"]);
const VALID_VERIFICATION_DECISIONS = new Set<string>([
  "verified",
  "approved",
  "rejected",
  "suspended",
  "revoked",
]);

function kid(userId: string, key: string): string {
  return `${userId}:${key}`;
}

function asNumber(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

async function audit(
  sql: Sql,
  userId: string,
  action: string,
  entityType: string,
  entityId: string,
  detail: string,
) {
  await sql`insert into audit_events (id, user_id, action, entity_type, entity_id, detail)
    values (${crypto.randomUUID()}, ${userId}, ${action}, ${entityType}, ${entityId}, ${detail})`;
}

/**
 * Ensures the caller has a non-empty authenticated user identifier.
 */
export function requireAuthenticatedUser(userId: string | null | undefined): string {
  if (!userId || typeof userId !== "string" || !userId.trim()) {
    throw new Error("Unauthorized: Authentication is required.");
  }
  return userId.trim();
}

/**
 * Resolves the authoritative authorization state for a user from `profiles` and `clinician_verifications`.
 *
 * Rules enforced:
 * 1. A role string ('clinician') alone is NEVER sufficient to establish clinician privileges.
 * 2. A user with `profiles.role === 'clinician'` must have an active approved verification status
 *    (`status === 'verified'` or `status === 'approved'`) with non-empty licence and registry.
 * 3. Unverified, pending, rejected, suspended, or revoked clinicians are downgraded to effective `'patient'` access.
 * 4. Administrators (`profiles.role === 'admin'`) hold full administrative and clinical privileges.
 */
export async function resolveUserAuthorization(sql: Sql, userId: string): Promise<UserAuthorization> {
  const uid = requireAuthenticatedUser(userId);
  const profileRows = await sql<{ role: string }>`
    select role from profiles where user_id = ${uid}
  `;
  const rawRole = profileRows[0]?.role ?? "patient";
  const storedRole: "patient" | "clinician" | "admin" =
    rawRole === "admin" || rawRole === "clinician" ? rawRole : "patient";

  const verifRows = await sql<{
    id: string;
    status: ClinicianVerificationStatus;
    licence_no: string;
    registry: string;
  }>`
    select id, status, licence_no, registry
    from clinician_verifications
    where user_id = ${uid}
    order by coalesce(decided_at, requested_at) desc, requested_at desc, id desc
    limit 1
  `.catch(() => []);

  const latest = verifRows[0];
  const verificationStatus: "unverified" | ClinicianVerificationStatus = latest?.status ?? "unverified";
  const hasValidCredentials =
    Boolean(latest) &&
    String(latest.licence_no ?? "").trim().length > 0 &&
    String(latest.registry ?? "").trim().length > 0;
  const isClinicianVerified =
    hasValidCredentials &&
    (verificationStatus === "verified" || verificationStatus === "approved");

  const isAdmin = storedRole === "admin";
  const effectiveRole: "patient" | "clinician" | "admin" = isAdmin
    ? "admin"
    : storedRole === "clinician" && isClinicianVerified
      ? "clinician"
      : "patient";

  return {
    userId: uid,
    role: storedRole,
    storedRole,
    effectiveRole,
    verificationStatus,
    verificationId: latest?.id ?? null,
    isClinicianVerified,
    isVerifiedClinician: isClinicianVerified,
    isAdmin,
    canPerformClinicianActions: isAdmin || (storedRole === "clinician" && isClinicianVerified),
  };
}

/**
 * Enforces that the caller is either an administrator or a clinician with an approved verification status.
 */
export async function requireVerifiedClinicianOrAdmin(
  sql: Sql,
  userId: string,
  actionDescription?: string,
): Promise<UserAuthorization> {
  const auth = await resolveUserAuthorization(sql, userId);
  if (auth.canPerformClinicianActions) {
    return auth;
  }
  const suffix = actionDescription ? ` (${actionDescription})` : "";
  if ((auth.storedRole === "clinician" || auth.verificationStatus !== "unverified") && !auth.isClinicianVerified) {
    throw new Error(
      `Unauthorized: Clinician verification is not approved (status: ${auth.verificationStatus}). Approved administrator verification is required before accessing clinician-restricted operations${suffix}.`,
    );
  }
  throw new Error(
    `Unauthorized: Verified clinician or administrator privileges required${suffix}.`,
  );
}

/**
 * Enforces that the caller is an administrator.
 */
export async function requireAdmin(
  sql: Sql,
  userId: string,
  actionDescription?: string,
): Promise<UserAuthorization> {
  const auth = await resolveUserAuthorization(sql, userId);
  if (!auth.isAdmin) {
    throw new Error(
      `Unauthorized: Only administrators can ${actionDescription ?? "perform this administrative operation"}.`,
    );
  }
  return auth;
}

/**
 * Enforces patient-record ownership and ensures that patients (and unverified clinicians)
 * can only access or modify their own (`is_self = true`) patient record.
 */
export async function requirePatientRecordAccess(
  sql: Sql,
  userId: string,
  patientId: string,
  actionDescription?: string,
): Promise<{ auth: UserAuthorization; patient: Record<string, unknown> & { id: string; is_self: boolean } }> {
  const auth = await resolveUserAuthorization(sql, userId);
  if (!patientId || typeof patientId !== "string" || !patientId.trim()) {
    throw new Error("Record not found.");
  }
  const rows = await sql<Record<string, unknown> & { id: string; is_self: boolean }>`
    select * from patients where id = ${patientId} and user_id = ${auth.userId}
  `;
  const patient = rows[0];
  if (!patient) {
    throw new Error("Record not found.");
  }
  if (!auth.canPerformClinicianActions && !patient.is_self) {
    throw new Error(
      `Unauthorized: Patient view can ${actionDescription ?? "access or modify"} only on your own synthetic record.`,
    );
  }
  return { auth, patient };
}

async function roleOf(sql: Sql, userId: string): Promise<string> {
  const auth = await resolveUserAuthorization(sql, userId);
  return auth.effectiveRole;
}

async function seed(sql: Sql, userId: string) {
  for (const p of PATIENTS) {
    await sql`insert into patients (id, user_id, code, display_name, year_of_birth, pathway, synopsis, is_self, synthetic)
      values (${kid(userId, p.key)}, ${userId}, ${p.code}, ${p.name}, ${p.yob}, ${p.pathway}, ${p.synopsis}, ${p.self}, ${true})`;
  }
  for (const s of STUDIES) {
    await sql`insert into studies (id, user_id, patient_id, modality, study_date, description, accession, synthetic, source_note)
      values (${kid(userId, s.key)}, ${userId}, ${kid(userId, s.patient)}, ${s.modality}, ${s.date}, ${s.description}, ${s.accession}, ${true}, ${s.note})`;
  }
  for (const s of SERIES) {
    await sql`insert into series (id, user_id, study_id, series_number, description, plane, slice_thickness_mm, pixel_spacing_mm, slice_count, quality)
      values (${kid(userId, s.key)}, ${userId}, ${kid(userId, s.study)}, ${s.n}, ${s.description}, ${s.plane}, ${s.thick}, ${s.spacing}, ${s.slices}, ${s.quality})`;
  }
  for (const r of REPORTS) {
    await sql`insert into reports (id, user_id, study_id, report_date, author_role, body, synthetic)
      values (${kid(userId, r.key)}, ${userId}, ${kid(userId, r.study)}, ${r.date}, ${"synthetic reporting clinician"}, ${r.body}, ${true})`;
  }
  for (const f of FINDINGS) {
    await sql`insert into findings (id, user_id, patient_id, code, structure, organ, pathway)
      values (${kid(userId, f.key)}, ${userId}, ${kid(userId, f.patient)}, ${f.code}, ${f.structure}, ${f.organ}, ${f.pathway})`;
    const series = SERIES.find((s) => s.study === f.study);
    const seriesId = series ? kid(userId, series.key) : null;
    for (let index = 0; index < f.versions.length; index += 1) {
      const v = f.versions[index];
      const id = kid(userId, v.key);
      const previous = index === 0 ? null : kid(userId, f.versions[index - 1].key);
      await sql`insert into finding_versions (
        id, user_id, finding_id, version_no, previous_version_id, study_id, observed_on, location_label, figo,
        centroid_mm, axes_mm, longest_mm, measurement_basis, frame, segmentation_source, model_id, quality, modality,
        report_longest_mm, change_reason
      ) values (
        ${id}, ${userId}, ${kid(userId, f.key)}, ${index + 1}, ${previous}, ${kid(userId, f.study)},
        ${(STUDIES.find((s) => s.key === f.study)?.date ?? "2025-01-01")}, ${f.location}, ${f.figo},
        ${f.centroid ? JSON.stringify(f.centroid) : null}, ${v.axes ? JSON.stringify(v.axes) : null}, ${v.longest},
        ${f.basis}, ${f.frame}, ${v.source}, ${v.modelId}, ${f.quality}, ${f.modality}, ${v.reportLongest}, ${v.reason}
      )`;
      const report = REPORTS.find((r) => r.study === f.study);
      await sql`insert into evidence_links (id, user_id, finding_version_id, kind, study_id, series_id, report_id, quote, slice_index, note)
        values (${kid(userId, `${v.key}-ev`)}, ${userId}, ${id}, ${"source"}, ${kid(userId, f.study)},
          ${seriesId}, ${report ? kid(userId, report.key) : null}, ${v.quote}, ${v.slice},
          ${"Link stored with the version. Quotes are from the synthetic report, not an external model."})`;
    }
  }
  for (const s of SYMPTOMS) {
    await sql`insert into symptoms (id, user_id, patient_id, recorded_on, region, intensity, cycle_day, description, source)
      values (${crypto.randomUUID()}, ${userId}, ${kid(userId, s.patient)}, ${s.date}, ${s.region}, ${s.intensity}, ${s.cycleDay}, ${s.description}, ${"patient_reported"})`;
  }
  for (const c of CYCLES) {
    await sql`insert into cycles (id, user_id, patient_id, start_date, length_days, flow, note)
      values (${crypto.randomUUID()}, ${userId}, ${kid(userId, c.patient)}, ${c.start}, ${c.length}, ${c.flow}, ${c.note})`;
  }
  for (const l of LABS) {
    await sql`insert into labs (id, user_id, patient_id, observed_on, analyte, value_text, unit, reference_text, source_note)
      values (${crypto.randomUUID()}, ${userId}, ${kid(userId, l.patient)}, ${l.date}, ${l.analyte}, ${l.value}, ${l.unit}, ${l.ref}, ${l.note})`;
  }
  for (const patient of PATIENTS) {
    for (const p of proposalsFor(patient.key)) {
      await sql`insert into correspondences (id, user_id, patient_id, from_version_id, to_version_id, from_study_id, to_study_id, category, score, rationale, provisional, engine_version, active)
        values (${crypto.randomUUID()}, ${userId}, ${kid(userId, patient.key)},
          ${p.fromId ? kid(userId, p.fromId) : null}, ${p.toId ? kid(userId, p.toId) : null},
          ${p.fromStudyId ? kid(userId, p.fromStudyId) : null}, ${p.toStudyId ? kid(userId, p.toStudyId) : null},
          ${p.category}, ${p.score}, ${p.rationale}, ${p.provisional}, ${ENGINE_VERSION}, ${true})`;
    }
    for (const d of discrepanciesFor(patient.key)) {
      await sql`insert into discrepancies (id, user_id, patient_id, category, summary, detail, left_ref, right_ref, engine_version, active)
        values (${crypto.randomUUID()}, ${userId}, ${kid(userId, patient.key)}, ${d.category}, ${d.summary}, ${d.detail},
          ${d.leftRef ? kid(userId, d.leftRef) : null}, ${d.rightRef ? kid(userId, d.rightRef) : null}, ${ENGINE_VERSION}, ${true})`;
    }
    await sql`insert into consents (id, user_id, patient_id, purpose, granted, note)
      values (${crypto.randomUUID()}, ${userId}, ${kid(userId, patient.key)}, ${"synthetic demonstration"}, ${true},
        ${"Synthetic record only. This is not consent from a real patient."})`;
  }
  await sql`update profiles set active_patient_id = ${kid(userId, "kavya")} where user_id = ${userId}`;
  await audit(sql, userId, "seed", "workspace", userId, "Synthetic clinic loaded. All people and scans are fabricated.");
}

export async function ensure(sql: Sql, userId: string) {
  const uid = requireAuthenticatedUser(userId);
  await sql`insert into profiles (user_id, display_name, role) values (${uid}, ${""}, ${"patient"}) on conflict (user_id) do nothing`;

  // Bootstrap admin role if configured via BOOTSTRAP_ADMIN_EMAILS
  const rawAdminEmails = process.env["BOOTSTRAP_ADMIN_EMAILS"];
  if (rawAdminEmails) {
    const adminEmails = rawAdminEmails.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
    const userRows = await sql<{ email: string }>`select email from "user" where id = ${uid}`.catch(() => []);
    const email = userRows[0]?.email?.toLowerCase();
    if (email && adminEmails.includes(email)) {
      const current = await roleOf(sql, uid);
      if (current !== "admin") {
        await sql`update profiles set role = 'admin' where user_id = ${uid}`;
        await audit(sql, uid, "bootstrap_admin", "profile", uid, `Bootstrapped admin role for ${email}`);
      }
    }
  }

  const n = await sql<{ n: number }>`select count(*)::int as n from patients where user_id = ${uid}`;
  if (asNumber(n[0]?.n) === 0) {
    try {
      await seed(sql, uid);
    } catch (error) {
      const again = await sql<{ n: number }>`select count(*)::int as n from patients where user_id = ${uid}`;
      if (asNumber(again[0]?.n) === 0) throw error;
    }
  }
}

function parseTriple(value: unknown): [number, number, number] | null {
  if (!value) return null;
  const raw = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(raw) || raw.length !== 3) return null;
  return [Number(raw[0]), Number(raw[1]), Number(raw[2])];
}

export async function executeGetWorkspace(sql: Sql, rawUserId: string): Promise<Workspace> {
  const userId = requireAuthenticatedUser(rawUserId);
  await ensure(sql, userId);
  const auth = await resolveUserAuthorization(sql, userId);

  const userProfiles = await sql<{
    user_id: string;
    display_name: string;
    role: string;
    active_patient_id: string | null;
  }>`select user_id, display_name, role, active_patient_id from profiles where user_id = ${userId}`;

  const rawProfile = userProfiles[0] ?? {
    user_id: userId,
    display_name: "",
    role: "patient",
    active_patient_id: null,
  };

  const [
    allPatients,
    allStudies,
    allSeries,
    allReports,
    allFindings,
    allVersions,
    allEvidence,
    allSymptoms,
    allCycles,
    allLabs,
    allCorrespondences,
    allDecisions,
    allDiscrepancies,
    allReviews,
    allConsents,
    allUploads,
    auditRows,
    allExtractions,
    verifications,
    allRegistrations,
    allEndometriosisRecords,
    allOvarianCystRecords,
    allPcosAssessments,
  ] = await Promise.all([
    sql<Workspace["patients"][number]>`select * from patients where user_id = ${userId} order by code`,
    sql<Workspace["studies"][number]>`select * from studies where user_id = ${userId} order by study_date`,
    sql<Workspace["series"][number]>`select * from series where user_id = ${userId} order by series_number`,
    sql<Workspace["reports"][number]>`select * from reports where user_id = ${userId} order by report_date`,
    sql<Workspace["findings"][number]>`select * from findings where user_id = ${userId} order by code`,
    sql<Record<string, unknown>>`select * from finding_versions where user_id = ${userId} order by observed_on, version_no`,
    sql<Workspace["evidence"][number]>`select * from evidence_links where user_id = ${userId}`,
    sql<Workspace["symptoms"][number]>`select * from symptoms where user_id = ${userId} order by recorded_on`,
    sql<Workspace["cycles"][number]>`select * from cycles where user_id = ${userId} order by start_date`,
    sql<Workspace["labs"][number]>`select * from labs where user_id = ${userId} order by observed_on, analyte`,
    sql<Workspace["correspondences"][number]>`select * from correspondences where user_id = ${userId} and active = true order by created_at`,
    sql<Workspace["decisions"][number]>`select * from correspondence_decisions where user_id = ${userId} order by created_at`,
    sql<Workspace["discrepancies"][number]>`select * from discrepancies where user_id = ${userId} and active = true order by created_at`,
    sql<Workspace["reviews"][number]>`select * from reviews where user_id = ${userId} order by created_at`,
    sql<Workspace["consents"][number]>`select * from consents where user_id = ${userId} order by created_at`,
    sql<Workspace["uploads"][number]>`select id, patient_id, received_at, file_name, transfer_syntax, metadata, warnings, identifiers_withheld from dicom_uploads where user_id = ${userId} order by received_at desc limit 12`,
    sql<Workspace["audit"][number]>`select * from audit_events where user_id = ${userId} order by at desc limit 40`,
    sql<Workspace["extractions"][number]>`select id, report_id, file_name, file_kind, content_sha256, deid_method, redaction_count, redaction_kinds, extractor, extraction, warnings, created_at from report_extractions where user_id = ${userId} order by created_at desc`,
    auth.isAdmin
      ? sql<ClinicianVerificationRow>`
          select cv.*, p.display_name, p.role as current_role
          from clinician_verifications cv
          left join profiles p on cv.user_id = p.user_id
          order by cv.requested_at desc
        `.catch(() => [])
      : sql<ClinicianVerificationRow>`
          select * from clinician_verifications where user_id = ${userId} order by requested_at desc
        `.catch(() => []),
    sql<RegistrationRow>`select * from registrations where user_id = ${userId} order by created_at desc`.catch(() => []),
    sql<EndometriosisRecordItem>`select * from pathway_endometriosis_records where user_id = ${userId} order by created_at desc`.catch(() => []),
    sql<OvarianCystRecordItem>`select * from pathway_ovarian_cyst_records where user_id = ${userId} order by created_at desc`.catch(() => []),
    sql<PcosAssessmentItem>`select * from pathway_pcos_assessments where user_id = ${userId} order by created_at desc`.catch(() => []),
  ]);

  // Enforce backend patient-record filtering: non-clinicians/unverified clinicians only receive their own (is_self = true) records
  const patients = auth.canPerformClinicianActions
    ? allPatients
    : allPatients.filter((p) => Boolean(p.is_self));
  const allowedPatientIds = new Set(patients.map((p) => p.id));

  const studies = allStudies.filter((s) => allowedPatientIds.has(s.patient_id));
  const allowedStudyIds = new Set(studies.map((s) => s.id));

  const series = allSeries.filter((s) => allowedStudyIds.has(s.study_id));
  const reports = allReports.filter((r) => allowedStudyIds.has(r.study_id));
  const allowedReportIds = new Set(reports.map((r) => r.id));

  const findings = allFindings.filter((f) => allowedPatientIds.has(f.patient_id));
  const allowedFindingIds = new Set(findings.map((f) => f.id));

  const versionsFiltered = allVersions.filter((v) => allowedFindingIds.has(String(v.finding_id)));
  const allowedVersionIds = new Set(versionsFiltered.map((v) => String(v.id)));

  const evidence = allEvidence.filter((e) => allowedVersionIds.has(e.finding_version_id));
  const symptoms = allSymptoms.filter((s) => allowedPatientIds.has(s.patient_id));
  const cycles = allCycles.filter((c) => allowedPatientIds.has(c.patient_id));
  const labs = allLabs.filter((l) => allowedPatientIds.has(l.patient_id));
  const correspondences = allCorrespondences.filter((c) => allowedPatientIds.has(c.patient_id));
  const allowedCorrespondenceIds = new Set(correspondences.map((c) => c.id));
  const decisions = allDecisions.filter((d) => allowedCorrespondenceIds.has(d.correspondence_id));
  const discrepancies = allDiscrepancies.filter((d) => allowedPatientIds.has(d.patient_id));
  const consents = allConsents.filter((c) => allowedPatientIds.has(c.patient_id));
  const uploads = allUploads.filter((u) => !u.patient_id || allowedPatientIds.has(u.patient_id));
  const extractions = allExtractions.filter((e) => allowedReportIds.has(e.report_id));
  const registrations = (allRegistrations ?? []).filter((r) => allowedPatientIds.has(r.patient_id));
  const endometriosisRecords = (allEndometriosisRecords ?? []).filter(
    (r) => !r.patient_id || allowedPatientIds.has(r.patient_id),
  );
  const ovarianCystRecords = (allOvarianCystRecords ?? []).filter(
    (r) => !r.patient_id || allowedPatientIds.has(r.patient_id),
  );
  const pcosAssessments = (allPcosAssessments ?? []).filter(
    (r) => !r.patient_id || allowedPatientIds.has(r.patient_id),
  );

  const versionsOut: VersionRow[] = versionsFiltered.map((v) => ({
    ...(v as object),
    centroid_mm: parseTriple(v.centroid_mm),
    axes_mm: parseTriple(v.axes_mm),
    longest_mm: v.longest_mm == null ? null : Number(v.longest_mm),
    report_longest_mm: v.report_longest_mm == null ? null : Number(v.report_longest_mm),
  })) as VersionRow[];

  const activePatientId =
    rawProfile.active_patient_id && allowedPatientIds.has(rawProfile.active_patient_id)
      ? rawProfile.active_patient_id
      : patients[0]?.id ?? null;

  return {
    profile: {
      user_id: rawProfile.user_id,
      display_name: rawProfile.display_name,
      role: auth.effectiveRole,
      stored_role: auth.storedRole,
      verification_status: auth.verificationStatus,
      is_verified_clinician: auth.isClinicianVerified,
      active_patient_id: activePatientId,
    },
    patients,
    studies,
    series,
    reports,
    findings,
    versions: versionsOut,
    evidence,
    symptoms,
    cycles,
    labs,
    correspondences,
    decisions,
    discrepancies,
    reviews: allReviews,
    consents,
    uploads,
    audit: auditRows,
    extractions,
    verifications: (verifications ?? []) as Workspace["verifications"],
    registrations,
    endometriosisRecords,
    ovarianCystRecords,
    pcosAssessments,
    models: MODELS.map((model) => ({
      id: model.id,
      name: model.name,
      status: model.status,
      note: model.note,
    })),
    engineVersion: ENGINE_VERSION,
  };
}

export const getWorkspace = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    return executeGetWorkspace(sql, context.userId);
  });

export async function executeSetRole(sql: Sql, rawUserId: string, targetRole: string) {
  const userId = requireAuthenticatedUser(rawUserId);
  if (!VALID_ROLES.has(targetRole)) {
    throw new Error("Unknown role");
  }
  const auth = await resolveUserAuthorization(sql, userId);

  if (auth.storedRole === "patient" && (targetRole === "clinician" || targetRole === "admin")) {
    await audit(sql, userId, "set_role_denied", "profile", userId, `Blocked self-escalation from patient to ${targetRole}.`);
    throw new Error("Unauthorized: Role escalation is not permitted. Only an administrator can assign clinician or admin roles.");
  }
  if (auth.storedRole === "clinician" && targetRole === "admin") {
    await audit(sql, userId, "set_role_denied", "profile", userId, "Blocked self-escalation from clinician to admin.");
    throw new Error("Unauthorized: Clinicians cannot self-escalate to administrator.");
  }
  if (targetRole === "clinician" && !auth.isAdmin && !auth.isClinicianVerified) {
    await audit(
      sql,
      userId,
      "set_role_denied",
      "profile",
      userId,
      `Blocked unverified clinician role activation (verification status: ${auth.verificationStatus}).`,
    );
    throw new Error(
      `Unauthorized: Clinician verification is not approved (status: ${auth.verificationStatus}). Only an administrator can approve clinician verification.`,
    );
  }
  if (auth.isAdmin && targetRole !== "admin") {
    const adminCount = await sql<{ count: number }>`select count(*)::int as count from profiles where role = 'admin'`;
    if (asNumber(adminCount[0]?.count) <= 1) {
      throw new Error("Action rejected: Cannot revoke or demote the last remaining administrator.");
    }
  }

  await sql`update profiles set role = ${targetRole} where user_id = ${userId}`;
  await audit(sql, userId, "set_role", "profile", userId, `Role set to ${targetRole}.`);
  return { ok: true };
}

export const setRole = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((role: string) => {
    if (role !== "patient" && role !== "clinician" && role !== "admin") throw new Error("Unknown role");
    return role;
  })
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await ensure(sql, context.userId);
    return executeSetRole(sql, context.userId, data);
  });

/**
 * Administrator-controlled role assignment (`promoteUser`).
 *
 * Security invariants:
 * - Only administrators can invoke `promoteUser`.
 * - Promoting a user to `'clinician'` NEVER bypasses the clinician verification workflow:
 *   the target user must already hold an approved (`'verified'` or `'approved'`) record in
 *   `clinician_verifications` with valid licence and registry details.
 * - Cannot demote the last remaining administrator.
 */
export async function executePromoteUser(
  sql: Sql,
  callerUserId: string,
  targetOrInput: string | { targetUserId: string; newRole: string },
  maybeNewRole?: string,
) {
  const targetUserId = typeof targetOrInput === "string" ? targetOrInput : targetOrInput?.targetUserId;
  const newRole = (typeof targetOrInput === "string" ? maybeNewRole : targetOrInput?.newRole) ?? "";
  const caller = await requireAdmin(sql, callerUserId, "assign roles to other users");
  if (!targetUserId || typeof targetUserId !== "string" || !targetUserId.trim()) {
    throw new Error("Target user ID is required.");
  }
  const cleanTargetId = targetUserId.trim();
  if (!VALID_ROLES.has(newRole)) {
    throw new Error("Invalid target role: must be patient, clinician, or admin.");
  }

  const targetRows = await sql<{ role: string }>`select role from profiles where user_id = ${cleanTargetId}`;
  if (!targetRows.length) {
    throw new Error("Target user profile not found.");
  }
  const previousRole = targetRows[0].role;

  if (previousRole === "admin" && newRole !== "admin") {
    const adminCount = await sql<{ count: number }>`select count(*)::int as count from profiles where role = 'admin'`;
    if (asNumber(adminCount[0]?.count) <= 1) {
      throw new Error("Action rejected: Cannot revoke or demote the last remaining administrator.");
    }
  }

  if (newRole === "clinician") {
    const targetAuth = await resolveUserAuthorization(sql, cleanTargetId);
    if (!targetAuth.isClinicianVerified) {
      await audit(
        sql,
        caller.userId,
        "promote_user_blocked",
        "profile",
        cleanTargetId,
        `Blocked direct promotion of ${cleanTargetId} to clinician without approved verification (status: ${targetAuth.verificationStatus}).`,
      );
      throw new Error(
        `Verification workflow required: Cannot promote user ${cleanTargetId} to clinician because their verification status is '${targetAuth.verificationStatus}'. Approve a clinician verification request first.`,
      );
    }
  }

  await sql`update profiles set role = ${newRole} where user_id = ${cleanTargetId}`;
  await audit(
    sql,
    caller.userId,
    "promote_user",
    "profile",
    cleanTargetId,
    `Role changed from ${previousRole} to ${newRole} by administrator ${caller.userId}.`,
  );
  return { ok: true, targetUserId: cleanTargetId, newRole };
}

export const promoteUser = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { targetUserId: string; newRole: string }) => {
    if (!input || typeof input !== "object") throw new Error("Expected an input object.");
    if (typeof input.targetUserId !== "string" || !input.targetUserId.trim()) {
      throw new Error("Target user ID is required.");
    }
    if (input.newRole !== "patient" && input.newRole !== "clinician" && input.newRole !== "admin") {
      throw new Error("Invalid target role: must be patient, clinician, or admin.");
    }
    return { targetUserId: input.targetUserId.trim(), newRole: input.newRole };
  })
  .handler(async ({ context, data: { targetUserId, newRole } }) => {
    const sql = await getSql();
    return executePromoteUser(sql, context.userId, targetUserId, newRole);
  });

export async function executeSetActivePatient(sql: Sql, rawUserId: string, patientId: string) {
  const { auth } = await requirePatientRecordAccess(sql, rawUserId, patientId, "switch active record");
  await sql`update profiles set active_patient_id = ${patientId} where user_id = ${auth.userId}`;
  return { ok: true };
}

export const setActivePatient = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((patientId: string) => patientId)
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    return executeSetActivePatient(sql, context.userId, data);
  });

export async function executeSetMenarcheYear(
  sql: Sql,
  rawUserId: string,
  data: { patientId: string; menarcheYear: number | null; reason: string },
  referenceYear = new Date().getFullYear(),
) {
  const auth = await resolveUserAuthorization(sql, rawUserId);
  const result = await applyMenarcheYear(sql, auth.userId, auth.effectiveRole, data, referenceYear);
  return { ok: true, changed: result.changed };
}

export const setMenarcheYear = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { patientId: string; menarcheYear: number | null; reason: string }) => {
    if (typeof input.patientId !== "string" || !input.patientId) throw new Error("Record not found.");
    if (input.menarcheYear !== null && (!Number.isInteger(input.menarcheYear) || input.menarcheYear < 1900 || input.menarcheYear > 2200)) {
      throw new Error("Enter the year of the first period as a whole year, or clear it.");
    }
    const reason = String(input.reason ?? "").trim().slice(0, 300);
    if (reason.length < 4) throw new Error("Say where the year came from (for example: patient-reported at visit).");
    return { ...input, reason };
  })
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    return executeSetMenarcheYear(sql, context.userId, data);
  });

const REGIONS = [
  "Lower abdomen — midline",
  "Right lower quadrant",
  "Left lower quadrant",
  "Low back",
  "Deep pelvis",
];

export async function executeAddSymptom(
  sql: Sql,
  rawUserId: string,
  data: { patientId: string; region: string; intensity: number; cycleDay: number | null; description: string; recordedOn: string },
) {
  const { auth } = await requirePatientRecordAccess(sql, rawUserId, data.patientId, "add symptoms");
  const id = crypto.randomUUID();
  await sql`insert into symptoms (id, user_id, patient_id, recorded_on, region, intensity, cycle_day, description, source)
    values (${id}, ${auth.userId}, ${data.patientId}, ${data.recordedOn}, ${data.region}, ${data.intensity}, ${data.cycleDay}, ${data.description}, ${"patient_reported"})`;
  await audit(sql, auth.userId, "add_symptom", "symptom", id, "Patient-reported symptom appended. Not a clinical finding.");
  return { ok: true, id };
}

export const addSymptom = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { patientId: string; region: string; intensity: number; cycleDay: number | null; description: string; recordedOn: string }) => {
    if (!REGIONS.includes(input.region)) throw new Error("Choose a listed body region.");
    if (input.intensity < 0 || input.intensity > 10) throw new Error("Intensity is 0 to 10.");
    if (!input.description.trim()) throw new Error("Add a short description.");
    return { ...input, description: input.description.trim().slice(0, 500) };
  })
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    return executeAddSymptom(sql, context.userId, data);
  });

export async function executeAddCycle(
  sql: Sql,
  rawUserId: string,
  data: { patientId: string; startDate: string; lengthDays: number; flow: string; note: string },
) {
  const { auth } = await requirePatientRecordAccess(sql, rawUserId, data.patientId, "add cycles");
  const id = crypto.randomUUID();
  await sql`insert into cycles (id, user_id, patient_id, start_date, length_days, flow, note)
    values (${id}, ${auth.userId}, ${data.patientId}, ${data.startDate}, ${data.lengthDays}, ${data.flow}, ${data.note})`;
  await audit(sql, auth.userId, "add_cycle", "cycle", id, "Menstrual interval appended.");
  return { ok: true, id };
}

export const addCycle = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { patientId: string; startDate: string; lengthDays: number; flow: string; note: string }) => {
    if (!Number.isFinite(input.lengthDays) || input.lengthDays < 1 || input.lengthDays > 120) throw new Error("Cycle length looks invalid.");
    return { ...input, note: input.note.trim().slice(0, 400), flow: input.flow.slice(0, 40) };
  })
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    return executeAddCycle(sql, context.userId, data);
  });

export async function executeAddLab(
  sql: Sql,
  rawUserId: string,
  data: { patientId: string; observedOn: string; analyte: string; valueText: string; unit: string; referenceText: string },
) {
  const { auth } = await requirePatientRecordAccess(sql, rawUserId, data.patientId, "add lab records");
  const id = crypto.randomUUID();
  await sql`insert into labs (id, user_id, patient_id, observed_on, analyte, value_text, unit, reference_text, source_note)
    values (${id}, ${auth.userId}, ${data.patientId}, ${data.observedOn}, ${data.analyte}, ${data.valueText}, ${data.unit}, ${data.referenceText}, ${"Entered in the workspace. Not interpreted."})`;
  await audit(sql, auth.userId, "add_lab", "lab", id, `${data.analyte} appended without interpretation.`);
  return { ok: true, id };
}

export const addLab = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { patientId: string; observedOn: string; analyte: string; valueText: string; unit: string; referenceText: string }) => {
    if (!input.analyte.trim() || !input.valueText.trim()) throw new Error("Analyte and value are required.");
    return {
      ...input,
      analyte: input.analyte.trim().slice(0, 80),
      valueText: input.valueText.trim().slice(0, 40),
      unit: input.unit.trim().slice(0, 24),
      referenceText: input.referenceText.trim().slice(0, 80),
    };
  })
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    return executeAddLab(sql, context.userId, data);
  });

export async function executeAddReview(
  sql: Sql,
  rawUserId: string,
  data: { targetType: string; targetId: string; status: string; note: string },
) {
  const auth = await requireVerifiedClinicianOrAdmin(sql, rawUserId, "recording a clinical review");
  if (data.targetType === "finding_version") {
    const v = await sql`select id from finding_versions where id = ${data.targetId} and user_id = ${auth.userId}`;
    if (!v.length) throw new Error("Finding version not found or not owned.");
  } else if (data.targetType === "correspondence") {
    const c = await sql`select id from correspondences where id = ${data.targetId} and user_id = ${auth.userId}`;
    if (!c.length) throw new Error("Correspondence proposal not found or not owned.");
  } else if (data.targetType === "discrepancy") {
    const d = await sql`select id from discrepancies where id = ${data.targetId} and user_id = ${auth.userId}`;
    if (!d.length) throw new Error("Discrepancy not found or not owned.");
  }
  const id = crypto.randomUUID();
  await sql`insert into reviews (id, user_id, target_type, target_id, status, note)
    values (${id}, ${auth.userId}, ${data.targetType}, ${data.targetId}, ${data.status}, ${data.note || "Reviewed."})`;
  await audit(sql, auth.userId, "review", data.targetType, data.targetId, `${data.status}. Prior versions were not overwritten.`);
  return { ok: true, id };
}

export const addReview = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { targetType: string; targetId: string; status: string; note: string }) => {
    if (!["verified", "rejected", "needs_more_information"].includes(input.status)) throw new Error("Unknown review status.");
    if (!["finding_version", "correspondence", "discrepancy"].includes(input.targetType)) throw new Error("Unknown review target.");
    return { ...input, note: input.note.trim().slice(0, 500) };
  })
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    return executeAddReview(sql, context.userId, data);
  });

export async function executeCorrectVersion(
  sql: Sql,
  rawUserId: string,
  data: { versionId?: string; findingId?: string; figo?: string; axes: [number, number, number]; reason: string },
) {
  const auth = await requireVerifiedClinicianOrAdmin(sql, rawUserId, "editing a finding measurement");
  const rows = data.versionId
    ? await sql<Record<string, unknown>>`select * from finding_versions where id = ${data.versionId} and user_id = ${auth.userId}`
    : await sql<Record<string, unknown>>`select * from finding_versions where finding_id = ${data.findingId ?? ""} and user_id = ${auth.userId} order by version_no desc limit 1`;
  const current = rows[0];
  if (!current) throw new Error("Version not found.");
  const latest = await sql<{ version_no: number }>`select version_no from finding_versions where finding_id = ${current.finding_id as string} and user_id = ${auth.userId} order by version_no desc limit 1`;
  const id = crypto.randomUUID();
  const longest = Math.max(...data.axes);
  await sql`insert into finding_versions (
    id, user_id, finding_id, version_no, previous_version_id, study_id, observed_on, location_label, figo,
    centroid_mm, axes_mm, longest_mm, measurement_basis, frame, segmentation_source, model_id, quality, modality,
    report_longest_mm, change_reason
  ) values (
    ${id}, ${auth.userId}, ${current.finding_id as string}, ${asNumber(latest[0]?.version_no) + 1}, ${current.id as string},
    ${current.study_id as string}, ${current.observed_on as string}, ${current.location_label as string}, ${current.figo as string | null},
    ${current.centroid_mm as string | null}, ${JSON.stringify(data.axes)}, ${longest}, ${current.measurement_basis as string},
    ${current.frame as string}, ${"clinician_edit"}, ${null}, ${current.quality as string}, ${current.modality as string},
    ${current.report_longest_mm as number | null}, ${data.reason}
  )`;
  await sql`insert into evidence_links (id, user_id, finding_version_id, kind, study_id, series_id, report_id, quote, slice_index, note)
    select ${crypto.randomUUID()}, user_id, ${id}, kind, study_id, series_id, report_id, quote, slice_index, ${"Copied forward when a clinician edited the measurement. The previous version remains."}
    from evidence_links where finding_version_id = ${current.id as string} and user_id = ${auth.userId} limit 1`;
  await audit(sql, auth.userId, "new_version", "finding_version", id, data.reason);
  return { ok: true, id };
}

export const correctVersion = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { versionId: string; axes: [number, number, number]; reason: string }) => {
    if (!Array.isArray(input.axes) || input.axes.length !== 3 || input.axes.some((n) => !Number.isFinite(n) || n <= 0 || n > 300)) {
      throw new Error("Axes must be three positive millimetre values.");
    }
    if (input.reason.trim().length < 8) throw new Error("Say why the measurement changed.");
    return { ...input, reason: input.reason.trim().slice(0, 500) };
  })
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    return executeCorrectVersion(sql, context.userId, data);
  });

export async function executeSaveLabMeasurement(sql: Sql, rawUserId: string, data: LabVersionInput) {
  const auth = await requireVerifiedClinicianOrAdmin(sql, rawUserId, "recording a Volume Lab measurement");
  const id = await insertLabVersion(sql, auth.userId, data);
  await audit(sql, auth.userId, "new_version", "finding_version", id, "Volume lab measurement recorded as a new version. Prior versions were not overwritten.");
  const patientRow = await sql<{ patient_id: string }>`select patient_id from findings where id = ${data.findingId} and user_id = ${auth.userId}`;
  if (patientRow[0]?.patient_id) {
    await recomputeReproTrace(sql, auth.userId, patientRow[0].patient_id).catch(() => null);
  }
  return { ok: true, id };
}

export const saveLabMeasurement = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (input: {
      findingId: string;
      axes: [number, number, number];
      longest: number;
      sliceIndex: number;
      reason: string;
      evidenceNote: string;
      studyId?: string | null;
      seriesId?: string | null;
      centroidMm?: [number, number, number] | null;
      frame?: string | null;
      modelId?: string | null;
      segmentationSource?: string | null;
      segmentationRunId?: string | null;
      volumeMm3?: number | null;
      uncertaintyMm3?: number | null;
      newStudy?: {
        patientId: string;
        modality?: string;
        studyDate?: string;
        description?: string;
        accession?: string;
        sourceNote?: string;
      };
      newSeries?: {
        seriesNumber?: number;
        description?: string;
        plane?: string;
        sliceCount?: number;
        pixelSpacingMm?: string;
        sliceThicknessMm?: number;
      };
    }) => {
      if (!Array.isArray(input.axes) || input.axes.length !== 3 || input.axes.some((n) => !Number.isFinite(n) || n <= 0 || n > 300)) {
        throw new Error("Axes must be three positive millimetre values.");
      }
      if (!Number.isFinite(input.longest) || input.longest <= 0 || input.longest > 300) throw new Error("Longest extent must be 0 to 300 mm.");
      if (!Number.isInteger(input.sliceIndex) || input.sliceIndex < 0 || input.sliceIndex > 5000) throw new Error("Slice index is not valid.");
      if (input.reason.trim().length < 8) throw new Error("Say why the measurement was recorded.");
      return {
        ...input,
        reason: input.reason.trim().slice(0, 500),
        evidenceNote: input.evidenceNote.trim().slice(0, 1500),
      };
    },
  )
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    return executeSaveLabMeasurement(sql, context.userId, data);
  });

export async function executeDecideCorrespondence(
  sql: Sql,
  rawUserId: string,
  data: { correspondenceId: string; decision: string; note: string },
) {
  const auth = await requireVerifiedClinicianOrAdmin(sql, rawUserId, "recording a correspondence decision");
  const rows = await sql`select id from correspondences where id = ${data.correspondenceId} and user_id = ${auth.userId}`;
  if (!rows.length) throw new Error("Proposal not found.");
  const id = crypto.randomUUID();
  await sql`insert into correspondence_decisions (id, user_id, correspondence_id, decision, note)
    values (${id}, ${auth.userId}, ${data.correspondenceId}, ${data.decision}, ${data.note || "Decision recorded. Findings were not merged."})`;
  await audit(sql, auth.userId, "correspondence_decision", "correspondence", data.correspondenceId, `${data.decision}. Records were not merged.`);
  return { ok: true, id };
}

export const decideCorrespondence = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { correspondenceId: string; decision: string; note: string }) => {
    if (!["accept", "reject", "defer"].includes(input.decision)) throw new Error("Unknown decision.");
    return { ...input, note: input.note.trim().slice(0, 400) };
  })
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    return executeDecideCorrespondence(sql, context.userId, data);
  });

export async function executeResolveDiscrepancy(
  sql: Sql,
  rawUserId: string,
  data: { discrepancyId: string; resolution: string; note: string },
) {
  const auth = await requireVerifiedClinicianOrAdmin(sql, rawUserId, "resolving a discrepancy");
  const rows = await sql`select id from discrepancies where id = ${data.discrepancyId} and user_id = ${auth.userId}`;
  if (!rows.length) throw new Error("Discrepancy not found or not owned.");
  await sql`update discrepancies set active = false where id = ${data.discrepancyId} and user_id = ${auth.userId}`;
  await audit(sql, auth.userId, "resolve_discrepancy", "discrepancy", data.discrepancyId, `${data.resolution}: ${data.note}`);
  return { ok: true };
}

export const resolveDiscrepancy = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { discrepancyId: string; resolution: string; note: string }) => {
    if (!["acknowledged", "resolved", "dismissed"].includes(input.resolution)) throw new Error("Unknown resolution.");
    return { ...input, note: input.note.trim().slice(0, 400) };
  })
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    return executeResolveDiscrepancy(sql, context.userId, data);
  });

export async function executeSaveDicomMeta(
  sql: Sql,
  rawUserId: string,
  data: { patientId: string | null; fileName: string; transferSyntax: string; metadata: Record<string, string>; warnings: string[] },
) {
  const userId = requireAuthenticatedUser(rawUserId);
  if (data.patientId) {
    await requirePatientRecordAccess(sql, userId, data.patientId, "save DICOM metadata");
  }
  const id = crypto.randomUUID();
  await sql`insert into dicom_uploads (id, user_id, patient_id, file_name, transfer_syntax, metadata, warnings, identifiers_withheld)
    values (${id}, ${userId}, ${data.patientId}, ${data.fileName}, ${data.transferSyntax}, ${JSON.stringify(data.metadata)}, ${JSON.stringify(data.warnings)}, ${true})`;
  await audit(sql, userId, "dicom_metadata", "dicom_upload", id, "Header stored. Pixel data and patient identifiers were not stored.");
  return { ok: true, id };
}

export const saveDicomMeta = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { patientId: string | null; fileName: string; transferSyntax: string; metadata: Record<string, string>; warnings: string[] }) => {
    const fileName = input.fileName.slice(0, 180);
    const metadata = Object.fromEntries(Object.entries(input.metadata).slice(0, 40).map(([k, v]) => [k.slice(0, 80), String(v).slice(0, 240)]));
    return { ...input, fileName, metadata, warnings: input.warnings.slice(0, 12).map((w) => w.slice(0, 240)) };
  })
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    return executeSaveDicomMeta(sql, context.userId, data);
  });

export async function executeExportRecord(sql: Sql, rawUserId: string, patientId: string): Promise<ExportPayload> {
  const { auth, patient } = await requirePatientRecordAccess(sql, rawUserId, patientId, "export");
  const studies = await sql`select * from studies where patient_id = ${patientId} and user_id = ${auth.userId}`;
  const findings = await sql`select * from findings where patient_id = ${patientId} and user_id = ${auth.userId}`;
  const findingIds = (findings as { id: string }[]).map((f) => f.id);
  const versions = [];
  for (const findingId of findingIds) {
    const rows = await sql`select * from finding_versions where user_id = ${auth.userId} and finding_id = ${findingId}`;
    versions.push(...rows);
  }
  await audit(sql, auth.userId, "export", "patient", patientId, "JSON export of the synthetic record.");
  return {
    warning: "Synthetic demonstration export. Not a medical record and not for clinical use.",
    patient: patient as ExportPayload["patient"],
    studies: studies as ExportPayload["studies"],
    findings: findings as ExportPayload["findings"],
    versions: versions as ExportPayload["versions"],
  };
}

export const exportRecord = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((patientId: string) => patientId)
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    return executeExportRecord(sql, context.userId, data);
  });

export async function executeResetWorkspace(sql: Sql, rawUserId: string) {
  const auth = await requireAdmin(sql, rawUserId, "reset the synthetic workspace");
  await sql`delete from patients where user_id = ${auth.userId}`;
  await sql`delete from dicom_uploads where user_id = ${auth.userId}`;
  await seed(sql, auth.userId);
  await audit(sql, auth.userId, "reset", "workspace", auth.userId, "Synthetic workspace reset. Earlier audit events were kept.");
  return { ok: true };
}

export const resetWorkspace = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    return executeResetWorkspace(sql, context.userId);
  });

export async function executeUploadReport(sql: Sql, rawUserId: string, data: IngestInput) {
  const auth = await requireVerifiedClinicianOrAdmin(sql, rawUserId, "uploading a clinical report");
  const res = await ingestReport(sql, auth.userId, data);
  await audit(
    sql,
    auth.userId,
    "upload_report",
    "report",
    res.reportId,
    `De-identified ${data.fileKind.toUpperCase()} text stored (sha256 ${data.sha256.slice(0, 12)}…). Original file not stored. ${res.extraction.measurements.length} measurement(s), ${res.extraction.findings.length} finding sentence(s) extracted by rules.`,
  );
  return { ok: true, reportId: res.reportId, studyId: res.studyId };
}

export const uploadReport = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: IngestInput) => input)
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    return executeUploadReport(sql, context.userId, data);
  });

export async function executeLinkReportEvidence(sql: Sql, rawUserId: string, data: QuoteLinkInput) {
  const auth = await requireVerifiedClinicianOrAdmin(sql, rawUserId, "linking report evidence");
  const id = await linkReportQuote(sql, auth.userId, data);
  await audit(sql, auth.userId, "link_evidence", "finding_version", data.findingVersionId, `Report quote [${data.start}, ${data.end}) linked. The version itself was not changed.`);
  return { ok: true, id };
}

export const linkReportEvidence = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: QuoteLinkInput) => {
    if (!Number.isInteger(input.start) || !Number.isInteger(input.end)) throw new Error("Quote offsets are not valid.");
    if (typeof input.quote !== "string" || input.quote.length < 1 || input.quote.length > 1200) throw new Error("Quote length is not valid.");
    return input;
  })
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    return executeLinkReportEvidence(sql, context.userId, data);
  });

/**
 * Recomputes longitudinal ReproTrace correspondences and discrepancies from live database records.
 *
 * Unifies identifiers across studies, series, finding versions, evidence links, and volume registrations,
 * validates transformation matrices, and enforces registration quality thresholds.
 */
export async function recomputeReproTrace(
  sql: Sql,
  userId: string,
  patientId: string,
): Promise<{ proposalsCount: number; discrepanciesCount: number }> {
  const studies = await sql<{ id: string; study_date: string }>`
    select id, study_date::text from studies where patient_id = ${patientId} and user_id = ${userId} order by study_date
  `;
  if (studies.length === 0) return { proposalsCount: 0, discrepanciesCount: 0 };

  const seriesRows = await sql<{
    id: string;
    study_id: string;
    quality: string;
    pixel_spacing_mm?: string | null;
    slice_thickness_mm?: number | null;
  }>`
    select id, study_id, quality, pixel_spacing_mm, slice_thickness_mm
    from series
    where user_id = ${userId}
      and study_id in (select id from studies where patient_id = ${patientId} and user_id = ${userId})
    order by series_number
  `.catch(() => []);

  const seriesToStudy = new Map<string, string>();
  const studyDefaultSeries = new Map<string, string>();
  const seriesSpacingMap = new Map<string, [number, number, number]>();
  for (const sr of seriesRows) {
    seriesToStudy.set(sr.id, sr.study_id);
    if (!studyDefaultSeries.has(sr.study_id)) {
      studyDefaultSeries.set(sr.study_id, sr.id);
    }
    if (sr.pixel_spacing_mm && sr.slice_thickness_mm != null) {
      const parts = String(sr.pixel_spacing_mm)
        .split(/[\\,/\s]+/)
        .map((x) => Number(x));
      if (parts.length >= 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1]) && parts[0] > 0 && parts[1] > 0 && Number(sr.slice_thickness_mm) > 0) {
        seriesSpacingMap.set(sr.id, [parts[0], parts[1], Number(sr.slice_thickness_mm)]);
      }
    }
  }

  const findings = await sql<{ id: string; code: string; organ: string; structure: string; pathway: string }>`
    select id, code, organ, structure, pathway from findings where patient_id = ${patientId} and user_id = ${userId}
  `;

  const versions = await sql<{
    id: string;
    finding_id: string;
    version_no: number;
    study_id: string;
    series_id?: string | null;
    observed_on: string;
    location_label: string;
    centroid_mm: string | null;
    axes_mm: string | null;
    longest_mm: number | null;
    frame: string;
    quality: string;
    modality: string;
    basis: string;
    report_longest_mm: number | null;
  }>`
    select id, finding_id, version_no, study_id, observed_on::text, location_label,
           centroid_mm, axes_mm, longest_mm, frame, quality, modality, measurement_basis as basis,
           report_longest_mm
    from finding_versions
    where user_id = ${userId} and finding_id in (select id from findings where patient_id = ${patientId} and user_id = ${userId})
    order by observed_on, version_no
  `;

  // Also query series_id, volume_mm3, uncertainty_mm3, segmentation_source from finding_versions (if migration 0009 was applied)
  const versionExtraRows = await sql<{
    id: string;
    series_id: string | null;
    volume_mm3?: number | null;
    uncertainty_mm3?: number | null;
    segmentation_source?: string | null;
  }>`
    select id, series_id, volume_mm3, uncertainty_mm3, segmentation_source from finding_versions
    where user_id = ${userId} and finding_id in (select id from findings where patient_id = ${patientId} and user_id = ${userId})
  `.catch(() => []);
  const versionSeriesMap = new Map<string, string>();
  const versionVolumeMap = new Map<string, { volumeMm3: number | null; uncertaintyMm3: number | null; source: string | null }>();
  for (const r of versionExtraRows) {
    if (r.series_id) versionSeriesMap.set(r.id, r.series_id);
    versionVolumeMap.set(r.id, {
      volumeMm3: r.volume_mm3 != null ? Number(r.volume_mm3) : null,
      uncertaintyMm3: r.uncertainty_mm3 != null ? Number(r.uncertainty_mm3) : null,
      source: r.segmentation_source ?? null,
    });
  }

  const evidenceSeriesRows = await sql<{ finding_version_id: string; series_id: string | null }>`
    select finding_version_id, series_id from evidence_links
    where user_id = ${userId} and series_id is not null
  `.catch(() => []);
  for (const r of evidenceSeriesRows) {
    if (r.series_id && !versionSeriesMap.has(r.finding_version_id)) {
      versionSeriesMap.set(r.finding_version_id, r.series_id);
    }
  }

  const regRows = await sql<{
    id: string;
    fixed_series_id: string;
    moving_series_id: string;
    ncc_score: number;
    residual_mm: number;
    transform_matrix_json: string;
    status: string;
  }>`
    select id, fixed_series_id, moving_series_id, ncc_score, residual_mm, transform_matrix_json, status
    from registrations
    where patient_id = ${patientId} and user_id = ${userId}
    order by created_at desc
  `.catch(() => []);

  const regMap = new Map<string, RegistrationLookupEntry>();
  for (const r of regRows) {
    const fixedStudyId = seriesToStudy.get(r.fixed_series_id) ?? null;
    const movingStudyId = seriesToStudy.get(r.moving_series_id) ?? null;
    const ncc = Number(r.ncc_score);
    const residual = Number(r.residual_mm);

    let parsedMatrix: unknown = null;
    let jsonValid = true;
    try {
      parsedMatrix = JSON.parse(r.transform_matrix_json);
    } catch {
      jsonValid = false;
    }

    const validation = jsonValid ? validateTransformMatrix(parsedMatrix) : { valid: false, reason: "Malformed JSON" };
    const minNcc = r.status === "verified" ? MIN_REGISTRATION_NCC_VERIFIED : MIN_REGISTRATION_NCC_UNVERIFIED;
    const qualityOk =
      r.status !== "failed" &&
      validation.valid &&
      Number.isFinite(ncc) &&
      ncc >= minNcc &&
      Number.isFinite(residual) &&
      residual >= 0 &&
      residual <= MAX_REGISTRATION_RESIDUAL_MM;

    const entry: RegistrationLookupEntry = {
      id: r.id,
      status: !validation.valid
        ? "invalid_transform"
        : r.status === "failed"
          ? "failed"
          : qualityOk
            ? (r.status === "verified" ? "verified" : "unverified")
            : "insufficient_quality",
      supported: qualityOk,
      transform: validation.valid && validation.transform ? validation.transform : null,
      nccScore: Number.isFinite(ncc) ? ncc : null,
      residualMm: Number.isFinite(residual) ? residual : null,
      fixedSeriesId: r.fixed_series_id,
      movingSeriesId: r.moving_series_id,
      fixedStudyId,
      movingStudyId,
    };

    const seriesKey = `${r.fixed_series_id}:${r.moving_series_id}`;
    if (!regMap.has(seriesKey)) {
      regMap.set(seriesKey, entry);
    }
    if (fixedStudyId && movingStudyId) {
      const compositeKey = `${fixedStudyId}:${r.fixed_series_id}->${movingStudyId}:${r.moving_series_id}`;
      if (!regMap.has(compositeKey)) {
        regMap.set(compositeKey, entry);
      }
      const studyKey = `${fixedStudyId}:${movingStudyId}`;
      if (!regMap.has(studyKey)) {
        regMap.set(studyKey, entry);
      }
    }
  }

  const studyGroups = studies.map((s) => {
    const studyVersions = versions.filter((v) => v.study_id === s.id);
    // Keep only the latest version of each finding per study for chronology matching
    const latestByFinding = new Map<string, (typeof studyVersions)[number]>();
    for (const v of studyVersions) {
      const prev = latestByFinding.get(v.finding_id);
      if (!prev || asNumber(v.version_no) >= asNumber(prev.version_no)) {
        latestByFinding.set(v.finding_id, v);
      }
    }
    const snaps: Snap[] = [...latestByFinding.values()].map((v) => {
      const f = findings.find((x) => x.id === v.finding_id);
      const resolvedSeriesId =
        versionSeriesMap.get(v.id) ?? studyDefaultSeries.get(v.study_id) ?? null;
      const vExtra = versionVolumeMap.get(v.id);
      const spacingMm = resolvedSeriesId ? (seriesSpacingMap.get(resolvedSeriesId) ?? null) : null;
      return {
        id: v.id,
        findingId: v.finding_id,
        studyId: v.study_id,
        seriesId: resolvedSeriesId,
        date: v.observed_on,
        organ: f?.organ ?? "uterus",
        structure: f?.structure ?? "fibroid",
        locationLabel: v.location_label,
        modality: v.modality,
        frame: (v.frame as Snap["frame"]) ?? "unavailable",
        centroidMm: parseTriple(v.centroid_mm),
        axesMm: parseTriple(v.axes_mm),
        longestMm: v.longest_mm == null ? null : Number(v.longest_mm),
        volumeMm3: vExtra?.volumeMm3 ?? null,
        uncertaintyMm3: vExtra?.uncertaintyMm3 ?? null,
        spacingMm,
        basis: v.basis,
        source: vExtra?.source ?? null,
        quality: (v.quality as Snap["quality"]) ?? "adequate",
      };
    });
    return { studyId: s.id, date: s.study_date, snaps };
  });

  // Load any prior clinician correspondence decisions so accepted/rejected/deferred decisions are preserved
  const priorDecisionRows = await sql<{
    correspondence_id: string;
    from_version_id: string | null;
    to_version_id: string | null;
    decision: "accept" | "reject" | "defer";
    note: string;
    user_id: string;
    at: string;
  }>`
    select cd.correspondence_id, c.from_version_id, c.to_version_id, cd.decision, cd.note, cd.user_id, cd.created_at::text as at
    from correspondence_decisions cd
    join correspondences c on c.id = cd.correspondence_id
    where c.patient_id = ${patientId} and cd.user_id = ${userId}
    order by cd.created_at desc
  `.catch(() => []);

  const clinicianDecisions: ClinicianCorrespondenceDecision[] = priorDecisionRows.map((d) => ({
    correspondenceId: d.correspondence_id,
    fromVersionId: d.from_version_id,
    toVersionId: d.to_version_id,
    decision: d.decision,
    note: d.note,
    decidedByUserId: d.user_id,
    decidedAt: d.at,
  }));

  const proposals = matchChronology(
    studyGroups,
    regMap.size > 0 ? regMap : undefined,
    { clinicianDecisions },
  );

  try {
    await sql`
      update correspondences
      set active = false
      where patient_id = ${patientId}
        and user_id = ${userId}
        and id not in (select correspondence_id from correspondence_decisions where user_id = ${userId})
    `;
  } catch {
    await sql`update correspondences set active = false where patient_id = ${patientId} and user_id = ${userId}`;
  }
  await sql`update discrepancies set active = false where patient_id = ${patientId} and user_id = ${userId}`;

  for (const p of proposals) {
    const corrId = crypto.randomUUID();
    const rq = p.registrationQuality;
    try {
      await sql`
        insert into correspondences (
          id, user_id, patient_id, from_version_id, to_version_id, from_study_id, to_study_id,
          from_series_id, to_series_id, registration_id, registration_status, registration_ncc, registration_residual_mm,
          category, score, rationale, provisional,
          attribution_category, uncertainty_mm, distance_mm, volume_delta_pct, elapsed_days, growth_rate_mm3_per_month,
          engine_version, active
        ) values (
          ${corrId}, ${userId}, ${patientId},
          ${p.fromId}, ${p.toId}, ${p.fromStudyId}, ${p.toStudyId},
          ${p.fromSeriesId ?? null}, ${p.toSeriesId ?? null},
          ${rq?.registrationId ?? rq?.id ?? null}, ${rq?.status ?? null}, ${rq?.nccScore ?? null}, ${rq?.residualMm ?? null},
          ${p.category}, ${p.score}, ${p.rationale}, ${p.provisional},
          ${p.attributionCategory ?? null}, ${p.uncertaintyMm ?? null}, ${p.distanceMm ?? null},
          ${p.volumeDeltaPct ?? null}, ${p.elapsedDays ?? null}, ${p.growthRateMm3PerMonth ?? null},
          ${ENGINE_VERSION}, true
        )
      `;
    } catch {
      try {
        await sql`
          insert into correspondences (
            id, user_id, patient_id, from_version_id, to_version_id, from_study_id, to_study_id,
            from_series_id, to_series_id, registration_id, registration_status, registration_ncc, registration_residual_mm,
            category, score, rationale, provisional, engine_version, active
          ) values (
            ${corrId}, ${userId}, ${patientId},
            ${p.fromId}, ${p.toId}, ${p.fromStudyId}, ${p.toStudyId},
            ${p.fromSeriesId ?? null}, ${p.toSeriesId ?? null},
            ${rq?.registrationId ?? rq?.id ?? null}, ${rq?.status ?? null}, ${rq?.nccScore ?? null}, ${rq?.residualMm ?? null},
            ${p.category}, ${p.score}, ${p.rationale}, ${p.provisional}, ${ENGINE_VERSION}, true
          )
        `;
      } catch {
        await sql`
          insert into correspondences (
            id, user_id, patient_id, from_version_id, to_version_id, from_study_id, to_study_id,
            category, score, rationale, provisional, engine_version, active
          ) values (
            ${corrId}, ${userId}, ${patientId},
            ${p.fromId}, ${p.toId}, ${p.fromStudyId}, ${p.toStudyId},
            ${p.category}, ${p.score}, ${p.rationale}, ${p.provisional}, ${ENGINE_VERSION}, true
          )
        `;
      }
    }
  }

  let discrepanciesCount = 0;
  for (const p of proposals) {
    if (!p.fromId || !p.toId) continue;
    if (p.category !== "likely_same" && p.category !== "uncertain") continue;
    const v1 = versions.find((v) => v.id === p.fromId);
    const v2 = versions.find((v) => v.id === p.toId);
    if (!v1 || !v2) continue;
    const m1: Measure = {
      id: v1.id,
      findingId: v1.finding_id,
      date: v1.observed_on,
      modality: v1.modality,
      basis: v1.basis,
      locationLabel: v1.location_label,
      longestMm: v1.longest_mm,
      axesMm: parseTriple(v1.axes_mm),
      source: "record",
      reportLongestMm: v1.report_longest_mm,
      quality: v1.quality,
    };
    const m2: Measure = {
      id: v2.id,
      findingId: v2.finding_id,
      date: v2.observed_on,
      modality: v2.modality,
      basis: v2.basis,
      locationLabel: v2.location_label,
      longestMm: v2.longest_mm,
      axesMm: parseTriple(v2.axes_mm),
      source: "record",
      reportLongestMm: v2.report_longest_mm,
      quality: v2.quality,
    };
    const s1Id = versionSeriesMap.get(v1.id) ?? studyDefaultSeries.get(v1.study_id) ?? null;
    const s2Id = versionSeriesMap.get(v2.id) ?? studyDefaultSeries.get(v2.study_id) ?? null;
    m1.volumeMm3 = versionVolumeMap.get(v1.id)?.volumeMm3 ?? null;
    m1.uncertaintyMm3 = versionVolumeMap.get(v1.id)?.uncertaintyMm3 ?? null;
    m1.spacingMm = s1Id ? (seriesSpacingMap.get(s1Id) ?? null) : null;
    m2.volumeMm3 = versionVolumeMap.get(v2.id)?.volumeMm3 ?? null;
    m2.uncertaintyMm3 = versionVolumeMap.get(v2.id)?.uncertaintyMm3 ?? null;
    m2.spacingMm = s2Id ? (seriesSpacingMap.get(s2Id) ?? null) : null;

    const disc = sameMethodChange(m1, m2);
    if (disc) {
      const discId = crypto.randomUUID();
      try {
        await sql`
          insert into discrepancies (
            id, user_id, patient_id, category, attribution_category, summary, detail,
            left_ref, right_ref, uncertainty_mm3, volume_delta_pct, elapsed_days, growth_rate_mm3_per_month,
            engine_version, active
          ) values (
            ${discId}, ${userId}, ${patientId},
            ${disc.category}, ${disc.attributionCategory ?? null}, ${disc.summary}, ${disc.detail},
            ${disc.leftRef}, ${disc.rightRef},
            ${disc.uncertaintyMm3 ?? null}, ${disc.volumeDeltaPct ?? null},
            ${disc.elapsedDays ?? null}, ${disc.growthRateMm3PerMonth ?? null},
            ${ENGINE_VERSION}, true
          )
        `;
      } catch {
        await sql`
          insert into discrepancies (
            id, user_id, patient_id, category, summary, detail, left_ref, right_ref, engine_version, active
          ) values (
            ${discId}, ${userId}, ${patientId},
            ${disc.category}, ${disc.summary}, ${disc.detail},
            ${disc.leftRef}, ${disc.rightRef}, ${ENGINE_VERSION}, true
          )
        `;
      }
      discrepanciesCount++;
    }
  }

  await audit(sql, userId, "recompute_reprotrace", "patient", patientId, `ReproTrace updated: ${proposals.length} proposal(s), ${discrepanciesCount} discrepancy(ies).`);
  return { proposalsCount: proposals.length, discrepanciesCount };
}

export async function executeRequestClinicianVerification(
  sql: Sql,
  rawUserId: string,
  data: { licenceNo: string; registry: string; evidenceNote: string },
) {
  const userId = requireAuthenticatedUser(rawUserId);
  const licenceNo = String(data.licenceNo ?? "").trim().slice(0, 100);
  const registry = String(data.registry ?? "").trim().slice(0, 100);
  const evidenceNote = String(data.evidenceNote ?? "").trim().slice(0, 1000);
  if (!licenceNo || !registry) {
    throw new Error("Licence number and medical registry are required.");
  }

  await sql`insert into profiles (user_id, display_name, role) values (${userId}, ${""}, ${"patient"}) on conflict (user_id) do nothing`;
  const id = crypto.randomUUID();
  await sql`
    insert into clinician_verifications (id, user_id, licence_no, registry, evidence_note, status)
    values (${id}, ${userId}, ${licenceNo}, ${registry}, ${evidenceNote}, 'pending')
  `;
  await audit(
    sql,
    userId,
    "request_clinician_verification",
    "clinician_verification",
    id,
    `Submitted licence ${licenceNo} (${registry}) for verification (status -> pending).`,
  );
  return { ok: true, id, verificationId: id, status: "pending" as const };
}

/** Request clinician verification for an authenticated user. */
export const requestClinicianVerification = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { licenceNo: string; registry: string; evidenceNote: string }) => {
    if (!input || typeof input !== "object") throw new Error("Expected an input object.");
    const licenceNo = String(input.licenceNo ?? "").trim().slice(0, 100);
    const registry = String(input.registry ?? "").trim().slice(0, 100);
    const evidenceNote = String(input.evidenceNote ?? "").trim().slice(0, 1000);
    if (!licenceNo || !registry) throw new Error("Licence number and medical registry are required.");
    return { licenceNo, registry, evidenceNote };
  })
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await ensure(sql, context.userId);
    return executeRequestClinicianVerification(sql, context.userId, data);
  });

/**
 * Administrator-controlled clinician verification decision (`executeVerifyClinician`).
 *
 * Supports `verified`, `approved`, `rejected`, `suspended`, and `revoked` transitions:
 * - Only administrators can approve, reject, suspend, or revoke clinician verification.
 * - Approving (`verified` or `approved`) promotes a patient to `'clinician'` (preserving `'admin'` if already admin).
 * - Rejecting, suspending, or revoking immediately removes clinician privileges (`role -> 'patient'`),
 *   subject to the last-remaining-administrator guard.
 * - Writes an immutable audit event to `audit_events` for every verification status change.
 */
export async function executeVerifyClinician(
  sql: Sql,
  callerUserId: string,
  data: { verificationId: string; decision: ClinicianVerificationDecision; reason: string },
) {
  const caller = await requireAdmin(
    sql,
    callerUserId,
    "approve, reject, suspend, or revoke clinician verifications",
  );
  if (!VALID_VERIFICATION_DECISIONS.has(data.decision)) {
    throw new Error("Decision must be verified, approved, rejected, suspended, or revoked.");
  }
  const reason = String(data.reason ?? "").trim().slice(0, 500);
  if (!reason) {
    throw new Error("A reason for the decision is required for auditing.");
  }

  const vRows = await sql<{
    id: string;
    user_id: string;
    status: string;
    licence_no: string;
    registry: string;
  }>`
    select id, user_id, status, licence_no, registry
    from clinician_verifications
    where id = ${data.verificationId}
  `;
  if (!vRows.length) {
    throw new Error("Verification request not found.");
  }
  const v = vRows[0];
  const targetUserId = v.user_id;
  const previousStatus = v.status;

  const isApproval = data.decision === "verified" || data.decision === "approved";
  if (isApproval && (!String(v.licence_no ?? "").trim() || !String(v.registry ?? "").trim())) {
    throw new Error("Cannot approve verification without a valid licence number and medical registry.");
  }

  const targetProfileRows = await sql<{ role: string }>`select role from profiles where user_id = ${targetUserId}`;
  const previousRole = targetProfileRows[0]?.role ?? "patient";

  if (!isApproval && previousRole === "admin") {
    const adminCount = await sql<{ count: number }>`select count(*)::int as count from profiles where role = 'admin'`;
    if (asNumber(adminCount[0]?.count) <= 1) {
      throw new Error("Action rejected: Cannot revoke or demote the last remaining administrator.");
    }
  }

  const newRole = isApproval ? (previousRole === "admin" ? "admin" : "clinician") : "patient";
  await sql`
    update clinician_verifications
    set status = ${data.decision}, decided_by = ${caller.userId}, decided_at = now(), reason = ${reason}
    where id = ${data.verificationId}
  `;
  await sql`update profiles set role = ${newRole} where user_id = ${targetUserId}`;

  const auditAction =
    data.decision === "verified" || data.decision === "approved"
      ? "verify_clinician"
      : data.decision === "rejected"
        ? "reject_clinician"
        : data.decision === "suspended"
          ? "suspend_clinician"
          : "revoke_clinician";

  await audit(
    sql,
    caller.userId,
    auditAction,
    "clinician_verification",
    data.verificationId,
    `User ${targetUserId} verification status ${previousStatus} -> ${data.decision} (role ${previousRole} -> ${newRole}): ${reason}`,
  );
  return { ok: true, status: data.decision, decision: data.decision, previousStatus, targetUserId, newRole };
}

/** Approve, reject, suspend, or revoke clinician verification. Admin only. */
export const verifyClinician = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { verificationId: string; decision: ClinicianVerificationDecision; reason: string }) => {
    if (!input || typeof input !== "object" || !VALID_VERIFICATION_DECISIONS.has(input.decision)) {
      throw new Error("Decision must be verified, approved, rejected, suspended, or revoked.");
    }
    const reason = String(input.reason ?? "").trim().slice(0, 500);
    if (!reason) throw new Error("A reason for the decision is required for auditing.");
    return { verificationId: input.verificationId, decision: input.decision, reason };
  })
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    return executeVerifyClinician(sql, context.userId, data);
  });

export type VerificationViewItem = {
  id: string;
  user_id: string;
  licence_no: string;
  registry: string;
  evidence_note: string;
  status: string;
  decided_by: string | null;
  decided_at: string | null;
  reason: string;
  requested_at: string;
  display_name: string | null;
  current_role: string | null;
};

export type VerificationStatusItem = {
  id: string;
  licence_no: string;
  registry: string;
  evidence_note: string;
  status: string;
  decided_at: string | null;
  reason: string;
  requested_at: string;
};

export async function executeListPendingClinicians(sql: Sql, callerUserId: string) {
  await requireAdmin(sql, callerUserId, "view clinician verifications");
  return sql<VerificationViewItem>`
    select
      v.id, v.user_id, v.licence_no, v.registry, v.evidence_note, v.status,
      v.decided_by, v.decided_at, v.reason, v.requested_at,
      p.display_name, p.role as current_role
    from clinician_verifications v
    left join profiles p on p.user_id = v.user_id
    order by v.requested_at desc
  `;
}

/** List all pending and historical clinician verifications. Admin only. */
export const listPendingClinicians = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    return executeListPendingClinicians(sql, context.userId);
  });

export async function executeGetVerificationStatus(sql: Sql, rawUserId: string) {
  const userId = requireAuthenticatedUser(rawUserId);
  const rows = await sql<VerificationStatusItem>`
    select id, licence_no, registry, evidence_note, status, decided_at, reason, requested_at
    from clinician_verifications
    where user_id = ${userId}
    order by coalesce(decided_at, requested_at) desc, requested_at desc, id desc limit 1
  `;
  return rows[0] ?? null;
}

/** Get verification status for the current user. */
export const getVerificationStatus = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    return executeGetVerificationStatus(sql, context.userId);
  });

export async function executeSaveVolumeRegistration(
  sql: Sql,
  rawUserId: string,
  data: {
    patientId: string;
    fixedSeriesId: string;
    movingSeriesId: string;
    method?: string;
    nccScore: number;
    residualMm: number;
    transformMatrix?: RegistrationTransformInput;
    matrix?: RegistrationTransformInput;
    status?: "verified" | "unverified" | "failed";
  },
) {
  const auth = await requireVerifiedClinicianOrAdmin(sql, rawUserId, "saving a volume registration");
  const patientRows = await sql<{ id: string }>`
    select id from patients where id = ${data.patientId} and user_id = ${auth.userId}
  `;
  if (!patientRows.length) {
    throw new Error("Patient record not found or not owned.");
  }

  const fixedSeriesRows = await sql<{ id: string; study_id: string }>`
    select s.id, s.study_id
    from series s
    join studies st on st.id = s.study_id
    where s.id = ${data.fixedSeriesId} and s.user_id = ${auth.userId} and st.patient_id = ${data.patientId}
  `;
  const movingSeriesRows = await sql<{ id: string; study_id: string }>`
    select s.id, s.study_id
    from series s
    join studies st on st.id = s.study_id
    where s.id = ${data.movingSeriesId} and s.user_id = ${auth.userId} and st.patient_id = ${data.patientId}
  `;
  if (!fixedSeriesRows.length || !movingSeriesRows.length) {
    throw new Error("Fixed or moving series not found for this patient record.");
  }

  const rawMatrix = data.transformMatrix ?? data.matrix;
  const validation = validateTransformMatrix(rawMatrix);
  if (data.status !== "failed" && (!validation.valid || !validation.transform)) {
    throw new Error(`Invalid registration transformation matrix: ${validation.reason ?? "validation failed"}`);
  }

  const nccScore = Number(data.nccScore);
  const residualMm = Number(data.residualMm);
  if (!Number.isFinite(nccScore) || !Number.isFinite(residualMm) || residualMm < 0) {
    throw new Error("Registration quality metrics (nccScore, residualMm) must be valid finite numbers.");
  }

  const effectiveStatus: "verified" | "unverified" | "failed" =
    data.status === "failed" ||
    !validation.valid ||
    nccScore < MIN_REGISTRATION_NCC_VERIFIED ||
    residualMm > MAX_REGISTRATION_RESIDUAL_MM
      ? "failed"
      : data.status ?? (nccScore >= MIN_REGISTRATION_NCC_UNVERIFIED ? "verified" : "unverified");

  const storedTransform = validation.valid && validation.transform ? validation.transform : rawMatrix;
  const id = crypto.randomUUID();
  const fixedStudyId = fixedSeriesRows[0].study_id;
  const movingStudyId = movingSeriesRows[0].study_id;
  try {
    await sql`
      insert into registrations (
        id, user_id, patient_id, fixed_series_id, moving_series_id, fixed_study_id, moving_study_id,
        ncc_score, residual_mm, transform_matrix_json, status, matrix_valid
      ) values (
        ${id}, ${auth.userId}, ${data.patientId}, ${data.fixedSeriesId}, ${data.movingSeriesId},
        ${fixedStudyId}, ${movingStudyId},
        ${nccScore}, ${residualMm}, ${JSON.stringify(storedTransform)}, ${effectiveStatus}, ${validation.valid}
      )
    `;
  } catch {
    await sql`
      insert into registrations (
        id, user_id, patient_id, fixed_series_id, moving_series_id, ncc_score, residual_mm, transform_matrix_json, status
      ) values (
        ${id}, ${auth.userId}, ${data.patientId}, ${data.fixedSeriesId}, ${data.movingSeriesId},
        ${nccScore}, ${residualMm}, ${JSON.stringify(storedTransform)}, ${effectiveStatus}
      )
    `;
  }
  await audit(
    sql,
    auth.userId,
    "save_registration",
    "registration",
    id,
    `Rigid volume registration stored (${data.fixedSeriesId} -> ${data.movingSeriesId}, status: ${effectiveStatus}, NCC: ${nccScore.toFixed(3)}, Residual: ${residualMm.toFixed(2)} mm)`,
  );
  await recomputeReproTrace(sql, auth.userId, data.patientId).catch(() => null);
  return { ok: true, id, status: effectiveStatus };
}

/** Save a 3D volume registration result across studies. Verified clinician or admin only. */
export const saveVolumeRegistration = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: {
    patientId: string;
    fixedSeriesId: string;
    movingSeriesId: string;
    nccScore: number;
    residualMm: number;
    transformMatrix: RegistrationTransformInput;
    status?: "verified" | "unverified" | "failed";
  }) => input)
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    return executeSaveVolumeRegistration(sql, context.userId, data);
  });

export async function executeSaveEndometriosisRecord(
  sql: Sql,
  rawUserId: string,
  data: { patientId: string; lesionSites: string[]; surgicalHistory: string; stagingRASRM?: string; imagingNote: string },
) {
  const auth = await requireVerifiedClinicianOrAdmin(sql, rawUserId, "entering endometriosis clinical records");
  const owned = await sql`select id from patients where id = ${data.patientId} and user_id = ${auth.userId}`;
  if (!owned.length) throw new Error("Record not found.");
  const id = crypto.randomUUID();
  await sql`
    insert into pathway_endometriosis_records (
      id, user_id, patient_id, lesion_sites_json, surgical_history, staging_rASRM, imaging_note
    ) values (
      ${id}, ${auth.userId}, ${data.patientId}, ${JSON.stringify(data.lesionSites)},
      ${data.surgicalHistory}, ${data.stagingRASRM ?? null}, ${data.imagingNote}
    )
  `;
  await audit(sql, auth.userId, "save_endometriosis_record", "endometriosis_record", id, `Sites: ${data.lesionSites.join(", ")}; Staging: ${data.stagingRASRM ?? "N/A"}`);
  return { ok: true, id };
}

/** Save structured Endometriosis clinical record. */
export const saveEndometriosisRecord = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { patientId: string; lesionSites: string[]; surgicalHistory: string; stagingRASRM?: string; imagingNote: string }) => input)
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    return executeSaveEndometriosisRecord(sql, context.userId, data);
  });

export async function executeGetEndometriosisRecords(sql: Sql, rawUserId: string, patientId: string) {
  const { auth } = await requirePatientRecordAccess(sql, rawUserId, patientId, "view endometriosis records");
  return sql<EndometriosisRecordItem>`
    select id, lesion_sites_json, surgical_history, staging_rASRM, imaging_note, created_at
    from pathway_endometriosis_records
    where patient_id = ${patientId} and user_id = ${auth.userId}
    order by created_at desc
  `;
}

/** Get structured Endometriosis clinical records for a patient. */
export const getEndometriosisRecords = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((patientId: string) => patientId)
  .handler(async ({ context, data: patientId }) => {
    const sql = await getSql();
    return executeGetEndometriosisRecords(sql, context.userId, patientId);
  });

export async function executeSaveOvarianCystRecord(
  sql: Sql,
  rawUserId: string,
  data: { patientId: string; laterality: "left" | "right" | "bilateral"; maxDiameterMm: number; featuresText: string; followUpMonths?: number; clinicalNote: string },
) {
  const auth = await requireVerifiedClinicianOrAdmin(sql, rawUserId, "entering ovarian cyst clinical records");
  const owned = await sql`select id from patients where id = ${data.patientId} and user_id = ${auth.userId}`;
  if (!owned.length) throw new Error("Record not found.");
  const id = crypto.randomUUID();
  await sql`
    insert into pathway_ovarian_cyst_records (
      id, user_id, patient_id, laterality, max_diameter_mm, features_text, follow_up_months, clinical_note
    ) values (
      ${id}, ${auth.userId}, ${data.patientId}, ${data.laterality},
      ${data.maxDiameterMm}, ${data.featuresText}, ${data.followUpMonths ?? null}, ${data.clinicalNote}
    )
  `;
  await audit(sql, auth.userId, "save_ovarian_cyst_record", "ovarian_cyst_record", id, `${data.laterality} cyst, diameter: ${data.maxDiameterMm}mm`);
  return { ok: true, id };
}

/** Save structured Ovarian Cyst clinical record. */
export const saveOvarianCystRecord = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { patientId: string; laterality: "left" | "right" | "bilateral"; maxDiameterMm: number; featuresText: string; followUpMonths?: number; clinicalNote: string }) => input)
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    return executeSaveOvarianCystRecord(sql, context.userId, data);
  });

export async function executeGetOvarianCystRecords(sql: Sql, rawUserId: string, patientId: string) {
  const { auth } = await requirePatientRecordAccess(sql, rawUserId, patientId, "view ovarian cyst records");
  return sql<OvarianCystRecordItem>`
    select id, laterality, max_diameter_mm, features_text, follow_up_months, clinical_note, created_at
    from pathway_ovarian_cyst_records
    where patient_id = ${patientId} and user_id = ${auth.userId}
    order by created_at desc
  `;
}

/** Get structured Ovarian Cyst clinical records for a patient. */
export const getOvarianCystRecords = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((patientId: string) => patientId)
  .handler(async ({ context, data: patientId }) => {
    const sql = await getSql();
    return executeGetOvarianCystRecords(sql, context.userId, patientId);
  });

export async function executeSavePcosAssessment(
  sql: Sql,
  rawUserId: string,
  data: {
    patientId: string;
    cycleIrregularity: boolean;
    hyperandrogenismClinical: boolean;
    hyperandrogenismBiochemical: boolean;
    ultrasoundOrAmhFeatures: boolean;
    notes: string;
  },
) {
  const auth = await requireVerifiedClinicianOrAdmin(sql, rawUserId, "entering PCOS assessments");
  const owned = await sql`select id from patients where id = ${data.patientId} and user_id = ${auth.userId}`;
  if (!owned.length) throw new Error("Record not found.");
  const hyperandrogenism = data.hyperandrogenismClinical || data.hyperandrogenismBiochemical;
  const criteriaCount = [data.cycleIrregularity, hyperandrogenism, data.ultrasoundOrAmhFeatures].filter(Boolean).length;
  const rotterdamMet = criteriaCount >= 2;

  const id = crypto.randomUUID();
  await sql`
    insert into pathway_pcos_assessments (
      id, user_id, patient_id, cycle_irregularity, hyperandrogenism_clinical, hyperandrogenism_biochemical,
      ultrasound_or_amh_features, rotterdam_criteria_met, notes
    ) values (
      ${id}, ${auth.userId}, ${data.patientId}, ${data.cycleIrregularity}, ${data.hyperandrogenismClinical},
      ${data.hyperandrogenismBiochemical}, ${data.ultrasoundOrAmhFeatures}, ${rotterdamMet}, ${data.notes}
    )
  `;
  await audit(sql, auth.userId, "save_pcos_assessment", "pcos_assessment", id, `Rotterdam criteria met: ${rotterdamMet} (${criteriaCount}/3 features)`);
  return { ok: true, id, rotterdamCriteriaMet: rotterdamMet };
}

/** Save structured PCOS clinical assessment (Rotterdam Criteria). */
export const savePcosAssessment = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: {
    patientId: string;
    cycleIrregularity: boolean;
    hyperandrogenismClinical: boolean;
    hyperandrogenismBiochemical: boolean;
    ultrasoundOrAmhFeatures: boolean;
    notes: string;
  }) => input)
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    return executeSavePcosAssessment(sql, context.userId, data);
  });

export async function executeGetPcosAssessments(sql: Sql, rawUserId: string, patientId: string) {
  const { auth } = await requirePatientRecordAccess(sql, rawUserId, patientId, "view PCOS assessments");
  return sql<PcosAssessmentItem>`
    select id, cycle_irregularity, hyperandrogenism_clinical, hyperandrogenism_biochemical,
           ultrasound_or_amh_features, rotterdam_criteria_met, notes, created_at
    from pathway_pcos_assessments
    where patient_id = ${patientId} and user_id = ${auth.userId}
    order by created_at desc
  `;
}

/** Get structured PCOS clinical assessments for a patient. */
export const getPcosAssessments = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((patientId: string) => patientId)
  .handler(async ({ context, data: patientId }) => {
    const sql = await getSql();
    return executeGetPcosAssessments(sql, context.userId, patientId);
  });


// ============================================================================
// Sprint 3: Persistent Medical Imaging Storage & Longitudinal Provenance APIs
// ============================================================================

export async function executeStoreImagingArtifact(
  sql: Sql,
  rawUserId: string,
  data: {
    patientId: string;
    studyId?: string | null;
    seriesId?: string | null;
    findingVersionId?: string | null;
    sourceObjectId?: string | null;
    sopInstanceUid?: string | null;
    instanceNumber?: number | null;
    kind: ImagingArtifactKind;
    fileName?: string | null;
    mimeType?: string | null;
    dataBase64: string;
    metadata?: Record<string, unknown>;
  },
) {
  const auth = await requireVerifiedClinicianOrAdmin(
    sql,
    rawUserId,
    "uploading or persisting a medical imaging artifact",
  );
  await requirePatientRecordAccess(sql, auth.userId, data.patientId, "store imaging artifact");
  const buffer = Buffer.from(data.dataBase64, "base64");
  return storeImagingArtifact(sql, {
    userId: auth.userId,
    patientId: data.patientId,
    studyId: data.studyId ?? null,
    seriesId: data.seriesId ?? null,
    findingVersionId: data.findingVersionId ?? null,
    sourceObjectId: data.sourceObjectId ?? null,
    sopInstanceUid: data.sopInstanceUid ?? null,
    instanceNumber: data.instanceNumber ?? null,
    kind: data.kind,
    fileName: data.fileName ?? null,
    mimeType: data.mimeType ?? null,
    data: buffer,
    metadata: data.metadata,
  });
}

export const uploadImagingArtifact = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (input: {
      patientId: string;
      studyId?: string | null;
      seriesId?: string | null;
      findingVersionId?: string | null;
      sourceObjectId?: string | null;
      sopInstanceUid?: string | null;
      instanceNumber?: number | null;
      kind: ImagingArtifactKind;
      fileName?: string | null;
      mimeType?: string | null;
      dataBase64: string;
      metadata?: Record<string, unknown>;
    }) => {
      if (!input.patientId || typeof input.patientId !== "string") {
        throw new Error("patientId is required.");
      }
      if (!input.dataBase64 || typeof input.dataBase64 !== "string") {
        throw new Error("dataBase64 payload is required.");
      }
      return input;
    },
  )
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    return executeStoreImagingArtifact(sql, context.userId, data);
  });

export async function executeGetImagingArtifact(
  sql: Sql,
  rawUserId: string,
  objectId: string,
  includeData: boolean = true,
) {
  const userId = requireAuthenticatedUser(rawUserId);
  const res = await getImagingArtifact(sql, userId, objectId, includeData);
  if (!res) {
    throw new Error("Imaging artifact not found or access denied.");
  }
  return {
    record: res.record,
    integrity: res.integrity,
    dataBase64: res.data ? res.data.toString("base64") : undefined,
  };
}

export const retrieveImagingArtifact = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { objectId: string; includeData?: boolean }) => input)
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    return executeGetImagingArtifact(
      sql,
      context.userId,
      data.objectId,
      data.includeData ?? true,
    );
  });

export async function executeListImagingArtifacts(
  sql: Sql,
  rawUserId: string,
  filter: {
    patientId: string;
    studyId?: string;
    seriesId?: string;
    findingVersionId?: string;
    kind?: ImagingArtifactKind;
    includePurged?: boolean;
  },
) {
  const { auth } = await requirePatientRecordAccess(
    sql,
    rawUserId,
    filter.patientId,
    "list imaging artifacts",
  );
  return listImagingArtifacts(sql, auth.userId, filter);
}

export const listPatientImagingArtifacts = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (input: {
      patientId: string;
      studyId?: string;
      seriesId?: string;
      findingVersionId?: string;
      kind?: ImagingArtifactKind;
      includePurged?: boolean;
    }) => input,
  )
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    return executeListImagingArtifacts(sql, context.userId, data);
  });

export async function executeVerifyImagingObjectIntegrity(
  sql: Sql,
  rawUserId: string,
  objectId: string,
) {
  const userId = requireAuthenticatedUser(rawUserId);
  return verifyImagingObjectIntegrity(sql, userId, objectId);
}

export const checkImagingIntegrity = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((objectId: string) => objectId)
  .handler(async ({ context, data: objectId }) => {
    const sql = await getSql();
    return executeVerifyImagingObjectIntegrity(sql, context.userId, objectId);
  });

export async function executePurgeImagingArtifact(
  sql: Sql,
  rawUserId: string,
  data: { objectId: string; reason: string },
) {
  const auth = await requireVerifiedClinicianOrAdmin(
    sql,
    rawUserId,
    "purging an imaging artifact under retention policy",
  );
  return purgeImagingArtifact(sql, auth.userId, data.objectId, data.reason);
}

export const deleteImagingArtifact = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { objectId: string; reason: string }) => input)
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    return executePurgeImagingArtifact(sql, context.userId, data);
  });

export async function executeGetHistoricalFindingImagingEvidence(
  sql: Sql,
  rawUserId: string,
  findingVersionId: string,
) {
  const userId = requireAuthenticatedUser(rawUserId);
  return getHistoricalFindingImagingEvidence(sql, userId, findingVersionId);
}

export const getFindingImagingEvidence = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((findingVersionId: string) => findingVersionId)
  .handler(async ({ context, data: findingVersionId }) => {
    const sql = await getSql();
    return executeGetHistoricalFindingImagingEvidence(sql, context.userId, findingVersionId);
  });

/**
 * Retrieve complete longitudinal comparison provenance for a correspondence record (Task 2E):
 * - Source and target examinations (`fromStudy`, `toStudy`, `fromSeries`, `toSeries`)
 * - Original finding references and full version measurements (`fromVersion`, `toVersion`)
 * - Registration information and quality metrics (`registration`)
 * - Matching confidence, physical distance, and uncertainty (`correspondence`)
 * - Discrepancy attribution explanation (`discrepancies`)
 * - Clinician review decisions, review dates, reviewer identities, and immutable audit history (`decisions`, `reviews`, `auditHistory`)
 */
export async function executeGetLongitudinalComparisonProvenance(
  sql: Sql,
  rawUserId: string,
  correspondenceId: string,
) {
  const userId = requireAuthenticatedUser(rawUserId);
  const corrRows = await sql<Record<string, unknown>>`
    select * from correspondences where id = ${correspondenceId} and user_id = ${userId}
  `;
  if (!corrRows.length) {
    throw new Error("Longitudinal correspondence not found or access denied.");
  }
  const correspondence = corrRows[0];
  const patientId = correspondence.patient_id as string;
  await requirePatientRecordAccess(sql, userId, patientId, "view longitudinal comparison provenance");

  const fromVersionId = correspondence.from_version_id as string | null;
  const toVersionId = correspondence.to_version_id as string | null;

  const fromEvidence = fromVersionId
    ? await getHistoricalFindingImagingEvidence(sql, userId, fromVersionId).catch(() => null)
    : null;
  const toEvidence = toVersionId
    ? await getHistoricalFindingImagingEvidence(sql, userId, toVersionId).catch(() => null)
    : null;

  const regId = correspondence.registration_id as string | null;
  const regRows = regId
    ? await sql<Record<string, unknown>>`
        select * from registrations where id = ${regId} and user_id = ${userId}
      `.catch(() => [])
    : [];

  const decisions = await sql<Record<string, unknown>>`
    select * from correspondence_decisions
    where correspondence_id = ${correspondenceId} and user_id = ${userId}
    order by created_at desc
  `.catch(() => []);

  const reviews = await sql<Record<string, unknown>>`
    select * from reviews
    where target_type = 'correspondence' and target_id = ${correspondenceId} and user_id = ${userId}
    order by created_at desc
  `.catch(() => []);

  const discrepancies =
    fromVersionId && toVersionId
      ? await sql<Record<string, unknown>>`
          select * from discrepancies
          where user_id = ${userId}
            and patient_id = ${patientId}
            and ((left_ref = ${fromVersionId} and right_ref = ${toVersionId})
              or (left_ref = ${toVersionId} and right_ref = ${fromVersionId}))
          order by created_at desc
        `.catch(() => [])
      : [];

  const auditHistory = await sql<Record<string, unknown>>`
    select * from audit_events
    where user_id = ${userId} and entity_id = ${correspondenceId}
    order by at desc
  `.catch(() => []);

  return {
    correspondence,
    sourceExamination: fromEvidence
      ? {
          study: fromEvidence.study,
          series: fromEvidence.series,
          finding: fromEvidence.finding,
          findingVersion: fromEvidence.findingVersion,
          segmentationRun: fromEvidence.segmentationRun,
          sourceDicomObjects: fromEvidence.sourceDicomObjects,
          maskObjects: fromEvidence.maskObjects,
          integritySummary: fromEvidence.integritySummary,
        }
      : null,
    targetExamination: toEvidence
      ? {
          study: toEvidence.study,
          series: toEvidence.series,
          finding: toEvidence.finding,
          findingVersion: toEvidence.findingVersion,
          segmentationRun: toEvidence.segmentationRun,
          sourceDicomObjects: toEvidence.sourceDicomObjects,
          maskObjects: toEvidence.maskObjects,
          integritySummary: toEvidence.integritySummary,
        }
      : null,
    registration: regRows[0] ?? null,
    discrepancies,
    clinicianDecisions: decisions,
    clinicianReviews: reviews,
    auditHistory,
  };
}

export const getLongitudinalComparisonProvenance = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((correspondenceId: string) => correspondenceId)
  .handler(async ({ context, data: correspondenceId }) => {
    const sql = await getSql();
    return executeGetLongitudinalComparisonProvenance(sql, context.userId, correspondenceId);
  });
